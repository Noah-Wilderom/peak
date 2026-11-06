//! Reading process statistics from Linux `/proc`.
//!
//! Parsers are pure functions over file contents; [`ProcFs`] does the I/O and
//! can be rooted anywhere so tests can use fixture directories.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use crate::model::Fds;

const KB: f64 = 1024.0;

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Stat {
    pub pid: u32,
    pub comm: String,
    pub state: char,
    pub ppid: u32,
    pub minflt: u64,
    pub majflt: u64,
    pub utime: u64,
    pub stime: u64,
    pub nice: i32,
    pub threads: u32,
    /// Clock ticks after boot.
    pub starttime: u64,
    pub vsize: u64,
}

/// Parse `/proc/<pid>/stat`. `comm` may contain spaces and parentheses, so we
/// split on the *last* `)`.
pub fn parse_stat(s: &str) -> Option<Stat> {
    let open = s.find('(')?;
    let close = s.rfind(')')?;
    let pid = s[..open].trim().parse().ok()?;
    let comm = s[open + 1..close].to_string();
    let f: Vec<&str> = s[close + 1..].split_whitespace().collect();
    // f[0] is field 3 (state); field n lives at f[n - 3].
    let at = |n: usize| f.get(n - 3).copied();
    let num = |n: usize| at(n).and_then(|x| x.parse::<u64>().ok());
    Some(Stat {
        pid,
        comm,
        state: at(3)?.chars().next()?,
        ppid: num(4)? as u32,
        minflt: num(10)?,
        majflt: num(12)?,
        utime: num(14)?,
        stime: num(15)?,
        nice: at(19)?.parse().ok()?,
        threads: num(20)? as u32,
        starttime: num(22)?,
        vsize: num(23)?,
    })
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Status {
    pub rss: f64,
    pub rss_anon: f64,
    pub rss_file: f64,
    pub rss_shmem: f64,
    pub swap: f64,
    pub vm_size: f64,
    pub vm_data: f64,
    pub vm_stk: f64,
    pub vm_exe: f64,
    pub uid: u32,
    pub voluntary_ctxt: u64,
    pub nonvoluntary_ctxt: u64,
}

/// Parse `/proc/<pid>/status`; memory values are converted from kB to bytes.
pub fn parse_status(s: &str) -> Status {
    let mut st = Status::default();
    for line in s.lines() {
        let Some((key, rest)) = line.split_once(':') else { continue };
        let first = rest.split_whitespace().next().unwrap_or("0");
        let kb = || first.parse::<f64>().unwrap_or(0.0) * KB;
        let n = || first.parse::<u64>().unwrap_or(0);
        match key {
            "VmRSS" => st.rss = kb(),
            "RssAnon" => st.rss_anon = kb(),
            "RssFile" => st.rss_file = kb(),
            "RssShmem" => st.rss_shmem = kb(),
            "VmSwap" => st.swap = kb(),
            "VmSize" => st.vm_size = kb(),
            "VmData" => st.vm_data = kb(),
            "VmStk" => st.vm_stk = kb(),
            "VmExe" => st.vm_exe = kb(),
            "Uid" => st.uid = n() as u32,
            "voluntary_ctxt_switches" => st.voluntary_ctxt = n(),
            "nonvoluntary_ctxt_switches" => st.nonvoluntary_ctxt = n(),
            _ => {}
        }
    }
    st
}

#[derive(Debug, Clone, PartialEq, Default)]
pub struct Io {
    pub rchar: u64,
    pub wchar: u64,
    pub syscr: u64,
    pub syscw: u64,
    pub read_bytes: u64,
    pub write_bytes: u64,
}

pub fn parse_io(s: &str) -> Io {
    let mut io = Io::default();
    for line in s.lines() {
        let Some((key, v)) = line.split_once(':') else { continue };
        let v = v.trim().parse().unwrap_or(0);
        match key {
            "rchar" => io.rchar = v,
            "wchar" => io.wchar = v,
            "syscr" => io.syscr = v,
            "syscw" => io.syscw = v,
            "read_bytes" => io.read_bytes = v,
            "write_bytes" => io.write_bytes = v,
            _ => {}
        }
    }
    io
}

/// `/proc/<pid>/cmdline` is NUL-separated.
pub fn parse_cmdline(bytes: &[u8]) -> Vec<String> {
    bytes.split(|b| *b == 0).filter(|s| !s.is_empty()).map(|s| String::from_utf8_lossy(s).into_owned()).collect()
}

/// Inode of a `socket:[N]` fd target.
pub fn socket_inode(target: &str) -> Option<u64> {
    target.strip_prefix("socket:[")?.strip_suffix(']')?.parse().ok()
}

/// A listening socket from `/proc/net/tcp{,6}`.
#[derive(Debug, Clone, PartialEq)]
pub struct Listener {
    pub inode: u64,
    pub addr: String,
    pub port: u16,
    pub proto: &'static str,
}

fn parse_hex_addr(hex: &str) -> Option<String> {
    let bytes: Vec<u8> =
        (0..hex.len()).step_by(2).map(|i| u8::from_str_radix(hex.get(i..i + 2)?, 16).ok()).collect::<Option<_>>()?;
    match bytes.len() {
        // IPv4 is stored as one little-endian u32.
        4 => Some(std::net::Ipv4Addr::new(bytes[3], bytes[2], bytes[1], bytes[0]).to_string()),
        // IPv6 is four little-endian u32s.
        16 => {
            let mut b = [0u8; 16];
            for (w, chunk) in bytes.chunks(4).enumerate() {
                for (i, v) in chunk.iter().rev().enumerate() {
                    b[w * 4 + i] = *v;
                }
            }
            Some(std::net::Ipv6Addr::from(b).to_string())
        }
        _ => None,
    }
}

/// Listening (state 0A) entries of a `/proc/net/tcp`-format table.
pub fn parse_net_listeners(s: &str, proto: &'static str) -> Vec<Listener> {
    s.lines()
        .skip(1)
        .filter_map(|line| {
            let f: Vec<&str> = line.split_whitespace().collect();
            if f.get(3) != Some(&"0A") {
                return None;
            }
            let (addr, port) = f.get(1)?.split_once(':')?;
            Some(Listener {
                inode: f.get(9)?.parse().ok()?,
                addr: parse_hex_addr(addr)?,
                port: u16::from_str_radix(port, 16).ok()?,
                proto,
            })
        })
        .collect()
}

#[derive(Debug, Clone, Copy, PartialEq, Default)]
pub struct MemInfo {
    pub total: f64,
    pub available: f64,
    pub swap_total: f64,
    pub swap_free: f64,
}

pub fn parse_meminfo(s: &str) -> MemInfo {
    let mut m = MemInfo::default();
    for line in s.lines() {
        let Some((k, v)) = line.split_once(':') else { continue };
        let v = v.split_whitespace().next().and_then(|x| x.parse::<f64>().ok()).unwrap_or(0.0) * KB;
        match k {
            "MemTotal" => m.total = v,
            "MemAvailable" => m.available = v,
            "SwapTotal" => m.swap_total = v,
            "SwapFree" => m.swap_free = v,
            _ => {}
        }
    }
    m
}

/// `(some avg10, full avg10)` from `/proc/pressure/memory`.
pub fn parse_psi(s: &str) -> (f64, f64) {
    let avg10 = |prefix: &str| {
        s.lines()
            .find(|l| l.starts_with(prefix))
            .and_then(|l| l.split_whitespace().find_map(|kv| kv.strip_prefix("avg10=")))
            .and_then(|v| v.parse().ok())
            .unwrap_or(0.0)
    };
    (avg10("some"), avg10("full"))
}

pub fn parse_loadavg(s: &str) -> f64 {
    s.split_whitespace().next().and_then(|v| v.parse().ok()).unwrap_or(0.0)
}

/// `(busy, total)` jiffies from the aggregate `cpu` line of `/proc/stat`.
pub fn parse_cpu_totals(s: &str) -> Option<(u64, u64)> {
    let line = s.lines().find(|l| l.starts_with("cpu "))?;
    let v: Vec<u64> = line.split_whitespace().skip(1).filter_map(|x| x.parse().ok()).collect();
    let total: u64 = v.iter().take(8).sum();
    let idle = v.get(3).copied().unwrap_or(0) + v.get(4).copied().unwrap_or(0);
    Some((total - idle, total))
}

pub fn classify_fds<'a>(targets: impl IntoIterator<Item = &'a str>) -> Fds {
    let mut fds = Fds::default();
    for t in targets {
        if t.starts_with("socket:") {
            fds.sockets += 1;
        } else if t.starts_with("pipe:") {
            fds.pipes += 1;
        } else {
            fds.files += 1;
        }
    }
    fds
}

