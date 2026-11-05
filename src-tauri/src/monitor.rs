//! Core state: every tracked process, its history, and the per-tick deltas
//! sent to the UI. Independent of Tauri so it can be tested directly.

use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use crate::model::*;
use crate::procfs::{self, ProcFs};
use crate::runner::{self, ExitInfo};
use crate::sampler::{AgentHeap, SystemSampler, TreeSampler};

pub type Shared = Arc<Mutex<Monitor>>;

pub fn now_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Origin {
    /// Started by peak; we own the process group and its output.
    Spawned,
    /// An existing process we only observe.
    Attached,
    /// Started by `peak run` in a terminal; output arrives over the hub.
    External,
}

/// Where runtime agents live and how to reach the hub.
#[derive(Debug, Clone, Default)]
pub struct AgentEnv {
    pub addr: String,
    pub node_agent: Option<PathBuf>,
    pub python_dir: Option<PathBuf>,
}

impl AgentEnv {
    /// Environment that makes Node and Python load the peak agent.
    pub fn vars(&self, token: &str, node_options: Option<&str>, python_path: Option<&str>) -> Vec<(String, String)> {
        if self.addr.is_empty() {
            return vec![];
        }
        let mut env =
            vec![("PEAK_AGENT_ADDR".into(), self.addr.clone()), ("PEAK_AGENT_TOKEN".into(), token.to_string())];
        if let Some(p) = &self.node_agent {
            let req = format!("--require \"{}\"", p.display());
            env.push((
                "NODE_OPTIONS".into(),
                match node_options {
                    Some(o) if !o.is_empty() => format!("{o} {req}"),
                    _ => req,
                },
            ));
        }
        if let Some(p) = &self.python_dir {
            let dir = p.display().to_string();
            env.push((
                "PYTHONPATH".into(),
                match python_path {
                    Some(o) if !o.is_empty() => format!("{dir}:{o}"),
                    _ => dir,
                },
            ));
        }
        env
    }
}

#[derive(Debug, Default)]
struct AgentState {
    heap: Option<AgentHeap>,
    lag: Option<f64>,
}

#[derive(Debug)]
struct Tracked {
    proc: Proc,
    origin: Origin,
    sampler: TreeSampler,
    stop_requested: bool,
    root_start: Option<u64>,
    new_samples: Vec<Sample>,
    new_logs: Vec<LogLine>,
    new_gc: Vec<GcEvent>,
    dirty: bool,
    agents: HashMap<u32, AgentState>,
    gc_freed: f64,
    cpu_sum: f64,
}

/// Everything new about one run since the last tick, for the database.
#[derive(Debug, Clone, PartialEq)]
pub struct RunWrite {
    /// The run without its (large) history arrays.
    pub meta: Proc,
    pub avg_cpu: f64,
    pub samples: Vec<Sample>,
    pub logs: Vec<LogLine>,
    pub gc: Vec<GcEvent>,
}

/// A copy of `p` without samples/logs/gc/snapshots/profiles, without cloning them.
pub fn meta_of(p: &mut Proc) -> Proc {
    let samples = std::mem::take(&mut p.samples);
    let logs = std::mem::take(&mut p.logs);
    let gc = std::mem::take(&mut p.gc);
    let snapshots = std::mem::take(&mut p.snapshots);
    let profiles = std::mem::take(&mut p.cpu_profiles);
    let meta = p.clone();
    p.samples = samples;
    p.logs = logs;
    p.gc = gc;
    p.snapshots = snapshots;
    p.cpu_profiles = profiles;
    meta
}

impl Tracked {
    fn new(proc: Proc, origin: Origin, clk_tck: u64, root_start: Option<u64>) -> Tracked {
        Tracked {
            proc,
            origin,
            sampler: TreeSampler::new(clk_tck),
            stop_requested: false,
            root_start,
            new_samples: vec![],
            new_logs: vec![],
            new_gc: vec![],
            dirty: false,
            agents: HashMap::new(),
            gc_freed: 0.0,
            cpu_sum: 0.0,
        }
    }

    fn write_for(&mut self, d: &ProcDelta) -> RunWrite {
        let n = self.proc.samples.len().max(1) as f64;
        RunWrite {
            meta: meta_of(&mut self.proc),
            avg_cpu: self.cpu_sum / n,
            samples: d.samples.clone(),
            logs: d.logs.clone(),
            gc: d.gc.clone(),
        }
    }

    fn delta(&mut self) -> ProcDelta {
        self.dirty = false;
        let p = &self.proc;
        ProcDelta {
            id: p.id.clone(),
            samples: std::mem::take(&mut self.new_samples),
            logs: std::mem::take(&mut self.new_logs),
            gc: std::mem::take(&mut self.new_gc),
            status: p.status,
            ended_at: p.ended_at,
            exit_code: p.exit_code,
            signal: p.signal.clone(),
            runtime: p.runtime,
            exe: p.exe.clone(),
            ppid: p.ppid,
            nice: p.nice,
            threads: p.threads,
            vsz: p.vsz,
            swap: p.swap,
            fds: p.fds,
            counters: p.counters.clone(),
            peak: p.peak.clone(),
            children: p.children.clone(),
            child_names: p.child_names.clone(),
            ports: p.ports.clone(),
            has_gc: p.has_gc,
            profiling: p.profiling,
        }
    }

