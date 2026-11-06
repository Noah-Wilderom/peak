//! How `peak run` finds an app that's already open.
//!
//! Each open app publishes its own record, so one app closing can't hide another. Records
//! live in the data directory the environment names and in the one the OS account names,
//! so a terminal with a different `XDG_DATA_HOME`, or none, still finds the app. A record
//! says which process wrote it, and that is checked before anything is sent to its port.
//!
//! `control.json` holds the newest app's record, for an older `peak` on the PATH.

use std::fs;
use std::io::{self, Write};
#[cfg(unix)]
use std::os::unix::fs::{DirBuilderExt, MetadataExt, OpenOptionsExt};
use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::hub::data_dir_in_home;
use crate::monitor::now_ms;
use crate::procfs::ProcFs;

const CONTROL_FILE: &str = "control.json";
const INSTANCES: &str = "instances";

/// One open app. Everything but `addr` and `secret` is absent in an older app's record.
#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Record {
    pub addr: String,
    pub secret: String,
    #[serde(default)]
    pub pid: Option<u32>,
    #[serde(default)]
    pub start_ticks: Option<u64>,
    #[serde(default)]
    pub boot_id: Option<String>,
    #[serde(default)]
    pub pid_ns: Option<String>,
    #[serde(default)]
    pub net_ns: Option<String>,
    #[serde(default)]
    pub host: Option<String>,
    #[serde(default)]
    pub data_dir: Option<String>,
    #[serde(default)]
    pub started_at: Option<u64>,
}

/// Who and where this process is.
#[derive(Debug, Clone, Default, PartialEq)]
pub struct Here {
    pub uid: u32,
    pub user: String,
    pub host: String,
    pub boot_id: String,
    pub pid_ns: String,
    pub net_ns: String,
}

#[cfg(target_os = "linux")]
fn read_trim(path: &str) -> String {
    fs::read_to_string(path).map(|s| s.trim().to_string()).unwrap_or_default()
}

#[cfg(target_os = "linux")]
fn read_link(path: &str) -> String {
    fs::read_link(path).map(|p| p.display().to_string()).unwrap_or_default()
}

impl Here {
    #[cfg(target_os = "linux")]
    pub fn detect() -> Here {
        let (uid, user) = current_user();
        Here {
            uid,
            user,
            host: read_trim("/proc/sys/kernel/hostname"),
            boot_id: read_trim("/proc/sys/kernel/random/boot_id"),
            pid_ns: read_link("/proc/self/ns/pid"),
            net_ns: read_link("/proc/self/ns/net"),
        }
    }

    /// No namespaces to tell apart here, so those stay empty and always match.
    #[cfg(not(target_os = "linux"))]
    pub fn detect() -> Here {
        let (uid, user) = current_user();
        let fs = ProcFs::default();
        Here {
            uid,
            user,
            host: fs.hostname(),
            boot_id: fs.boot_time().unwrap_or(0).to_string(),
            pid_ns: String::new(),
            net_ns: String::new(),
        }
    }
}

#[cfg(unix)]
fn current_user() -> (u32, String) {
    // SAFETY: geteuid has no preconditions.
    let uid = unsafe { libc::geteuid() };
    (uid, account(uid).map_or_else(|| format!("uid {uid}"), |(name, _)| name))
}

/// Windows keeps a user's application data private to that account already.
#[cfg(windows)]
fn current_user() -> (u32, String) {
    (0, std::env::var("USERNAME").unwrap_or_else(|_| "this user".into()))
}

/// Name and home directory from the OS account database.
#[cfg(unix)]
fn account(uid: u32) -> Option<(String, PathBuf)> {
    use std::ffi::CStr;
    let mut buf = vec![0u8; 64 * 1024];
    // SAFETY: passwd is plain data, filled in by getpwuid_r with pointers into `buf`,
    // and both are read before they go out of scope.
    unsafe {
        let mut pw: libc::passwd = std::mem::zeroed();
        let mut out = std::ptr::null_mut();
        let rc = libc::getpwuid_r(uid, &mut pw, buf.as_mut_ptr().cast(), buf.len(), &mut out);
        if rc != 0 || out.is_null() {
            return None;
        }
        let name = CStr::from_ptr(pw.pw_name).to_string_lossy().into_owned();
        let home = PathBuf::from(CStr::from_ptr(pw.pw_dir).to_string_lossy().into_owned());
        Some((name, home))
    }
}

