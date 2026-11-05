//! Local JSON-lines socket shared by two kinds of clients:
//!
//! * **runtime agents** injected into Node/Python processes — they stream heap
//!   stats and GC events and answer snapshot / GC requests;
//! * the **`peak run` CLI** — it registers a command started in a terminal and
//!   forwards its output and exit status.

use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

use crate::model::*;
use crate::monitor::{AgentEnv, Origin, Shared, now_ms};
use crate::runner::ExitInfo;
use crate::sampler::AgentHeap;

pub const NODE_AGENT: &str = include_str!("../agents/peak-agent.cjs");
pub const PYTHON_AGENT: &str = include_str!("../agents/python/sitecustomize.py");

/// Inbound messages (agents and CLI).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Inbound {
    Hello {
        token: String,
        pid: u32,
        runtime: Runtime,
    },
    #[serde(rename_all = "camelCase")]
    Heap {
        heap_used: f64,
        heap_total: f64,
        external: f64,
        #[serde(default)]
        loop_lag: Option<f64>,
    },
    /// Runtime responsiveness only (agents without heap stats, e.g. Python).
    #[serde(rename_all = "camelCase")]
    Lag {
        loop_lag: f64,
    },
    #[serde(rename_all = "camelCase")]
    Gc {
        kind: GcKind,
        pause_ms: f64,
        freed: f64,
        t: Option<u64>,
    },
    #[serde(rename_all = "camelCase")]
    Reply {
        req_id: u64,
        ok: bool,
        data: Option<Value>,
        error: Option<String>,
    },
    Register {
        secret: String,
        command: String,
        cwd: String,
    },
    Started {
        pid: u32,
    },
    Log {
        stream: Stream,
        text: String,
    },
    Exit {
        code: Option<i32>,
        signal: Option<i32>,
    },
}

#[derive(Debug, Serialize, Deserialize, PartialEq)]
pub struct ControlFile {
    pub addr: String,
    pub secret: String,
}

/// `$XDG_DATA_HOME/peak` or `~/.local/share/peak`.
pub fn data_dir(xdg: Option<&str>, home: Option<&str>) -> PathBuf {
    match (xdg.filter(|x| !x.is_empty()), home) {
        (Some(x), _) => PathBuf::from(x).join("peak"),
        (None, Some(h)) => PathBuf::from(h).join(".local/share/peak"),
        (None, None) => std::env::temp_dir().join("peak"),
    }
}

pub fn default_data_dir() -> PathBuf {
    data_dir(std::env::var("XDG_DATA_HOME").ok().as_deref(), std::env::var("HOME").ok().as_deref())
}

pub fn random_hex(bytes: usize) -> String {
    random_hex_from(Path::new("/dev/urandom"), bytes)
}

/// Hex string from an entropy source, falling back to a time-based mix.
pub fn random_hex_from(source: &Path, bytes: usize) -> String {
    let mut buf = vec![0u8; bytes];
    if fs::File::open(source).and_then(|mut f| f.read_exact(&mut buf)).is_err() {
        let seed = now_ms() ^ ((std::process::id() as u64) << 32);
        for (i, b) in buf.iter_mut().enumerate() {
            *b = (seed.rotate_left(i as u32 * 7) & 0xff) as u8;
        }
    }
    buf.iter().map(|b| format!("{b:02x}")).collect()
}

/// Write the agent scripts to `dir` and return the environment that loads them.
pub fn install_agents(dir: &Path, addr: &str) -> io::Result<AgentEnv> {
    let agents = dir.join("agents");
    let py = agents.join("python");
    fs::create_dir_all(&py)?;
    let node = agents.join("peak-agent.cjs");
    fs::write(&node, NODE_AGENT)?;
    fs::write(py.join("sitecustomize.py"), PYTHON_AGENT)?;
    Ok(AgentEnv { addr: addr.to_string(), node_agent: Some(node), python_dir: Some(py) })
}