    fn has_news(&self) -> bool {
        self.dirty || !self.new_samples.is_empty() || !self.new_logs.is_empty() || !self.new_gc.is_empty()
    }

    /// The agent with the largest heap is the one doing the real work
    /// (`npm run dev` → the server process, not npm itself).
    fn primary_agent(&self) -> Option<u32> {
        self.agents
            .iter()
            .max_by(|a, b| {
                let h = |s: &AgentState| s.heap.map(|h| h.heap_total).unwrap_or(0.0);
                h(a.1).total_cmp(&h(b.1)).then(b.0.cmp(a.0))
            })
            .map(|(pid, _)| *pid)
    }
}

pub struct Monitor {
    procs: Vec<Tracked>,
    fs: ProcFs,
    clk_tck: u64,
    boot: u64,
    next_id: u64,
    next_log: u64,
    pub agent_env: AgentEnv,
    home: Option<String>,
    self_pid: u32,
    self_uid: u32,
    system: SystemSampler,
    writes: Vec<RunWrite>,
}

impl Monitor {
    pub fn new(fs: ProcFs, agent_env: AgentEnv) -> Self {
        let boot = fs.boot_time().unwrap_or(0);
        Monitor {
            procs: vec![],
            fs,
            clk_tck: procfs::clock_ticks(),
            boot,
            next_id: 1,
            next_log: 1,
            agent_env,
            home: std::env::var("HOME").ok(),
            self_pid: std::process::id(),
            // SAFETY: getuid has no preconditions.
            self_uid: unsafe { libc::getuid() },
            system: SystemSampler::default(),
            writes: vec![],
        }
    }

    pub fn shared(self) -> Shared {
        Arc::new(Mutex::new(self))
    }

    pub fn system_info(&self) -> SystemInfo {
        SystemInfo {
            total_memory: self.fs.mem_total().unwrap_or(0.0),
            cpus: thread::available_parallelism().map(|n| n.get() as u32).unwrap_or(1),
            hostname: self.fs.hostname(),
            os: std::env::consts::OS.to_string(),
        }
    }

    pub fn full_state(&self) -> FullState {
        FullState { procs: self.procs.iter().map(|t| t.proc.clone()).collect(), system: self.system_info() }
    }

    pub fn get(&self, id: &str) -> Option<&Proc> {
        self.procs.iter().find(|t| t.proc.id == id).map(|t| &t.proc)
    }

    fn tracked(&mut self, id: &str) -> Option<&mut Tracked> {
        self.procs.iter_mut().find(|t| t.proc.id == id)
    }

    pub fn set_origin(&mut self, id: &str, origin: Origin) {
        if let Some(tr) = self.tracked(id) {
            tr.origin = origin;
        }
    }

    pub fn origin(&self, id: &str) -> Option<Origin> {
        self.procs.iter().find(|t| t.proc.id == id).map(|t| t.origin)
    }

    fn start_time_ms(&self, starttime_ticks: u64) -> u64 {
        self.boot * 1000 + starttime_ticks * 1000 / self.clk_tck.max(1)
    }

    pub fn new_id(&mut self) -> String {
        self.next_id += 1;
        format!("p_{:x}_{:x}", now_ms(), self.next_id)
    }

    /// Start tracking a process. Returns the full record.
    pub fn insert(&mut self, id: String, origin: Origin, pid: u32, command: &str, cwd: &str, t: u64) -> Proc {
        let stat = self.fs.stat(pid);
        let uid = self.fs.status(pid).map(|s| s.uid).unwrap_or(self.self_uid);
        let started_at = match (&stat, origin) {
            (Some(s), Origin::Attached) => self.start_time_ms(s.starttime),
            _ => t,
        };
        let runtime = Runtime::infer(command);
        let proc = Proc {
            id,
            pid,
            ppid: stat.as_ref().map(|s| s.ppid).unwrap_or(0),
            user: self.fs.user(uid),
            exe: self.fs.exe(pid).unwrap_or_default(),
            command: command.to_string(),
            cwd: cwd.to_string(),
            runtime,
            status: Status::Running,
            started_at,
            ended_at: None,
            exit_code: None,
            signal: None,
            nice: stat.as_ref().map(|s| s.nice).unwrap_or(0),
            threads: stat.as_ref().map(|s| s.threads).unwrap_or(1),
            vsz: 0.0,
            swap: 0.0,
            fds: Fds::default(),
            counters: Counters::default(),
            samples: vec![],
            peak: Sample { t, ..Default::default() },
            gc: vec![],
            has_gc: false,
            profiling: false,
            snapshots: vec![],
            logs: vec![],
            children: vec![],
            child_names: Default::default(),
            ports: vec![],
            cpu_profiles: vec![],
        };
        self.procs.insert(0, Tracked::new(proc, origin, self.clk_tck, stat.map(|s| s.starttime)));
        // Take a first sample right away — the UI always expects one.
        let fs = self.fs.clone();
        let tr = &mut self.procs[0];
        match fs.read(pid) {
            Some(root) => sample_tree(tr, &fs, &fs.parents(), &fs.listeners(), root, t),
            None => push_bounded(&mut tr.proc.samples, Sample { t, ..Default::default() }, MAX_SAMPLES),
        }
        // The first sample stays queued so it is persisted; the UI skips duplicates by timestamp.
        tr.proc.clone()
    }

