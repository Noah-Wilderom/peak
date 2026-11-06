//! Data model shared with the frontend (`src/lib/types.ts`). All structs
//! serialize as camelCase JSON.

use std::collections::BTreeMap;

use serde::{Deserialize, Serialize};

pub const TICK_MS: u64 = 500;
pub const MAX_SAMPLES: usize = 7200;
pub const MAX_LOGS: usize = 2000;
pub const MAX_GC: usize = 3000;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Runtime {
    Node,
    Bun,
    Python,
    Rust,
    Go,
    Shell,
}

impl Runtime {
    /// Best guess from a command line or executable name.
    pub fn infer(command: &str) -> Runtime {
        let bin = command.split_whitespace().next().unwrap_or("");
        let bin = bin.rsplit('/').next().unwrap_or(bin);
        match bin {
            "bun" | "bunx" => Runtime::Bun,
            "node" | "npm" | "npx" | "pnpm" | "yarn" | "tsx" | "vite" | "deno" => Runtime::Node,
            "cargo" | "rustc" => Runtime::Rust,
            "go" => Runtime::Go,
            b if b.starts_with("python") || matches!(b, "uv" | "pytest" | "poetry" | "pip") => Runtime::Python,
            _ => Runtime::Shell,
        }
    }

    pub fn has_gc(self) -> bool {
        matches!(self, Runtime::Node | Runtime::Bun | Runtime::Python | Runtime::Go)
    }
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Status {
    Running,
    Exited,
    Crashed,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Sample {
    pub t: u64,
    pub rss: f64,
    pub heap: f64,
    pub heap_total: f64,
    pub external: f64,
    pub code: f64,
    pub stack: f64,
    pub cpu: f64,
    pub cpu_user: f64,
    pub cpu_sys: f64,
    pub read: f64,
    pub write: f64,
    pub alloc: f64,
    pub faults: f64,
    #[serde(default)]
    pub threads: f64,
    #[serde(default)]
    pub files: f64,
    #[serde(default)]
    pub sockets: f64,
    #[serde(default)]
    pub pipes: f64,
    /// Runtime responsiveness (Node event-loop delay / Python interpreter latency), p99 ms.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub loop_lag: Option<f64>,
    /// Per-child memory and CPU at this instant.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub kids: Vec<KidSample>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KidSample {
    pub pid: u32,
    pub rss: f64,
    pub cpu: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Port {
    pub port: u16,
    pub proto: String,
    pub addr: String,
    pub pid: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct CpuProfile {
    pub id: String,
    pub t: u64,
    pub duration_ms: f64,
    /// How stacks were collected ("v8", "stack"). Neither is strict on-CPU time;
    /// see `CpuSampling` in src/lib/types.ts.
    #[serde(default = "unknown_sampling")]
    pub sampling: String,
    /// Same tree shape as allocation sites; `self` is sampled milliseconds.
    pub root: AllocFrame,
}

pub fn unknown_sampling() -> String {
    "unknown".into()
}

/// Machine-wide context, sampled alongside processes.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct SystemSample {
    pub t: u64,
    pub mem_total: f64,
    pub mem_available: f64,
    pub swap_total: f64,
    pub swap_free: f64,
    /// % of time some tasks stalled on memory (PSI, avg10). `None` when the
    /// kernel doesn't report pressure: unknown, not zero.
    pub psi_some: Option<f64>,
    pub psi_full: Option<f64>,
    pub load1: f64,
    /// Whole-machine CPU busy %, 0–100.
    pub cpu: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TickPayload {
    pub procs: Vec<ProcDelta>,
    pub system: Option<SystemSample>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct RunSummary {
    pub id: String,
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub runtime: Runtime,
    pub status: Status,
    pub started_at: u64,
    pub ended_at: Option<u64>,
    pub exit_code: Option<i32>,
    pub signal: Option<String>,
    pub peak_rss: f64,
    pub avg_cpu: f64,
    pub samples: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct StorageInfo {
    pub path: String,
    pub bytes: u64,
    pub runs: u64,
    pub stopped_runs: u64,
    pub samples: u64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct Settings {
    /// Stopped runs older than this are pruned automatically (0 = keep forever).
    pub retention_days: u32,
    /// Keep at most this many stopped runs (0 = unlimited).
    pub max_runs: u32,
    pub alerts_enabled: bool,
    pub notifications: bool,
    /// Alert when resident memory exceeds this many MiB (0 = off).
    pub alert_memory_mib: f64,
    /// Alert when CPU stays above this % ...
    pub alert_cpu_percent: f64,
    /// ... for this many seconds (0 = off).
    pub alert_cpu_seconds: f64,
    /// Look for a new release on start and every few hours. Installing always asks.
    #[serde(default = "enabled")]
    pub check_for_updates: bool,
}

fn enabled() -> bool {
    true
}

impl Default for Settings {
    fn default() -> Self {
        Settings {
            retention_days: 30,
            max_runs: 500,
            alerts_enabled: true,
            notifications: true,
            alert_memory_mib: 0.0,
            alert_cpu_percent: 90.0,
            alert_cpu_seconds: 0.0,
            check_for_updates: true,
        }
    }
}

impl Settings {
    /// Negative limits mean nothing; treat them as "off".
    pub fn sanitized(&self) -> Settings {
        Settings {
            alert_memory_mib: self.alert_memory_mib.max(0.0),
            alert_cpu_percent: self.alert_cpu_percent.max(0.0),
            alert_cpu_seconds: self.alert_cpu_seconds.max(0.0),
            ..self.clone()
        }
    }
}

/// A threshold crossing recorded on a run (see `src/lib/alerts.ts`).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Alert {
    pub t: u64,
    pub kind: String,
    pub message: String,
    pub value: f64,
    pub threshold: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum GcKind {
    Minor,
    Major,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct GcEvent {
    pub t: u64,
    pub kind: GcKind,
    pub pause_ms: f64,
    pub freed: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeapEntry {
    pub name: String,
    pub count: f64,
    pub shallow: f64,
    pub retained: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct AllocFrame {
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub file: Option<String>,
    #[serde(rename = "self")]
    pub self_bytes: f64,
    #[serde(default)]
    pub children: Vec<AllocFrame>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct HeapSnapshot {
    pub id: String,
    pub t: u64,
    pub heap_used: f64,
    pub entries: Vec<HeapEntry>,
    pub sites: AllocFrame,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Stream {
    Stdout,
    Stderr,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct LogLine {
    pub id: u64,
    pub t: u64,
    pub stream: Stream,
    pub text: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ChildProc {
    pub pid: u32,
    pub name: String,
    pub cpu: f64,
    pub rss: f64,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Counters {
    pub cpu_user_ms: f64,
    pub cpu_sys_ms: f64,
    pub minor_faults: f64,
    pub major_faults: f64,
    pub ctx_voluntary: f64,
    pub ctx_involuntary: f64,
    pub read_total: f64,
    pub write_total: f64,
    pub syscalls: f64,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct Fds {
    pub files: u32,
    pub sockets: u32,
    pub pipes: u32,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Proc {
    pub id: String,
    pub pid: u32,
    pub ppid: u32,
    pub user: String,
    pub exe: String,
    pub command: String,
    pub cwd: String,
    pub runtime: Runtime,
    pub status: Status,
    pub started_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    pub nice: i32,
    pub threads: u32,
    pub vsz: f64,
    pub swap: f64,
    pub fds: Fds,
    pub counters: Counters,
    pub samples: Vec<Sample>,
    pub peak: Sample,
    pub gc: Vec<GcEvent>,
    pub has_gc: bool,
    pub profiling: bool,
    pub snapshots: Vec<HeapSnapshot>,
    pub logs: Vec<LogLine>,
    pub children: Vec<ChildProc>,
    #[serde(default)]
    pub child_names: BTreeMap<String, String>,
    #[serde(default)]
    pub ports: Vec<Port>,
    #[serde(default)]
    pub cpu_profiles: Vec<CpuProfile>,
    #[serde(default)]
    pub alerts: Vec<Alert>,
    /// Reopened from stored history, as opposed to a workload monitored in this session.
    #[serde(default, skip_serializing_if = "is_false")]
    pub historical: bool,
    /// Metrics that couldn't be read ("io", "fds"). Their values mean unknown, not zero.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<String>,
    /// Where this run lives, when it isn't on this machine.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target: Option<ProcTarget>,
    /// Stretches with no data because the connection was lost.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gaps: Vec<Gap>,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq, Hash)]
#[serde(rename_all = "lowercase")]
pub enum TargetKind {
    Local,
    Ssh,
    Docker,
    Kubernetes,
}

/// Is the link to a target up? Independent of whether any workload is running:
/// losing the connection is not evidence that a workload exited.
#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum ConnectionState {
    Connecting,
    Connected,
    /// Linked, but frames have stopped arriving.
    Stale,
    Disconnected,
    /// Couldn't connect, and retrying won't help until something changes.
    Failed,
}

/// What can be done on a target right now. These govern which actions the UI offers.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct Capabilities {
    /// A collector is running: detailed process metrics, attach and signals.
    pub collector: bool,
    pub attach: bool,
    /// Commands can be launched, with exact stdout/stderr captured.
    pub launch: bool,
    pub signal: bool,
    /// Agent scripts are on the target, so launched Node/Python get heap, GC and CPU profiles.
    pub runtime_agents: bool,
    /// Whole-container CPU/memory totals without a collector.
    pub container_totals: bool,
    /// Logs recorded by the container platform.
    pub container_logs: bool,
    /// Process listing from the container platform.
    pub container_top: bool,
}

/// What makes a workload the same workload. A PID alone doesn't: PIDs get reused,
/// and a reused name or PID must not inherit history or receive a predecessor's signal.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ProcIdentity {
    pub boot_id: String,
    pub pid_ns: String,
    pub pid: u32,
    pub start_ticks: u64,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub container_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub pod_uid: Option<String>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcTarget {
    pub target_id: String,
    pub label: String,
    pub kind: TargetKind,
    pub identity: ProcIdentity,
    /// Launched by the collector (output captured, restartable). Otherwise observed.
    pub launched: bool,
    /// Launch specification kept for an explicit restart.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub spec: Option<LaunchSpec>,
    /// Desktop receipt time minus target wall time, at the last frame (ms). Sample
    /// times are the target's; this shows how far apart the clocks are.
    #[serde(default)]
    pub clock_offset_ms: i64,
}

/// How to start a command on a target.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct LaunchSpec {
    /// Shell command line (requires /bin/sh on the target).
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub command: Option<String>,
    /// Direct executable + arguments, for images without a shell.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub argv: Option<Vec<String>>,
    #[serde(default)]
    pub cwd: String,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Gap {
    pub from: u64,
    pub to: u64,
}

/// Apply an incremental update to a full record (what the frontend's `applyDelta` does).
pub fn merge_delta(p: &mut Proc, d: &ProcDelta) {
    let last_t = p.samples.last().map(|s| s.t);
    for s in d.samples.iter().filter(|s| last_t.is_none_or(|l| s.t > l)) {
        push_bounded(&mut p.samples, s.clone(), MAX_SAMPLES);
    }
    let last_log = p.logs.last().map(|l| l.id);
    for l in d.logs.iter().filter(|l| last_log.is_none_or(|x| l.id > x)) {
        push_bounded(&mut p.logs, l.clone(), MAX_LOGS);
    }
    let last_gc = p.gc.last().map(|g| g.t);
    for g in d.gc.iter().filter(|g| last_gc.is_none_or(|x| g.t > x)) {
        push_bounded(&mut p.gc, g.clone(), MAX_GC);
    }
    p.status = d.status;
    p.ended_at = d.ended_at;
    p.exit_code = d.exit_code;
    p.signal = d.signal.clone();
    p.runtime = d.runtime;
    p.exe = d.exe.clone();
    p.ppid = d.ppid;
    p.nice = d.nice;
    p.threads = d.threads;
    p.vsz = d.vsz;
    p.swap = d.swap;
    p.fds = d.fds;
    p.counters = d.counters.clone();
    p.peak = d.peak.clone();
    p.children = d.children.clone();
    p.child_names = d.child_names.clone();
    p.ports = d.ports.clone();
    p.has_gc = d.has_gc;
    p.profiling = d.profiling;
    p.unavailable = d.unavailable.clone();
}

fn is_false(b: &bool) -> bool {
    !*b
}

/// Incremental update for one process (see `ProcDelta` in tauri-monitor.ts).
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct ProcDelta {
    pub id: String,
    pub samples: Vec<Sample>,
    pub logs: Vec<LogLine>,
    pub gc: Vec<GcEvent>,
    pub status: Status,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub ended_at: Option<u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub exit_code: Option<i32>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub signal: Option<String>,
    pub runtime: Runtime,
    pub exe: String,
    pub ppid: u32,
    pub nice: i32,
    pub threads: u32,
    pub vsz: f64,
    pub swap: f64,
    pub fds: Fds,
    pub counters: Counters,
    pub peak: Sample,
    pub children: Vec<ChildProc>,
    pub child_names: BTreeMap<String, String>,
    pub ports: Vec<Port>,
    pub has_gc: bool,
    pub profiling: bool,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub unavailable: Vec<String>,
    /// Remote runs: every stretch with no data so far. Set by the desktop, not the collector.
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub gaps: Vec<Gap>,
    /// Remote runs: this machine's clock minus the target's, at the latest frame.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub clock_offset_ms: Option<i64>,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct SystemInfo {
    pub total_memory: f64,
    pub cpus: u32,
    pub hostname: String,
    pub os: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct FullState {
    pub procs: Vec<Proc>,
    pub system: SystemInfo,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Attachable {
    pub pid: u32,
    pub command: String,
    pub cwd: String,
    pub rss: f64,
    /// Identifies this process among any that reuse its PID.
    #[serde(default)]
    pub start_ticks: u64,
}

/// Push onto a bounded history, dropping the oldest items.
pub fn push_bounded<T>(v: &mut Vec<T>, item: T, max: usize) {
    v.push(item);
    if v.len() > max {
        let excess = v.len() - max;
        v.drain(..excess);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn infers_runtimes() {
        assert_eq!(Runtime::infer("bun run dev"), Runtime::Bun);
        assert_eq!(Runtime::infer("bunx vite"), Runtime::Bun);
        assert_eq!(Runtime::infer("/usr/bin/node server.js"), Runtime::Node);
        assert_eq!(Runtime::infer("npm test"), Runtime::Node);
        assert_eq!(Runtime::infer("python3.13 train.py"), Runtime::Python);
        assert_eq!(Runtime::infer("uv run app.py"), Runtime::Python);
        assert_eq!(Runtime::infer("cargo build"), Runtime::Rust);
        assert_eq!(Runtime::infer("go run ."), Runtime::Go);
        assert_eq!(Runtime::infer("make all"), Runtime::Shell);
        assert_eq!(Runtime::infer(""), Runtime::Shell);
    }

    #[test]
    fn gc_runtimes() {
        assert!(Runtime::Node.has_gc());
        assert!(Runtime::Python.has_gc());
        assert!(!Runtime::Rust.has_gc());
        assert!(!Runtime::Shell.has_gc());
    }

    #[test]
    fn serializes_camel_case() {
        let s = Sample { t: 1, heap_total: 2.0, cpu_user: 3.0, ..Default::default() };
        let v = serde_json::to_value(&s).unwrap();
        assert_eq!(v["heapTotal"], json!(2.0));
        assert_eq!(v["cpuUser"], json!(3.0));
        let f = AllocFrame { name: "a".into(), file: None, self_bytes: 4.0, children: vec![] };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v, json!({"name": "a", "self": 4.0, "children": []}));
        let back: AllocFrame = serde_json::from_value(json!({"name": "b", "self": 1.0})).unwrap();
        assert!(back.children.is_empty() && back.file.is_none());
        assert_eq!(serde_json::to_value(Status::Crashed).unwrap(), json!("crashed"));
        assert_eq!(serde_json::to_value(GcKind::Major).unwrap(), json!("major"));
        assert_eq!(serde_json::to_value(Stream::Stderr).unwrap(), json!("stderr"));
    }

    #[test]
    fn sanitizes_settings() {
        let s =
            Settings { alert_memory_mib: -1.0, alert_cpu_percent: -2.0, alert_cpu_seconds: -3.0, ..Default::default() };
        let clean = s.sanitized();
        assert_eq!((clean.alert_memory_mib, clean.alert_cpu_percent, clean.alert_cpu_seconds), (0.0, 0.0, 0.0));
        assert_eq!(clean.retention_days, s.retention_days);
    }

    fn proc(id: &str) -> Proc {
        Proc {
            id: id.into(),
            pid: 1,
            ppid: 0,
            user: String::new(),
            exe: String::new(),
            command: String::new(),
            cwd: String::new(),
            runtime: Runtime::Shell,
            status: Status::Running,
            started_at: 0,
            ended_at: None,
            exit_code: None,
            signal: None,
            nice: 0,
            threads: 1,
            vsz: 0.0,
            swap: 0.0,
            fds: Fds::default(),
            counters: Counters::default(),
            samples: vec![Sample { t: 5, ..Default::default() }],
            peak: Sample::default(),
            gc: vec![GcEvent { t: 5, kind: GcKind::Minor, pause_ms: 0.0, freed: 0.0 }],
            has_gc: false,
            profiling: false,
            snapshots: vec![],
            logs: vec![LogLine { id: 5, t: 5, stream: Stream::Stdout, text: "old".into() }],
            children: vec![],
            child_names: Default::default(),
            ports: vec![],
            cpu_profiles: vec![],
            alerts: vec![],
            historical: false,
            unavailable: vec![],
            target: None,
            gaps: vec![],
        }
    }

    #[test]
    fn merges_deltas_without_duplicates() {
        let mut p = proc("a");
        let d = ProcDelta {
            id: "a".into(),
            samples: vec![
                Sample { t: 5, rss: 1.0, ..Default::default() },
                Sample { t: 6, rss: 2.0, ..Default::default() },
            ],
            logs: vec![
                LogLine { id: 5, t: 5, stream: Stream::Stdout, text: "old".into() },
                LogLine { id: 6, t: 6, stream: Stream::Stderr, text: "new".into() },
            ],
            gc: vec![
                GcEvent { t: 5, kind: GcKind::Minor, pause_ms: 0.0, freed: 0.0 },
                GcEvent { t: 6, kind: GcKind::Major, pause_ms: 1.0, freed: 1.0 },
            ],
            status: Status::Crashed,
            ended_at: Some(7),
            exit_code: Some(3),
            signal: None,
            runtime: Runtime::Node,
            exe: "x".into(),
            ppid: 9,
            nice: 1,
            threads: 2,
            vsz: 3.0,
            swap: 4.0,
            fds: Fds { files: 1, sockets: 1, pipes: 1 },
            counters: Counters::default(),
            peak: Sample { t: 6, rss: 2.0, ..Default::default() },
            children: vec![],
            child_names: Default::default(),
            ports: vec![],
            has_gc: true,
            profiling: true,
            unavailable: vec!["io".into()],
            gaps: vec![],
            clock_offset_ms: None,
        };
        merge_delta(&mut p, &d);
        merge_delta(&mut p, &d);
        assert_eq!(p.samples.iter().map(|s| s.t).collect::<Vec<_>>(), vec![5, 6]);
        assert_eq!(p.logs.len(), 2);
        assert_eq!(p.gc.len(), 2);
        assert_eq!((p.status, p.exit_code, p.threads), (Status::Crashed, Some(3), 2));
        assert_eq!(p.unavailable, vec!["io"]);
        let mut empty = proc("b");
        empty.samples.clear();
        empty.logs.clear();
        empty.gc.clear();
        merge_delta(&mut empty, &d);
        assert_eq!((empty.samples.len(), empty.logs.len(), empty.gc.len()), (2, 2, 2));
    }

    #[test]
    fn optional_remote_fields_stay_out_of_local_records() {
        let v = serde_json::to_value(proc("a")).unwrap();
        for key in ["target", "gaps", "unavailable", "historical"] {
            assert!(v.get(key).is_none(), "{key} serialized on a plain local run");
        }
        let back: Proc = serde_json::from_value(v).unwrap();
        assert_eq!(back.target, None);
    }

    #[test]
    fn bounded_push_drops_oldest() {
        let mut v = vec![1, 2, 3];
        push_bounded(&mut v, 4, 3);
        assert_eq!(v, vec![2, 3, 4]);
        push_bounded(&mut v, 5, 10);
        assert_eq!(v, vec![2, 3, 4, 5]);
    }
}
