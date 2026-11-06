//! Process statistics on macOS and Windows, behind the same interface as Linux's `ProcFs`.
//!
//! `sysinfo` lists processes and their memory, disk use, command and start time. What it
//! doesn't give (user and system CPU apart, threads, page faults) comes from each OS's
//! own API in [`os`]. Times are in milliseconds here, so `clock_ticks` is 1000.
//!
//! Not available on these platforms, and reported as such rather than as zero: file handles
//! by kind and listening ports. Memory pressure (PSI) is Linux-only, and Windows has no
//! load average.

use std::collections::HashMap;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

use sysinfo::{
    MemoryRefreshKind, Pid, ProcessRefreshKind, ProcessStatus, ProcessesToUpdate, System, UpdateKind, Users,
};

use crate::model::Fds;
use crate::procfs::{Io, Listener, MemInfo, RawProc, Stat, Status};

/// Charts ask per process, per tick. One pass of the process table serves them all.
const TABLE_MAX_AGE: Duration = Duration::from_millis(200);
const MISS_RETRY: Duration = Duration::from_millis(40);

pub fn clock_ticks() -> u64 {
    1000
}

/// Which user a process belongs to is only used as "this one" or "another".
pub const SAME_USER: u32 = 0;
pub const OTHER_USER: u32 = 1;

pub fn current_uid() -> u32 {
    SAME_USER
}

struct Table {
    sys: System,
    refreshed: Option<Instant>,
    /// Accumulated (busy, total) milliseconds, for the same shape as Linux's CPU counters.
    cpu_counters: (u64, u64),
    cpu_read: Option<Instant>,
}

#[derive(Clone)]
pub struct ProcFs {
    table: Arc<Mutex<Table>>,
    boot: u64,
}

impl std::fmt::Debug for ProcFs {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("ProcFs")
    }
}

impl Default for ProcFs {
    fn default() -> Self {
        ProcFs {
            table: Arc::new(Mutex::new(Table {
                sys: System::new(),
                refreshed: None,
                cpu_counters: (0, 0),
                cpu_read: None,
            })),
            boot: System::boot_time(),
        }
    }
}

fn refresh_kind() -> ProcessRefreshKind {
    ProcessRefreshKind::nothing()
        .with_memory()
        .with_cpu()
        .with_disk_usage()
        .with_exe(UpdateKind::OnlyIfNotSet)
        .with_cmd(UpdateKind::OnlyIfNotSet)
        .with_cwd(UpdateKind::OnlyIfNotSet)
        .with_user(UpdateKind::OnlyIfNotSet)
}

impl ProcFs {
    fn with_table<T>(&self, pid: Option<u32>, read: impl Fn(&System) -> T) -> T {
        let mut t = self.table.lock().unwrap();
        let age = t.refreshed.map(|r| r.elapsed());
        let stale = age.is_none_or(|a| a > TABLE_MAX_AGE);
        // A process started a moment ago isn't in the table yet.
        let missing =
            pid.is_some_and(|p| t.sys.process(Pid::from_u32(p)).is_none()) && age.is_none_or(|a| a > MISS_RETRY);
        if stale || missing {
            t.sys.refresh_processes_specifics(ProcessesToUpdate::All, true, refresh_kind());
            t.refreshed = Some(Instant::now());
        }
        read(&t.sys)
    }

    fn own_user(sys: &System) -> Option<sysinfo::Uid> {
        sys.process(Pid::from_u32(std::process::id()))?.user_id().cloned()
    }

    pub fn pids(&self) -> Vec<u32> {
        let mut pids = self.with_table(None, |s| s.processes().keys().map(|p| p.as_u32()).collect::<Vec<_>>());
        pids.sort_unstable();
        pids
    }