    pub fn push_log(&mut self, id: &str, stream: Stream, text: String, t: u64) {
        let lid = self.next_log;
        self.next_log += 1;
        if let Some(tr) = self.tracked(id) {
            let line = LogLine { id: lid, t, stream, text };
            push_bounded(&mut tr.proc.logs, line.clone(), MAX_LOGS);
            push_bounded(&mut tr.new_logs, line, MAX_LOGS);
        }
    }

    pub fn on_exit(&mut self, id: &str, info: ExitInfo, t: u64) {
        if let Some(tr) = self.tracked(id) {
            if tr.proc.status != Status::Running {
                return;
            }
            let (status, code, signal) = runner::classify_exit(info, tr.stop_requested);
            let p = &mut tr.proc;
            p.status = status;
            p.exit_code = code;
            p.signal = signal;
            p.ended_at = Some(t);
            p.children.clear();
            tr.dirty = true;
        }
    }

    /// Sample every running process once. Returns deltas for processes that
    /// changed since the previous tick.
    pub fn tick(&mut self, t: u64) -> TickPayload {
        let parents = self.fs.parents();
        let fs = self.fs.clone();
        let listeners = fs.listeners();
        let mut out = vec![];
        for tr in &mut self.procs {
            if tr.proc.status == Status::Running {
                let root = fs
                    .read(tr.proc.pid)
                    .filter(|r| tr.root_start.is_none_or(|s| s == r.stat.starttime) && r.stat.state != 'Z');
                match root {
                    None if tr.origin == Origin::Attached => {
                        tr.proc.status = Status::Exited;
                        tr.proc.ended_at = Some(t);
                        tr.proc.children.clear();
                        tr.dirty = true;
                    }
                    None => {} // the waiter (or `peak run`) will report the exit
                    Some(root) => sample_tree(tr, &fs, &parents, &listeners, root, t),
                }
            }
            if tr.has_news() {
                let d = tr.delta();
                self.writes.push(tr.write_for(&d));
                out.push(d);
            }
        }
        TickPayload { procs: out, system: Some(self.system.sample(t, &fs)) }
    }

    /// Pending database writes accumulated by `tick`.
    pub fn take_writes(&mut self) -> Vec<RunWrite> {
        std::mem::take(&mut self.writes)
    }

    /// Bring a stored run back into the session (read-only until restarted).
    pub fn insert_historical(&mut self, mut proc: Proc) -> Proc {
        if let Some(p) = self.get(&proc.id) {
            return p.clone();
        }
        if proc.status == Status::Running {
            proc.status = Status::Exited;
        }
        self.procs.insert(0, Tracked::new(proc.clone(), Origin::Attached, self.clk_tck, None));
        proc
    }

    pub fn add_cpu_profile(&mut self, id: &str, profile: CpuProfile) {
        if let Some(tr) = self.tracked(id) {
            tr.proc.cpu_profiles.push(profile);
        }
    }

    /// Ask a process to stop. Returns the pid to escalate on if it lingers.
    pub fn request_stop(&mut self, id: &str) -> Result<u32, String> {
        let tr = self.tracked(id).ok_or("unknown process")?;
        if tr.proc.status != Status::Running {
            return Err("process is not running".into());
        }
        tr.stop_requested = true;
        let pid = tr.proc.pid;
        let ok = match tr.origin {
            Origin::Spawned => runner::signal_group(pid, libc::SIGINT),
            Origin::Attached | Origin::External => runner::signal_pid(pid, libc::SIGTERM),
        };
        if ok { Ok(pid) } else { Err(format!("could not signal pid {pid}")) }
    }

    /// Terminate every process peak spawned (called when the app quits).
    pub fn shutdown(&mut self) -> usize {
        let mut n = 0;
        for tr in self.procs.iter_mut().filter(|t| t.origin == Origin::Spawned && t.proc.status == Status::Running) {
            tr.stop_requested = true;
            if runner::signal_group(tr.proc.pid, libc::SIGTERM) {
                n += 1;
            }
        }
        n
    }

    pub fn remove(&mut self, id: &str) -> bool {
        let before = self.procs.len();
        self.procs.retain(|t| t.proc.id != id || t.proc.status == Status::Running);
        before != self.procs.len()
    }

    pub fn clear_ended(&mut self) -> usize {
        let before = self.procs.len();
        self.procs.retain(|t| t.proc.status == Status::Running);
        before - self.procs.len()
    }