pub fn write_control_file(dir: &Path, cf: &ControlFile) -> io::Result<PathBuf> {
    use std::os::unix::fs::OpenOptionsExt;
    fs::create_dir_all(dir)?;
    let path = dir.join("control.json");
    let mut f = fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&path)?;
    f.write_all(serde_json::to_string(cf)?.as_bytes())?;
    Ok(path)
}

pub fn read_control_file(dir: &Path) -> Option<ControlFile> {
    serde_json::from_str(&fs::read_to_string(dir.join("control.json")).ok()?).ok()
}

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;
type Notify = Arc<dyn Fn(Proc) + Send + Sync>;

pub struct Hub {
    addr: SocketAddr,
    secret: String,
    monitor: Shared,
    agents: Mutex<HashMap<(String, u32), TcpStream>>,
    pending: Pending,
    next_req: AtomicU64,
    on_proc: Notify,
}

impl Hub {
    /// Bind to an ephemeral localhost port and start accepting clients.
    pub fn start(monitor: Shared, secret: String, on_proc: Notify) -> io::Result<Arc<Hub>> {
        let listener = TcpListener::bind("127.0.0.1:0")?;
        let hub = Arc::new(Hub {
            addr: listener.local_addr()?,
            secret,
            monitor,
            agents: Mutex::new(HashMap::new()),
            pending: Arc::new(Mutex::new(HashMap::new())),
            next_req: AtomicU64::new(1),
            on_proc,
        });
        let h = hub.clone();
        thread::spawn(move || {
            for stream in listener.incoming().flatten() {
                let h = h.clone();
                thread::spawn(move || h.serve(stream));
            }
        });
        Ok(hub)
    }

    pub fn addr(&self) -> SocketAddr {
        self.addr
    }

    fn serve(self: Arc<Self>, stream: TcpStream) {
        let Ok(write) = stream.try_clone() else { return };
        let mut lines = BufReader::new(stream).lines();
        let Some(Ok(first)) = lines.next() else { return };
        match serde_json::from_str::<Inbound>(&first) {
            Ok(Inbound::Hello { token, pid, runtime }) => {
                if !self.monitor.lock().unwrap().agent_hello(&token, pid, runtime) {
                    return;
                }
                self.agents.lock().unwrap().insert((token.clone(), pid), write);
                for line in lines.map_while(Result::ok) {
                    if let Ok(msg) = serde_json::from_str::<Inbound>(&line) {
                        self.on_agent(&token, pid, msg);
                    }
                }
                self.agents.lock().unwrap().remove(&(token.clone(), pid));
                self.monitor.lock().unwrap().agent_bye(&token, pid);
            }
            Ok(Inbound::Register { secret, command, cwd }) if secret == self.secret => {
                self.serve_cli(write, lines, command, cwd);
            }
            _ => {}
        }
    }

    fn on_agent(&self, token: &str, pid: u32, msg: Inbound) {
        match msg {
            Inbound::Heap { heap_used, heap_total, external, loop_lag } => {
                let heap = AgentHeap { heap_used, heap_total, external, loop_lag };
                self.monitor.lock().unwrap().agent_heap(token, pid, heap);
            }
            Inbound::Lag { loop_lag } => self.monitor.lock().unwrap().agent_lag(token, pid, loop_lag),
            Inbound::Gc { kind, pause_ms, freed, t } => {
                let ev = GcEvent { t: t.unwrap_or_else(now_ms), kind, pause_ms, freed };
                self.monitor.lock().unwrap().agent_gc(token, ev);
            }
            Inbound::Reply { req_id, ok, data, error } => {
                if let Some(tx) = self.pending.lock().unwrap().remove(&req_id) {
                    let _ = tx.send(if ok {
                        Ok(data.unwrap_or(Value::Null))
                    } else {
                        Err(error.unwrap_or_else(|| "agent error".into()))
                    });
                }
            }
            _ => {}
        }
    }