/// The start time of a process, if it's running. A zombie has exited, whatever its parent does.
pub fn start_ticks(pid: u32) -> Option<u64> {
    ProcFs::default().stat(pid).filter(|s| s.state != 'Z').map(|s| s.starttime)
}

/// Where to look and publish: the environment's data directory, then the account's.
pub fn search_dirs(env_dir: PathBuf, account_home: Option<&Path>) -> Vec<PathBuf> {
    let mut dirs = vec![env_dir];
    if let Some(home) = account_home {
        let dir = data_dir_in_home(home);
        if !dirs.contains(&dir) {
            dirs.push(dir);
        }
    }
    dirs
}

pub fn default_dirs() -> Vec<PathBuf> {
    #[cfg(unix)]
    let home = account(unsafe { libc::geteuid() }).map(|(_, home)| home);
    #[cfg(windows)]
    let home: Option<PathBuf> = None;
    search_dirs(crate::hub::default_data_dir(), home.as_deref())
}

// ─── publishing ──────────────────────────────────────────────────────────────

fn instance_name(record: &Record) -> String {
    format!("{}-{}.json", record.pid.unwrap_or(0), record.start_ticks.unwrap_or(0))
}

/// Replace `path` whole, readable only by this user, so a reader never sees half a record.
fn write_private(path: &Path, record: &Record) -> io::Result<()> {
    let dir = path.parent().expect("records live in a directory");
    let mut builder = fs::DirBuilder::new();
    builder.recursive(true);
    #[cfg(unix)]
    builder.mode(0o700);
    builder.create(dir)?;
    let tmp = dir.join(format!(".{}.tmp", std::process::id()));
    let mut options = fs::OpenOptions::new();
    options.write(true).create(true).truncate(true);
    #[cfg(unix)]
    options.mode(0o600);
    let mut f = options.open(&tmp)?;
    f.write_all(serde_json::to_string(record)?.as_bytes())?;
    drop(f);
    fs::rename(&tmp, path)
}

/// This app's records. Lets terminals find it for as long as it's open.
pub struct Publication {
    record: Record,
    instance_files: Vec<PathBuf>,
    control_files: Vec<PathBuf>,
}

impl Publication {
    pub fn new(addr: String, secret: String, dirs: &[PathBuf], here: &Here) -> Publication {
        let pid = std::process::id();
        let record = Record {
            addr,
            secret,
            pid: Some(pid),
            start_ticks: start_ticks(pid),
            boot_id: Some(here.boot_id.clone()),
            pid_ns: Some(here.pid_ns.clone()),
            net_ns: Some(here.net_ns.clone()),
            host: Some(here.host.clone()),
            data_dir: dirs.first().map(|d| d.display().to_string()),
            started_at: Some(now_ms()),
        };
        Publication {
            instance_files: dirs.iter().map(|d| d.join(INSTANCES).join(instance_name(&record))).collect(),
            control_files: dirs.iter().map(|d| d.join(CONTROL_FILE)).collect(),
            record,
        }
    }

    /// Write every record, including over another app's `control.json`: newest wins there.
    /// Returns what couldn't be written. The app works without them, but terminals can't find it.
    pub fn publish(&self) -> Vec<String> {
        self.write(self.instance_files.iter().chain(&self.control_files), false)
    }

    /// Put back whatever has gone, since nothing else will while this app stays open.
    pub fn ensure(&self) -> Vec<String> {
        self.write(self.instance_files.iter().chain(&self.control_files), true)
    }