pub fn parse_meminfo_total(s: &str) -> Option<f64> {
    s.lines()
        .find_map(|l| l.strip_prefix("MemTotal:"))
        .and_then(|v| v.split_whitespace().next()?.parse::<f64>().ok())
        .map(|kb| kb * KB)
}

pub fn parse_btime(s: &str) -> Option<u64> {
    s.lines().find_map(|l| l.strip_prefix("btime ")).and_then(|v| v.trim().parse().ok())
}

/// Map uid → user name from `/etc/passwd` contents.
pub fn user_name(passwd: &str, uid: u32) -> Option<String> {
    passwd.lines().find_map(|l| {
        let mut parts = l.split(':');
        let name = parts.next()?;
        let _pw = parts.next()?;
        let id: u32 = parts.next()?.parse().ok()?;
        (id == uid).then(|| name.to_string())
    })
}

/// Everything peak reads about one process in a single pass.
#[derive(Debug, Clone, PartialEq, Default)]
pub struct RawProc {
    pub stat: Stat,
    pub status: Status,
    pub io: Io,
    pub fds: Fds,
    pub socket_inodes: Vec<u64>,
    /// `io` couldn't be read (another user's process, hidepid): the zeros mean unknown.
    pub io_denied: bool,
    /// The fd table couldn't be read: `fds` and `socket_inodes` mean unknown.
    pub fds_denied: bool,
}

