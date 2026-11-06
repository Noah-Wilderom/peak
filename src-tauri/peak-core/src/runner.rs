//! Spawning commands, streaming their output, and signalling process groups.

use std::io::{self, BufRead, BufReader, Read};
#[cfg(unix)]
use std::os::unix::process::{CommandExt, ExitStatusExt};
#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::PathBuf;
use std::process::{Command, ExitStatus, Stdio};
use std::thread;

use crate::model::{Status, Stream};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ExitInfo {
    pub code: Option<i32>,
    pub signal: Option<i32>,
}

impl From<ExitStatus> for ExitInfo {
    #[cfg(unix)]
    fn from(s: ExitStatus) -> Self {
        ExitInfo { code: s.code(), signal: s.signal() }
    }

    #[cfg(windows)]
    fn from(s: ExitStatus) -> Self {
        ExitInfo { code: s.code(), signal: None }
    }
}

pub fn signal_name(sig: i32) -> String {
    match sig {
        SIGHUP => "SIGHUP",
        SIGINT => "SIGINT",
        SIGQUIT => "SIGQUIT",
        SIGILL => "SIGILL",
        SIGABRT => "SIGABRT",
        SIGBUS => "SIGBUS",
        SIGFPE => "SIGFPE",
        SIGKILL => "SIGKILL",
        SIGSEGV => "SIGSEGV",
        SIGPIPE => "SIGPIPE",
        SIGTERM => "SIGTERM",
        _ => return format!("signal {sig}"),
    }
    .to_string()
}

/// Signal numbers. Windows has no signals, but the rest of Peak speaks in them, and
/// `signal_group` turns them into what Windows can do.
#[cfg(unix)]
pub use libc::{SIGABRT, SIGBUS, SIGFPE, SIGHUP, SIGILL, SIGINT, SIGKILL, SIGPIPE, SIGQUIT, SIGSEGV, SIGTERM};
#[cfg(windows)]
pub const SIGHUP: i32 = 1;
#[cfg(windows)]
pub const SIGINT: i32 = 2;
#[cfg(windows)]
pub const SIGQUIT: i32 = 3;
#[cfg(windows)]
pub const SIGILL: i32 = 4;
#[cfg(windows)]
pub const SIGABRT: i32 = 6;
#[cfg(windows)]
pub const SIGBUS: i32 = 7;
#[cfg(windows)]
pub const SIGFPE: i32 = 8;
#[cfg(windows)]
pub const SIGKILL: i32 = 9;
#[cfg(windows)]
pub const SIGSEGV: i32 = 11;
#[cfg(windows)]
pub const SIGPIPE: i32 = 13;
#[cfg(windows)]
pub const SIGTERM: i32 = 15;

/// Decide how a process ended. Signals we sent ourselves (a requested stop)
/// count as a clean exit; anything else killed by a signal, or a non-zero
/// exit code, is a crash.
pub fn classify_exit(info: ExitInfo, stop_requested: bool) -> (Status, Option<i32>, Option<String>) {
    match (info.code, info.signal) {
        (_, Some(sig)) => {
            let ours = stop_requested && matches!(sig, SIGINT | SIGTERM | SIGKILL);
            (if ours { Status::Exited } else { Status::Crashed }, None, Some(signal_name(sig)))
        }
        (Some(code), None) => {
            // Shells report "killed by signal N" as 128 + N.
            if code > 128 && code < 128 + 32 {
                let sig = code - 128;
                let ours = stop_requested && matches!(sig, SIGINT | SIGTERM | SIGKILL);
                return (if ours { Status::Exited } else { Status::Crashed }, Some(code), Some(signal_name(sig)));
            }
            (if code == 0 || stop_requested { Status::Exited } else { Status::Crashed }, Some(code), None)
        }
        (None, None) => (Status::Exited, None, None),
    }
}

/// Expand a leading `~` using `home`.
pub fn expand_tilde(path: &str, home: Option<&str>) -> PathBuf {
    match (path.strip_prefix('~'), home) {
        (Some(rest), Some(h)) if rest.is_empty() || rest.starts_with('/') => PathBuf::from(format!("{h}{rest}")),
        _ => PathBuf::from(if path.is_empty() { "." } else { path }),
    }
}