    pub fn stat(&self, pid: u32) -> Option<Stat> {
        let extras = os::extras(pid);
        self.with_table(Some(pid), |sys| {
            let p = sys.process(Pid::from_u32(pid))?;
            let (utime, stime) = extras.cpu_ms.unwrap_or((p.accumulated_cpu_time(), 0));
            Some(Stat {
                pid,
                comm: p.name().to_string_lossy().into_owned(),
                state: match p.status() {
                    ProcessStatus::Zombie | ProcessStatus::Dead => 'Z',
                    _ => 'R',
                },
                ppid: p.parent().map_or(0, |x| x.as_u32()),
                minflt: extras.faults,
                majflt: 0,
                utime,
                stime,
                nice: 0,
                threads: extras.threads,
                starttime: p.start_time().saturating_sub(self.boot) * clock_ticks(),
                vsize: p.virtual_memory(),
            })
        })
    }

    pub fn status(&self, pid: u32) -> Option<Status> {
        self.with_table(Some(pid), |sys| {
            let p = sys.process(Pid::from_u32(pid))?;
            let own = Self::own_user(sys);
            Some(Status {
                rss: p.memory() as f64,
                vm_size: p.virtual_memory() as f64,
                uid: if p.user_id().cloned() == own { SAME_USER } else { OTHER_USER },
                ..Default::default()
            })
        })
    }

    pub fn io(&self, pid: u32) -> Io {
        self.with_table(Some(pid), |sys| {
            sys.process(Pid::from_u32(pid)).map_or_else(Io::default, |p| {
                let d = p.disk_usage();
                Io {
                    rchar: d.total_read_bytes,
                    wchar: d.total_written_bytes,
                    read_bytes: d.total_read_bytes,
                    write_bytes: d.total_written_bytes,
                    ..Default::default()
                }
            })
        })
    }

    pub fn cmdline(&self, pid: u32) -> Vec<String> {
        self.with_table(Some(pid), |sys| {
            sys.process(Pid::from_u32(pid))
                .map(|p| p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect())
                .unwrap_or_default()
        })
    }

    pub fn exe(&self, pid: u32) -> Option<String> {
        self.with_table(Some(pid), |sys| sys.process(Pid::from_u32(pid))?.exe().map(|p| p.display().to_string()))
    }

    pub fn cwd(&self, pid: u32) -> Option<String> {
        self.with_table(Some(pid), |sys| sys.process(Pid::from_u32(pid))?.cwd().map(|p| p.display().to_string()))
    }

    pub fn fds(&self, _pid: u32) -> Fds {
        Fds::default()
    }

    pub fn read(&self, pid: u32) -> Option<RawProc> {
        Some(RawProc {
            stat: self.stat(pid)?,
            status: self.status(pid)?,
            io: self.io(pid),
            fds: Fds::default(),
            socket_inodes: vec![],
            io_denied: false,
            fds_denied: true,
            ports_unknown: true,
        })
    }

    pub fn listeners(&self) -> HashMap<u64, Listener> {
        HashMap::new()
    }

    pub fn meminfo(&self) -> MemInfo {
        let mut sys = System::new();
        sys.refresh_memory_specifics(MemoryRefreshKind::everything());
        MemInfo {
            total: sys.total_memory() as f64,
            available: sys.available_memory() as f64,
            swap_total: sys.total_swap() as f64,
            swap_free: sys.free_swap() as f64,
        }
    }

    pub fn psi_memory(&self) -> Option<(f64, f64)> {
        None
    }

    /// Negative where the OS has no such figure, which the UI leaves out.
    pub fn loadavg(&self) -> f64 {
        if cfg!(windows) { -1.0 } else { System::load_average().one }
    }

    pub fn cpu_totals(&self) -> Option<(u64, u64)> {
        let mut t = self.table.lock().unwrap();
        t.sys.refresh_cpu_usage();
        let elapsed = t.cpu_read.map_or(0, |r| r.elapsed().as_millis() as u64);
        let busy = (elapsed as f64 * f64::from(t.sys.global_cpu_usage()) / 100.0) as u64;
        t.cpu_read = Some(Instant::now());
        t.cpu_counters = (t.cpu_counters.0 + busy, t.cpu_counters.1 + elapsed);
        Some(t.cpu_counters)
    }