    fn serve_cli(&self, mut write: TcpStream, lines: io::Lines<BufReader<TcpStream>>, command: String, cwd: String) {
        let (id, env) = {
            let mut m = self.monitor.lock().unwrap();
            let id = m.new_id();
            let env = m.agent_env.vars(&id, None, None);
            (id, env)
        };
        // A failed write surfaces as EOF on the read loop below.
        let _ = writeln!(write, "{}", json!({ "type": "registered", "id": id, "env": env }));
        let mut exited = false;
        let mut started = false;
        for line in lines.map_while(Result::ok) {
            let Ok(msg) = serde_json::from_str::<Inbound>(&line) else { continue };
            let mut m = self.monitor.lock().unwrap();
            match msg {
                Inbound::Started { pid } if !started => {
                    started = true;
                    let proc = m.insert(id.clone(), Origin::External, pid, &command, &cwd, now_ms());
                    m.push_log(&id, Stream::Stdout, format!("$ {command}"), proc.started_at);
                    let proc = m.get(&id).cloned().unwrap_or(proc);
                    drop(m);
                    (self.on_proc)(proc);
                }
                Inbound::Log { stream, text } => m.push_log(&id, stream, text, now_ms()),
                Inbound::Exit { code, signal } => {
                    m.on_exit(&id, ExitInfo { code, signal }, now_ms());
                    exited = true;
                }
                _ => {}
            }
        }
        if started && !exited {
            // The terminal went away; fall back to watching the pid.
            self.monitor.lock().unwrap().set_origin(&id, Origin::Attached);
        }
    }

    /// Send a command to one agent and wait for its reply.
    pub fn request(&self, token: &str, pid: u32, cmd: &str, timeout: Duration) -> Result<Value, String> {
        self.request_with(token, pid, cmd, json!({}), timeout)
    }

    /// Like `request`, merging `params` into the command message.
    pub fn request_with(
        &self,
        token: &str,
        pid: u32,
        cmd: &str,
        params: Value,
        timeout: Duration,
    ) -> Result<Value, String> {
        let req_id = self.next_req.fetch_add(1, Ordering::Relaxed);
        let mut msg = json!({ "cmd": cmd, "reqId": req_id });
        if let (Some(m), Some(p)) = (msg.as_object_mut(), params.as_object()) {
            m.extend(p.clone());
        }
        let (tx, rx) = mpsc::channel();
        self.pending.lock().unwrap().insert(req_id, tx);
        let sent = {
            let mut agents = self.agents.lock().unwrap();
            match agents.get_mut(&(token.to_string(), pid)) {
                Some(s) => writeln!(s, "{msg}").map_err(|e| e.to_string()),
                None => Err("agent is not connected".into()),
            }
        };
        let result =
            sent.and_then(|_| rx.recv_timeout(timeout).map_err(|_| format!("agent did not answer `{cmd}` in time"))?);
        self.pending.lock().unwrap().remove(&req_id);
        result
    }

    fn primary(&self, id: &str) -> Result<u32, String> {
        self.monitor
            .lock()
            .unwrap()
            .primary_agent(id)
            .ok_or_else(|| "no profiling agent is attached to this process".into())
    }

    pub fn take_snapshot(&self, id: &str, timeout: Duration) -> Result<HeapSnapshot, String> {
        let pid = self.primary(id)?;
        let data = self.request(id, pid, "snapshot", timeout)?;
        let snap = snapshot_from_agent(data, now_ms())?;
        self.monitor.lock().unwrap().add_snapshot(id, snap.clone());
        Ok(snap)
    }

    pub fn force_gc(&self, id: &str, timeout: Duration) -> Result<(), String> {
        let pid = self.primary(id)?;
        self.request(id, pid, "gc", timeout).map(|_| ())
    }