/// Read a stream line by line (lossy UTF-8, `\r` stripped) until EOF.
pub fn pump_lines<R: Read>(r: R, mut on_line: impl FnMut(String)) {
    let mut reader = BufReader::new(r);
    let mut buf = Vec::new();
    loop {
        buf.clear();
        match reader.read_until(b'\n', &mut buf) {
            Ok(0) | Err(_) => break,
            Ok(_) => {
                let line = String::from_utf8_lossy(&buf);
                on_line(line.trim_end_matches(['\n', '\r']).to_string());
            }
        }
    }
}

#[cfg(unix)]
/// Restore default handling of SIGINT/SIGTERM. Runs in the child between fork
/// and exec, so ignored signals in peak itself are not inherited.
pub fn reset_signals() -> io::Result<()> {
    // SAFETY: signal(2) is async-signal-safe.
    unsafe {
        libc::signal(libc::SIGINT, libc::SIG_DFL);
        libc::signal(libc::SIGTERM, libc::SIG_DFL);
    }
    Ok(())
}

/// What to run: a shell line, or a direct executable where there may be no shell.
#[derive(Debug, Clone, Copy)]
pub enum Program<'a> {
    Shell(&'a str),
    Argv(&'a [String]),
}

impl Program<'_> {
    fn command(self) -> Command {
        match self {
            Program::Shell(line) => shell_command(line),
            Program::Argv(argv) => {
                let mut c = host_command(&argv[0]);
                c.args(&argv[1..]);
                c
            }
        }
    }
}

/// `line` as the platform's shell runs it.
#[cfg(unix)]
pub fn shell_command(line: &str) -> Command {
    let mut c = host_command("/bin/sh");
    c.arg("-c").arg(line);
    c
}

/// `line` as the platform's shell runs it. Passed through untouched, because `cmd` has
/// quoting rules of its own that the usual argument escaping would break.
#[cfg(windows)]
pub fn shell_command(line: &str) -> Command {
    let mut c = host_command("cmd");
    c.arg("/S").arg("/C").raw_arg(format!("\"{line}\""));
    c
}

/// Set by an AppImage's launcher for the app itself, whatever they hold.
const APPIMAGE_ONLY: [&str; 5] = ["APPDIR", "APPIMAGE", "ARGV0", "OWD", "GDK_BACKEND"];

/// How to undo an AppImage's environment: variables to remove, and path lists to replace.
/// Everything pointing into the mounted image is there for this app's own libraries, and
/// would break anything else run with it.
pub fn appimage_env_fixes(vars: impl Iterator<Item = (String, String)>) -> Vec<(String, Option<String>)> {
    let vars: Vec<_> = vars.collect();
    let Some(appdir) = vars.iter().find(|(k, _)| k == "APPDIR").map(|(_, v)| v.clone()).filter(|d| !d.is_empty())
    else {
        return vec![];
    };
    vars.iter()
        .filter_map(|(k, v)| {
            if APPIMAGE_ONLY.contains(&k.as_str()) {
                return Some((k.clone(), None));
            }
            if !v.contains(&appdir) {
                return None;
            }
            let kept: Vec<&str> = v.split(':').filter(|p| !p.is_empty() && !p.contains(&appdir)).collect();
            Some((k.clone(), (!kept.is_empty()).then(|| kept.join(":"))))
        })
        .collect()
}

/// A command for something outside this app, with the environment it would have had if
/// the app weren't running from an AppImage.
pub fn host_command(program: impl AsRef<std::ffi::OsStr>) -> Command {
    let mut c = Command::new(program);
    let vars = std::env::vars_os().filter_map(|(k, v)| Some((k.into_string().ok()?, v.into_string().ok()?)));
    apply_env_fixes(&mut c, appimage_env_fixes(vars));
    c
}

fn apply_env_fixes(c: &mut Command, fixes: Vec<(String, Option<String>)>) {
    for (k, v) in fixes {
        match v {
            Some(v) => c.env(k, v),
            None => c.env_remove(k),
        };
    }
}