    pub fn parents(&self) -> HashMap<u32, u32> {
        self.with_table(None, |sys| {
            sys.processes().iter().filter_map(|(pid, p)| Some((pid.as_u32(), p.parent()?.as_u32()))).collect()
        })
    }

    pub fn mem_total(&self) -> Option<f64> {
        let mut sys = System::new();
        sys.refresh_memory_specifics(MemoryRefreshKind::nothing().with_ram());
        Some(sys.total_memory() as f64)
    }

    pub fn boot_time(&self) -> Option<u64> {
        Some(self.boot)
    }

    pub fn hostname(&self) -> String {
        System::host_name().unwrap_or_default()
    }

    pub fn user(&self, uid: u32) -> String {
        if uid != SAME_USER {
            return "another user".into();
        }
        let id = self.with_table(None, Self::own_user);
        let users = Users::new_with_refreshed_list();
        id.and_then(|id| users.get_user_by_id(&id).map(|u| u.name().to_string())).unwrap_or_default()
    }
}

#[derive(Default)]
struct Extras {
    /// User and system CPU, when the OS would say.
    cpu_ms: Option<(u64, u64)>,
    threads: u32,
    faults: u64,
}

#[cfg(target_os = "macos")]
mod os {
    use super::Extras;

    #[repr(C)]
    struct TimebaseInfo {
        numer: u32,
        denom: u32,
    }

    unsafe extern "C" {
        fn mach_timebase_info(info: *mut TimebaseInfo) -> i32;
    }

    pub(super) fn extras(pid: u32) -> Extras {
        let mut info: libc::proc_taskinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_taskinfo>() as i32;
        // SAFETY: the buffer is exactly the size passed, for the flavor that fills that struct.
        let got = unsafe { libc::proc_pidinfo(pid as i32, libc::PROC_PIDTASKINFO, 0, (&raw mut info).cast(), size) };
        if got != size {
            return Extras::default();
        }
        let mut base = TimebaseInfo { numer: 1, denom: 1 };
        // SAFETY: mach_timebase_info only fills the struct it's given.
        unsafe { mach_timebase_info(&raw mut base) };
        let to_ms = |ticks: u64| {
            (u128::from(ticks) * u128::from(base.numer.max(1)) / u128::from(base.denom.max(1)) / 1_000_000) as u64
        };
        Extras {
            cpu_ms: Some((to_ms(info.pti_total_user), to_ms(info.pti_total_system))),
            threads: info.pti_threadnum as u32,
            faults: info.pti_faults as u64,
        }
    }
}

#[cfg(windows)]
mod os {
    use super::Extras;
    use windows_sys::Win32::Foundation::{CloseHandle, FILETIME, INVALID_HANDLE_VALUE};
    use windows_sys::Win32::System::Diagnostics::ToolHelp::{
        CreateToolhelp32Snapshot, PROCESSENTRY32W, Process32FirstW, Process32NextW, TH32CS_SNAPPROCESS,
    };
    use windows_sys::Win32::System::ProcessStatus::{K32GetProcessMemoryInfo, PROCESS_MEMORY_COUNTERS};
    use windows_sys::Win32::System::Threading::{GetProcessTimes, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};

    fn ms(t: FILETIME) -> u64 {
        ((u64::from(t.dwHighDateTime) << 32) | u64::from(t.dwLowDateTime)) / 10_000
    }

    fn threads(pid: u32) -> u32 {
        // SAFETY: the snapshot handle is checked and closed; the entry is sized as the API requires.
        unsafe {
            let snap = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
            if snap == INVALID_HANDLE_VALUE {
                return 0;
            }
            let mut entry: PROCESSENTRY32W = std::mem::zeroed();
            entry.dwSize = std::mem::size_of::<PROCESSENTRY32W>() as u32;
            let mut found = 0;
            let mut more = Process32FirstW(snap, &mut entry) != 0;
            while more {
                if entry.th32ProcessID == pid {
                    found = entry.cntThreads;
                    break;
                }
                more = Process32NextW(snap, &mut entry) != 0;
            }
            CloseHandle(snap);
            found
        }
    }

