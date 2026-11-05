//! Spawning commands, streaming their output, and signalling process groups.

use std::io::{self, BufRead, BufReader, Read};
use std::os::unix::process::{CommandExt, ExitStatusExt};
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
    fn from(s: ExitStatus) -> Self {
        ExitInfo { code: s.code(), signal: s.signal() }
    }
}

pub fn signal_name(sig: i32) -> String {
    match sig {
        libc::SIGHUP => "SIGHUP",
        libc::SIGINT => "SIGINT",
        libc::SIGQUIT => "SIGQUIT",
        libc::SIGILL => "SIGILL",
        libc::SIGABRT => "SIGABRT",
        libc::SIGBUS => "SIGBUS",
        libc::SIGFPE => "SIGFPE",
        libc::SIGKILL => "SIGKILL",
        libc::SIGSEGV => "SIGSEGV",
        libc::SIGPIPE => "SIGPIPE",
        libc::SIGTERM => "SIGTERM",
        _ => return format!("signal {sig}"),
    }
    .to_string()
}

/// Decide how a process ended. Signals we sent ourselves (a requested stop)
/// count as a clean exit; anything else killed by a signal, or a non-zero
/// exit code, is a crash.
pub fn classify_exit(info: ExitInfo, stop_requested: bool) -> (Status, Option<i32>, Option<String>) {
    match (info.code, info.signal) {
        (_, Some(sig)) => {
            let ours = stop_requested && matches!(sig, libc::SIGINT | libc::SIGTERM | libc::SIGKILL);
            (if ours { Status::Exited } else { Status::Crashed }, None, Some(signal_name(sig)))
        }
        (Some(code), None) => {
            // Shells report "killed by signal N" as 128 + N.
            if code > 128 && code < 128 + 32 {
                let sig = code - 128;
                let ours = stop_requested && matches!(sig, libc::SIGINT | libc::SIGTERM | libc::SIGKILL);
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

/// Spawn `command` through `sh -c` in its own process group. Output lines and
/// the final exit are delivered via callbacks from background threads.
pub fn spawn<L, E>(command: &str, cwd: &PathBuf, env: &[(String, String)], on_line: L, on_exit: E) -> io::Result<u32>
where
    L: Fn(Stream, String) + Send + Sync + Clone + 'static,
    E: FnOnce(ExitInfo) + Send + 'static,
{
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c")
        .arg(command)
        .current_dir(cwd)
        .envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())))
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .process_group(0);
    // SAFETY: reset_signals only calls async-signal-safe functions.
    unsafe { cmd.pre_exec(reset_signals) };
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
pub fn signal_group(pgid: u32, sig: i32) -> bool {
    // SAFETY: kill(2) with a negative pid targets a process group.
    unsafe { libc::kill(-(pgid as i32), sig) == 0 }
}

pub fn signal_pid(pid: u32, sig: i32) -> bool {
    // SAFETY: plain kill(2).
    unsafe { libc::kill(pid as i32, sig) == 0 }
}

pub fn alive(pid: u32) -> bool {
    signal_pid(pid, 0)
}

#[cfg(test)]
mod tests {
    use super::*;
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
        assert_eq!(signal_name(libc::SIGKILL), "SIGKILL");
        assert_eq!(signal_name(libc::SIGSEGV), "SIGSEGV");
        for s in [
            libc::SIGHUP,
            libc::SIGINT,
            libc::SIGQUIT,
            libc::SIGILL,
            libc::SIGABRT,
            libc::SIGBUS,
            libc::SIGFPE,
            libc::SIGPIPE,
            libc::SIGTERM,
        ] {
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
            cmd,
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
        let pid = spawn("sleep 30", &PathBuf::from("/tmp"), &[], ignore_line, move |e| tx.send(e).unwrap()).unwrap();
        assert!(alive(pid));
        assert!(signal_group(pid, libc::SIGTERM));
        let exit = rx.recv_timeout(Duration::from_secs(10)).unwrap();
        assert_eq!(exit.signal, Some(libc::SIGTERM));
        assert!(!signal_pid(pid, 0) || !alive(pid));
        assert!(!signal_group(999_999, libc::SIGTERM));
    }

    #[test]
    fn spawn_fails_for_missing_cwd() {
        assert!(spawn("true", &PathBuf::from("/definitely/missing"), &[], ignore_line, ignore_exit).is_err());
    }

    #[test]
    fn resets_signals_and_children_get_sigint() {
        reset_signals().unwrap();
        // Even if the parent ignores SIGINT, spawned groups still die from it.
        let (tx, rx) = mpsc::channel();
        let pid = spawn("sleep 30", &PathBuf::from("/tmp"), &[], ignore_line, move |e| tx.send(e).unwrap()).unwrap();
        thread::sleep(Duration::from_millis(50));
        signal_group(pid, libc::SIGINT);
        assert_eq!(rx.recv_timeout(Duration::from_secs(5)).unwrap().signal, Some(libc::SIGINT));
    }

    #[test]
    fn exit_info_from_status() {
        let s = Command::new("/bin/sh").args(["-c", "exit 4"]).status().unwrap();
        assert_eq!(ExitInfo::from(s), ExitInfo { code: Some(4), signal: None });
    }
}