    /// Up to `limit` processes owned by the current user, largest first.
    pub fn list_attachable(&self, limit: usize) -> Vec<Attachable> {
        let tracked: Vec<u32> =
            self.procs.iter().filter(|t| t.proc.status == Status::Running).map(|t| t.proc.pid).collect();
        let mut out: Vec<Attachable> = self
            .fs
            .pids()
            .into_iter()
            .filter(|pid| *pid != self.self_pid && !tracked.contains(pid))
            .filter_map(|pid| {
                let status = self.fs.status(pid)?;
                if status.uid != self.self_uid || status.rss <= 0.0 {
                    return None;
                }
                let cmd = self.fs.cmdline(pid);
                if cmd.is_empty() {
                    return None;
                }
                Some(Attachable {
                    pid,
                    command: cmd.join(" "),
                    cwd: self.fs.cwd(pid).unwrap_or_default(),
                    rss: status.rss,
                })
            })
            .collect();
        out.sort_by(|a, b| b.rss.total_cmp(&a.rss));
        out.truncate(limit);
        out
    }

    pub fn cwd_path(&self, cwd: &str) -> PathBuf {
        runner::expand_tilde(cwd, self.home.as_deref())
    }

    pub fn add_snapshot(&mut self, id: &str, snap: HeapSnapshot) {
        if let Some(tr) = self.tracked(id) {
            tr.proc.snapshots.push(snap);
        }
    }

    // ─── agent hooks ───

    /// An agent connected. Returns false for unknown tokens.
    pub fn agent_hello(&mut self, token: &str, pid: u32, runtime: Runtime) -> bool {
        let Some(tr) = self.tracked(token) else { return false };
        tr.agents.entry(pid).or_default();
        tr.proc.profiling = true;
        tr.proc.has_gc = true;
        if tr.proc.runtime == Runtime::Shell || tr.agents.len() == 1 {
            tr.proc.runtime = runtime;
        }
        tr.dirty = true;
        true
    }

    pub fn agent_heap(&mut self, token: &str, pid: u32, heap: AgentHeap) {
        if let Some(tr) = self.tracked(token) {
            tr.agents.entry(pid).or_default().heap = Some(heap);
        }
    }

    pub fn agent_lag(&mut self, token: &str, pid: u32, lag: f64) {
        if let Some(tr) = self.tracked(token) {
            tr.agents.entry(pid).or_default().lag = Some(lag);
        }
    }

    pub fn agent_gc(&mut self, token: &str, ev: GcEvent) {
        if let Some(tr) = self.tracked(token) {
            tr.gc_freed += ev.freed;
            push_bounded(&mut tr.proc.gc, ev.clone(), MAX_GC);
            push_bounded(&mut tr.new_gc, ev, MAX_GC);
        }
    }

    pub fn agent_bye(&mut self, token: &str, pid: u32) {
        if let Some(tr) = self.tracked(token) {
            tr.agents.remove(&pid);
            if tr.agents.is_empty() {
                tr.proc.profiling = false;
                tr.dirty = true;
            }
        }
    }

    pub fn primary_agent(&self, id: &str) -> Option<u32> {
        self.procs.iter().find(|t| t.proc.id == id)?.primary_agent()
    }
}

/// Read the rest of the tree under `root` and record one sample.
fn sample_tree(
    tr: &mut Tracked,
    fs: &ProcFs,
    parents: &HashMap<u32, u32>,
    listeners: &HashMap<u64, procfs::Listener>,
    root: procfs::RawProc,
    t: u64,
) {
    let mut tree = vec![root];
    tree.extend(procfs::descendants(parents, tr.proc.pid).into_iter().filter_map(|pid| fs.read(pid)));
    let mut ports: Vec<Port> = tree
        .iter()
        .flat_map(|r| {
            r.socket_inodes.iter().filter_map(|i| listeners.get(i)).map(|l| Port {
                port: l.port,
                proto: l.proto.to_string(),
                addr: l.addr.clone(),
                pid: r.stat.pid,
            })
        })
        .collect();
    ports.sort_by(|a, b| (a.port, &a.proto).cmp(&(b.port, &b.proto)));
    ports.dedup_by(|a, b| a.port == b.port && a.proto == b.proto);
    let agent = tr.primary_agent().and_then(|pid| tr.agents.get(&pid));
    let heap = agent.and_then(|a| a.heap);
    let lag = agent.and_then(|a| a.lag.or(a.heap.and_then(|h| h.loop_lag)));
    let freed = std::mem::take(&mut tr.gc_freed);
    let mut ts = tr.sampler.sample(t, &tree, heap, freed);
    ts.sample.loop_lag = lag;
    let p = &mut tr.proc;
    if ts.sample.rss >= p.peak.rss {
        p.peak = ts.sample.clone();
    }
    p.threads = ts.threads;
    p.vsz = ts.vsz;
    p.swap = ts.swap;
    p.fds = ts.fds;
    p.nice = ts.nice;
    p.ppid = ts.ppid;
    for c in &ts.children {
        p.child_names.entry(c.pid).or_insert_with(|| c.name.clone());
    }
    p.children = ts.children;
    p.ports = ports;
    tr.cpu_sum += ts.sample.cpu;
    p.counters = tr.sampler.counters.clone();
    if let Some(exe) = fs.exe(p.pid).filter(|e| *e != p.exe) {
        p.exe = exe;
    }
    push_bounded(&mut p.samples, ts.sample.clone(), MAX_SAMPLES);
    push_bounded(&mut tr.new_samples, ts.sample, MAX_SAMPLES);
}

// ─── operations that spawn threads (need the shared handle) ─────────────────