/// Give the child its own process group, so it can be stopped with what it started.
#[cfg(unix)]
fn isolate(cmd: &mut Command) {
    cmd.process_group(0);
    // SAFETY: reset_signals only calls async-signal-safe functions.
    unsafe { cmd.pre_exec(reset_signals) };
}

/// Give the child its own process group, and no console window of its own.
#[cfg(windows)]
fn isolate(cmd: &mut Command) {
    const CREATE_NEW_PROCESS_GROUP: u32 = 0x0000_0200;
    const CREATE_NO_WINDOW: u32 = 0x0800_0000;
    cmd.creation_flags(CREATE_NEW_PROCESS_GROUP | CREATE_NO_WINDOW);
}

/// Spawn a program in its own process group. Output lines and the final exit are
/// delivered via callbacks from background threads.
pub fn spawn<L, E>(
    program: Program<'_>,
    cwd: &PathBuf,
    env: &[(String, String)],
    on_line: L,
    on_exit: E,
) -> io::Result<u32>
where
    L: Fn(Stream, String) + Send + Sync + Clone + 'static,
    E: FnOnce(ExitInfo) + Send + 'static,
{
    let mut cmd = program.command();
    cmd.current_dir(cwd)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    isolate(&mut cmd);
    let mut child = cmd.spawn()?;
    let pid = child.id();

    let out = child.stdout.take().expect("piped stdout");
    let err = child.stderr.take().expect("piped stderr");
    let l1 = on_line.clone();
    let t_out = thread::spawn(move || pump_lines(out, |line| l1(Stream::Stdout, line)));
    let t_err = thread::spawn(move || pump_lines(err, |line| on_line(Stream::Stderr, line)));

    thread::spawn(move || {
        let status = child.wait().map(ExitInfo::from).unwrap_or(ExitInfo { code: None, signal: None });
        // Let buffered output land first, unless a grandchild holds the pipes open.
        for t in [t_out, t_err] {
            let deadline = std::time::Instant::now() + std::time::Duration::from_millis(300);
            while !t.is_finished() && std::time::Instant::now() < deadline {
                thread::sleep(std::time::Duration::from_millis(5));
            }
        }
        on_exit(status);
    });
    Ok(pid)
}

/// Send `sig` to a whole process group.
#[cfg(unix)]
pub fn signal_group(pgid: u32, sig: i32) -> bool {
    // SAFETY: kill(2) with a negative pid targets a process group.
    unsafe { libc::kill(-(pgid as i32), sig) == 0 }
}

#[cfg(unix)]
pub fn signal_pid(pid: u32, sig: i32) -> bool {
    // SAFETY: plain kill(2).
    unsafe { libc::kill(pid as i32, sig) == 0 }
}

#[cfg(unix)]
pub fn alive(pid: u32) -> bool {
    signal_pid(pid, 0)
}

/// The nearest Windows has: SIGKILL ends the process tree now; anything else asks it to close.
/// A program with no window can't be asked, and taskkill says so, so that ends it outright:
/// on Windows such a program gets no chance to clean up when stopped.
#[cfg(windows)]
fn taskkill(pid: u32, tree: bool, force: bool) -> bool {
    let mut c = Command::new("taskkill");
    c.arg("/PID").arg(pid.to_string()).stdout(Stdio::null()).stderr(Stdio::null());
    c.creation_flags(0x0800_0000);
    if tree {
        c.arg("/T");
    }
    if force {
        c.arg("/F");
    }
    c.status().is_ok_and(|s| s.success())
}

#[cfg(windows)]
pub fn signal_group(pid: u32, sig: i32) -> bool {
    (sig != SIGKILL && taskkill(pid, true, false)) || taskkill(pid, true, true)
}

#[cfg(windows)]
pub fn signal_pid(pid: u32, sig: i32) -> bool {
    (sig != SIGKILL && taskkill(pid, false, false)) || taskkill(pid, false, true)
}

