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
    /// Same tree shape as allocation sites; `self` is milliseconds on-CPU.
    pub root: AllocFrame,
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
    /// % of time some tasks stalled on memory (PSI, avg10).
    pub psi_some: f64,
    pub psi_full: f64,
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
        }
    }
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
    pub child_names: BTreeMap<u32, String>,
    #[serde(default)]
    pub ports: Vec<Port>,
    #[serde(default)]
    pub cpu_profiles: Vec<CpuProfile>,
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
    pub child_names: BTreeMap<u32, String>,
    pub ports: Vec<Port>,
    pub has_gc: bool,
    pub profiling: bool,
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
    fn bounded_push_drops_oldest() {
        let mut v = vec![1, 2, 3];
        push_bounded(&mut v, 4, 3);
        assert_eq!(v, vec![2, 3, 4]);
        push_bounded(&mut v, 5, 10);
        assert_eq!(v, vec![2, 3, 4, 5]);
    }
}