    fn write<'a>(&self, files: impl Iterator<Item = &'a PathBuf>, only_missing: bool) -> Vec<String> {
        files
            .filter(|f| !(only_missing && f.exists()))
            .filter_map(|f| write_private(f, &self.record).err().map(|e| format!("{}: {e}", f.display())))
            .collect()
    }

    /// The app is closing.
    pub fn retire(&self) {
        for f in &self.instance_files {
            let _ = fs::remove_file(f);
        }
        for f in &self.control_files {
            let ours = fs::read_to_string(f).ok().and_then(|s| serde_json::from_str::<Record>(&s).ok());
            if ours.is_some_and(|r| r.secret == self.record.secret) {
                let _ = fs::remove_file(f);
            }
        }
    }
}

// ─── discovering ─────────────────────────────────────────────────────────────

/// What a record says about an app, judged from here.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Standing {
    /// That exact process is running here.
    Live,
    /// Written by an older app, or from another PID namespace on this kernel. Only trying can tell.
    Unverified,
    /// Its process has gone.
    Stale,
    /// On another machine sharing this home directory. Not this machine's business.
    Elsewhere,
    /// This kernel, but not reachable over this shell's localhost.
    OtherNetwork,
}

pub fn standing(r: &Record, here: &Here, ticks_of: &dyn Fn(u32) -> Option<u64>) -> Standing {
    let (Some(pid), Some(boot_id)) = (r.pid, r.boot_id.as_deref()) else { return Standing::Unverified };
    let network_differs = r.net_ns.as_deref().is_some_and(|n| n != here.net_ns);
    if boot_id != here.boot_id {
        return if r.host.as_deref() == Some(here.host.as_str()) { Standing::Stale } else { Standing::Elsewhere };
    }
    if r.pid_ns.as_deref().is_some_and(|n| n != here.pid_ns) {
        return if network_differs { Standing::OtherNetwork } else { Standing::Unverified };
    }
    if r.start_ticks.is_none() || ticks_of(pid) != r.start_ticks {
        return Standing::Stale;
    }
    if network_differs { Standing::OtherNetwork } else { Standing::Live }
}

/// A record that might lead to an app.
#[derive(Debug, Clone, PartialEq)]
pub struct Candidate {
    pub record: Record,
    pub standing: Standing,
    pub path: PathBuf,
}

#[derive(Debug, Default, PartialEq)]
pub struct Discovery {
    /// Worth connecting to, best first: same data directory, then newest.
    pub candidates: Vec<Candidate>,
    /// Records of apps this shell can't reach, and records that couldn't be used.
    pub obstacles: Vec<String>,
}

pub fn discover(dirs: &[PathBuf], here: &Here, ticks_of: &dyn Fn(u32) -> Option<u64>) -> Discovery {
    let mut found = Discovery::default();
    let mut seen: Vec<Candidate> = vec![];
    for dir in dirs {
        let instances = dir.join(INSTANCES);
        let mut files = match fs::read_dir(&instances) {
            Ok(entries) => entries
                .flatten()
                .map(|e| e.path())
                .filter(|p| p.extension().is_some_and(|x| x == "json"))
                .collect::<Vec<_>>(),
            Err(e) => {
                note_unreadable(&mut found, &instances, &e);
                vec![]
            }
        };
        files.sort();
        // The newer records come first, so `control.json` only adds an older app's.
        files.push(dir.join(CONTROL_FILE));
        for path in files {
            match read_record(&path, here) {
                Ok(Some(record)) => {
                    if !seen.iter().any(|c| c.record.addr == record.addr && c.record.secret == record.secret) {
                        let standing = standing(&record, here, ticks_of);
                        seen.push(Candidate { record, standing, path });
                    }
                }
                Ok(None) => {}
                Err(problem) => found.obstacles.push(problem),
            }
        }
    }
    let preferred = dirs.first().map(|d| d.display().to_string());
    for c in seen {
        match c.standing {
            Standing::Stale => forget(&c),
            Standing::Elsewhere => {}
            Standing::OtherNetwork => found.obstacles.push(format!(
                "a Peak app is recorded in another container or network namespace (PID {}), which this shell can't reach",
                c.record.pid.unwrap_or(0)
            )),
            Standing::Live | Standing::Unverified => found.candidates.push(c),
        }
    }
    found.candidates.sort_by_key(|c| {
        (c.standing != Standing::Live, c.record.data_dir != preferred, std::cmp::Reverse(c.record.started_at))
    });
    found
}

