//! Local JSON-lines socket shared by two kinds of clients:
//!
//! * **runtime agents**, injected into Node, Bun, Python and PHP or linked into Go programs —
//!   they stream heap stats and GC events and answer snapshot, profile and GC requests;
//! * the **`peak` CLI** — `peak run` registers a command started in a terminal and forwards its
//!   output and exit status, `peak ps` and `peak profile` read and act on monitored runs.

use std::collections::HashMap;
use std::fs;
use std::io::{self, BufRead, BufReader, Read, Write};
use std::net::{SocketAddr, TcpListener, TcpStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::Deserialize;
use serde_json::{Value, json};

use crate::model::*;
use crate::monitor::{AgentEnv, Origin, Shared, now_ms};
use crate::runner::ExitInfo;
use crate::sampler::AgentHeap;

pub const NODE_AGENT: &str = include_str!("../../agents/peak-agent.cjs");
pub const PYTHON_AGENT: &str = include_str!("../../agents/python/sitecustomize.py");
pub const BUN_AGENT: &str = include_str!("../../agents/bun/peak-agent-bun.js");
pub const PHP_AGENT: &str = include_str!("../../agents/php/peak-agent.php");
/// A compiled Go program can't be injected into, so it imports this. A copy goes with the app,
/// so programs can build against the matching version without downloading anything.
pub const GO_SDK: [(&str, &str); 5] = [
    ("go.mod", include_str!("../../../sdk/go/go.mod")),
    ("README.md", include_str!("../../../sdk/go/README.md")),
    ("peak.go", include_str!("../../../sdk/go/peak.go")),
    ("pprof.go", include_str!("../../../sdk/go/pprof.go")),
    ("auto/auto.go", include_str!("../../../sdk/go/auto/auto.go")),
];

/// Inbound messages (agents and CLI).
#[derive(Debug, Deserialize, PartialEq)]
#[serde(tag = "type", rename_all = "lowercase")]
pub enum Inbound {
    Hello {
        token: String,
        pid: u32,
        runtime: Runtime,
        #[serde(default)]
        agent: Option<AgentInfo>,
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
    Gauges {
        values: Vec<Gauge>,
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
    /// From `peak ps` and `peak profile`: one request and one answer on a connection.
    Control {
        secret: String,
        action: String,
        #[serde(default)]
        target: String,
        #[serde(default)]
        ms: u64,
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

/// `$XDG_DATA_HOME/peak` or `~/.local/share/peak`.
pub fn data_dir(xdg: Option<&str>, home: Option<&str>) -> PathBuf {
    match (xdg.filter(|x| !x.is_empty()), home) {
        (Some(x), _) => PathBuf::from(x).join("peak"),
        (None, Some(h)) => PathBuf::from(h).join(".local/share/peak"),
        (None, None) => std::env::temp_dir().join("peak"),
    }
}

/// `peak` in the per-user application data directory for a given home.
#[cfg(target_os = "macos")]
pub fn data_dir_in_home(home: &Path) -> PathBuf {
    home.join("Library/Application Support/peak")
}

/// `peak` in the per-user application data directory for a given home.
#[cfg(not(target_os = "macos"))]
pub fn data_dir_in_home(home: &Path) -> PathBuf {
    home.join(".local/share/peak")
}

#[cfg(target_os = "linux")]
pub fn default_data_dir() -> PathBuf {
    data_dir(std::env::var("XDG_DATA_HOME").ok().as_deref(), std::env::var("HOME").ok().as_deref())
}

#[cfg(target_os = "macos")]
pub fn default_data_dir() -> PathBuf {
    std::env::var_os("HOME").map_or_else(|| std::env::temp_dir().join("peak"), |h| data_dir_in_home(Path::new(&h)))
}

#[cfg(windows)]
pub fn default_data_dir() -> PathBuf {
    std::env::var_os("LOCALAPPDATA")
        .map_or_else(|| std::env::temp_dir().join("peak"), |d| PathBuf::from(d).join("peak"))
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

/// How a PHP process finds its agent. Goes in a file because PHP has no option variable.
fn php_ini(agent: &Path) -> String {
    format!(
        "; Written by Peak. Only read by programs Peak started.\nauto_prepend_file=\"{}\"\n",
        agent.display().to_string().replace('\\', "/")
    )
}

/// Write the agents to `dir` and return the environment that loads them.
pub fn install_agents(dir: &Path, addr: &str) -> io::Result<AgentEnv> {
    let agents = dir.join("agents");
    let py = agents.join("python");
    let bun = agents.join("bun");
    let php = agents.join("php");
    fs::create_dir_all(&py)?;
    fs::create_dir_all(&bun)?;
    fs::create_dir_all(php.join("ini"))?;
    let node = agents.join("peak-agent.cjs");
    fs::write(&node, NODE_AGENT)?;
    fs::write(py.join("sitecustomize.py"), PYTHON_AGENT)?;
    let bun_agent = bun.join("peak-agent-bun.js");
    fs::write(&bun_agent, BUN_AGENT)?;
    let php_agent = php.join("peak-agent.php");
    fs::write(&php_agent, PHP_AGENT)?;
    fs::write(php.join("ini").join("peak.ini"), php_ini(&php_agent))?;
    for (name, text) in GO_SDK {
        let path = agents.join("go").join(name);
        fs::create_dir_all(path.parent().expect("the SDK's files are in a directory"))?;
        fs::write(path, text)?;
    }
    Ok(AgentEnv {
        addr: addr.to_string(),
        node_agent: Some(node),
        python_dir: Some(py),
        bun_agent: Some(bun_agent),
        php_ini_dir: Some(php.join("ini")),
    })
}

/// What it takes to profile each runtime, as `peak agents` prints it.
pub fn agent_setup(dir: &Path) -> String {
    let agents = dir.join("agents");
    format!(
        "Node.js  automatic. Started by Peak or `peak run`: heap, GC, event-loop delay, CPU, heap snapshots.\n\
         Bun      automatic, on versions that read BUN_OPTIONS. Heap, timer delay, CPU, heap snapshots. No GC events: Bun doesn't publish them.\n\
         Python   automatic. GC, interpreter delay, CPU stacks, allocation snapshots.\n\
         PHP      automatic for the CLI: figures at exit. For live heap, GC, commands and CPU, install the Excimer extension: pecl install excimer\n\
         \u{20}        No event-loop delay or heap snapshots. No Excimer build for Windows, so only figures at exit there.\n\
         Go       needs one import, as a compiled program can't be injected into:\n\
         \u{20}          import _ \"github.com/Noah-Wilderom/peak/sdk/go/auto\"\n\
         \u{20}        Then run it with `peak run -- ./yourprogram`. Heap, GC, scheduler latency, CPU, allocation profiles.\n\
         \u{20}        Get it with `go get github.com/Noah-Wilderom/peak/sdk/go@latest`, or build against the copy for this version:\n\
         \u{20}          go mod edit -require=github.com/Noah-Wilderom/peak/sdk/go@v0.0.0 -replace=github.com/Noah-Wilderom/peak/sdk/go={}\n\
         \n\
         Peak can't attach to a process that's already running, or look inside a program without one of these.\n\
         Agents are in {}",
        agents.join("go").display(),
        agents.display(),
    )
}

/// How long an agent's hello waits for its run to be registered.
const HELLO_PATIENCE: Duration = Duration::from_secs(3);

type Pending = Arc<Mutex<HashMap<u64, mpsc::Sender<Result<Value, String>>>>>;
type Notify = Arc<dyn Fn(Proc) + Send + Sync>;
/// Carries out a `peak profile` action: (action, run id, milliseconds).
pub type ControlFn = Arc<dyn Fn(&str, &str, u64) -> Result<Value, String> + Send + Sync>;

pub struct Hub {
    addr: SocketAddr,
    secret: String,
    monitor: Shared,
    agents: Mutex<HashMap<(String, u32), TcpStream>>,
    pending: Pending,
    next_req: AtomicU64,
    on_proc: Notify,
    control: Mutex<Option<ControlFn>>,
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
            control: Mutex::new(None),
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

    /// Route `peak profile` through whatever keeps the results, rather than straight to the agent.
    pub fn set_control(&self, control: ControlFn) {
        *self.control.lock().unwrap() = Some(control);
    }

    fn control(&self, action: &str, target: &str, ms: u64) -> Result<Value, String> {
        if action == "list" {
            return serde_json::to_value(self.monitor.lock().unwrap().listing()).map_err(|e| e.to_string());
        }
        let id = self.monitor.lock().unwrap().resolve_run(target);
        let id = id.ok_or_else(|| format!("no run in this session matches `{target}`"))?;
        let control = self.control.lock().unwrap().clone();
        match control {
            Some(control) => control(action, &id, ms),
            None => self.perform(action, &id, ms),
        }
    }

    /// Carry out a control action on a run's agent.
    pub fn perform(&self, action: &str, id: &str, ms: u64) -> Result<Value, String> {
        fn value(v: impl serde::Serialize) -> Result<Value, String> {
            serde_json::to_value(v).map_err(|e| e.to_string())
        }
        match action {
            "gc" => self.force_gc(id, Duration::from_secs(30)).map(|()| Value::Null),
            "snapshot" => value(self.take_snapshot(id, Duration::from_secs(120))?),
            "cpu" => value(self.cpu_profile(id, ms.clamp(500, 60_000))?),
            other => Err(format!("unknown action `{other}`")),
        }
    }

    fn serve(self: Arc<Self>, stream: TcpStream) {
        let Ok(write) = stream.try_clone() else { return };
        let mut lines = BufReader::new(stream).lines();
        let Some(Ok(first)) = lines.next() else { return };
        match serde_json::from_str::<Inbound>(&first) {
            Ok(Inbound::Hello { token, pid, runtime, agent }) => {
                if !self.greet(&token, pid, runtime, agent) {
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
            Ok(Inbound::Control { secret, action, target, ms }) if secret == self.secret => {
                let reply = match self.control(&action, &target, ms) {
                    Ok(data) => json!({ "type": "control", "ok": true, "data": data }),
                    Err(error) => json!({ "type": "control", "ok": false, "error": error }),
                };
                let mut write = write;
                let _ = writeln!(write, "{reply}");
            }
            // Lets the CLI say it was turned away, rather than that there's no app.
            Ok(Inbound::Register { .. } | Inbound::Control { .. }) => {
                let mut write = write;
                let _ = writeln!(write, "{}", json!({ "type": "rejected" }));
            }
            _ => {}
        }
    }

    /// A run from `peak run` only becomes known once the CLI's `started` message is handled, and
    /// a runtime that starts quickly can get here first. Turning it away would lose the agent for
    /// the whole run, so a token gets a moment to appear.
    fn greet(&self, token: &str, pid: u32, runtime: Runtime, agent: Option<AgentInfo>) -> bool {
        let deadline = Instant::now() + HELLO_PATIENCE;
        loop {
            if self.monitor.lock().unwrap().agent_hello(token, pid, runtime, agent.clone()) {
                return true;
            }
            if Instant::now() >= deadline {
                return false;
            }
            thread::sleep(Duration::from_millis(20));
        }
    }

    fn on_agent(&self, token: &str, pid: u32, msg: Inbound) {
        match msg {
            Inbound::Heap { heap_used, heap_total, external, loop_lag } => {
                let heap = AgentHeap { heap_used, heap_total, external, loop_lag };
                self.monitor.lock().unwrap().agent_heap(token, pid, heap);
            }
            Inbound::Lag { loop_lag } => self.monitor.lock().unwrap().agent_lag(token, pid, loop_lag),
            Inbound::Gauges { values } => self.monitor.lock().unwrap().agent_gauges(token, pid, values),
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
            let env = m.agent_env.vars(&id);
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

    /// The agent to ask for `capability`, or why it can't be asked: one that can't do it may
    /// not be able to answer at all, so it's told here rather than by a timeout.
    fn primary(&self, id: &str, capability: &str) -> Result<u32, String> {
        let m = self.monitor.lock().unwrap();
        let pid = m.primary_agent(id).ok_or("no profiling agent is attached to this process")?;
        if let Some(info) = m.get(id).and_then(|p| p.agent.as_ref()).filter(|i| !i.can(capability)) {
            return Err(info
                .unavailable
                .get(capability)
                .cloned()
                .unwrap_or_else(|| format!("this agent doesn't support {}", capability_name(capability))));
        }
        Ok(pid)
    }

    pub fn take_snapshot(&self, id: &str, timeout: Duration) -> Result<HeapSnapshot, String> {
        let pid = self.primary(id, "snapshot")?;
        let data = self.request(id, pid, "snapshot", timeout)?;
        let snap = snapshot_from_agent(data, now_ms())?;
        self.monitor.lock().unwrap().add_snapshot(id, snap.clone());
        Ok(snap)
    }

    pub fn force_gc(&self, id: &str, timeout: Duration) -> Result<(), String> {
        let pid = self.primary(id, "forcegc")?;
        self.request(id, pid, "gc", timeout).map(|_| ())
    }

    /// Sample the primary agent's CPU for `ms` milliseconds.
    pub fn cpu_profile(&self, id: &str, ms: u64) -> Result<CpuProfile, String> {
        let pid = self.primary(id, "cpu")?;
        let data = self.request_with(id, pid, "cpuprofile", json!({ "ms": ms }), Duration::from_millis(ms + 15_000))?;
        let profile = cpu_profile_from_agent(data, now_ms())?;
        self.monitor.lock().unwrap().add_cpu_profile(id, profile.clone());
        Ok(profile)
    }
}

fn capability_name(capability: &str) -> &str {
    match capability {
        "cpu" => "CPU profiles",
        "snapshot" => "heap snapshots",
        _ => "forcing a collection",
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
    #[serde(default = "crate::model::unknown_sampling")]
    sampling: String,
    root: AllocFrame,
}

/// Validate an agent's CPU profile payload and stamp it.
pub fn cpu_profile_from_agent(data: Value, t: u64) -> Result<CpuProfile, String> {
    let p: AgentCpuProfile = serde_json::from_value(data).map_err(|e| format!("bad cpu profile from agent: {e}"))?;
    Ok(CpuProfile {
        id: format!("c_{t:x}_{}", random_hex(3)),
        t,
        duration_ms: p.duration_ms,
        sampling: p.sampling,
        root: p.root,
    })
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

#[cfg(all(test, target_os = "linux"))]
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
    fn paths_and_agents() {
        assert_eq!(data_dir(Some("/x"), Some("/h")), PathBuf::from("/x/peak"));
        assert_eq!(data_dir(Some(""), Some("/h")), PathBuf::from("/h/.local/share/peak"));
        assert_eq!(data_dir(None, None), std::env::temp_dir().join("peak"));
        assert!(default_data_dir().ends_with("peak"));
        let dir = tempfile::tempdir().unwrap();
        let env = install_agents(dir.path(), "127.0.0.1:1").unwrap();
        assert!(fs::read_to_string(env.node_agent.unwrap()).unwrap().contains("PEAK_AGENT_ADDR"));
        assert!(env.python_dir.unwrap().join("sitecustomize.py").exists());
        assert!(fs::read_to_string(env.bun_agent.unwrap()).unwrap().contains("BUN_OPTIONS"));
        let ini = fs::read_to_string(env.php_ini_dir.unwrap().join("peak.ini")).unwrap();
        assert!(ini.contains("auto_prepend_file=") && ini.contains("peak-agent.php"), "{ini}");
        assert!(dir.path().join("agents/php/peak-agent.php").exists());
        for (name, _) in GO_SDK {
            assert!(dir.path().join("agents/go").join(name).exists(), "{name}");
        }
        let setup = agent_setup(dir.path());
        assert!(setup.contains("sdk/go/auto") && setup.contains("pecl install excimer"));
        assert!(setup.contains(&dir.path().join("agents/go").display().to_string()));
        assert_eq!(php_ini(Path::new("C:\\a b\\p.php")).lines().nth(1), Some("auto_prepend_file=\"C:/a b/p.php\""));
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

    /// `peak run` announces a run after starting it, so a fast runtime's agent can arrive first.
    #[test]
    fn an_agent_that_arrives_before_its_run_is_kept() {
        let (m, hub, _) = setup();
        let id = m.lock().unwrap().new_id();
        let (mut a, _a_r) = connect(&hub);
        writeln!(a, r#"{{"type":"hello","token":"{id}","pid":4242,"runtime":"node"}}"#).unwrap();
        thread::sleep(Duration::from_millis(150));
        m.lock().unwrap().insert(id.clone(), Origin::External, std::process::id(), "node app.js", "/tmp", now_ms());
        eventually(|| m.lock().unwrap().get(&id).is_some_and(|p| p.profiling));
        assert_eq!(m.lock().unwrap().get(&id).unwrap().runtime, Runtime::Node);
        writeln!(a, r#"{{"type":"lag","loopLag":7.0}}"#).unwrap();
        // Still connected: the hub took that as coming from a known agent.
        eventually(|| hub.agents.lock().unwrap().contains_key(&(id.clone(), 4242)));
    }

    #[test]
    fn agents_say_what_they_can_do_and_it_stays_with_the_run() {
        let (m, hub, _) = setup();
        let id = {
            let mut g = m.lock().unwrap();
            let id = g.new_id();
            g.insert(id.clone(), Origin::External, std::process::id(), "./server", "/tmp", now_ms());
            id
        };
        let (mut a, a_r) = connect(&hub);
        let hello = json!({ "type": "hello", "token": id, "pid": 7, "runtime": "php", "agent": {
            "runtimeVersion": "8.3.6", "agentVersion": "0.1.1", "capabilities": [],
            "unavailable": { "cpu": "Install Excimer" }
        }});
        writeln!(a, "{hello}").unwrap();
        eventually(|| m.lock().unwrap().get(&id).unwrap().profiling);
        {
            let g = m.lock().unwrap();
            let p = g.get(&id).unwrap();
            assert_eq!(p.runtime, Runtime::Php);
            assert!(!p.has_gc, "an agent without GC data doesn't get a GC view");
            assert_eq!(p.agent.as_ref().unwrap().runtime_version, "8.3.6");
        }
        assert_eq!(hub.cpu_profile(&id, 500).unwrap_err(), "Install Excimer");
        // With no reason given, it's still not left to time out.
        assert_eq!(
            hub.take_snapshot(&id, Duration::from_secs(9)).unwrap_err(),
            "this agent doesn't support heap snapshots"
        );
        assert_eq!(
            hub.force_gc(&id, Duration::from_secs(9)).unwrap_err(),
            "this agent doesn't support forcing a collection"
        );

        writeln!(a, r#"{{"type":"gauges","values":[{{"name":"Peak memory","value":5,"unit":"bytes"}}]}}"#).unwrap();
        eventually(|| !m.lock().unwrap().get(&id).unwrap().agent.as_ref().unwrap().gauges.is_empty());
        drop(a);
        drop(a_r);
        eventually(|| !m.lock().unwrap().get(&id).unwrap().profiling);
        let g = m.lock().unwrap();
        let info = g.get(&id).unwrap().agent.clone().unwrap();
        assert_eq!(info.gauges[0].name, "Peak memory");
        assert_eq!(info.unavailable["cpu"], "Install Excimer");
        assert_eq!(g.listing()[0].id, id);
        assert_eq!(g.resolve_run("7"), None, "an agent that's gone doesn't identify a run");
        assert_eq!(g.resolve_run(&std::process::id().to_string()), Some(id.clone()));
        assert_eq!(g.resolve_run(&id), Some(id.clone()));
        assert_eq!(g.resolve_run("not a pid"), None);
    }

    #[test]
    fn control_actions() {
        let (m, hub, _) = setup();
        let run = |action: &str, target: &str| {
            let (mut c, mut r) = connect(&hub);
            let req = json!({ "type": "control", "secret": "sekrit", "action": action, "target": target, "ms": 500 });
            writeln!(c, "{req}").unwrap();
            serde_json::from_str::<Value>(&r.next().unwrap().unwrap()).unwrap()
        };
        assert_eq!(run("list", "")["data"], json!([]));
        assert!(run("cpu", "nope")["error"].as_str().unwrap().contains("no run in this session"));
        let id = {
            let mut g = m.lock().unwrap();
            let id = g.new_id();
            g.insert(id.clone(), Origin::External, std::process::id(), "./server", "/tmp", now_ms());
            id
        };
        // Straight to the agent when nothing else wants to keep the results.
        for action in ["cpu", "snapshot", "gc"] {
            assert!(run(action, &id)["error"].as_str().unwrap().contains("no profiling agent"), "{action}");
        }
        assert!(run("wat", &id)["error"].as_str().unwrap().contains("unknown action"));
        // Otherwise through whatever does.
        hub.set_control(Arc::new(|action, id, ms| Ok(json!([action, id, ms]))));
        assert_eq!(run("cpu", &id)["data"], json!(["cpu", id, 500]));
        // The wrong secret gets nothing.
        let (mut c, mut r) = connect(&hub);
        writeln!(c, "{}", json!({ "type": "control", "secret": "x", "action": "list" })).unwrap();
        let reply: Value = serde_json::from_str(&r.next().unwrap().unwrap()).unwrap();
        assert_eq!(reply["type"], "rejected");
    }

    #[test]
    fn cli_registers_and_streams() {
        let (m, hub, seen) = setup();
        // A wrong secret is told so, and goes no further.
        let (mut bad, mut bad_r) = connect(&hub);
        writeln!(bad, r#"{{"type":"register","secret":"x","command":"c","cwd":"/"}}"#).unwrap();
        let reply: Value = serde_json::from_str(&bad_r.next().unwrap().unwrap()).unwrap();
        assert_eq!(reply["type"], "rejected");
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