#[derive(Debug, Clone)]
pub struct ProcFs {
    root: PathBuf,
    passwd: PathBuf,
}

impl Default for ProcFs {
    fn default() -> Self {
        ProcFs::new("/proc", "/etc/passwd")
    }
}

impl ProcFs {
    pub fn new(root: impl Into<PathBuf>, passwd: impl Into<PathBuf>) -> Self {
        ProcFs { root: root.into(), passwd: passwd.into() }
    }

    fn path(&self, pid: u32, file: &str) -> PathBuf {
        self.root.join(pid.to_string()).join(file)
    }

    pub fn pids(&self) -> Vec<u32> {
        let Ok(dir) = fs::read_dir(&self.root) else { return vec![] };
        let mut pids: Vec<u32> = dir.filter_map(|e| e.ok()?.file_name().to_str()?.parse().ok()).collect();
        pids.sort_unstable();
        pids
    }

    pub fn stat(&self, pid: u32) -> Option<Stat> {
        parse_stat(&fs::read_to_string(self.path(pid, "stat")).ok()?)
    }

    pub fn status(&self, pid: u32) -> Option<Status> {
        Some(parse_status(&fs::read_to_string(self.path(pid, "status")).ok()?))
    }

    /// `/proc/<pid>/io` needs ptrace access; missing means zeros.
    pub fn io(&self, pid: u32) -> Io {
        fs::read_to_string(self.path(pid, "io")).map(|s| parse_io(&s)).unwrap_or_default()
    }

    pub fn cmdline(&self, pid: u32) -> Vec<String> {
        fs::read(self.path(pid, "cmdline")).map(|b| parse_cmdline(&b)).unwrap_or_default()
    }

    fn link(&self, pid: u32, name: &str) -> Option<String> {
        fs::read_link(self.path(pid, name)).ok().map(|p| p.to_string_lossy().into_owned())
    }

    pub fn exe(&self, pid: u32) -> Option<String> {
        self.link(pid, "exe")
    }

    pub fn cwd(&self, pid: u32) -> Option<String> {
        self.link(pid, "cwd")
    }