fn note_unreadable(found: &mut Discovery, path: &Path, e: &io::Error) {
    if e.kind() != io::ErrorKind::NotFound {
        found.obstacles.push(format!("couldn't read {}: {e}", path.display()));
    }
}

/// `Ok(None)` means there's no such record.
#[cfg_attr(windows, allow(unused_variables))]
fn read_record(path: &Path, here: &Here) -> Result<Option<Record>, String> {
    #[cfg_attr(windows, allow(unused_variables))]
    let meta = match fs::metadata(path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(format!("couldn't read {}: {e}", path.display())),
    };
    #[cfg(unix)]
    if meta.uid() != here.uid {
        return Err(format!("{} belongs to another user, so it can't be used", path.display()));
    }
    let text = fs::read_to_string(path).map_err(|e| format!("couldn't read {}: {e}", path.display()))?;
    serde_json::from_str(&text).map(Some).map_err(|e| format!("couldn't read {}: {e}", path.display()))
}

/// Only the file of a process known to be gone; a live app's record is left alone.
fn forget(c: &Candidate) {
    let _ = fs::remove_file(&c.path);
}

/// Clear records of apps that have gone, as a new app starts.
pub fn prune(dirs: &[PathBuf], here: &Here) {
    discover(dirs, here, &start_ticks);
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    fn here() -> Here {
        Here {
            uid: unsafe { libc::geteuid() },
            user: "me".into(),
            host: "box".into(),
            boot_id: "boot".into(),
            pid_ns: "pid:[1]".into(),
            net_ns: "net:[1]".into(),
        }
    }

    fn record(pid: u32, started_at: u64) -> Record {
        Record {
            addr: format!("127.0.0.1:{pid}"),
            secret: format!("s{pid}"),
            pid: Some(pid),
            start_ticks: Some(100),
            boot_id: Some("boot".into()),
            pid_ns: Some("pid:[1]".into()),
            net_ns: Some("net:[1]".into()),
            host: Some("box".into()),
            data_dir: None,
            started_at: Some(started_at),
        }
    }

    fn put(dir: &Path, r: &Record) -> PathBuf {
        let path = dir.join(INSTANCES).join(instance_name(r));
        write_private(&path, r).unwrap();
        path
    }

    fn alive(_: u32) -> Option<u64> {
        Some(100)
    }

    fn dead(_: u32) -> Option<u64> {
        None
    }

    #[test]
    fn reads_this_system() {
        let h = Here::detect();
        assert!(!h.boot_id.is_empty() && !h.pid_ns.is_empty() && !h.net_ns.is_empty() && !h.user.is_empty());
        assert!(start_ticks(std::process::id()).unwrap() > 0);
        assert_eq!(start_ticks(u32::MAX), None);
        assert!(account(h.uid).is_some());
        assert_eq!(account(u32::MAX - 7), None);
        assert!(!default_dirs().is_empty());
    }

    #[test]
    fn looks_in_the_environments_directory_and_the_accounts() {
        let home = Path::new("/home/me");
        let account_dir = PathBuf::from("/home/me/.local/share/peak");
        assert_eq!(
            search_dirs(PathBuf::from("/snap/x/peak"), Some(home)),
            vec![PathBuf::from("/snap/x/peak"), account_dir.clone()]
        );
        assert_eq!(search_dirs(account_dir.clone(), Some(home)), vec![account_dir]);
        assert_eq!(search_dirs(PathBuf::from("/tmp/peak"), None), vec![PathBuf::from("/tmp/peak")]);
    }

    #[test]
    fn judges_a_record() {
        let h = here();
        let r = record(5, 1);
        assert_eq!(standing(&r, &h, &alive), Standing::Live);
        assert_eq!(standing(&r, &h, &dead), Standing::Stale);
        // The PID came back as a different process.
        assert_eq!(standing(&r, &h, &|_| Some(999)), Standing::Stale);
        assert_eq!(standing(&Record { start_ticks: None, ..r.clone() }, &h, &alive), Standing::Stale);
        // Rebooted, against a home shared with another machine.
        assert_eq!(standing(&Record { boot_id: Some("old".into()), ..r.clone() }, &h, &alive), Standing::Stale);
        let other = Record { boot_id: Some("old".into()), host: Some("other".into()), ..r.clone() };
        assert_eq!(standing(&other, &h, &alive), Standing::Elsewhere);
        // Containers on this kernel.
        let ns = Record { pid_ns: Some("pid:[2]".into()), ..r.clone() };
        assert_eq!(standing(&ns, &h, &dead), Standing::Unverified);
        let isolated = Record { net_ns: Some("net:[2]".into()), ..ns };
        assert_eq!(standing(&isolated, &h, &dead), Standing::OtherNetwork);
        assert_eq!(
            standing(&Record { net_ns: Some("net:[2]".into()), ..r.clone() }, &h, &alive),
            Standing::OtherNetwork
        );
        // An older app's record says nothing about itself.
        assert_eq!(
            standing(&Record { addr: "a".into(), secret: "s".into(), ..Default::default() }, &h, &dead),
            Standing::Unverified
        );
    }

    #[test]
    fn one_app_closing_leaves_the_other_findable() {
        let d = tempfile::tempdir().unwrap();
        let dirs = vec![d.path().to_path_buf()];
        let first = record(11, 1);
        let second = record(22, 2);
        put(d.path(), &first);
        let gone = put(d.path(), &second);
        // `control.json` still names the one that has closed.
        write_private(&d.path().join(CONTROL_FILE), &second).unwrap();
        let found = discover(&dirs, &here(), &|pid| (pid == 11).then_some(100));
        assert_eq!(found.candidates.len(), 1);
        assert_eq!(found.candidates[0].record, first);
        assert!(found.obstacles.is_empty());
        assert!(!gone.exists(), "the closed app's record is cleared");
    }

    #[test]
    fn prefers_this_data_directory_then_the_newest() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let dirs = vec![a.path().to_path_buf(), b.path().to_path_buf()];
        let mine = Record { data_dir: Some(a.path().display().to_string()), ..record(1, 10) };
        put(a.path(), &mine);
        put(b.path(), &record(2, 20));
        put(b.path(), &record(3, 30));
        // The same app published in both directories counts once.
        put(b.path(), &mine);
        let order: Vec<_> = discover(&dirs, &here(), &alive).candidates.iter().map(|c| c.record.pid).collect();
        assert_eq!(order, vec![Some(1), Some(3), Some(2)]);
    }

    #[test]
    fn tries_a_verified_app_before_an_older_record() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), &record(1, 1));
        write_private(
            &d.path().join(CONTROL_FILE),
            &Record { addr: "old".into(), secret: "x".into(), ..Default::default() },
        )
        .unwrap();
        let found = discover(&[d.path().to_path_buf()], &here(), &alive);
        assert_eq!(
            found.candidates.iter().map(|c| c.standing).collect::<Vec<_>>(),
            vec![Standing::Live, Standing::Unverified]
        );
    }

    #[test]
    fn reports_what_it_cant_use() {
        let d = tempfile::tempdir().unwrap();
        let dirs = vec![d.path().to_path_buf()];
        assert_eq!(discover(&dirs, &here(), &alive), Discovery::default());
        fs::write(d.path().join(CONTROL_FILE), "{ not json").unwrap();
        fs::create_dir_all(d.path().join(INSTANCES)).unwrap();
        fs::write(d.path().join(INSTANCES).join("note.txt"), "ignored").unwrap();
        let found = discover(&dirs, &here(), &alive);
        assert!(found.candidates.is_empty());
        assert_eq!(found.obstacles.len(), 1);
        assert!(found.obstacles[0].contains("couldn't read") && found.obstacles[0].contains(CONTROL_FILE));

        // Not this user's.
        let foreign = Here { uid: here().uid + 1, ..here() };
        fs::remove_file(d.path().join(CONTROL_FILE)).unwrap();
        put(d.path(), &record(1, 1));
        let found = discover(&dirs, &foreign, &alive);
        assert!(found.candidates.is_empty());
        assert!(found.obstacles[0].contains("another user"));

        // A record that's not a readable file, and a directory that's not a directory.
        let e = tempfile::tempdir().unwrap();
        fs::create_dir_all(e.path().join(CONTROL_FILE)).unwrap();
        fs::write(e.path().join(INSTANCES), "a file").unwrap();
        let found = discover(&[e.path().to_path_buf()], &here(), &alive);
        assert_eq!(found.obstacles.len(), 2);
        assert!(found.obstacles.iter().all(|o| o.contains("couldn't read")));
        assert!(read_record(&e.path().join(INSTANCES).join("x"), &here()).unwrap_err().contains("couldn't read"));
    }

    #[test]
    fn says_when_an_app_is_out_of_reach() {
        let d = tempfile::tempdir().unwrap();
        put(d.path(), &Record { net_ns: Some("net:[9]".into()), ..record(7, 1) });
        put(d.path(), &Record { boot_id: Some("old".into()), host: Some("other".into()), ..record(8, 1) });
        let found = discover(&[d.path().to_path_buf()], &here(), &alive);
        assert!(found.candidates.is_empty());
        assert_eq!(found.obstacles.len(), 1);
        assert!(found.obstacles[0].contains("PID 7") && found.obstacles[0].contains("network namespace"));
    }

    #[test]
    fn publishes_privately_restores_and_retires() {
        let (a, b) = (tempfile::tempdir().unwrap(), tempfile::tempdir().unwrap());
        let dirs = vec![a.path().join("peak"), b.path().join("peak")];
        let h = Here::detect();
        let p = Publication::new("127.0.0.1:9".into(), "sek".into(), &dirs, &h);
        assert!(p.publish().is_empty());
        let inst = &p.instance_files[0];
        assert_eq!(fs::metadata(inst).unwrap().permissions().mode() & 0o777, 0o600);
        assert_eq!(fs::metadata(inst.parent().unwrap()).unwrap().permissions().mode() & 0o777, 0o700);
        assert_eq!(fs::metadata(dirs[1].join(CONTROL_FILE)).unwrap().permissions().mode() & 0o777, 0o600);

        // It's found through the real process table, from either directory.
        for d in &dirs {
            let found = discover(std::slice::from_ref(d), &h, &start_ticks);
            assert_eq!(found.candidates[0].standing, Standing::Live);
            assert_eq!(found.candidates[0].record.secret, "sek");
        }
        prune(&dirs, &h);
        assert!(inst.exists(), "a live app's record stays");

        // Something removed them while it stays open. Existing ones aren't rewritten.
        fs::remove_dir_all(&dirs[0]).unwrap();
        let before = fs::metadata(&p.instance_files[1]).unwrap().modified().unwrap();
        assert!(p.ensure().is_empty());
        assert!(inst.exists() && dirs[0].join(CONTROL_FILE).exists());
        assert_eq!(fs::metadata(&p.instance_files[1]).unwrap().modified().unwrap(), before);

        // Another app has taken over `control.json` in one place: closing leaves that alone.
        write_private(&dirs[0].join(CONTROL_FILE), &record(1, 1)).unwrap();
        p.retire();
        assert!(!inst.exists());
        assert!(dirs[0].join(CONTROL_FILE).exists());
        assert!(!dirs[1].join(CONTROL_FILE).exists());
    }

    #[test]
    fn reports_what_it_couldnt_publish() {
        let d = tempfile::tempdir().unwrap();
        fs::write(d.path().join("peak"), "a file").unwrap();
        let p = Publication::new("a".into(), "s".into(), &[d.path().join("peak")], &Here::detect());
        assert_eq!(p.publish().len(), 2);
        assert_eq!(p.ensure().len(), 2);
    }
}
