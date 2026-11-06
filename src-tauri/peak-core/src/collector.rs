//! The headless collector: a `Monitor` and agent hub running beside the workload,
//! driven over stdio by the desktop.
//!
//! Disconnect contract: if the session ends for any reason (stdin closes, the
//! desktop goes quiet past the idle timeout, or `Shutdown`), attached processes
//! are simply no longer observed, and commands this collector launched are stopped
//! (SIGTERM, then SIGKILL), because their output pipes end with the session. Durable
//! remote jobs need a real supervisor; this collector doesn't pretend to be one.

use std::collections::VecDeque;
use std::io::{self, BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, RecvTimeoutError, SyncSender, TrySendError};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde_json::{Value, json};

use crate::cgroup;
use crate::hub::{self, Hub};
use crate::model::*;
use crate::monitor::{self, AgentEnv, Monitor, Shared, now_ms, wall_ms};
use crate::procfs::{self, ProcFs};
use crate::protocol::*;

pub struct Options {
    /// With nothing from the desktop for this long, the session is over. SSH can
    /// keep a dead connection's stdin open for a long time.
    pub idle_timeout: Duration,
    pub tick: Duration,
    /// How long launched commands get between SIGTERM and SIGKILL when the session ends.
    pub stop_grace: Duration,
    pub data_dir: Option<PathBuf>,
}

impl Default for Options {
    fn default() -> Self {
        Options {
            idle_timeout: Duration::from_secs(30),
            tick: Duration::from_millis(TICK_MS),
            stop_grace: Duration::from_secs(3),
            data_dir: None,
        }
    }
}

fn read_trim(path: &str) -> String {
    std::fs::read_to_string(path).map(|s| s.trim().to_string()).unwrap_or_default()
}

/// What this target is. Identity fields empty mean the kernel wouldn't say.
pub fn facts() -> Facts {
    let fs = ProcFs::default();
    Facts {
        protocol: VERSION,
        collector_version: env!("CARGO_PKG_VERSION").to_string(),
        arch: std::env::consts::ARCH.to_string(),
        kernel: read_trim("/proc/sys/kernel/osrelease"),
        hostname: fs.hostname(),
        boot_id: read_trim("/proc/sys/kernel/random/boot_id"),
        pid_ns: std::fs::read_link("/proc/self/ns/pid").map(|p| p.display().to_string()).unwrap_or_default(),
        // SAFETY: getuid has no preconditions.
        uid: unsafe { libc::getuid() },
        clk_tck: procfs::clock_ticks(),
        cpus: thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
        host_memory: fs.mem_total().unwrap_or(0.0),
        limits: cgroup::own_limits(),
        runtime_agents: false,
    }
}

/// Read one line, refusing lines over the frame limit. `Ok(None)` at EOF.
fn read_frame(input: &mut impl BufRead) -> io::Result<Option<Result<String, usize>>> {
    let mut buf = Vec::new();
    let n = input.by_ref().take(MAX_FRAME as u64 + 1).read_until(b'\n', &mut buf)?;
    if n == 0 {
        return Ok(None);
    }
    if buf.len() > MAX_FRAME {
        // Skip the rest of the oversized line.
        let mut skipped = buf.len();
        while !buf.ends_with(b"\n") {
            buf.clear();
            if input.read_until(b'\n', &mut buf)? == 0 {
                break;
            }
            skipped += buf.len();
        }
        return Ok(Some(Err(skipped)));
    }
    Ok(Some(Ok(String::from_utf8_lossy(&buf).trim_end().to_string())))
}

struct Session {
    monitor: Shared,
    hub: Arc<Hub>,
    facts: Facts,
    frames: SyncSender<String>,
    /// Recent ticks by sequence, for `Resync`.
    recent: Mutex<VecDeque<(u64, String)>>,
    seq: AtomicU64,
    dropped: AtomicU64,
    stop_grace: Duration,
}

fn reply_line(id: u64, result: Result<Value, String>) -> String {
    let frame = match result {
        Ok(data) => ServerFrame::Reply { id, ok: true, data: Some(data), error: None },
        Err(e) => ServerFrame::Reply { id, ok: false, data: None, error: Some(e) },
    };
    serde_json::to_string(&frame).expect("frames always serialize")
}

