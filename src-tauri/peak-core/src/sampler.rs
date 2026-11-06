//! Turns successive raw readings of a process tree into [`Sample`]s: rates
//! from counter deltas, cumulative totals, and the memory composition.

use std::collections::HashMap;

use crate::model::{ChildProc, Counters, Fds, KidSample, Sample, SystemSample};
use crate::procfs::{ProcFs, RawProc};

/// Heap figures reported by a runtime agent (bytes).
#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct AgentHeap {
    pub heap_used: f64,
    pub heap_total: f64,
    pub external: f64,
    /// p99 event-loop / interpreter delay over the last interval, ms.
    pub loop_lag: Option<f64>,
}

#[derive(Debug, Clone, Copy, Default)]
struct Prev {
    utime: u64,
    stime: u64,
    minflt: u64,
    majflt: u64,
    vol: u64,
    invol: u64,
    rchar: u64,
    wchar: u64,
    syscalls: u64,
}

impl Prev {
    fn of(p: &RawProc) -> Prev {
        Prev {
            utime: p.stat.utime,
            stime: p.stat.stime,
            minflt: p.stat.minflt,
            majflt: p.stat.majflt,
            vol: p.status.voluntary_ctxt,
            invol: p.status.nonvoluntary_ctxt,
            rchar: p.io.rchar,
            wchar: p.io.wchar,
            syscalls: p.io.syscr + p.io.syscw,
        }
    }
}

/// One reading of the tree: root first, then descendants.
#[derive(Debug, Clone, PartialEq)]
pub struct TreeSample {
    pub sample: Sample,
    pub threads: u32,
    pub vsz: f64,
    pub swap: f64,
    pub fds: Fds,
    pub nice: i32,
    pub ppid: u32,
    pub children: Vec<ChildProc>,
    /// Metrics that couldn't be read for part of the tree, so totals understate them.
    pub unavailable: Vec<String>,
}

#[derive(Debug)]
pub struct TreeSampler {
    clk_tck: f64,
    prev: HashMap<(u32, u64), Prev>,
    prev_t: Option<u64>,
    prev_heap: Option<f64>,
    pub counters: Counters,
}

impl TreeSampler {
    pub fn new(clk_tck: u64) -> Self {
        TreeSampler {
            clk_tck: clk_tck.max(1) as f64,
            prev: HashMap::new(),
            prev_t: None,
            prev_heap: None,
            counters: Counters::default(),
        }
    }