/// Run `command` under peak.
pub fn capture(shared: &Shared, command: &str, cwd: &str) -> Result<Proc, String> {
    let command = command.trim();
    if command.is_empty() {
        return Err("command is empty".into());
    }
    let (id, dir, env) = {
        let mut m = shared.lock().unwrap();
        let id = m.new_id();
        let env = m.agent_env.vars(
            &id,
            std::env::var("NODE_OPTIONS").ok().as_deref(),
            std::env::var("PYTHONPATH").ok().as_deref(),
        );
        (id, m.cwd_path(cwd), env)
    };
    let s1 = shared.clone();
    let s2 = shared.clone();
    let (id1, id2) = (id.clone(), id.clone());
    // Hold the lock across spawn so the first output line can't beat `insert`.
    let mut m = shared.lock().unwrap();
    let pid = runner::spawn(
        command,
        &dir,
        &env,
        move |stream, text| s1.lock().unwrap().push_log(&id1, stream, text, now_ms()),
        move |info| s2.lock().unwrap().on_exit(&id2, info, now_ms()),
    )
    .map_err(|e| format!("failed to start in {}: {e}", dir.display()))?;
    let display_cwd = dir.display().to_string();
    let mut proc = m.insert(id.clone(), Origin::Spawned, pid, command, &display_cwd, now_ms());
    let t = proc.started_at;
    m.push_log(&id, Stream::Stdout, format!("$ {command}"), t);
    proc.logs = m.get(&id).map(|p| p.logs.clone()).unwrap_or_default();
    Ok(proc)
}

/// Observe an existing process.
pub fn attach(shared: &Shared, pid: u32) -> Result<Proc, String> {
    let mut m = shared.lock().unwrap();
    if m.fs.stat(pid).is_none() {
        return Err(format!("no process with pid {pid}"));
    }
    let cmd = m.fs.cmdline(pid).join(" ");
    let cmd = if cmd.is_empty() { m.fs.stat(pid).map(|s| s.comm).unwrap_or_default() } else { cmd };
    let cwd = m.fs.cwd(pid).unwrap_or_default();
    let id = m.new_id();
    Ok(m.insert(id, Origin::Attached, pid, &cmd, &cwd, now_ms()))
}

/// Run the same command again in place of an ended (or running) process.
pub fn restart(shared: &Shared, id: &str) -> Result<Proc, String> {
    let (command, cwd, running) = {
        let m = shared.lock().unwrap();
        let p = m.get(id).ok_or("unknown process")?;
        (p.command.clone(), p.cwd.clone(), p.status == Status::Running)
    };
    if running {
        stop(shared, id, Duration::from_secs(3))?;
        for _ in 0..100 {
            if shared.lock().unwrap().get(id).is_none_or(|p| p.status != Status::Running) {
                break;
            }
            thread::sleep(Duration::from_millis(30));
        }
    }
    let proc = capture(shared, &command, &cwd)?;
    let mut m = shared.lock().unwrap();
    // Take the old entry's place in the list: the new one sits at 0, so swap it
    // into the old slot and drop the old entry (a no-op if it was removed).
    let old = m.procs.iter().position(|t| t.proc.id == id).unwrap_or(0);
    m.procs.swap(0, old);
    m.procs.retain(|t| t.proc.id != id);
    Ok(proc)
}