    pub(super) fn extras(pid: u32) -> Extras {
        let mut out = Extras { threads: threads(pid), ..Default::default() };
        // SAFETY: the handle is checked and closed; every out-parameter is a local of the right type.
        unsafe {
            let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
            if h.is_null() {
                return out;
            }
            let zero = FILETIME { dwLowDateTime: 0, dwHighDateTime: 0 };
            let (mut created, mut exited, mut kernel, mut user) = (zero, zero, zero, zero);
            if GetProcessTimes(h, &mut created, &mut exited, &mut kernel, &mut user) != 0 {
                out.cpu_ms = Some((ms(user), ms(kernel)));
            }
            let mut mem: PROCESS_MEMORY_COUNTERS = std::mem::zeroed();
            mem.cb = std::mem::size_of::<PROCESS_MEMORY_COUNTERS>() as u32;
            if K32GetProcessMemoryInfo(h, &mut mem, mem.cb) != 0 {
                out.faults = u64::from(mem.PageFaultCount);
            }
            CloseHandle(h);
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_this_process() {
        let fs = ProcFs::default();
        let me = std::process::id();
        assert!(fs.pids().contains(&me));
        let raw = fs.read(me).expect("this process is listed");
        assert!(raw.status.rss > 0.0, "resident memory");
        assert!(raw.status.vm_size > 0.0);
        assert_eq!(raw.status.uid, SAME_USER);
        assert!(raw.stat.threads >= 1, "threads");
        assert!(raw.stat.starttime > 0 || fs.boot_time().is_some());
        assert!(raw.fds_denied && raw.ports_unknown, "says these are unknown");
        assert!(fs.exe(me).unwrap().to_lowercase().contains("peak"));
        assert!(fs.cwd(me).is_some());
        assert!(!fs.cmdline(me).is_empty());
        assert!(fs.parents().contains_key(&me));
        assert!(!fs.hostname().is_empty());
        assert!(!fs.user(SAME_USER).is_empty());
        assert_eq!(fs.user(OTHER_USER), "another user");
        assert!(fs.meminfo().total > 0.0 && fs.mem_total().unwrap() > 0.0);
        assert!(fs.psi_memory().is_none());
        assert!(fs.listeners().is_empty());
        assert_eq!(fs.fds(me), Fds::default());
        assert!(fs.stat(u32::MAX - 1).is_none());
    }

    #[test]
    fn counts_cpu_time_this_process_spends() {
        let fs = ProcFs::default();
        let me = std::process::id();
        let before = fs.stat(me).unwrap();
        let until = Instant::now() + Duration::from_millis(400);
        let mut x = 0u64;
        while Instant::now() < until {
            x = x.wrapping_add(std::hint::black_box(1));
        }
        std::thread::sleep(TABLE_MAX_AGE * 2);
        let after = fs.stat(me).unwrap();
        assert!(x > 0);
        assert!(after.utime + after.stime > before.utime + before.stime, "cpu time advanced");
    }

    #[test]
    fn cpu_counters_only_grow() {
        let fs = ProcFs::default();
        let a = fs.cpu_totals().unwrap();
        std::thread::sleep(Duration::from_millis(250));
        let b = fs.cpu_totals().unwrap();
        assert!(b.1 > a.1 && b.0 >= a.0 && b.0 <= b.1);
    }

    #[test]
    fn finds_a_process_started_a_moment_ago() {
        let fs = ProcFs::default();
        fs.pids();
        let mut child = if cfg!(windows) {
            std::process::Command::new("cmd").args(["/C", "ping -n 3 127.0.0.1 >NUL"]).spawn().unwrap()
        } else {
            std::process::Command::new("sleep").arg("2").spawn().unwrap()
        };
        std::thread::sleep(MISS_RETRY * 2);
        assert!(fs.stat(child.id()).is_some());
        let _ = child.kill();
        let _ = child.wait();
    }
}