#[cfg(windows)]
pub fn alive(pid: u32) -> bool {
    use windows_sys::Win32::Foundation::CloseHandle;
    use windows_sys::Win32::System::Threading::{GetExitCodeProcess, OpenProcess, PROCESS_QUERY_LIMITED_INFORMATION};
    const STILL_ACTIVE: u32 = 259;
    // SAFETY: the handle is checked and closed; the code is a local.
    unsafe {
        let h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, 0, pid);
        if h.is_null() {
            return false;
        }
        let mut code = 0;
        let ok = GetExitCodeProcess(h, &mut code) != 0;
        CloseHandle(h);
        ok && code == STILL_ACTIVE
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;

    #[test]
    fn undoes_an_appimages_environment() {
        let vars = |list: &[(&str, &str)]| list.iter().map(|(k, v)| (k.to_string(), v.to_string())).collect::<Vec<_>>();
        let mut fixes = appimage_env_fixes(
            vars(&[
                ("APPDIR", "/tmp/.mount_x"),
                ("APPIMAGE", "/home/me/peak"),
                ("OWD", "/work"),
                ("LD_LIBRARY_PATH", "/tmp/.mount_x/usr/lib"),
                ("PATH", "/tmp/.mount_x/usr/bin:/usr/bin:/bin"),
                ("GTK_DATA_PREFIX", "/tmp/.mount_x/usr"),
                ("HOME", "/home/me"),
            ])
            .into_iter(),
        );
        fixes.sort();
        assert_eq!(
            fixes,
            vec![
                ("APPDIR".to_string(), None),
                ("APPIMAGE".to_string(), None),
                ("GTK_DATA_PREFIX".to_string(), None),
                ("LD_LIBRARY_PATH".to_string(), None),
                ("OWD".to_string(), None),
                ("PATH".to_string(), Some("/usr/bin:/bin".to_string())),
            ]
        );
        // Outside an AppImage there's nothing to undo.
        assert!(appimage_env_fixes(vars(&[("PATH", "/usr/bin"), ("OWD", "/x")]).into_iter()).is_empty());
        assert!(appimage_env_fixes(vars(&[("APPDIR", "")]).into_iter()).is_empty());
    }

    #[test]
    fn applies_the_fixes_to_a_command() {
        let mut c = Command::new("/bin/sh");
        c.args(["-c", "echo \"$FIXED|$GONE\""]).env("GONE", "here");
        apply_env_fixes(&mut c, vec![("FIXED".into(), Some("/usr/bin".into())), ("GONE".into(), None)]);
        let out = c.output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "/usr/bin|");
    }

    #[test]
    fn host_commands_run() {
        let out = host_command("/bin/sh").args(["-c", "echo ok"]).output().unwrap();
        assert_eq!(String::from_utf8_lossy(&out.stdout).trim(), "ok");
    }
    use std::sync::mpsc;
    use std::sync::{Arc, Mutex};
    use std::thread;
    use std::time::Duration;

    fn ignore_line(_: Stream, _: String) {}
    fn ignore_exit(_: ExitInfo) {}

    #[test]
    fn names_signals() {
        ignore_line(Stream::Stdout, String::new());
        ignore_exit(ExitInfo { code: None, signal: None });
        assert_eq!(signal_name(SIGKILL), "SIGKILL");
        assert_eq!(signal_name(SIGSEGV), "SIGSEGV");
        for s in [SIGHUP, SIGINT, SIGQUIT, SIGILL, SIGABRT, SIGBUS, SIGFPE, SIGPIPE, SIGTERM] {
            assert!(signal_name(s).starts_with("SIG"));
        }
        assert_eq!(signal_name(63), "signal 63");
    }

    #[test]
    fn classifies_exits() {
        let e = |code, signal| ExitInfo { code, signal };
        assert_eq!(classify_exit(e(Some(0), None), false), (Status::Exited, Some(0), None));
        assert_eq!(classify_exit(e(Some(2), None), false), (Status::Crashed, Some(2), None));
        assert_eq!(classify_exit(e(Some(2), None), true), (Status::Exited, Some(2), None));
        assert_eq!(classify_exit(e(None, Some(9)), false), (Status::Crashed, None, Some("SIGKILL".into())));
        assert_eq!(classify_exit(e(None, Some(2)), true), (Status::Exited, None, Some("SIGINT".into())));
        assert_eq!(classify_exit(e(None, Some(11)), true), (Status::Crashed, None, Some("SIGSEGV".into())));
        assert_eq!(classify_exit(e(Some(137), None), false), (Status::Crashed, Some(137), Some("SIGKILL".into())));
        assert_eq!(classify_exit(e(Some(130), None), true), (Status::Exited, Some(130), Some("SIGINT".into())));
        assert_eq!(classify_exit(e(None, None), false), (Status::Exited, None, None));
    }

    #[test]
    fn expands_tilde() {
        assert_eq!(expand_tilde("~", Some("/home/n")), PathBuf::from("/home/n"));
        assert_eq!(expand_tilde("~/dev", Some("/home/n")), PathBuf::from("/home/n/dev"));
        assert_eq!(expand_tilde("~other", Some("/home/n")), PathBuf::from("~other"));
        assert_eq!(expand_tilde("~/dev", None), PathBuf::from("~/dev"));
        assert_eq!(expand_tilde("/tmp", Some("/home/n")), PathBuf::from("/tmp"));
        assert_eq!(expand_tilde("", None), PathBuf::from("."));
    }

    #[test]
    fn pumps_lines_lossily() {
        let mut lines = vec![];
        pump_lines(&b"one\r\ntwo\n\xffthree"[..], |l| lines.push(l));
        assert_eq!(lines, vec!["one", "two", "\u{fffd}three"]);
    }

    fn run(cmd: &str) -> (Vec<(Stream, String)>, ExitInfo) {
        let lines = Arc::new(Mutex::new(vec![]));
        let (tx, rx) = mpsc::channel();
        let l = lines.clone();
        spawn(
            Program::Shell(cmd),
            &PathBuf::from("/tmp"),
            &[("PEAK_TEST".into(), "yes".into())],
            move |s, t| l.lock().unwrap().push((s, t)),
            move |e| tx.send(e).unwrap(),
        )
        .unwrap();
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        let out = lines.lock().unwrap().clone();
        (out, exit)
    }

    #[test]
    fn spawns_and_captures_output() {
        let (lines, exit) = run("echo out; echo err >&2; echo $PEAK_TEST; pwd; exit 3");
        assert_eq!(exit, ExitInfo { code: Some(3), signal: None });
        assert!(lines.contains(&(Stream::Stdout, "out".into())));
        assert!(lines.contains(&(Stream::Stderr, "err".into())));
        assert!(lines.contains(&(Stream::Stdout, "yes".into())));
        assert!(lines.contains(&(Stream::Stdout, "/tmp".into())));
    }

    #[test]
    fn signals_process_groups() {
        let (tx, rx) = mpsc::channel();
        let pid =
            spawn(Program::Shell("sleep 30"), &PathBuf::from("/tmp"), &[], ignore_line, move |e| tx.send(e).unwrap())
                .unwrap();
        assert!(alive(pid));
        assert!(signal_group(pid, SIGTERM));
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(exit.signal, Some(SIGTERM));
        assert!(!signal_pid(pid, 0) || !alive(pid));
        assert!(!signal_group(999_999, SIGTERM));
    }

    #[test]
    fn spawn_fails_for_missing_cwd() {
        assert!(
            spawn(Program::Shell("true"), &PathBuf::from("/definitely/missing"), &[], ignore_line, ignore_exit)
                .is_err()
        );
        let argv = vec!["/definitely/missing".to_string()];
        assert!(spawn(Program::Argv(&argv), &PathBuf::from("/tmp"), &[], ignore_line, ignore_exit).is_err());
    }

    #[test]
    fn resets_signals_and_children_get_sigint() {
        reset_signals().unwrap();
        // Even if the parent ignores SIGINT, spawned groups still die from it.
        let (tx, rx) = mpsc::channel();
        let pid =
            spawn(Program::Shell("sleep 30"), &PathBuf::from("/tmp"), &[], ignore_line, move |e| tx.send(e).unwrap())
                .unwrap();
        thread::sleep(Duration::from_millis(50));
        signal_group(pid, SIGINT);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().signal, Some(SIGINT));
    }

    #[test]
    fn exit_info_from_status() {
        let s = Command::new("/bin/sh").args(["-c", "exit 4"]).status().unwrap();
        assert_eq!(ExitInfo::from(s), ExitInfo { code: Some(4), signal: None });
    }
}