    /// Sample a tree. `gc_freed` is bytes reclaimed by GC since the last call
    /// (used to estimate allocation rate when an agent reports the heap).
    pub fn sample(&mut self, t: u64, tree: &[RawProc], agent: Option<AgentHeap>, gc_freed: f64) -> TreeSample {
        let first = self.prev_t.is_none();
        let dt_s = self.prev_t.map(|p| (t.saturating_sub(p)) as f64 / 1000.0).filter(|d| *d > 0.0).unwrap_or(1.0);
        let ticks_ms = 1000.0 / self.clk_tck;

        let mut next = HashMap::with_capacity(tree.len());
        let mut d = Prev::default();
        let mut children = Vec::new();
        let (mut rss, mut anon, mut file, mut shmem, mut stack) = (0.0, 0.0, 0.0, 0.0, 0.0);
        let (mut threads, mut vsz, mut swap) = (0u32, 0.0, 0.0);
        let mut fds = Fds::default();

        for (i, p) in tree.iter().enumerate() {
            let key = (p.stat.pid, p.stat.starttime);
            let cur = Prev::of(p);
            // New members contribute everything since they started; on the very
            // first reading we only establish a baseline.
            let base = if first { cur } else { self.prev.get(&key).copied().unwrap_or_default() };
            let delta = Prev {
                utime: cur.utime.saturating_sub(base.utime),
                stime: cur.stime.saturating_sub(base.stime),
                minflt: cur.minflt.saturating_sub(base.minflt),
                majflt: cur.majflt.saturating_sub(base.majflt),
                vol: cur.vol.saturating_sub(base.vol),
                invol: cur.invol.saturating_sub(base.invol),
                rchar: cur.rchar.saturating_sub(base.rchar),
                wchar: cur.wchar.saturating_sub(base.wchar),
                syscalls: cur.syscalls.saturating_sub(base.syscalls),
            };
            next.insert(key, cur);

            d.utime += delta.utime;
            d.stime += delta.stime;
            d.minflt += delta.minflt;
            d.majflt += delta.majflt;
            d.vol += delta.vol;
            d.invol += delta.invol;
            d.rchar += delta.rchar;
            d.wchar += delta.wchar;
            d.syscalls += delta.syscalls;

            let s = &p.status;
            rss += s.rss;
            anon += s.rss_anon;
            file += s.rss_file;
            shmem += s.rss_shmem;
            stack += s.vm_stk.min(s.rss_anon);
            threads += p.stat.threads;
            vsz += p.stat.vsize as f64;
            swap += s.swap;
            fds.files += p.fds.files;
            fds.sockets += p.fds.sockets;
            fds.pipes += p.fds.pipes;

            if i > 0 {
                let cpu = ((delta.utime + delta.stime) as f64 * ticks_ms) / (dt_s * 1000.0) * 100.0;
                children.push(ChildProc { pid: p.stat.pid, name: p.stat.comm.clone(), cpu, rss: s.rss });
            }
        }

        let user_ms = d.utime as f64 * ticks_ms;
        let sys_ms = d.stime as f64 * ticks_ms;
        let c = &mut self.counters;
        c.cpu_user_ms += user_ms;
        c.cpu_sys_ms += sys_ms;
        c.minor_faults += d.minflt as f64;
        c.major_faults += d.majflt as f64;
        c.ctx_voluntary += d.vol as f64;
        c.ctx_involuntary += d.invol as f64;
        c.read_total += d.rchar as f64;
        c.write_total += d.wchar as f64;
        c.syscalls += d.syscalls as f64;

        let (heap, heap_total, external) = match agent {
            Some(a) => {
                let heap_total = a.heap_total.min(rss);
                (a.heap_used.min(heap_total), heap_total, (a.external + shmem).min((rss - heap_total).max(0.0)))
            }
            None => {
                let h = (anon - stack).max(0.0);
                (h, h, shmem)
            }
        };

        // Allocation rate: net heap growth plus whatever the GC reclaimed.
        let alloc = match self.prev_heap {
            Some(prev) if !first => ((heap - prev) + gc_freed).max(0.0) / dt_s,
            _ => 0.0,
        };

        let cpu_user = user_ms / (dt_s * 1000.0) * 100.0;
        let cpu_sys = sys_ms / (dt_s * 1000.0) * 100.0;
        let sample = Sample {
            t,
            rss,
            heap,
            heap_total,
            external,
            code: file,
            stack,
            cpu: cpu_user + cpu_sys,
            cpu_user,
            cpu_sys,
            read: d.rchar as f64 / dt_s,
            write: d.wchar as f64 / dt_s,
            alloc,
            faults: d.minflt as f64 / dt_s,
            threads: threads as f64,
            files: fds.files as f64,
            sockets: fds.sockets as f64,
            pipes: fds.pipes as f64,
            loop_lag: agent.and_then(|a| a.loop_lag),
            kids: children.iter().map(|c| KidSample { pid: c.pid, rss: c.rss, cpu: c.cpu }).collect(),
        };

        self.prev = next;
        self.prev_t = Some(t);
        self.prev_heap = Some(heap);

        let root = tree.first();
        TreeSample {
            sample,
            threads,
            vsz,
            swap,
            fds,
            nice: root.map(|r| r.stat.nice).unwrap_or(0),
            ppid: root.map(|r| r.stat.ppid).unwrap_or(0),
            children,
            unavailable: [("io", tree.iter().any(|p| p.io_denied)), ("fds", tree.iter().any(|p| p.fds_denied))]
                .into_iter()
                .filter(|(_, denied)| *denied)
                .map(|(name, _)| name.to_string())
                .collect(),
        }
    }
}

/// Samples machine-wide memory, pressure, load and CPU.
#[derive(Debug, Default)]
pub struct SystemSampler {
    prev_cpu: Option<(u64, u64)>,
}