    fn fd_targets(&self, pid: u32) -> Vec<String> {
        let Ok(dir) = fs::read_dir(self.path(pid, "fd")) else { return vec![] };
        dir.filter_map(|e| fs::read_link(e.ok()?.path()).ok()).map(|p| p.to_string_lossy().into_owned()).collect()
    }

    pub fn fds(&self, pid: u32) -> Fds {
        classify_fds(self.fd_targets(pid).iter().map(String::as_str))
    }

    pub fn read(&self, pid: u32) -> Option<RawProc> {
        let targets = self.fd_targets(pid);
        Some(RawProc {
            io_denied: fs::read_to_string(self.path(pid, "io")).is_err(),
            fds_denied: fs::read_dir(self.path(pid, "fd")).is_err(),
            stat: self.stat(pid)?,
            status: self.status(pid)?,
            io: self.io(pid),
            fds: classify_fds(targets.iter().map(String::as_str)),
            socket_inodes: targets.iter().filter_map(|t| socket_inode(t)).collect(),
        })
    }

    /// Every listening TCP socket on the machine, keyed by inode.
    pub fn listeners(&self) -> HashMap<u64, Listener> {
        [("net/tcp", "tcp"), ("net/tcp6", "tcp6")]
            .into_iter()
            .flat_map(|(f, proto)| {
                parse_net_listeners(&fs::read_to_string(self.root.join(f)).unwrap_or_default(), proto)
            })
            .map(|l| (l.inode, l))
            .collect()
    }

    pub fn meminfo(&self) -> MemInfo {
        parse_meminfo(&fs::read_to_string(self.root.join("meminfo")).unwrap_or_default())
    }

    /// `None` when the kernel has no pressure information (PSI disabled or absent).
    pub fn psi_memory(&self) -> Option<(f64, f64)> {
        fs::read_to_string(self.root.join("pressure/memory")).ok().map(|s| parse_psi(&s))
    }

    pub fn loadavg(&self) -> f64 {
        parse_loadavg(&fs::read_to_string(self.root.join("loadavg")).unwrap_or_default())
    }

    pub fn cpu_totals(&self) -> Option<(u64, u64)> {
        parse_cpu_totals(&fs::read_to_string(self.root.join("stat")).ok()?)
    }

    /// pid → ppid for every visible process.
    pub fn parents(&self) -> HashMap<u32, u32> {
        self.pids().into_iter().filter_map(|pid| Some((pid, self.stat(pid)?.ppid))).collect()
    }

    pub fn mem_total(&self) -> Option<f64> {
        parse_meminfo_total(&fs::read_to_string(self.root.join("meminfo")).ok()?)
    }

    pub fn boot_time(&self) -> Option<u64> {
        parse_btime(&fs::read_to_string(self.root.join("stat")).ok()?)
    }

    pub fn hostname(&self) -> String {
        fs::read_to_string(self.root.join("sys/kernel/hostname")).map(|s| s.trim().to_string()).unwrap_or_default()
    }

    pub fn user(&self, uid: u32) -> String {
        fs::read_to_string(&self.passwd).ok().and_then(|p| user_name(&p, uid)).unwrap_or_else(|| uid.to_string())
    }

    pub fn root(&self) -> &Path {
        &self.root
    }
}

/// All descendants of `root` (not including it), breadth-first.
pub fn descendants(parents: &HashMap<u32, u32>, root: u32) -> Vec<u32> {
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for (&pid, &ppid) in parents {
        children.entry(ppid).or_default().push(pid);
    }
    for v in children.values_mut() {
        v.sort_unstable();
    }
    let mut out = vec![];
    let mut queue = std::collections::VecDeque::from([root]);
    while let Some(p) = queue.pop_front() {
        for &c in children.get(&p).map(Vec::as_slice).unwrap_or(&[]) {
            if c != root && !out.contains(&c) {
                out.push(c);
                queue.push_back(c);
            }
        }
    }
    out
}

