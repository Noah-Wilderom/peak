//! `peak run -- <command>`: run a command in the terminal while streaming it
//! to the peak app (output is tee'd, the exit status is forwarded).

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpStream;
use std::os::unix::process::ExitStatusExt;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::discovery::{Candidate, Here, Record, Standing, discover, start_ticks};
use crate::runner::pump_lines;
use std::os::unix::process::CommandExt;

#[derive(Debug, PartialEq, Eq)]
pub enum Cli {
    Run(String),
    Collector,
    Help,
}

pub const USAGE: &str = "usage: peak run [--] <command> [args…]\n       peak collector\n\nrun: runs <command> and streams its memory, CPU and output to the peak app.\ncollector: shows the collector this build copies to remote targets.";

/// `None` means "no CLI arguments — start the desktop app".
pub fn parse_args(args: &[String]) -> Option<Cli> {
    let (first, rest) = args.split_first()?;
    match first.as_str() {
        "run" => {
            let rest = if rest.first().map(String::as_str) == Some("--") { &rest[1..] } else { rest };
            if rest.is_empty() { Some(Cli::Help) } else { Some(Cli::Run(shell_join(rest))) }
        }
        "collector" => Some(Cli::Collector),
        "help" | "--help" | "-h" => Some(Cli::Help),
        // Tauri/WebKit may pass its own flags; anything unknown starts the app.
        _ => None,
    }
}