impl SystemSampler {
    pub fn sample(&mut self, t: u64, fs: &ProcFs) -> SystemSample {
        let m = fs.meminfo();
        let psi = fs.psi_memory();
        let now = fs.cpu_totals();
        let cpu = match (self.prev_cpu, now) {
            (Some((b0, t0)), Some((b1, t1))) if t1 > t0 => (b1.saturating_sub(b0)) as f64 / (t1 - t0) as f64 * 100.0,
            _ => 0.0,
        };
        self.prev_cpu = now;
        SystemSample {
            t,
            mem_total: m.total,
            mem_available: m.available,
            swap_total: m.swap_total,
            swap_free: m.swap_free,
            psi_some: psi.map(|p| p.0),
            psi_full: psi.map(|p| p.1),
            load1: fs.loadavg(),
            cpu,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::procfs::{Io, Stat, Status};

    fn raw(pid: u32, utime: u64, stime: u64, rss_mb: f64, rchar: u64) -> RawProc {
        RawProc {
            stat: Stat {
                pid,
                comm: format!("p{pid}"),
                ppid: 1,
                utime,
                stime,
                minflt: utime * 10,
                majflt: 1,
                threads: 2,
                starttime: 7,
                vsize: 1000,
                nice: 5,
                ..Default::default()
            },
            status: Status {
                rss: rss_mb * 1048576.0,
                rss_anon: rss_mb * 0.7 * 1048576.0,
                rss_file: rss_mb * 0.25 * 1048576.0,
                rss_shmem: rss_mb * 0.05 * 1048576.0,
                vm_stk: 1048576.0,
                swap: 10.0,
                voluntary_ctxt: utime,
                nonvoluntary_ctxt: stime,
                ..Default::default()
            },
            io: Io { rchar, wchar: rchar / 2, syscr: 1, syscw: 1, ..Default::default() },
            fds: Fds { files: 3, sockets: 1, pipes: 2 },
            socket_inodes: vec![],
            io_denied: false,
            fds_denied: false,
        }
    }

    #[test]
    fn first_reading_is_a_baseline() {
        let mut s = TreeSampler::new(100);
        let r = s.sample(1000, &[raw(1, 500, 100, 100.0, 9999)], None, 0.0);
        assert_eq!(r.sample.cpu, 0.0);
        assert_eq!(r.sample.read, 0.0);
        assert_eq!(r.sample.alloc, 0.0);
        assert_eq!(s.counters, Counters::default());
        assert_eq!(r.sample.rss, 100.0 * 1048576.0);
        assert_eq!(r.nice, 5);
        assert_eq!(r.ppid, 1);
    }

    #[test]
    fn computes_rates_and_totals() {
        let mut s = TreeSampler::new(100);
        s.sample(0, &[raw(1, 0, 0, 100.0, 0), raw(2, 0, 0, 10.0, 0)], None, 0.0);
        // 500ms later: root used 25+5 ticks (=300ms), child 10 ticks (=100ms).
        let r = s.sample(500, &[raw(1, 25, 5, 120.0, 1000), raw(2, 10, 0, 10.0, 0)], None, 0.0);
        assert!((r.sample.cpu_user - 70.0).abs() < 1e-9, "{}", r.sample.cpu_user);
        assert!((r.sample.cpu_sys - 10.0).abs() < 1e-9);
        assert!((r.sample.cpu - 80.0).abs() < 1e-9);
        assert_eq!(r.sample.read, 2000.0);
        assert_eq!(r.sample.write, 1000.0);
        assert_eq!(r.sample.faults, (350.0) / 0.5);
        assert_eq!(s.counters.cpu_user_ms, 350.0);
        assert_eq!(s.counters.cpu_sys_ms, 50.0);
        assert_eq!(s.counters.read_total, 1000.0);
        assert_eq!(s.counters.ctx_voluntary, 35.0);
        assert_eq!(r.threads, 4);
        assert_eq!(r.fds, Fds { files: 6, sockets: 2, pipes: 4 });
        assert_eq!(r.children.len(), 1);
        assert_eq!(r.children[0].pid, 2);
        assert!((r.children[0].cpu - 20.0).abs() < 1e-9);
        // Without an agent heap ≈ anonymous memory minus stacks, and allocation
        // is net anonymous growth.
        let anon = 120.0 * 0.7 * 1048576.0 + 10.0 * 0.7 * 1048576.0;
        assert!((r.sample.heap - (anon - 2.0 * 1048576.0)).abs() < 1.0);
        assert_eq!(r.sample.heap, r.sample.heap_total);
        assert!(r.sample.alloc > 0.0);
    }

    #[test]
    fn new_children_count_from_zero_and_exited_ones_drop_out() {
        let mut s = TreeSampler::new(100);
        s.sample(0, &[raw(1, 0, 0, 10.0, 0)], None, 0.0);
        let r = s.sample(1000, &[raw(1, 0, 0, 10.0, 0), raw(3, 50, 0, 5.0, 0)], None, 0.0);
        assert!((r.sample.cpu - 50.0).abs() < 1e-9);
        let r = s.sample(2000, &[raw(1, 0, 0, 10.0, 0)], None, 0.0);
        assert_eq!(r.sample.cpu, 0.0);
        assert!(r.children.is_empty());
        // Counters never go backwards when a child disappears.
        assert_eq!(s.counters.cpu_user_ms, 500.0);
    }

    #[test]
    fn agent_heap_shapes_composition_and_alloc() {
        let mut s = TreeSampler::new(100);
        let a = AgentHeap {
            heap_used: 40.0 * 1048576.0,
            heap_total: 60.0 * 1048576.0,
            external: 5.0 * 1048576.0,
            loop_lag: None,
        };
        s.sample(0, &[raw(1, 0, 0, 100.0, 0)], Some(a), 0.0);
        let a2 = AgentHeap { heap_used: 30.0 * 1048576.0, ..a };
        let r = s.sample(1000, &[raw(1, 0, 0, 100.0, 0)], Some(a2), 20.0 * 1048576.0);
        assert_eq!(r.sample.heap, 30.0 * 1048576.0);
        assert_eq!(r.sample.heap_total, 60.0 * 1048576.0);
        assert_eq!(r.sample.external, 10.0 * 1048576.0);
        // Heap fell by 10MB while GC freed 20MB → 10MB allocated in 1s.
        assert!((r.sample.alloc - 10.0 * 1048576.0).abs() < 1.0);
        // Agent figures are clamped to what is actually resident.
        let huge = AgentHeap { heap_used: 1e12, heap_total: 1e12, external: 1e12, loop_lag: None };
        let r = s.sample(2000, &[raw(1, 0, 0, 100.0, 0)], Some(huge), 0.0);
        assert_eq!(r.sample.heap_total, r.sample.rss);
        assert_eq!(r.sample.heap, r.sample.rss);
        assert_eq!(r.sample.external, 0.0);
    }

    #[test]
    fn records_resources_kids_and_loop_lag() {
        let mut s = TreeSampler::new(100);
        s.sample(0, &[raw(1, 0, 0, 10.0, 0), raw(2, 0, 0, 5.0, 0)], None, 0.0);
        let a = AgentHeap { heap_used: 1.0, heap_total: 2.0, external: 0.0, loop_lag: Some(4.5) };
        let r = s.sample(500, &[raw(1, 0, 0, 10.0, 0), raw(2, 5, 0, 5.0, 0)], Some(a), 0.0);
        assert_eq!((r.sample.threads, r.sample.files, r.sample.sockets, r.sample.pipes), (4.0, 6.0, 2.0, 4.0));
        assert_eq!(r.sample.loop_lag, Some(4.5));
        assert_eq!(r.sample.kids, vec![KidSample { pid: 2, rss: 5.0 * 1048576.0, cpu: 10.0 }]);
    }

    #[test]
    fn samples_the_system() {
        let dir = tempfile::tempdir().unwrap();
        let fs = ProcFs::new(dir.path(), "/nope");
        std::fs::write(dir.path().join("meminfo"), "MemTotal: 100 kB\nMemAvailable: 25 kB\n").unwrap();
        std::fs::write(dir.path().join("stat"), "cpu  10 0 0 90 0 0 0 0\n").unwrap();
        let mut sys = SystemSampler::default();
        let first = sys.sample(1, &fs);
        assert_eq!(first.cpu, 0.0);
        assert_eq!(first.mem_available, 25.0 * 1024.0);
        std::fs::write(dir.path().join("stat"), "cpu  40 0 0 160 0 0 0 0\n").unwrap();
        assert_eq!(sys.sample(2, &fs).cpu, 30.0);
        // Same counters again: no division by zero.
        assert_eq!(sys.sample(3, &fs).cpu, 0.0);
        let real = SystemSampler::default().sample(1, &ProcFs::default());
        assert!(real.mem_total > 0.0);
    }

    #[test]
    fn handles_empty_tree_and_zero_dt() {
        let mut s = TreeSampler::new(0);
        let r = s.sample(5, &[], None, 0.0);
        assert_eq!(r.sample.rss, 0.0);
        assert_eq!(r.nice, 0);
        let r = s.sample(5, &[], None, 0.0);
        assert_eq!(r.sample.cpu, 0.0);
    }
}