pub fn clock_ticks() -> u64 {
    // SAFETY: sysconf has no preconditions.
    let v = unsafe { libc::sysconf(libc::_SC_CLK_TCK) };
    if v > 0 { v as u64 } else { 100 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::symlink;

    const STAT: &str = "4242 (my (weird) proc) S 1 4242 4242 0 -1 4194304 1500 0 7 0 250 50 0 0 20 0 9 0 12345 1048576 300 18446744073709551615 0 0 0 0 0 0 0 0 0 0 0 0 17 3 0 0 0 0 0";

    #[test]
    fn parses_stat_with_tricky_comm() {
        let s = parse_stat(STAT).unwrap();
        assert_eq!(s.pid, 4242);
        assert_eq!(s.comm, "my (weird) proc");
        assert_eq!(s.state, 'S');
        assert_eq!(s.ppid, 1);
        assert_eq!(s.minflt, 1500);
        assert_eq!(s.majflt, 7);
        assert_eq!((s.utime, s.stime), (250, 50));
        assert_eq!(s.nice, 0);
        assert_eq!(s.threads, 9);
        assert_eq!(s.starttime, 12345);
        assert_eq!(s.vsize, 1048576);
    }

    #[test]
    fn rejects_bad_stat() {
        assert!(parse_stat("").is_none());
        assert!(parse_stat("x (a) S").is_none());
        assert!(parse_stat("1 (a) S 1").is_none());
        assert!(parse_stat("1 (a)").is_none());
    }

    #[test]
    fn parses_status() {
        let s = parse_status(
            "Name:\tnode\nUid:\t1000\t1000\t1000\t1000\nVmSize:\t  2048 kB\nVmRSS:\t  1024 kB\nRssAnon:\t 600 kB\nRssFile:\t 400 kB\nRssShmem:\t 24 kB\nVmData:\t 900 kB\nVmStk:\t 132 kB\nVmExe:\t 50 kB\nVmSwap:\t 8 kB\nvoluntary_ctxt_switches:\t12\nnonvoluntary_ctxt_switches:\t3\nbogus line\n",
        );
        assert_eq!(s.rss, 1024.0 * KB);
        assert_eq!(s.rss_anon, 600.0 * KB);
        assert_eq!(s.rss_file, 400.0 * KB);
        assert_eq!(s.rss_shmem, 24.0 * KB);
        assert_eq!(s.vm_size, 2048.0 * KB);
        assert_eq!(s.vm_data, 900.0 * KB);
        assert_eq!(s.vm_stk, 132.0 * KB);
        assert_eq!(s.vm_exe, 50.0 * KB);
        assert_eq!(s.swap, 8.0 * KB);
        assert_eq!(s.uid, 1000);
        assert_eq!((s.voluntary_ctxt, s.nonvoluntary_ctxt), (12, 3));
    }

    #[test]
    fn parses_io_and_cmdline_and_meminfo() {
        let io = parse_io(
            "rchar: 10\nwchar: 20\nsyscr: 3\nsyscw: 4\nread_bytes: 5\nwrite_bytes: 6\ncancelled_write_bytes: 0\nnope\n",
        );
        assert_eq!(io, Io { rchar: 10, wchar: 20, syscr: 3, syscw: 4, read_bytes: 5, write_bytes: 6 });
        assert_eq!(parse_cmdline(b"node\0server.js\0--port\x003000\0"), vec!["node", "server.js", "--port", "3000"]);
        assert!(parse_cmdline(b"").is_empty());
        assert_eq!(parse_meminfo_total("MemTotal:       16384 kB\nMemFree: 1 kB"), Some(16384.0 * KB));
        assert_eq!(parse_meminfo_total("nothing"), None);
        assert_eq!(parse_btime("cpu 1 2\nbtime 1700000000\n"), Some(1_700_000_000));
        assert_eq!(parse_btime(""), None);
    }

    #[test]
    fn classifies_fds_and_users() {
        let fds = classify_fds(["socket:[1]", "pipe:[2]", "/dev/null", "/tmp/x", "anon_inode:[eventfd]"]);
        assert_eq!(fds, Fds { files: 3, sockets: 1, pipes: 1 });
        let passwd = "root:x:0:0::/root:/bin/bash\nnoah:x:1000:1000::/home/noah:/bin/zsh\nbroken\n";
        assert_eq!(user_name(passwd, 1000).as_deref(), Some("noah"));
        assert_eq!(user_name(passwd, 0).as_deref(), Some("root"));
        assert_eq!(user_name(passwd, 7), None);
    }

    #[test]
    fn parses_network_and_system_files() {
        assert_eq!(socket_inode("socket:[123]"), Some(123));
        assert_eq!(socket_inode("pipe:[1]"), None);
        let tcp = "  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode\n   0: 0100007F:0BB8 00000000:0000 0A 00000000:00000000 00:00000000 00000000  1000        0 555 1\n   1: 0100007F:1F90 0100007F:D2A4 01 00000000:00000000 00:00000000 00000000  1000        0 556 1\n   2: zz:0BB8 00000000:0000 0A 0 0 0 0 0 557\n";
        assert_eq!(
            parse_net_listeners(tcp, "tcp"),
            vec![Listener { inode: 555, addr: "127.0.0.1".into(), port: 3000, proto: "tcp" }]
        );
        let tcp6 = "header\n   0: 00000000000000000000000001000000:0050 00000000000000000000000000000000:0000 0A 0 0 0 0 0 777 1\n";
        assert_eq!(
            parse_net_listeners(tcp6, "tcp6")[0],
            Listener { inode: 777, addr: "::1".into(), port: 80, proto: "tcp6" }
        );
        assert_eq!(parse_hex_addr("ABC"), None);
        assert_eq!(parse_hex_addr("0102"), None);
        let m = parse_meminfo(
            "MemTotal: 100 kB\nMemAvailable: 40 kB\nSwapTotal: 10 kB\nSwapFree: 5 kB\nbad\nOther: 1 kB\n",
        );
        assert_eq!(m, MemInfo { total: 100.0 * KB, available: 40.0 * KB, swap_total: 10.0 * KB, swap_free: 5.0 * KB });
        assert_eq!(
            parse_psi("some avg10=1.50 avg60=0.00 avg300=0.00 total=1\nfull avg10=0.25 avg60=0 avg300=0 total=0\n"),
            (1.5, 0.25)
        );
        assert_eq!(parse_psi(""), (0.0, 0.0));
        assert_eq!(parse_loadavg("0.52 0.40 0.30 1/200 999"), 0.52);
        assert_eq!(parse_loadavg(""), 0.0);
        assert_eq!(parse_cpu_totals("cpu  10 0 10 70 10 0 0 0 0 0\ncpu0 1 1 1 1"), Some((20, 100)));
        assert_eq!(parse_cpu_totals("cpu  1 2"), Some((3, 3)));
        assert_eq!(parse_cpu_totals("nope"), None);
    }

    #[test]
    fn finds_descendants() {
        let parents = HashMap::from([(10, 1), (11, 10), (12, 10), (13, 11), (20, 1), (10_000, 10_000)]);
        assert_eq!(descendants(&parents, 10), vec![11, 12, 13]);
        assert!(descendants(&parents, 20).is_empty());
        assert!(descendants(&parents, 10_000).is_empty());
    }

    fn fixture() -> tempfile::TempDir {
        let dir = tempfile::tempdir().unwrap();
        let p = dir.path().join("4242");
        fs::create_dir_all(p.join("fd")).unwrap();
        fs::write(p.join("stat"), STAT).unwrap();
        fs::write(p.join("status"), "VmRSS:\t100 kB\nUid:\t1000\n").unwrap();
        fs::write(p.join("io"), "rchar: 9\n").unwrap();
        fs::write(p.join("cmdline"), b"sleep\x0010\0").unwrap();
        symlink("/usr/bin/sleep", p.join("exe")).unwrap();
        symlink("/home/noah", p.join("cwd")).unwrap();
        symlink("socket:[99]", p.join("fd/3")).unwrap();
        symlink("/dev/null", p.join("fd/0")).unwrap();
        fs::create_dir_all(dir.path().join("sys/kernel")).unwrap();
        fs::write(dir.path().join("sys/kernel/hostname"), "devbox\n").unwrap();
        fs::write(dir.path().join("meminfo"), "MemTotal: 2048 kB\n").unwrap();
        fs::write(dir.path().join("stat"), "btime 1000\n").unwrap();
        fs::write(dir.path().join("passwd"), "noah:x:1000:1000::/home/noah:/bin/sh\n").unwrap();
        fs::create_dir_all(dir.path().join("self")).unwrap();
        dir
    }

    #[test]
    fn reads_fixture_tree() {
        let dir = fixture();
        let fs_ = ProcFs::new(dir.path(), dir.path().join("passwd"));
        assert_eq!(fs_.pids(), vec![4242]);
        let raw = fs_.read(4242).unwrap();
        assert_eq!(raw.stat.comm, "my (weird) proc");
        assert_eq!(raw.status.rss, 100.0 * KB);
        assert_eq!(raw.io.rchar, 9);
        assert_eq!(raw.fds, Fds { files: 1, sockets: 1, pipes: 0 });
        assert_eq!(fs_.cmdline(4242), vec!["sleep", "10"]);
        assert_eq!(fs_.exe(4242).as_deref(), Some("/usr/bin/sleep"));
        assert_eq!(fs_.cwd(4242).as_deref(), Some("/home/noah"));
        assert_eq!(fs_.parents(), HashMap::from([(4242, 1)]));
        assert_eq!(fs_.mem_total(), Some(2048.0 * KB));
        assert_eq!(fs_.boot_time(), Some(1000));
        assert_eq!(fs_.hostname(), "devbox");
        assert_eq!(fs_.user(1000), "noah");
        assert_eq!(fs_.user(5), "5");
        assert_eq!(fs_.root(), dir.path());
        assert_eq!(raw.socket_inodes, vec![99]);
        fs::create_dir_all(dir.path().join("net")).unwrap();
        fs::write(dir.path().join("net/tcp"), "h\n 0: 0100007F:0BB8 00000000:0000 0A 0 0 0 0 0 99 1\n").unwrap();
        assert_eq!(fs_.listeners()[&99].port, 3000);
        assert_eq!(fs_.meminfo().total, 2048.0 * KB);
        fs::create_dir_all(dir.path().join("pressure")).unwrap();
        fs::write(dir.path().join("pressure/memory"), "some avg10=2.00\n").unwrap();
        assert_eq!(fs_.psi_memory().unwrap().0, 2.0);
        fs::write(dir.path().join("loadavg"), "1.25 1 1").unwrap();
        assert_eq!(fs_.loadavg(), 1.25);
        assert_eq!(fs_.cpu_totals(), None); // the fixture's stat has no cpu line
        // Missing pieces degrade gracefully.
        assert!(fs_.read(1).is_none());
        assert_eq!(fs_.io(1), Io::default());
        assert_eq!(fs_.fds(1), Fds::default());
        assert!(fs_.cmdline(1).is_empty());
        assert!(fs_.exe(1).is_none());
    }

    #[test]
    fn missing_root_is_empty() {
        let fs_ = ProcFs::new("/definitely/not/here", "/nope");
        assert!(fs_.pids().is_empty());
        assert!(fs_.mem_total().is_none());
        assert!(fs_.boot_time().is_none());
        assert!(fs_.listeners().is_empty());
        assert_eq!(fs_.meminfo(), MemInfo::default());
        assert_eq!(fs_.psi_memory(), None);
        assert_eq!(fs_.loadavg(), 0.0);
        assert!(fs_.cpu_totals().is_none());
        assert_eq!(fs_.hostname(), "");
        assert_eq!(fs_.user(0), "0");
    }

    #[test]
    fn reads_real_self() {
        let fs_ = ProcFs::default();
        let me = std::process::id();
        let raw = fs_.read(me).expect("own /proc entry");
        assert_eq!(raw.stat.pid, me);
        assert!(raw.status.rss > 0.0);
        assert!(fs_.pids().contains(&me));
        assert!(fs_.mem_total().unwrap() > 0.0);
        assert!(fs_.boot_time().unwrap() > 0);
        assert!(fs_.cpu_totals().unwrap().1 > 0);
        assert!(fs_.meminfo().available > 0.0);
        assert!(clock_ticks() > 0);
    }
}