    /// Sample the primary agent's CPU for `ms` milliseconds.
    pub fn cpu_profile(&self, id: &str, ms: u64) -> Result<CpuProfile, String> {
        let pid = self.primary(id)?;
        let data = self.request_with(id, pid, "cpuprofile", json!({ "ms": ms }), Duration::from_millis(ms + 15_000))?;
        let profile = cpu_profile_from_agent(data, now_ms())?;
        self.monitor.lock().unwrap().add_cpu_profile(id, profile.clone());
        Ok(profile)
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentSnapshot {
    heap_used: f64,
    entries: Vec<HeapEntry>,
    sites: Option<AllocFrame>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct AgentCpuProfile {
    duration_ms: f64,
    root: AllocFrame,
}

/// Validate an agent's CPU profile payload and stamp it.
pub fn cpu_profile_from_agent(data: Value, t: u64) -> Result<CpuProfile, String> {
    let p: AgentCpuProfile = serde_json::from_value(data).map_err(|e| format!("bad cpu profile from agent: {e}"))?;
    Ok(CpuProfile { id: format!("c_{t:x}_{}", random_hex(3)), t, duration_ms: p.duration_ms, root: p.root })
}

/// Validate an agent's snapshot payload and stamp it.
pub fn snapshot_from_agent(data: Value, t: u64) -> Result<HeapSnapshot, String> {
    let s: AgentSnapshot = serde_json::from_value(data).map_err(|e| format!("bad snapshot from agent: {e}"))?;
    let mut entries = s.entries;
    entries.sort_by(|a, b| b.retained.total_cmp(&a.retained));
    Ok(HeapSnapshot {
        id: format!("s_{t:x}_{}", random_hex(3)),
        t,
        heap_used: s.heap_used,
        entries,
        sites: s.sites.unwrap_or(AllocFrame { name: "(root)".into(), file: None, self_bytes: 0.0, children: vec![] }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::{AgentEnv, Monitor};
    use crate::procfs::ProcFs;

    fn setup() -> (Shared, Arc<Hub>, Arc<Mutex<Vec<Proc>>>) {
        let m = Monitor::new(ProcFs::default(), AgentEnv { addr: "x".into(), ..Default::default() }).shared();
        let seen = Arc::new(Mutex::new(vec![]));
        let s = seen.clone();
        let hub = Hub::start(m.clone(), "sekrit".into(), Arc::new(move |p| s.lock().unwrap().push(p))).unwrap();
        (m, hub, seen)
    }

    fn connect(hub: &Hub) -> (TcpStream, io::Lines<BufReader<TcpStream>>) {
        let s = TcpStream::connect(hub.addr()).unwrap();
        s.set_read_timeout(Some(Duration::from_secs(5))).unwrap();
        let r = BufReader::new(s.try_clone().unwrap()).lines();
        (s, r)
    }

    fn eventually(f: impl Fn() -> bool) {
        let ok = (0..200).any(|_| {
            f() || {
                thread::sleep(Duration::from_millis(10));
                false
            }
        });
        assert!(ok, "condition never became true");
    }

    #[test]
    fn parses_inbound_messages() {
        let m: Inbound = serde_json::from_str(r#"{"type":"gc","kind":"major","pauseMs":3.5,"freed":10}"#).unwrap();
        assert_eq!(m, Inbound::Gc { kind: GcKind::Major, pause_ms: 3.5, freed: 10.0, t: None });
        let m: Inbound = serde_json::from_str(r#"{"type":"reply","reqId":4,"ok":false,"error":"nope"}"#).unwrap();
        assert_eq!(m, Inbound::Reply { req_id: 4, ok: false, data: None, error: Some("nope".into()) });
        assert!(serde_json::from_str::<Inbound>(r#"{"type":"wat"}"#).is_err());
    }

    #[test]
    fn paths_and_control_file() {
        assert_eq!(data_dir(Some("/x"), Some("/h")), PathBuf::from("/x/peak"));
        assert_eq!(data_dir(Some(""), Some("/h")), PathBuf::from("/h/.local/share/peak"));
        assert_eq!(data_dir(None, None), std::env::temp_dir().join("peak"));
        assert!(default_data_dir().ends_with("peak"));
        let dir = tempfile::tempdir().unwrap();
        assert!(read_control_file(dir.path()).is_none());
        let cf = ControlFile { addr: "127.0.0.1:1".into(), secret: "s".into() };
        let path = write_control_file(dir.path(), &cf).unwrap();
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&path).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(read_control_file(dir.path()), Some(cf));
        let env = install_agents(dir.path(), "127.0.0.1:1").unwrap();
        assert!(fs::read_to_string(env.node_agent.unwrap()).unwrap().contains("PEAK_AGENT_ADDR"));
        assert!(env.python_dir.unwrap().join("sitecustomize.py").exists());
        assert_eq!(random_hex(4).len(), 8);
        assert_eq!(random_hex_from(Path::new("/definitely/missing"), 6).len(), 12);
        assert_ne!(random_hex(8), random_hex(8));
    }

    #[test]
    fn snapshot_payloads() {
        let s = snapshot_from_agent(
            json!({"heapUsed": 10, "entries": [
                {"name": "a", "count": 1, "shallow": 1, "retained": 1},
                {"name": "b", "count": 1, "shallow": 5, "retained": 5}
            ]}),
            7,
        )
        .unwrap();
        assert_eq!(s.t, 7);
        assert_eq!(s.entries[0].name, "b");
        assert_eq!(s.sites.name, "(root)");
        assert!(snapshot_from_agent(json!({"nope": 1}), 7).is_err());
    }

    #[test]
    fn agents_stream_stats_and_answer_requests() {
        let (m, hub, _) = setup();
        let id = {
            let mut g = m.lock().unwrap();
            let id = g.new_id();
            g.insert(id.clone(), Origin::External, std::process::id(), "node app.js", "/tmp", now_ms());
            id
        };
        // Unknown tokens are dropped.
        let (mut bad, mut bad_r) = connect(&hub);
        writeln!(bad, r#"{{"type":"hello","token":"nope","pid":1,"runtime":"node"}}"#).unwrap();
        assert!(bad_r.next().is_none());

        let (mut a, mut a_r) = connect(&hub);
        writeln!(a, r#"{{"type":"hello","token":"{id}","pid":4242,"runtime":"node"}}"#).unwrap();
        writeln!(a, r#"{{"type":"heap","heapUsed":100,"heapTotal":200,"external":5,"loopLag":3.5}}"#).unwrap();
        writeln!(a, r#"{{"type":"lag","loopLag":7.0}}"#).unwrap();
        writeln!(a, r#"{{"type":"gc","kind":"minor","pauseMs":1.5,"freed":64,"t":99}}"#).unwrap();
        writeln!(a, "garbage").unwrap();
        // Messages that aren't agent messages, and replies nobody waits for, are ignored.
        writeln!(a, r#"{{"type":"started","pid":1}}"#).unwrap();
        writeln!(a, r#"{{"type":"reply","reqId":424242,"ok":true}}"#).unwrap();
        writeln!(a, r#"{{"type":"gc","kind":"major","pauseMs":9,"freed":1}}"#).unwrap();
        eventually(|| m.lock().unwrap().get(&id).unwrap().gc.len() == 2);
        assert!(m.lock().unwrap().get(&id).unwrap().profiling);
        assert_eq!(m.lock().unwrap().primary_agent(&id), Some(4242));
        assert_eq!(m.lock().unwrap().get(&id).unwrap().gc[0].t, 99);

        // Snapshot round-trip, answered by a fake agent thread.
        let responder = thread::spawn(move || {
            for _ in 0..3 {
                let req: Value = serde_json::from_str(&a_r.next().unwrap().unwrap()).unwrap();
                let rid = req["reqId"].as_u64().unwrap();
                let reply = match req["cmd"].as_str().unwrap() {
                    "snapshot" => {
                        json!({"type":"reply","reqId":rid,"ok":true,"data":{"heapUsed":100,"entries":[{"name":"Object","count":3,"shallow":30,"retained":40}],"sites":{"name":"(root)","self":0,"children":[]}}})
                    }
                    "gc" => json!({"type":"reply","reqId":rid,"ok":true}),
                    _ => json!({"type":"reply","reqId":rid,"ok":false}),
                };
                writeln!(a, "{reply}").unwrap();
            }
            a
        });
        let snap = hub.take_snapshot(&id, Duration::from_secs(5)).unwrap();
        assert_eq!(snap.entries[0].name, "Object");
        assert_eq!(m.lock().unwrap().get(&id).unwrap().snapshots.len(), 1);
        hub.force_gc(&id, Duration::from_secs(5)).unwrap();
        assert_eq!(hub.request(&id, 4242, "weird", Duration::from_secs(5)).unwrap_err(), "agent error");
        let a = responder.join().unwrap();
        assert!(hub.request(&id, 4242, "gc", Duration::from_millis(50)).unwrap_err().contains("in time"));
        assert!(hub.request(&id, 1, "gc", Duration::from_millis(50)).unwrap_err().contains("not connected"));
        assert!(hub.take_snapshot("nope", Duration::from_millis(50)).is_err());
        assert!(hub.force_gc("nope", Duration::from_millis(50)).is_err());

        drop(a);
        eventually(|| !m.lock().unwrap().get(&id).unwrap().profiling);
    }

    #[test]
    fn cli_registers_and_streams() {
        let (m, hub, seen) = setup();
        // Wrong secret is ignored.
        let (mut bad, mut bad_r) = connect(&hub);
        writeln!(bad, r#"{{"type":"register","secret":"x","command":"c","cwd":"/"}}"#).unwrap();
        assert!(bad_r.next().is_none());

        let (mut c, mut r) = connect(&hub);
        writeln!(c, r#"{{"type":"register","secret":"sekrit","command":"npm test","cwd":"/tmp"}}"#).unwrap();
        let reply: Value = serde_json::from_str(&r.next().unwrap().unwrap()).unwrap();
        assert_eq!(reply["type"], "registered");
        let id = reply["id"].as_str().unwrap().to_string();
        assert!(reply["env"].as_array().unwrap().iter().any(|kv| kv[0] == "PEAK_AGENT_TOKEN" && kv[1] == id.as_str()));
        writeln!(c, r#"{{"type":"started","pid":{}}}"#, std::process::id()).unwrap();
        writeln!(c, r#"{{"type":"started","pid":1}}"#).unwrap();
        writeln!(c, r#"{{"type":"log","stream":"stdout","text":"PASS"}}"#).unwrap();
        writeln!(c, "not json").unwrap();
        writeln!(c, r#"{{"type":"exit","code":1,"signal":null}}"#).unwrap();
        eventually(|| m.lock().unwrap().get(&id).is_some_and(|p| p.status == Status::Crashed));
        let p = m.lock().unwrap().get(&id).unwrap().clone();
        assert_eq!(p.exit_code, Some(1));
        assert!(p.logs.iter().any(|l| l.text == "PASS"));
        assert_eq!(seen.lock().unwrap().len(), 1);
        assert_eq!(seen.lock().unwrap()[0].command, "npm test");

        // A CLI that disconnects without reporting an exit falls back to pid watching.
        let (mut c, mut r) = connect(&hub);
        writeln!(c, r#"{{"type":"register","secret":"sekrit","command":"sleep","cwd":"/tmp"}}"#).unwrap();
        let reply: Value = serde_json::from_str(&r.next().unwrap().unwrap()).unwrap();
        let id2 = reply["id"].as_str().unwrap().to_string();
        writeln!(c, r#"{{"type":"started","pid":999999}}"#).unwrap();
        drop(c);
        drop(r);
        eventually(|| m.lock().unwrap().origin(&id2) == Some(Origin::Attached));
        m.lock().unwrap().tick(now_ms());
        assert_eq!(m.lock().unwrap().get(&id2).unwrap().status, Status::Exited);

        // Clients that send nothing useful are dropped quietly.
        let (c, _) = connect(&hub);
        drop(c);
        let (mut c, _) = connect(&hub);
        writeln!(c, "{{}}").unwrap();
    }
}
