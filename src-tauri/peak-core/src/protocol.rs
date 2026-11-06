//! The versioned collector protocol: JSON lines over the transport's stdio.
//! Authentication stays with the transport (SSH, Docker, Kubernetes). Stdout is
//! reserved for these frames; workload output travels inside `Tick` frames.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::cgroup::CgroupLimits;
use crate::model::*;

pub const VERSION: u32 = 1;
/// A frame larger than this is refused, not buffered.
pub const MAX_FRAME: usize = 64 * 1024 * 1024;
/// Recent ticks kept for `Resync`.
pub const RESYNC_FRAMES: usize = 2400;

/// Desktop → collector.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "op", rename_all = "camelCase")]
pub enum Request {
    Hello {
        version: u32,
    },
    Ping,
    #[serde(rename_all = "camelCase")]
    ListProcesses {
        limit: u32,
    },
    /// Observe a process. With `expect`, only if it's still that process.
    #[serde(rename_all = "camelCase")]
    Attach {
        pid: u32,
        #[serde(default)]
        expect: Option<ProcIdentity>,
    },
    /// Stop observing. Never signals the process.
    Detach {
        id: String,
    },
    Launch {
        spec: LaunchSpec,
    },
    /// SIGINT, then SIGKILL after a grace period, verified against identity.
    Stop {
        id: String,
    },
    /// One explicit signal ("TERM", "INT", "KILL", "HUP"), verified against identity.
    Signal {
        id: String,
        signal: String,
    },
    Snapshot {
        id: String,
    },
    Gc {
        id: String,
    },
    CpuProfile {
        id: String,
        ms: u64,
    },
    /// Replay buffered ticks after `since`, when a sequence gap is noticed.
    Resync {
        since: u64,
    },
    Shutdown,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
pub struct ClientFrame {
    /// Echoed in the reply. Named apart from the `id` many requests carry.
    pub req: u64,
    #[serde(flatten)]
    pub request: Request,
}

/// Collector → desktop.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(tag = "frame", rename_all = "camelCase")]
pub enum ServerFrame {
    Reply {
        id: u64,
        ok: bool,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        data: Option<Value>,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        error: Option<String>,
    },
    Tick(Tick),
    Bye {
        reason: String,
    },
}

/// One sampling round. `t` runs on the target's clock, advanced monotonically so
/// rates survive clock changes there; `wall` is that clock's reading right now.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Tick {
    pub seq: u64,
    pub t: u64,
    pub wall: u64,
    pub procs: Vec<ProcDelta>,
    pub system: Option<SystemSample>,
}

/// What the target is, reported by the collector running on it.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct Facts {
    pub protocol: u32,
    pub collector_version: String,
    pub arch: String,
    pub kernel: String,
    pub hostname: String,
    pub boot_id: String,
    pub pid_ns: String,
    pub uid: u32,
    pub clk_tck: u64,
    /// CPUs this process may use (honours affinity).
    pub cpus: u32,
    /// The machine or VM's memory, from /proc/meminfo.
    pub host_memory: f64,
    /// Limits on the collector's cgroup: a separate figure from host memory.
    pub limits: CgroupLimits,
    /// Agent scripts are installed and can be injected into launched commands.
    pub runtime_agents: bool,
}

/// Parse a signal name, including only those the protocol allows.
pub fn signal_number(name: &str) -> Option<i32> {
    match name {
        "INT" => Some(libc::SIGINT),
        "TERM" => Some(libc::SIGTERM),
        "KILL" => Some(libc::SIGKILL),
        "HUP" => Some(libc::SIGHUP),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn frames_have_a_stable_wire_format() {
        let f = ClientFrame { req: 3, request: Request::ListProcesses { limit: 10 } };
        let v = serde_json::to_value(&f).unwrap();
        assert_eq!(v, json!({"req": 3, "op": "listProcesses", "limit": 10}));
        assert_eq!(serde_json::from_value::<ClientFrame>(v).unwrap(), f);

        let attach: ClientFrame = serde_json::from_value(json!({"req": 1, "op": "attach", "pid": 9})).unwrap();
        assert_eq!(attach.request, Request::Attach { pid: 9, expect: None });

        let r = ServerFrame::Reply { id: 1, ok: false, data: None, error: Some("no".into()) };
        assert_eq!(serde_json::to_value(&r).unwrap(), json!({"frame": "reply", "id": 1, "ok": false, "error": "no"}));
        let t = ServerFrame::Tick(Tick { seq: 7, t: 1, wall: 2, procs: vec![], system: None });
        let v = serde_json::to_value(&t).unwrap();
        assert_eq!(v["frame"], "tick");
        assert_eq!(v["seq"], 7);
        assert_eq!(serde_json::from_value::<ServerFrame>(v).unwrap(), t);
        assert!(serde_json::from_value::<ClientFrame>(json!({"req": 1, "op": "reboot"})).is_err());
        // Requests that name a run keep their own id.
        let d = ClientFrame { req: 2, request: Request::Detach { id: "run".into() } };
        let line = serde_json::to_string(&d).unwrap();
        assert_eq!(serde_json::from_str::<ClientFrame>(&line).unwrap(), d);
    }

    #[test]
    fn tick_frames_carry_full_deltas_through_the_tagged_enum() {
        let d: ProcDelta = serde_json::from_value(json!({
            "id": "a", "samples": [], "logs": [], "gc": [], "status": "running", "runtime": "node", "exe": "x",
            "ppid": 1, "nice": 0, "threads": 1, "vsz": 0, "swap": 0, "fds": {"files": 0, "sockets": 0, "pipes": 0},
            "counters": {"cpuUserMs": 0, "cpuSysMs": 0, "minorFaults": 0, "majorFaults": 0, "ctxVoluntary": 0,
                         "ctxInvoluntary": 0, "readTotal": 0, "writeTotal": 0, "syscalls": 0},
            "peak": {"t": 0, "rss": 0, "heap": 0, "heapTotal": 0, "external": 0, "code": 0, "stack": 0, "cpu": 0,
                     "cpuUser": 0, "cpuSys": 0, "read": 0, "write": 0, "alloc": 0, "faults": 0},
            "children": [], "childNames": {"42": "worker"}, "ports": [], "hasGc": false, "profiling": false,
        }))
        .unwrap();
        let t = ServerFrame::Tick(Tick { seq: 1, t: 1, wall: 1, procs: vec![d], system: None });
        let line = serde_json::to_string(&t).unwrap();
        assert_eq!(serde_json::from_str::<ServerFrame>(&line).unwrap(), t);
    }

    #[test]
    fn only_known_signals_are_accepted() {
        assert_eq!(signal_number("TERM"), Some(libc::SIGTERM));
        assert_eq!(signal_number("INT"), Some(libc::SIGINT));
        assert_eq!(signal_number("KILL"), Some(libc::SIGKILL));
        assert_eq!(signal_number("HUP"), Some(libc::SIGHUP));
        assert_eq!(signal_number("USR1"), None);
    }
}