/// Stop a process, escalating to SIGKILL after `grace`.
pub fn stop(shared: &Shared, id: &str, grace: Duration) -> Result<(), String> {
    let (pid, origin) = {
        let mut m = shared.lock().unwrap();
        let pid = m.request_stop(id)?;
        (pid, m.origin(id).unwrap_or(Origin::Attached))
    };
    let s = shared.clone();
    let id = id.to_string();
    thread::spawn(move || {
        thread::sleep(grace);
        let still = s.lock().unwrap().get(&id).is_some_and(|p| p.status == Status::Running);
        if still {
            if origin == Origin::Spawned {
                runner::signal_group(pid, libc::SIGKILL);
            } else {
                runner::signal_pid(pid, libc::SIGKILL);
            }
        }
    });
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::process::{Command, Stdio};

    fn monitor() -> Shared {
        Monitor::new(ProcFs::default(), AgentEnv::default()).shared()
    }

    fn wait_for(shared: &Shared, id: &str, f: impl Fn(&Proc) -> bool) -> Proc {
        let found = (0..400).find_map(|_| {
            let p = {
                let mut m = shared.lock().unwrap();
                m.tick(now_ms());
                m.get(id).filter(|p| f(p)).cloned()
            };
            if p.is_none() {
                thread::sleep(Duration::from_millis(25));
            }
            p
        });
        assert!(found.is_some(), "condition not met for {id}");
        found.unwrap()
    }

    #[test]
    fn agent_env_vars() {
        assert!(AgentEnv::default().vars("t", None, None).is_empty());
        let env = AgentEnv {
            addr: "127.0.0.1:9".into(),
            node_agent: Some("/a/agent.cjs".into()),
            python_dir: Some("/a/py".into()),
        };
        let v: HashMap<_, _> = env.vars("tok", Some("--max-old-space-size=4096"), Some("/x")).into_iter().collect();
        assert_eq!(v["PEAK_AGENT_ADDR"], "127.0.0.1:9");
        assert_eq!(v["PEAK_AGENT_TOKEN"], "tok");
        assert_eq!(v["NODE_OPTIONS"], "--max-old-space-size=4096 --require \"/a/agent.cjs\"");
        assert_eq!(v["PYTHONPATH"], "/a/py:/x");
        let v: HashMap<_, _> = env.vars("tok", Some(""), None).into_iter().collect();
        assert_eq!(v["NODE_OPTIONS"], "--require \"/a/agent.cjs\"");
        assert_eq!(v["PYTHONPATH"], "/a/py");
    }

    #[test]
    fn captures_output_and_exit() {
        let m = monitor();
        let p = capture(&m, "echo hello; echo oops >&2; exit 3", "/tmp").unwrap();
        assert_eq!(p.status, Status::Running);
        assert_eq!(p.logs[0].text, "$ echo hello; echo oops >&2; exit 3");
        let done = wait_for(&m, &p.id, |p| p.status != Status::Running);
        assert_eq!(done.status, Status::Crashed);
        assert_eq!(done.exit_code, Some(3));
        assert!(done.ended_at.is_some());
        let texts: Vec<_> = done.logs.iter().map(|l| (l.stream, l.text.as_str())).collect();
        assert!(texts.contains(&(Stream::Stdout, "hello")));
        assert!(texts.contains(&(Stream::Stderr, "oops")));
        // The transition is reported once, then nothing more.
        let mut g = m.lock().unwrap();
        g.tick(now_ms());
        assert!(g.tick(now_ms()).procs.is_empty());
    }

    #[test]
    fn samples_a_running_tree() {
        let m = monitor();
        let p = capture(&m, "sleep 5 & sleep 5; wait", "/tmp").unwrap();
        thread::sleep(Duration::from_millis(150));
        let mut deltas = m.lock().unwrap().tick(now_ms()).procs;
        thread::sleep(Duration::from_millis(100));
        deltas.extend(m.lock().unwrap().tick(now_ms()).procs);
        let d = deltas.iter().find(|d| d.id == p.id).unwrap();
        assert_eq!(d.status, Status::Running);
        let proc = m.lock().unwrap().get(&p.id).unwrap().clone();
        assert!(proc.samples.len() >= 2);
        assert!(proc.samples.last().unwrap().rss > 0.0);
        assert!(proc.children.len() >= 2, "{:?}", proc.children);
        assert!(proc.peak.rss > 0.0);
        assert!(!proc.exe.is_empty());
        stop(&m, &p.id, Duration::from_millis(200)).unwrap();
        let done = wait_for(&m, &p.id, |p| p.status != Status::Running);
        assert_eq!(done.status, Status::Exited, "{done:?}");
        assert!(stop(&m, &p.id, Duration::ZERO).is_err());
        assert!(stop(&m, "nope", Duration::ZERO).is_err());
    }

    #[test]
    fn finds_listening_ports_and_child_names() {
        let m = monitor();
        let script = "import socket,time; s=socket.socket(); s.bind(('127.0.0.1',0)); s.listen(); print(s.getsockname()[1], flush=True); time.sleep(30)";
        let p = capture(&m, &format!("python3 -c \"{script}\" & wait"), "/tmp").unwrap();
        let port: u16 = (0..200)
            .find_map(|_| {
                thread::sleep(Duration::from_millis(20));
                let g = m.lock().unwrap();
                g.get(&p.id).unwrap().logs.iter().find_map(|l| l.text.parse::<u16>().ok())
            })
            .expect("server printed its port");
        let proc = wait_for(&m, &p.id, |p| p.ports.iter().any(|x| x.port == port));
        let found = proc.ports.iter().find(|x| x.port == port).unwrap();
        assert_eq!((found.proto.as_str(), found.addr.as_str()), ("tcp", "127.0.0.1"));
        assert!(proc.child_names.values().any(|n| n.starts_with("python")), "{:?}", proc.child_names);
        assert!(proc.samples.last().unwrap().kids.iter().any(|k| k.rss > 0.0));
        stop(&m, &p.id, Duration::from_millis(200)).unwrap();
        wait_for(&m, &p.id, |p| p.status != Status::Running);
    }

    #[test]
    fn restores_historical_runs_and_profiles() {
        let m = monitor();
        let mut g = m.lock().unwrap();
        let id = g.new_id();
        let mut p = g.insert(id.clone(), Origin::External, 999_999, "old run", "/tmp", 5);
        g.on_exit(&id, ExitInfo { code: Some(0), signal: None }, 6);
        g.remove(&id);
        p.status = Status::Running; // e.g. stored while peak crashed
        let restored = g.insert_historical(p.clone());
        assert_eq!(restored.status, Status::Exited);
        assert_eq!(g.insert_historical(p).id, id, "inserting twice keeps the existing entry");
        let root = AllocFrame { name: "(root)".into(), file: None, self_bytes: 1.0, children: vec![] };
        g.add_cpu_profile(&id, CpuProfile { id: "c".into(), t: 1, duration_ms: 10.0, root: root.clone() });
        g.add_cpu_profile("nope", CpuProfile { id: "c".into(), t: 1, duration_ms: 10.0, root });
        assert_eq!(g.get(&id).unwrap().cpu_profiles.len(), 1);
        assert!(g.take_writes().iter().all(|w| w.meta.samples.is_empty()));
        // Ticks persist writes for changed runs and sample the system.
        let pid = std::process::id();
        let live = g.new_id();
        g.insert(live.clone(), Origin::External, pid, "me", "/tmp", now_ms());
        let payload = g.tick(now_ms());
        assert!(payload.system.unwrap().mem_total > 0.0);
        let w = g.take_writes();
        assert!(w.iter().any(|w| w.meta.id == live && !w.samples.is_empty()));
        assert!(g.take_writes().is_empty());
    }

    #[test]
    fn escalates_to_sigkill() {
        let m = monitor();
        let p = capture(&m, "trap '' INT; sleep 30", "/tmp").unwrap();
        thread::sleep(Duration::from_millis(100));
        stop(&m, &p.id, Duration::from_millis(150)).unwrap();
        let done = wait_for(&m, &p.id, |p| p.status != Status::Running);
        assert_eq!(done.signal.as_deref(), Some("SIGKILL"));
        assert_eq!(done.status, Status::Exited);
    }

    #[test]
    fn shutdown_terminates_spawned_processes() {
        let m = monitor();
        let p = capture(&m, "sleep 30", "/tmp").unwrap();
        thread::sleep(Duration::from_millis(50));
        assert_eq!(m.lock().unwrap().shutdown(), 1);
        let done = wait_for(&m, &p.id, |p| p.status != Status::Running);
        assert_eq!(done.status, Status::Exited);
        assert_eq!(m.lock().unwrap().shutdown(), 0);
    }

    #[test]
    fn capture_errors() {
        let m = monitor();
        assert!(capture(&m, "  ", "/tmp").is_err());
        assert!(capture(&m, "true", "/definitely/missing").is_err());
    }

    #[test]
    fn attaches_and_detects_exit() {
        let m = monitor();
        let mut child = Command::new("sleep").arg("30").stdout(Stdio::null()).spawn().unwrap();
        let pid = child.id();
        let listed = m.lock().unwrap().list_attachable(usize::MAX);
        assert!(listed.iter().any(|a| a.pid == pid && a.command == "sleep 30"), "{listed:?}");
        let p = attach(&m, pid).unwrap();
        assert_eq!(p.command, "sleep 30");
        assert_eq!(p.samples.len(), 1, "attach must return a first sample");
        assert!(p.samples[0].rss > 0.0);
        assert_eq!(p.peak.rss, p.samples[0].rss);
        assert!(p.started_at > 0);
        assert!(!m.lock().unwrap().list_attachable(usize::MAX).iter().any(|a| a.pid == pid));
        assert!(m.lock().unwrap().list_attachable(1).len() <= 1);
        m.lock().unwrap().tick(now_ms());
        child.kill().unwrap();
        child.wait().unwrap();
        let done = wait_for(&m, &p.id, |p| p.status == Status::Exited);
        assert!(done.exit_code.is_none());
        assert!(attach(&m, 999_999).is_err());
    }

    #[test]
    fn kills_attached_processes_that_ignore_sigterm() {
        let m = monitor();
        let mut child =
            Command::new("/bin/sh").args(["-c", "trap '' TERM; while :; do sleep 0.05; done"]).spawn().unwrap();
        thread::sleep(Duration::from_millis(100));
        let p = attach(&m, child.id()).unwrap();
        stop(&m, &p.id, Duration::from_millis(150)).unwrap();
        use std::os::unix::process::ExitStatusExt;
        assert_eq!(child.wait().unwrap().signal(), Some(libc::SIGKILL));
        wait_for(&m, &p.id, |p| p.status == Status::Exited);
    }

    #[test]
    fn attachable_skips_processes_without_cmdline() {
        let dir = tempfile::tempdir().unwrap();
        let uid = unsafe { libc::getuid() };
        for (pid, cmdline) in [(10u32, &b""[..]), (11, &b"node\0app.js\0"[..])] {
            let p = dir.path().join(pid.to_string());
            std::fs::create_dir_all(&p).unwrap();
            std::fs::write(p.join("status"), format!("Uid:\t{uid}\nVmRSS:\t{} kB\n", pid * 100)).unwrap();
            std::fs::write(p.join("cmdline"), cmdline).unwrap();
        }
        let m = Monitor::new(ProcFs::new(dir.path(), "/etc/passwd"), AgentEnv::default());
        let list = m.list_attachable(10);
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].command, "node app.js");
        assert_eq!(list[0].cwd, "");
    }

    #[test]
    fn stops_attached_processes() {
        let m = monitor();
        let mut child = Command::new("sleep").arg("30").spawn().unwrap();
        let p = attach(&m, child.id()).unwrap();
        stop(&m, &p.id, Duration::from_secs(5)).unwrap();
        child.wait().unwrap();
        wait_for(&m, &p.id, |p| p.status == Status::Exited);
    }

    #[test]
    fn restart_remove_and_clear() {
        let m = monitor();
        let a = capture(&m, "exit 0", "/tmp").unwrap();
        wait_for(&m, &a.id, |p| p.status == Status::Exited);
        let b = capture(&m, "sleep 30", "~").unwrap();
        assert!(!b.cwd.starts_with('~'));
        // Restart replaces the entry in place.
        let a2 = restart(&m, &a.id).unwrap();
        {
            let g = m.lock().unwrap();
            assert!(g.get(&a.id).is_none());
            let ids: Vec<_> = g.full_state().procs.into_iter().map(|p| p.id).collect();
            assert_eq!(ids, vec![b.id.clone(), a2.id.clone()]);
        }
        // Restarting a running process stops it first.
        let b2 = restart(&m, &b.id).unwrap();
        assert_ne!(b2.id, b.id);
        assert!(restart(&m, "nope").is_err());
        wait_for(&m, &a2.id, |p| p.status != Status::Running);
        let mut g = m.lock().unwrap();
        assert!(!g.remove(&b2.id), "running processes are not removable");
        assert!(g.remove(&a2.id));
        assert!(!g.remove("nope"));
        drop(g);
        stop(&m, &b2.id, Duration::from_millis(100)).unwrap();
        wait_for(&m, &b2.id, |p| p.status != Status::Running);
        assert_eq!(m.lock().unwrap().clear_ended(), 1);
        assert!(m.lock().unwrap().full_state().procs.is_empty());
    }

    #[test]
    fn agent_hooks_feed_the_profile() {
        let m = monitor();
        let p = capture(&m, "sleep 2", "/tmp").unwrap();
        let mut g = m.lock().unwrap();
        assert!(!g.agent_hello("nope", 1, Runtime::Node));
        assert!(g.agent_hello(&p.id, 100, Runtime::Node));
        assert!(g.agent_hello(&p.id, 200, Runtime::Node));
        let pr = g.get(&p.id).unwrap();
        assert!(pr.profiling && pr.has_gc);
        assert_eq!(pr.runtime, Runtime::Node);
        g.agent_heap(&p.id, 100, AgentHeap { heap_used: 1.0, heap_total: 2.0, external: 0.0, loop_lag: None });
        g.agent_heap(&p.id, 200, AgentHeap { heap_used: 5.0, heap_total: 9.0, external: 0.0, loop_lag: Some(2.0) });
        g.agent_heap("nope", 1, AgentHeap::default());
        assert_eq!(g.primary_agent(&p.id), Some(200));
        assert_eq!(g.primary_agent("nope"), None);
        g.agent_lag(&p.id, 200, 9.0);
        g.agent_lag("nope", 1, 1.0);
        g.agent_gc(&p.id, GcEvent { t: 1, kind: GcKind::Minor, pause_ms: 1.0, freed: 10.0 });
        g.agent_gc("nope", GcEvent { t: 1, kind: GcKind::Minor, pause_ms: 1.0, freed: 10.0 });
        let d = g.tick(now_ms());
        let d = d.procs.iter().find(|d| d.id == p.id).unwrap();
        assert_eq!(d.gc.len(), 1);
        assert_eq!(d.samples.last().unwrap().loop_lag, Some(9.0), "explicit lag wins over the heap report");
        assert!(d.profiling);
        g.agent_bye(&p.id, 200);
        assert!(g.get(&p.id).unwrap().profiling);
        g.agent_bye(&p.id, 100);
        g.agent_bye("nope", 1);
        assert!(!g.get(&p.id).unwrap().profiling);
        g.add_snapshot(
            &p.id,
            HeapSnapshot {
                id: "s".into(),
                t: 1,
                heap_used: 1.0,
                entries: vec![],
                sites: AllocFrame { name: "(root)".into(), file: None, self_bytes: 0.0, children: vec![] },
            },
        );
        g.add_snapshot(
            "nope",
            HeapSnapshot {
                id: "s".into(),
                t: 1,
                heap_used: 1.0,
                entries: vec![],
                sites: AllocFrame { name: "(root)".into(), file: None, self_bytes: 0.0, children: vec![] },
            },
        );
        assert_eq!(g.get(&p.id).unwrap().snapshots.len(), 1);
        g.push_log("nope", Stream::Stdout, "x".into(), 1);
        g.on_exit("nope", ExitInfo { code: Some(0), signal: None }, 1);
        let sys = g.system_info();
        assert!(sys.total_memory > 0.0 && sys.cpus >= 1);
        assert_eq!(sys.os, std::env::consts::OS);
    }

    #[test]
    fn external_processes_wait_for_reported_exit() {
        let m = monitor();
        let mut g = m.lock().unwrap();
        let id = g.new_id();
        let p = g.insert(id.clone(), Origin::External, 999_999, "npm test", "/tmp", 5);
        assert_eq!(p.samples, vec![Sample { t: 5, ..Default::default() }]);
        g.tick(now_ms());
        assert_eq!(g.get(&id).unwrap().status, Status::Running);
        assert_eq!(g.origin(&id), Some(Origin::External));
        assert_eq!(g.origin("nope"), None);
        g.on_exit(&id, ExitInfo { code: Some(0), signal: None }, 9);
        g.on_exit(&id, ExitInfo { code: Some(1), signal: None }, 10);
        let p = g.get(&id).unwrap();
        assert_eq!((p.status, p.ended_at), (Status::Exited, Some(9)));
        assert!(g.request_stop(&id).is_err());
    }
}