fn to_value<T: serde::Serialize>(v: T) -> Result<Value, String> {
    serde_json::to_value(v).map_err(|e| e.to_string())
}

impl Session {
    /// Requests that can take a while (profiles, snapshots) run on their own thread
    /// so ticks and pings keep flowing.
    fn handle(self: &Arc<Self>, id: u64, request: Request) {
        if matches!(request, Request::Snapshot { .. } | Request::CpuProfile { .. } | Request::Gc { .. }) {
            let s = self.clone();
            thread::spawn(move || {
                let line = reply_line(id, s.answer(request));
                let _ = s.frames.send(line);
            });
        } else {
            let _ = self.frames.send(reply_line(id, self.answer(request)));
        }
    }

    /// A process record with what makes it uniquely that process on this target.
    fn identified(&self, proc: Proc) -> Value {
        let ticks = self.monitor.lock().unwrap().start_ticks(&proc.id).unwrap_or(0);
        let pid = proc.pid;
        json!({
            "proc": proc,
            "identity": ProcIdentity {
                boot_id: self.facts.boot_id.clone(),
                pid_ns: self.facts.pid_ns.clone(),
                pid,
                start_ticks: ticks,
                container_id: None,
                pod_uid: None,
            },
        })
    }

    fn answer(&self, request: Request) -> Result<Value, String> {
        match request {
            Request::Snapshot { id } => to_value(self.hub.take_snapshot(&id, Duration::from_secs(120))?),
            Request::Gc { id } => self.hub.force_gc(&id, Duration::from_secs(30)).map(|_| Value::Null),
            Request::CpuProfile { id, ms } => to_value(self.hub.cpu_profile(&id, ms.clamp(500, 60_000))?),
            Request::Hello { version } if version == VERSION => to_value(&self.facts),
            Request::Hello { version } => {
                Err(format!("protocol mismatch: desktop speaks {version}, this collector speaks {VERSION}"))
            }
            Request::Ping => Ok(json!({ "t": now_ms(), "wall": wall_ms() })),
            Request::ListProcesses { limit } => to_value(self.monitor.lock().unwrap().list_attachable(limit as usize)),
            Request::Attach { pid, expect } => {
                if let Some(want) = &expect {
                    if want.boot_id != self.facts.boot_id {
                        return Err("identity: the target has rebooted since this process was seen".into());
                    }
                    if want.pid_ns != self.facts.pid_ns {
                        return Err("identity: this is a different PID namespace".into());
                    }
                    let live = self.monitor.lock().unwrap().live_start_ticks(pid);
                    if live != Some(want.start_ticks) {
                        return Err(format!("identity: pid {pid} is gone or is now a different process"));
                    }
                }
                let proc = monitor::attach(&self.monitor, pid)?;
                Ok(self.identified(proc))
            }
            Request::Detach { id } => {
                let mut m = self.monitor.lock().unwrap();
                Ok(json!(m.forget(&id)))
            }
            Request::Launch { spec } => {
                let proc = monitor::launch_spec(&self.monitor, &spec)?;
                Ok(self.identified(proc))
            }
            Request::Stop { id } => monitor::stop(&self.monitor, &id, Duration::from_secs(3)).map(|_| Value::Null),
            Request::Signal { id, signal } => {
                let n = signal_number(&signal).ok_or_else(|| format!("signal {signal} is not allowed"))?;
                self.monitor.lock().unwrap().signal(&id, n).map(|_| Value::Null)
            }
            Request::Resync { since } => {
                let recent = self.recent.lock().unwrap();
                let oldest = recent.front().map(|(s, _)| *s);
                let complete = since + 1 >= oldest.unwrap_or(0);
                let ticks: Vec<Value> = recent
                    .iter()
                    .filter(|(s, _)| *s > since)
                    .filter_map(|(_, line)| serde_json::from_str(line).ok())
                    .collect();
                Ok(json!({ "complete": complete, "ticks": ticks, "dropped": self.dropped.load(Ordering::Relaxed) }))
            }
            Request::Shutdown => Ok(Value::Null),
        }
    }