/// Quote arguments for `sh -c` so `peak run -- node "my file.js"` round-trips.
pub fn shell_join(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if !a.is_empty() && a.chars().all(|c| c.is_ascii_alphanumeric() || "-_./=:,+@%^".contains(c)) {
                a.clone()
            } else {
                format!("'{}'", a.replace('\'', "'\\''"))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Exit code a shell would report for a status.
pub fn exit_code(code: Option<i32>, signal: Option<i32>) -> i32 {
    match (code, signal) {
        (Some(c), _) => c,
        (None, Some(s)) => 128 + s,
        (None, None) => 1,
    }
}

struct Link {
    stream: Mutex<TcpStream>,
}

impl Link {
    fn send(&self, msg: Value) {
        let mut s = self.stream.lock().unwrap();
        let _ = writeln!(s, "{msg}");
    }
}

type Env = Vec<(String, String)>;

/// How long an app gets to answer. Only a frozen app makes a command wait this long.
const ANSWER_TIMEOUT: Duration = Duration::from_secs(3);

/// Why one app couldn't take this command.
#[derive(Debug, PartialEq)]
enum Failure {
    Refused(String),
    NoAnswer,
    Rejected,
    BadReply,
}

impl From<io::Error> for Failure {
    fn from(e: io::Error) -> Failure {
        match e.kind() {
            io::ErrorKind::WouldBlock | io::ErrorKind::TimedOut => Failure::NoAnswer,
            _ => Failure::Refused(e.to_string()),
        }
    }
}

/// Register the command with one app. Returns the link and the child's environment (agent variables).
fn register_with(record: &Record, command: &str, cwd: &str) -> Result<(Arc<Link>, Env), Failure> {
    let addr = record.addr.parse().map_err(|_| Failure::BadReply)?;
    let stream = TcpStream::connect_timeout(&addr, ANSWER_TIMEOUT)?;
    stream.set_read_timeout(Some(ANSWER_TIMEOUT))?;
    let mut w = stream.try_clone()?;
    writeln!(w, "{}", json!({ "type": "register", "secret": record.secret, "command": command, "cwd": cwd }))?;
    let mut line = String::new();
    let read = BufReader::new(stream.try_clone()?).read_line(&mut line)?;
    // An older app closes the connection on a wrong secret instead of answering.
    if read == 0 {
        return Err(Failure::Rejected);
    }
    let reply: Value = serde_json::from_str(&line).map_err(|_| Failure::BadReply)?;
    match reply["type"].as_str() {
        Some("registered") => {}
        Some("rejected") => return Err(Failure::Rejected),
        _ => return Err(Failure::BadReply),
    }
    let env = reply["env"]
        .as_array()
        .map(|kv| kv.iter().filter_map(|p| Some((p[0].as_str()?.to_string(), p[1].as_str()?.to_string()))).collect())
        .unwrap_or_default();
    stream.set_read_timeout(None)?;
    Ok((Arc::new(Link { stream: Mutex::new(stream) }), env))
}

/// What to tell the user about an app that couldn't take the command. `None`: an older
/// app's record with nothing listening, which just means that app has gone.
fn describe(c: &Candidate, failure: &Failure) -> Option<String> {
    let addr = &c.record.addr;
    Some(match (c.standing, c.record.pid, failure) {
        (Standing::Live, Some(pid), Failure::NoAnswer) => format!("the app is open (PID {pid}) but isn't answering"),
        (Standing::Live, Some(pid), Failure::Refused(e)) => {
            format!("the app is open (PID {pid}) but can't be reached at {addr}: {e}")
        }
        (Standing::Live, Some(pid), Failure::Rejected) => format!("the app (PID {pid}) turned this connection away"),
        (Standing::Live, Some(pid), Failure::BadReply) => {
            format!("the app (PID {pid}) gave a reply this version can't read")
        }
        (_, _, Failure::Refused(_)) => return None,
        (_, _, Failure::NoAnswer) => format!("something at {addr}, from {}, isn't answering", c.path.display()),
        (_, _, Failure::Rejected) => format!("the app at {addr} turned this connection away"),
        (_, _, Failure::BadReply) => {
            format!("something at {addr}, from {}, doesn't answer like Peak", c.path.display())
        }
    })
}

/// Find an open app and register with it, or say exactly why not.
fn connect(
    dirs: &[PathBuf],
    here: &Here,
    command: &str,
    cwd: &str,
) -> Result<(Arc<Link>, Env, Option<String>), String> {
    let found = discover(dirs, here, &start_ticks);
    let mut problems = found.obstacles;
    let apps = found.candidates.iter().filter(|c| c.standing == Standing::Live).count();
    let mut failed = vec![];
    for c in &found.candidates {
        match register_with(&c.record, command, cwd) {
            Ok((link, env)) => {
                let note = (apps > 1).then(|| {
                    format!("{apps} Peak apps are open; this run is in the one with PID {}", c.record.pid.unwrap_or(0))
                });
                return Ok((link, env, note));
            }
            Err(f) => failed.extend(describe(c, &f)),
        }
    }
    // An app that failed to answer says more than a record that couldn't be read.
    failed.append(&mut problems);
    Err(failed
        .into_iter()
        .next()
        .unwrap_or_else(|| format!("the app isn't running on {} for {}", here.host, here.user)))
}

/// Run `command`; output goes to `out`/`err` (the terminal) and, when an app
/// can take it, to peak as well. Returns the exit code to propagate.
pub fn run<O, E>(command: &str, dirs: &[PathBuf], out: O, err: E) -> io::Result<i32>
where
    O: Write + Send + 'static,
    E: Write + Send + 'static,
{
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
    let mut err = err;
    let link = match connect(dirs, &Here::detect(), command, &cwd) {
        Ok((link, env, note)) => {
            if let Some(note) = note {
                writeln!(err, "peak: {note}")?;
            }
            Some((link, env))
        }
        Err(why) => {
            writeln!(err, "peak: {why} — running without monitoring")?;
            None
        }
    };
    let mut cmd = Command::new("/bin/sh");
    cmd.arg("-c").arg(command).stdin(Stdio::inherit()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some((_, env)) = &link {
        cmd.envs(env.iter().map(|(k, v)| (k.as_str(), v.as_str())));
    }
    // SAFETY: reset_signals only calls async-signal-safe functions.
    unsafe { cmd.pre_exec(crate::runner::reset_signals) };
    let mut child = cmd.spawn()?;
    // Ctrl-C goes to the child; we stay alive to report how it ended.
    // SAFETY: setting a signal disposition has no preconditions.
    let prev = unsafe { libc::signal(libc::SIGINT, libc::SIG_IGN) };
    if let Some((l, _)) = &link {
        l.send(json!({ "type": "started", "pid": child.id() }));
    }

    let tee = |r: Box<dyn io::Read + Send>, mut w: Box<dyn Write + Send>, stream: &'static str| {
        let l = link.as_ref().map(|(l, _)| l.clone());
        thread::spawn(move || {
            pump_lines(r, |line| {
                let _ = writeln!(w, "{line}");
                let _ = w.flush();
                if let Some(l) = &l {
                    l.send(json!({ "type": "log", "stream": stream, "text": line }));
                }
            })
        })
    };
    let t1 = tee(Box::new(child.stdout.take().expect("stdout")), Box::new(out), "stdout");
    let t2 = tee(Box::new(child.stderr.take().expect("stderr")), Box::new(err), "stderr");
    let status = child.wait()?;
    let _ = t1.join();
    let _ = t2.join();
    // SAFETY: restoring the previous disposition.
    unsafe { libc::signal(libc::SIGINT, prev) };

    if let Some((l, _)) = &link {
        l.send(json!({ "type": "exit", "code": status.code(), "signal": status.signal() }));
    }
    Ok(exit_code(status.code(), status.signal()))
}

pub fn main(cli: Cli, dirs: &[PathBuf]) -> i32 {
    match cli {
        Cli::Help => {
            println!("{USAGE}");
            0
        }
        Cli::Collector => {
            let arch = std::env::consts::ARCH;
            match crate::transport::local_collector(&crate::transport::Tools::default(), arch) {
                Ok(path) => {
                    let version = Command::new(&path).arg("version").output();
                    let version = version.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
                    println!("{arch}: {} ({})", path.display(), version.unwrap_or_else(|e| e.to_string()));
                    0
                }
                Err(e) => {
                    eprintln!("peak: {e}");
                    1
                }
            }
        }
        Cli::Run(command) => match run(&command, dirs, io::stdout(), io::stderr()) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("peak: {e}");
                127
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::discovery::{Publication, default_dirs};
    use crate::hub::Hub;
    use crate::model::Status;
    use crate::monitor::{AgentEnv, Monitor};
    use crate::procfs::ProcFs;

    fn ignore_proc(_: crate::model::Proc) {}

    /// A record as an older app wrote it: an address, a secret and nothing to verify.
    fn old_record(dir: &std::path::Path, addr: String, secret: &str) -> Vec<PathBuf> {
        std::fs::write(dir.join("control.json"), json!({ "addr": addr, "secret": secret }).to_string()).unwrap();
        vec![dir.to_path_buf()]
    }

    /// This test process, published as an open app.
    fn publish(dir: &std::path::Path, addr: String, secret: &str) -> Vec<PathBuf> {
        let dirs = vec![dir.to_path_buf()];
        assert!(Publication::new(addr, secret.into(), &dirs, &Here::detect()).publish().is_empty());
        dirs
    }

    fn s(v: &[&str]) -> Vec<String> {
        v.iter().map(|x| x.to_string()).collect()
    }

    #[test]
    fn parses_arguments() {
        assert_eq!(parse_args(&[]), None);
        assert_eq!(parse_args(&s(&["--some-webkit-flag"])), None);
        assert_eq!(parse_args(&s(&["run"])), Some(Cli::Help));
        assert_eq!(parse_args(&s(&["run", "--"])), Some(Cli::Help));
        assert_eq!(parse_args(&s(&["help"])), Some(Cli::Help));
        assert_eq!(parse_args(&s(&["-h"])), Some(Cli::Help));
        assert_eq!(parse_args(&s(&["collector"])), Some(Cli::Collector));
        assert_eq!(parse_args(&s(&["run", "--", "bun", "run", "build"])), Some(Cli::Run("bun run build".into())));
        assert_eq!(parse_args(&s(&["run", "node", "my file.js"])), Some(Cli::Run("node 'my file.js'".into())));
    }

    #[test]
    fn quotes_for_the_shell() {
        assert_eq!(shell_join(&s(&["a", "", "it's", "x=1"])), "a '' 'it'\\''s' x=1");
    }

    #[test]
    fn computes_exit_codes() {
        assert_eq!(exit_code(Some(3), None), 3);
        assert_eq!(exit_code(None, Some(9)), 137);
        assert_eq!(exit_code(None, None), 1);
    }

    #[derive(Clone, Default)]
    struct Buf(Arc<Mutex<Vec<u8>>>);
    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> io::Result<()> {
            Ok(())
        }
    }
    impl Buf {
        fn text(&self) -> String {
            String::from_utf8(self.0.lock().unwrap().clone()).unwrap()
        }
    }

    #[test]
    fn runs_without_the_app() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        let (out, err) = (Buf::default(), Buf::default());
        let code = run("echo hi; echo bad >&2; exit 4", &dirs, out.clone(), err.clone()).unwrap();
        assert_eq!(code, 4);
        assert_eq!(out.text(), "hi\n");
        let here = Here::detect();
        assert!(err.text().starts_with(&format!(
            "peak: the app isn't running on {} for {} — running without monitoring\n",
            here.host, here.user
        )));
        assert!(err.text().contains("bad"));
        // An older app's record with nothing listening means the same.
        let err = Buf::default();
        old_record(dir.path(), "127.0.0.1:1".into(), "x");
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        assert!(err.text().contains("isn't running"));
    }

    #[test]
    fn tells_a_bad_record_from_no_app() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        std::fs::write(dir.path().join("control.json"), "{ not json").unwrap();
        let err = Buf::default();
        assert_eq!(run("exit 2", &dirs, Buf::default(), err.clone()).unwrap(), 2);
        assert!(err.text().contains("couldn't read") && err.text().contains("without monitoring"), "{}", err.text());
        let err = Buf::default();
        old_record(dir.path(), "not an addr".into(), "x");
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        assert!(err.text().contains("doesn't answer like Peak"), "{}", err.text());
    }

    #[test]
    fn describes_each_failure() {
        let live = Candidate {
            record: Record { addr: "a:1".into(), pid: Some(5), ..Default::default() },
            standing: Standing::Live,
            path: "/r".into(),
        };
        let old = Candidate { standing: Standing::Unverified, ..live.clone() };
        let said = |c: &Candidate, f: Failure| describe(c, &f);
        assert_eq!(said(&live, Failure::NoAnswer).unwrap(), "the app is open (PID 5) but isn't answering");
        assert!(said(&live, Failure::Refused("nope".into())).unwrap().contains("can't be reached at a:1: nope"));
        assert!(said(&live, Failure::Rejected).unwrap().contains("turned this connection away"));
        assert!(said(&live, Failure::BadReply).unwrap().contains("can't read"));
        assert_eq!(said(&old, Failure::Refused("nope".into())), None);
        assert!(said(&old, Failure::NoAnswer).unwrap().contains("isn't answering"));
        assert!(said(&old, Failure::Rejected).unwrap().contains("turned this connection away"));
        assert!(said(&old, Failure::BadReply).unwrap().contains("doesn't answer like Peak"));
        assert_eq!(Failure::from(io::Error::from(io::ErrorKind::WouldBlock)), Failure::NoAnswer);
    }

    #[test]
    fn reports_an_app_that_stopped_answering() {
        use std::net::TcpListener;
        let dir = tempfile::tempdir().unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        // Accepted by the kernel, never read: what a frozen app looks like.
        let dirs = publish(dir.path(), l.local_addr().unwrap().to_string(), "s");
        let err = Buf::default();
        assert_eq!(run("exit 6", &dirs, Buf::default(), err.clone()).unwrap(), 6);
        assert!(
            err.text().contains(&format!("the app is open (PID {}) but isn't answering", std::process::id())),
            "{}",
            err.text()
        );
        drop(l);
    }

    #[test]
    fn says_which_app_when_several_are_open() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m, "sek".into(), Arc::new(ignore_proc)).unwrap();
        let dirs = publish(dir.path(), hub.addr().to_string(), "sek");
        // A second live app in the records. It's this same process, under another name.
        let here = Here::detect();
        let second = Record {
            addr: "127.0.0.1:1".into(),
            secret: "other".into(),
            pid: Some(std::process::id()),
            start_ticks: start_ticks(std::process::id()),
            boot_id: Some(here.boot_id.clone()),
            pid_ns: Some(here.pid_ns.clone()),
            net_ns: Some(here.net_ns.clone()),
            host: Some(here.host.clone()),
            data_dir: Some("/elsewhere".into()),
            started_at: Some(1),
        };
        std::fs::write(dir.path().join("instances/other.json"), serde_json::to_string(&second).unwrap()).unwrap();
        let err = Buf::default();
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        assert!(
            err.text().starts_with(&format!(
                "peak: 2 Peak apps are open; this run is in the one with PID {}",
                std::process::id()
            )),
            "{}",
            err.text()
        );
    }

    #[test]
    fn passes_over_an_app_that_cant_take_it() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m.clone(), "sek".into(), Arc::new(ignore_proc)).unwrap();
        let dirs = publish(dir.path(), hub.addr().to_string(), "sek");
        let here = Here::detect();
        let closed = Record {
            addr: "127.0.0.1:1".into(),
            secret: "x".into(),
            pid: Some(std::process::id()),
            start_ticks: start_ticks(std::process::id()),
            boot_id: Some(here.boot_id.clone()),
            pid_ns: Some(here.pid_ns.clone()),
            net_ns: Some(here.net_ns.clone()),
            host: Some(here.host.clone()),
            data_dir: Some(dir.path().display().to_string()),
            started_at: Some(u64::MAX),
        };
        std::fs::write(dir.path().join("instances/first.json"), serde_json::to_string(&closed).unwrap()).unwrap();
        let err = Buf::default();
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        assert!(!err.text().contains("without monitoring"), "{}", err.text());
    }

    #[test]
    fn says_an_open_apps_port_is_closed() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = publish(dir.path(), "127.0.0.1:1".into(), "s");
        let err = Buf::default();
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        assert!(err.text().contains("but can't be reached at 127.0.0.1:1"), "{}", err.text());
        assert!(!default_dirs().is_empty());
    }

    #[test]
    fn streams_to_a_running_app() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv { addr: "127.0.0.1:9".into(), ..Default::default() }).shared();
        let hub = Hub::start(m.clone(), "sek".into(), Arc::new(ignore_proc)).unwrap();
        let dirs = publish(dir.path(), hub.addr().to_string(), "sek");
        let out = Buf::default();
        let code = run("echo $PEAK_AGENT_ADDR; echo line2", &dirs, out.clone(), Buf::default()).unwrap();
        assert_eq!(code, 0);
        assert_eq!(out.text(), "127.0.0.1:9\nline2\n");
        let ended = (0..200).find_map(|_| {
            let p = m.lock().unwrap().full_state().procs.into_iter().find(|p| p.status != Status::Running);
            thread::sleep(Duration::from_millis(10));
            p
        });
        let p = ended.expect("exit never arrived");
        assert_eq!(p.status, Status::Exited);
        assert!(p.logs.iter().any(|l| l.text == "line2"));
    }

    #[test]
    fn still_works_with_an_older_apps_record() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m, "sek".into(), Arc::new(ignore_proc)).unwrap();
        let dirs = old_record(dir.path(), hub.addr().to_string(), "sek");
        let err = Buf::default();
        assert_eq!(run("exit 3", &dirs, Buf::default(), err.clone()).unwrap(), 3);
        assert_eq!(err.text(), "");
    }

    #[test]
    fn wrong_secret_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m, "right".into(), Arc::new(ignore_proc)).unwrap();
        let dirs = publish(dir.path(), hub.addr().to_string(), "wrong");
        let err = Buf::default();
        assert_eq!(run("exit 0", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        assert!(err.text().contains("turned this connection away"), "{}", err.text());
        assert!(err.text().contains("without monitoring"));
    }

    #[test]
    fn an_older_app_hanging_up_counts_as_turned_away() {
        use std::net::TcpListener;
        let dir = tempfile::tempdir().unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let dirs = old_record(dir.path(), l.local_addr().unwrap().to_string(), "s");
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
        });
        let err = Buf::default();
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        server.join().unwrap();
        assert!(err.text().contains("turned this connection away"), "{}", err.text());
    }

    #[test]
    fn help_and_spawn_errors() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        assert_eq!(main(Cli::Help, &dirs), 0);
        #[cfg(peak_embedded_collector)]
        assert_eq!(main(Cli::Collector, &dirs), 0, "this build can name its collector");
        assert_eq!(main(Cli::Run("exit 5".into()), &dirs), 5);
        // A NUL byte can't be passed to exec.
        assert_eq!(main(Cli::Run("a\0b".into()), &dirs), 127);
    }

    #[test]
    fn unexpected_reply_falls_back() {
        use std::net::TcpListener;
        let dir = tempfile::tempdir().unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        let dirs = old_record(dir.path(), l.local_addr().unwrap().to_string(), "s");
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
            writeln!(&s, "{}", json!({"type": "nope"})).unwrap();
        });
        let err = Buf::default();
        assert_eq!(run("true", &dirs, Buf::default(), err.clone()).unwrap(), 0);
        server.join().unwrap();
        assert!(err.text().contains("doesn't answer like Peak"), "{}", err.text());
    }
}