    fn tick(&self) {
        let t = now_ms();
        let payload = {
            let mut m = self.monitor.lock().unwrap();
            let p = m.tick(t);
            m.take_writes(); // the desktop stores history
            p
        };
        let seq = self.seq.fetch_add(1, Ordering::Relaxed) + 1;
        let frame = ServerFrame::Tick(Tick { seq, t, wall: wall_ms(), procs: payload.procs, system: payload.system });
        let line = serde_json::to_string(&frame).expect("frames always serialize");
        {
            let mut recent = self.recent.lock().unwrap();
            recent.push_back((seq, line.clone()));
            if recent.len() > RESYNC_FRAMES {
                recent.pop_front();
            }
        }
        // A blocked transport must not stall sampling. The desktop sees the sequence
        // jump and asks for a resync; the buffer above is bounded.
        if let Err(TrySendError::Full(_)) = self.frames.try_send(line) {
            self.dropped.fetch_add(1, Ordering::Relaxed);
        }
    }

    /// Stop what this session launched. Attached processes are left alone.
    fn finish(&self) {
        self.monitor.lock().unwrap().shutdown();
        let deadline = Instant::now() + self.stop_grace;
        while Instant::now() < deadline {
            {
                let mut m = self.monitor.lock().unwrap();
                if !m.has_running_spawned() {
                    return;
                }
                m.tick(now_ms());
                m.take_writes();
            }
            thread::sleep(Duration::from_millis(50));
        }
        self.monitor.lock().unwrap().kill_spawned();
    }
}

/// Run one session until the input ends, the desktop goes quiet, or it says so.
pub fn serve<R, W>(input: R, mut output: W, opts: Options)
where
    R: BufRead + Send + 'static,
    W: Write + Send + 'static,
{
    let dir = opts.data_dir.clone().unwrap_or_else(hub::default_data_dir);
    let monitor = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
    let hub = match Hub::start(monitor.clone(), hub::random_hex(16), Arc::new(|_| {})) {
        Ok(h) => h,
        Err(e) => {
            let bye = ServerFrame::Bye { reason: format!("couldn't start the agent hub: {e}") };
            let _ = writeln!(output, "{}", serde_json::to_string(&bye).expect("frames always serialize"));
            return;
        }
    };
    let addr = hub.addr().to_string();
    // A read-only filesystem only costs runtime agents, and the facts say so.
    let env = hub::install_agents(&dir, &addr);
    let mut facts = facts();
    facts.runtime_agents = env.is_ok();
    monitor.lock().unwrap().agent_env = env.unwrap_or(AgentEnv { addr, ..Default::default() });

    let (frames, frames_rx) = mpsc::sync_channel::<String>(256);
    let writer = thread::spawn(move || {
        for line in frames_rx {
            if line.is_empty() {
                break; // End of session; lingering threads may still hold senders.
            }
            if writeln!(output, "{line}").and_then(|_| output.flush()).is_err() {
                break;
            }
        }
    });

    let session = Arc::new(Session {
        monitor,
        hub,
        facts,
        frames: frames.clone(),
        recent: Mutex::new(VecDeque::new()),
        seq: AtomicU64::new(0),
        dropped: AtomicU64::new(0),
        stop_grace: opts.stop_grace,
    });

    let (ended_tx, ended_rx) = mpsc::channel::<&'static str>();
    let last_input = Arc::new(Mutex::new(Instant::now()));
    {
        // On its own thread, because a blocked stdin can't be interrupted.
        let session = session.clone();
        let last_input = last_input.clone();
        let mut input = input;
        thread::spawn(move || {
            loop {
                match read_frame(&mut input) {
                    Ok(None) | Err(_) => break,
                    Ok(Some(Err(size))) => {
                        eprintln!("peak-collector: ignored a {size}-byte frame");
                    }
                    Ok(Some(Ok(line))) => {
                        *last_input.lock().unwrap() = Instant::now();
                        match serde_json::from_str::<ClientFrame>(&line) {
                            Ok(ClientFrame { req, request: Request::Shutdown }) => {
                                session.handle(req, Request::Shutdown);
                                let _ = ended_tx.send("shutdown requested");
                                return;
                            }
                            Ok(ClientFrame { req, request }) => session.handle(req, request),
                            Err(e) => eprintln!("peak-collector: ignored a bad frame: {e}"),
                        }
                    }
                }
            }
            let _ = ended_tx.send("input closed");
        });
    }

    let stop = Arc::new(AtomicBool::new(false));
    let ticker = {
        let session = session.clone();
        let stop = stop.clone();
        let every = opts.tick;
        thread::spawn(move || {
            while !stop.load(Ordering::Relaxed) {
                thread::sleep(every);
                session.tick();
            }
        })
    };

    let reason = loop {
        match ended_rx.recv_timeout(Duration::from_millis(100)) {
            Ok(reason) => break reason,
            Err(RecvTimeoutError::Disconnected) => break "input closed",
            Err(RecvTimeoutError::Timeout) => {
                if last_input.lock().unwrap().elapsed() > opts.idle_timeout {
                    break "no word from the desktop";
                }
            }
        }
    };
    stop.store(true, Ordering::Relaxed);
    let _ = ticker.join();
    session.finish();
    let bye = ServerFrame::Bye { reason: reason.to_string() };
    let _ = frames.send(serde_json::to_string(&bye).expect("frames always serialize"));
    let _ = frames.send(String::new());
    let _ = writer.join();
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::io::{BufReader, PipeReader, PipeWriter};
    use std::process::{Child, Command, Stdio};
    use std::sync::mpsc::Receiver;

    /// A collector session on real pipes, as the transports will see it.
    struct Peer {
        to: Option<PipeWriter>,
        frames: Receiver<ServerFrame>,
        raw: Arc<Mutex<Vec<String>>>,
        done: Receiver<()>,
        ticks: Vec<Tick>,
        next: u64,
        _dir: tempfile::TempDir,
    }

    fn start(tweak: impl FnOnce(&mut Options)) -> Peer {
        let dir = tempfile::tempdir().unwrap();
        let mut opts = Options {
            tick: Duration::from_millis(40),
            stop_grace: Duration::from_millis(500),
            data_dir: Some(dir.path().to_path_buf()),
            ..Default::default()
        };
        tweak(&mut opts);
        let (in_r, in_w): (PipeReader, PipeWriter) = io::pipe().unwrap();
        let (out_r, out_w) = io::pipe().unwrap();
        let (done_tx, done) = mpsc::channel();
        thread::spawn(move || {
            serve(BufReader::new(in_r), out_w, opts);
            let _ = done_tx.send(());
        });
        let (tx, frames) = mpsc::channel();
        let raw = Arc::new(Mutex::new(vec![]));
        let raw2 = raw.clone();
        thread::spawn(move || {
            for line in BufReader::new(out_r).lines().map_while(Result::ok) {
                raw2.lock().unwrap().push(line.clone());
                let frame: ServerFrame = serde_json::from_str(&line).expect("stdout carries only protocol frames");
                if tx.send(frame).is_err() {
                    return;
                }
            }
        });
        Peer { to: Some(in_w), frames, raw, done, ticks: vec![], next: 1, _dir: dir }
    }

    impl Peer {
        fn send(&mut self, request: Request) -> u64 {
            let id = self.next;
            self.next += 1;
            let line = serde_json::to_string(&ClientFrame { req: id, request }).unwrap();
            writeln!(self.to.as_mut().unwrap(), "{line}").unwrap();
            id
        }

        fn wait_reply(&mut self, want: u64) -> Result<Value, String> {
            loop {
                match self.frames.recv_timeout(Duration::from_secs(20)).expect("collector stayed silent") {
                    ServerFrame::Reply { id, ok, data, error } if id == want => {
                        return if ok { Ok(data.unwrap_or(Value::Null)) } else { Err(error.unwrap()) };
                    }
                    ServerFrame::Reply { .. } => {}
                    ServerFrame::Tick(t) => self.ticks.push(t),
                    ServerFrame::Bye { reason } => panic!("collector left: {reason}"),
                }
            }
        }

        fn call(&mut self, request: Request) -> Result<Value, String> {
            let id = self.send(request);
            self.wait_reply(id)
        }

        /// Read frames until a run's deltas satisfy `pred`.
        fn until(&mut self, id: &str, pred: impl Fn(&ProcDelta) -> bool) -> ProcDelta {
            for _ in 0..1000 {
                if let ServerFrame::Tick(t) = self.frames.recv_timeout(Duration::from_secs(20)).expect("no frames") {
                    let hit = t.procs.iter().find(|d| d.id == id && pred(d)).cloned();
                    self.ticks.push(t);
                    if let Some(d) = hit {
                        return d;
                    }
                }
            }
            panic!("condition never held for {id}");
        }

        /// The last frame explains why the session ended (the reader may lag a moment).
        fn said_goodbye(&self, why: &str) {
            let seen = (0..200).any(|_| {
                let hit = self.raw.lock().unwrap().last().is_some_and(|l| l.contains(why));
                if !hit {
                    thread::sleep(Duration::from_millis(10));
                }
                hit
            });
            assert!(seen, "{:?}", self.raw.lock().unwrap().last());
        }

        fn close(&mut self) {
            self.to = None;
            self.done.recv_timeout(Duration::from_secs(10)).expect("session should end");
        }
    }

    fn sleeper() -> Child {
        Command::new("sleep").arg("60").stdout(Stdio::null()).spawn().unwrap()
    }

    fn alive(c: &mut Child) -> bool {
        c.try_wait().unwrap().is_none()
    }

    fn attach(p: &mut Peer, pid: u32) -> (Proc, ProcIdentity) {
        let v = p.call(Request::Attach { pid, expect: None }).unwrap();
        (serde_json::from_value(v["proc"].clone()).unwrap(), serde_json::from_value(v["identity"].clone()).unwrap())
    }

    #[test]
    fn handshake_reports_target_facts_and_rejects_other_versions() {
        let mut p = start(|_| {});
        let facts: Facts = serde_json::from_value(p.call(Request::Hello { version: VERSION }).unwrap()).unwrap();
        assert_eq!(facts.protocol, VERSION);
        assert!(!facts.boot_id.is_empty() && !facts.pid_ns.is_empty());
        assert!(facts.clk_tck > 0 && facts.cpus > 0 && facts.host_memory > 0.0);
        assert!(facts.runtime_agents);
        assert!(p.call(Request::Hello { version: 999 }).unwrap_err().contains("protocol mismatch"));
        let pong = p.call(Request::Ping).unwrap();
        assert!(pong["t"].as_u64().unwrap() > 0 && pong["wall"].as_u64().unwrap() > 0);
        p.close();
    }

    #[test]
    fn lists_attaches_and_streams_real_samples_in_sequence() {
        let mut child = sleeper();
        let mut p = start(|_| {});
        let list: Vec<Attachable> =
            serde_json::from_value(p.call(Request::ListProcesses { limit: 500 }).unwrap()).unwrap();
        let me = list.iter().find(|a| a.pid == child.id()).expect("own-user process is listed");
        assert!(me.start_ticks > 0);

        let (proc, identity) = attach(&mut p, child.id());
        assert_eq!(identity.pid, child.id());
        assert_eq!(identity.start_ticks, me.start_ticks);
        let d = p.until(&proc.id, |d| d.samples.iter().any(|s| s.rss > 0.0));
        assert!(d.samples[0].t > 0);
        assert_eq!(d.status, Status::Running);
        let seqs: Vec<u64> = p.ticks.iter().map(|t| t.seq).collect();
        assert!(seqs.windows(2).all(|w| w[1] == w[0] + 1), "{seqs:?}");
        assert!(p.ticks.last().unwrap().system.is_some());

        // Detaching stops observation and never signals.
        assert_eq!(p.call(Request::Detach { id: proc.id.clone() }).unwrap(), json!(true));
        assert_eq!(p.call(Request::Detach { id: proc.id }).unwrap(), json!(false));
        assert!(alive(&mut child));
        p.close();
        assert!(alive(&mut child), "ending the session leaves attached processes alone");
        child.kill().unwrap();
        child.wait().unwrap();
    }

    #[test]
    fn a_reused_pid_cannot_inherit_an_identity() {
        let mut child = sleeper();
        let mut p = start(|_| {});
        let (_, identity) = attach(&mut p, child.id());
        let pid = child.id();
        // Same process: reattaching with its identity works.
        assert!(p.call(Request::Attach { pid, expect: Some(identity.clone()) }).is_ok());
        let cases = [
            (ProcIdentity { start_ticks: identity.start_ticks + 1, ..identity.clone() }, "different process"),
            (ProcIdentity { boot_id: "other".into(), ..identity.clone() }, "rebooted"),
            (ProcIdentity { pid_ns: "other".into(), ..identity.clone() }, "PID namespace"),
        ];
        for (want, why) in cases {
            let e = p.call(Request::Attach { pid, expect: Some(want) }).unwrap_err();
            assert!(e.contains(why), "{e}");
        }
        child.kill().unwrap();
        child.wait().unwrap();
        let e = p.call(Request::Attach { pid, expect: Some(identity) }).unwrap_err();
        assert!(e.contains("gone"), "{e}");
        assert!(p.call(Request::Attach { pid: 0, expect: None }).is_err());
        p.close();
    }

    #[test]
    fn launches_with_captured_output_and_exact_exit_status() {
        let mut p = start(|_| {});
        let spec =
            LaunchSpec { command: Some("echo out; echo err >&2; exit 3".into()), argv: None, cwd: "/tmp".into() };
        let v = p.call(Request::Launch { spec }).unwrap();
        let proc: Proc = serde_json::from_value(v["proc"].clone()).unwrap();
        let d = p.until(&proc.id, |d| d.status != Status::Running);
        assert_eq!((d.status, d.exit_code), (Status::Crashed, Some(3)));
        let logs: Vec<LogLine> = p
            .ticks
            .iter()
            .flat_map(|t| t.procs.iter())
            .filter(|d| d.id == proc.id)
            .flat_map(|d| d.logs.clone())
            .collect();
        assert!(logs.iter().any(|l| l.text == "out" && l.stream == Stream::Stdout), "{logs:?}");
        assert!(logs.iter().any(|l| l.text == "err" && l.stream == Stream::Stderr), "{logs:?}");

        // Direct argv: no shell involved, so shell syntax is passed through literally.
        let spec =
            LaunchSpec { command: None, argv: Some(vec!["/bin/echo".into(), "$HOME;x".into()]), cwd: "/tmp".into() };
        let v = p.call(Request::Launch { spec }).unwrap();
        let proc: Proc = serde_json::from_value(v["proc"].clone()).unwrap();
        p.until(&proc.id, |d| d.logs.iter().any(|l| l.text == "$HOME;x"));

        let empty = LaunchSpec { command: None, argv: Some(vec![]), cwd: String::new() };
        assert!(p.call(Request::Launch { spec: empty }).unwrap_err().contains("empty"));
        let missing = LaunchSpec { command: None, argv: Some(vec!["/no/such/binary".into()]), cwd: "/tmp".into() };
        assert!(p.call(Request::Launch { spec: missing }).is_err());
        p.close();
    }

    #[test]
    fn signals_are_routed_and_validated() {
        let mut p = start(|_| {});
        let spec = LaunchSpec { command: Some("sleep 60".into()), argv: None, cwd: "/tmp".into() };
        let v = p.call(Request::Launch { spec }).unwrap();
        let proc: Proc = serde_json::from_value(v["proc"].clone()).unwrap();
        let bad = p.call(Request::Signal { id: proc.id.clone(), signal: "USR1".into() }).unwrap_err();
        assert!(bad.contains("not allowed"));
        assert!(p.call(Request::Signal { id: "nope".into(), signal: "TERM".into() }).is_err());
        assert!(p.call(Request::Stop { id: "nope".into() }).is_err());
        p.call(Request::Signal { id: proc.id.clone(), signal: "TERM".into() }).unwrap();
        let d = p.until(&proc.id, |d| d.status != Status::Running);
        assert_eq!(d.status, Status::Exited, "a requested signal isn't a crash");
        assert!(p.call(Request::Signal { id: proc.id, signal: "TERM".into() }).is_err(), "it already ended");

        let spec = LaunchSpec { command: Some("sleep 60".into()), argv: None, cwd: "/tmp".into() };
        let v = p.call(Request::Launch { spec }).unwrap();
        let proc: Proc = serde_json::from_value(v["proc"].clone()).unwrap();
        p.call(Request::Stop { id: proc.id.clone() }).unwrap();
        p.until(&proc.id, |d| d.status == Status::Exited);
        p.close();
    }

    #[test]
    fn ending_the_session_stops_what_it_launched() {
        let mut p = start(|_| {});
        let spec = LaunchSpec { command: Some("trap '' TERM; sleep 60 & wait".into()), argv: None, cwd: "/tmp".into() };
        let v = p.call(Request::Launch { spec }).unwrap();
        let pid = v["proc"]["pid"].as_u64().unwrap() as i32;
        p.close();
        // SAFETY: kill with signal 0 only checks existence.
        let exists = || unsafe { libc::kill(pid, 0) == 0 };
        assert!(
            (0..100).any(|_| {
                thread::sleep(Duration::from_millis(50));
                !exists() || ProcFs::default().stat(pid as u32).is_none_or(|s| s.state == 'Z')
            }),
            "even a command ignoring SIGTERM is gone after the grace period"
        );
    }

    #[test]
    fn a_silent_desktop_ends_the_session() {
        let mut p = start(|o| o.idle_timeout = Duration::from_millis(300));
        // Stdin stays open, as it can on a dead SSH connection.
        assert!(p.done.recv_timeout(Duration::from_secs(10)).is_ok());
        p.said_goodbye("no word from the desktop");
        p.to = None;
    }

    #[test]
    fn shutdown_is_acknowledged() {
        let mut p = start(|_| {});
        assert_eq!(p.call(Request::Shutdown).unwrap(), Value::Null);
        assert!(p.done.recv_timeout(Duration::from_secs(10)).is_ok());
        p.said_goodbye("shutdown requested");
    }

    #[test]
    fn resync_replays_recent_ticks_without_gaps() {
        let mut p = start(|_| {});
        let child_pid = std::process::id();
        attach(&mut p, child_pid);
        while p.ticks.len() < 6 {
            if let ServerFrame::Tick(t) = p.frames.recv_timeout(Duration::from_secs(20)).unwrap() {
                p.ticks.push(t);
            }
        }
        let since = p.ticks[2].seq;
        let v = p.call(Request::Resync { since }).unwrap();
        assert_eq!(v["complete"], json!(true));
        let replayed: Vec<u64> = v["ticks"].as_array().unwrap().iter().map(|f| f["seq"].as_u64().unwrap()).collect();
        assert_eq!(replayed[0], since + 1);
        assert!(replayed.windows(2).all(|w| w[1] == w[0] + 1));
        p.close();
    }

    #[test]
    fn slow_requests_answer_honestly_without_an_agent() {
        let mut p = start(|_| {});
        let (proc, _) = attach(&mut p, std::process::id());
        for request in [
            Request::Snapshot { id: proc.id.clone() },
            Request::Gc { id: proc.id.clone() },
            Request::CpuProfile { id: proc.id.clone(), ms: 1000 },
        ] {
            assert!(p.call(request).unwrap_err().contains("no profiling agent"));
        }
        p.close();
    }

    #[test]
    fn runtime_agents_work_through_the_collector() {
        let mut p = start(|_| {});
        let spec = LaunchSpec {
            command: Some("node --no-use-osr -e 'function busyWork(){const e=Date.now()+50;while(Date.now()<e);} setInterval(busyWork,60)'".into()),
            argv: None,
            cwd: "/tmp".into(),
        };
        let v = p.call(Request::Launch { spec }).unwrap();
        let proc: Proc = serde_json::from_value(v["proc"].clone()).unwrap();
        p.until(&proc.id, |d| d.profiling);
        let d = p.until(&proc.id, |d| d.samples.iter().any(|s| s.loop_lag.is_some()));
        assert!(d.has_gc);
        let profile: CpuProfile =
            serde_json::from_value(p.call(Request::CpuProfile { id: proc.id.clone(), ms: 500 }).unwrap()).unwrap();
        assert_eq!(profile.sampling, "v8");
        let snap: HeapSnapshot =
            serde_json::from_value(p.call(Request::Snapshot { id: proc.id.clone() }).unwrap()).unwrap();
        assert!(!snap.entries.is_empty());
        assert_eq!(p.call(Request::Gc { id: proc.id }).unwrap(), Value::Null);
        p.close();
    }

    #[test]
    fn unusable_data_dir_only_costs_runtime_agents_and_bad_frames_are_ignored() {
        let file = tempfile::NamedTempFile::new().unwrap();
        let path = file.path().to_path_buf();
        let mut p = start(move |o| o.data_dir = Some(path));
        let facts: Facts = serde_json::from_value(p.call(Request::Hello { version: VERSION }).unwrap()).unwrap();
        assert!(!facts.runtime_agents, "says so instead of claiming heap support");
        writeln!(p.to.as_mut().unwrap(), "not json").unwrap();
        assert!(p.call(Request::Ping).is_ok(), "survives a bad frame");
        p.close();
    }

    #[test]
    fn a_blocked_transport_never_stalls_sampling_and_the_buffer_stays_bounded() {
        let empty = tempfile::tempdir().unwrap();
        let monitor = Monitor::new(ProcFs::new(empty.path(), "/nope"), AgentEnv::default()).shared();
        let hub = Hub::start(monitor.clone(), "s".into(), Arc::new(|_| {})).unwrap();
        let (frames, _rx) = mpsc::sync_channel(4); // and nobody is reading
        let session = Session {
            monitor,
            hub,
            facts: facts(),
            frames,
            recent: Mutex::new(VecDeque::new()),
            seq: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            stop_grace: Duration::ZERO,
        };
        for _ in 0..RESYNC_FRAMES + 10 {
            session.tick();
        }
        assert_eq!(session.dropped.load(Ordering::Relaxed), (RESYNC_FRAMES + 6) as u64);
        assert_eq!(session.recent.lock().unwrap().len(), RESYNC_FRAMES);
        // What aged out of the buffer is reported as an incomplete replay.
        let old = session.answer(Request::Resync { since: 1 }).unwrap();
        assert_eq!(old["complete"], json!(false));
        let tail = session.answer(Request::Resync { since: (RESYNC_FRAMES + 8) as u64 }).unwrap();
        assert_eq!((tail["complete"].as_bool(), tail["ticks"].as_array().unwrap().len()), (Some(true), 2));
    }

    #[test]
    fn serve_skips_an_oversized_frame_and_carries_on() {
        let mut p = start(|_| {});
        let huge = format!("{}\n", "x".repeat(MAX_FRAME + 1));
        let mut w = p.to.take().unwrap();
        let writer = thread::spawn(move || {
            w.write_all(huge.as_bytes()).unwrap();
            w
        });
        // The reader has to drain it for the write to finish.
        p.to = Some(writer.join().unwrap());
        assert!(p.call(Request::Ping).is_ok());
        p.close();
    }

    #[test]
    fn oversized_frames_are_refused_not_buffered() {
        let big = format!("{}\nnext\n", "x".repeat(MAX_FRAME + 10));
        let mut r = BufReader::new(big.as_bytes());
        assert_eq!(read_frame(&mut r).unwrap(), Some(Err(MAX_FRAME + 11)));
        assert_eq!(read_frame(&mut r).unwrap(), Some(Ok("next".to_string())));
        assert_eq!(read_frame(&mut r).unwrap(), None);
        let unterminated = "y".repeat(MAX_FRAME + 10);
        let mut r = BufReader::new(unterminated.as_bytes());
        assert_eq!(read_frame(&mut r).unwrap(), Some(Err(MAX_FRAME + 10)));
    }
}
