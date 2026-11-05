//! `peak run -- <command>`: run a command in the terminal while streaming it
//! to the peak app (output is tee'd, the exit status is forwarded).

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpStream;
use std::os::unix::process::ExitStatusExt;
use std::path::Path;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::hub::read_control_file;
use crate::runner::pump_lines;
use std::os::unix::process::CommandExt;

#[derive(Debug, PartialEq, Eq)]
pub enum Cli {
    Run(String),
    Help,
}

pub const USAGE: &str =
    "usage: peak run [--] <command> [args…]\n\nRuns <command> and streams its memory, CPU and output to the peak app.";

/// `None` means "no CLI arguments — start the desktop app".
pub fn parse_args(args: &[String]) -> Option<Cli> {
    let (first, rest) = args.split_first()?;
    match first.as_str() {
        "run" => {
            let rest = if rest.first().map(String::as_str) == Some("--") { &rest[1..] } else { rest };
            if rest.is_empty() { Some(Cli::Help) } else { Some(Cli::Run(shell_join(rest))) }
        }
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

/// Connect to a running app and register the command. Returns the link and
/// the environment for the child (agent variables).
fn register(data_dir: &Path, command: &str, cwd: &str) -> Option<(Arc<Link>, Env)> {
    let cf = read_control_file(data_dir)?;
    let addr = cf.addr.parse().ok()?;
    let stream = TcpStream::connect_timeout(&addr, Duration::from_millis(500)).ok()?;
    stream.set_read_timeout(Some(Duration::from_secs(2))).ok()?;
    let mut w = stream.try_clone().ok()?;
    writeln!(w, "{}", json!({ "type": "register", "secret": cf.secret, "command": command, "cwd": cwd })).ok()?;
    let mut line = String::new();
    BufReader::new(stream.try_clone().ok()?).read_line(&mut line).ok()?;
    let reply: Value = serde_json::from_str(&line).ok()?;
    if reply["type"] != "registered" {
        return None;
    }
    let env = reply["env"]
        .as_array()
        .map(|kv| kv.iter().filter_map(|p| Some((p[0].as_str()?.to_string(), p[1].as_str()?.to_string()))).collect())
        .unwrap_or_default();
    stream.set_read_timeout(None).ok()?;
    Some((Arc::new(Link { stream: Mutex::new(stream) }), env))
}

/// Run `command`; output goes to `out`/`err` (the terminal) and, when the app
/// is running, to peak as well. Returns the exit code to propagate.
pub fn run<O, E>(command: &str, data_dir: &Path, out: O, err: E) -> io::Result<i32>
where
    O: Write + Send + 'static,
    E: Write + Send + 'static,
{
    let cwd = std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default();
    let link = register(data_dir, command, &cwd);
    let mut err = err;
    if link.is_none() {
        writeln!(err, "peak: the app isn't running — running without monitoring")?;
    }
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

pub fn main(cli: Cli, data_dir: &Path) -> i32 {
    match cli {
        Cli::Help => {
            println!("{USAGE}");
            0
        }
        Cli::Run(command) => match run(&command, data_dir, io::stdout(), io::stderr()) {
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
    use crate::hub::{ControlFile, Hub, write_control_file};
    use crate::model::Status;
    use crate::monitor::{AgentEnv, Monitor};
    use crate::procfs::ProcFs;

    fn ignore_proc(_: crate::model::Proc) {}

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
        let (out, err) = (Buf::default(), Buf::default());
        let code = run("echo hi; echo bad >&2; exit 4", dir.path(), out.clone(), err.clone()).unwrap();
        assert_eq!(code, 4);
        assert_eq!(out.text(), "hi\n");
        assert!(err.text().contains("isn't running"));
        assert!(err.text().contains("bad"));
        // A stale control file behaves the same.
        write_control_file(dir.path(), &ControlFile { addr: "127.0.0.1:1".into(), secret: "x".into() }).unwrap();
        assert_eq!(run("true", dir.path(), Buf::default(), Buf::default()).unwrap(), 0);
        write_control_file(dir.path(), &ControlFile { addr: "not an addr".into(), secret: "x".into() }).unwrap();
        assert_eq!(run("true", dir.path(), Buf::default(), Buf::default()).unwrap(), 0);
    }

    #[test]
    fn streams_to_a_running_app() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv { addr: "127.0.0.1:9".into(), ..Default::default() }).shared();
        let hub = Hub::start(m.clone(), "sek".into(), Arc::new(ignore_proc)).unwrap();
        write_control_file(dir.path(), &ControlFile { addr: hub.addr().to_string(), secret: "sek".into() }).unwrap();
        let out = Buf::default();
        let code = run("echo $PEAK_AGENT_ADDR; echo line2", dir.path(), out.clone(), Buf::default()).unwrap();
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
    fn wrong_secret_falls_back() {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m, "right".into(), Arc::new(ignore_proc)).unwrap();
        write_control_file(dir.path(), &ControlFile { addr: hub.addr().to_string(), secret: "wrong".into() }).unwrap();
        let err = Buf::default();
        assert_eq!(run("exit 0", dir.path(), Buf::default(), err.clone()).unwrap(), 0);
        assert!(err.text().contains("isn't running"));
    }

    #[test]
    fn help_and_spawn_errors() {
        let dir = tempfile::tempdir().unwrap();
        assert_eq!(main(Cli::Help, dir.path()), 0);
        assert_eq!(main(Cli::Run("exit 5".into()), dir.path()), 5);
        // A NUL byte can't be passed to exec.
        assert_eq!(main(Cli::Run("a\0b".into()), dir.path()), 127);
    }

    #[test]
    fn unexpected_reply_falls_back() {
        use std::net::TcpListener;
        let dir = tempfile::tempdir().unwrap();
        let l = TcpListener::bind("127.0.0.1:0").unwrap();
        write_control_file(dir.path(), &ControlFile { addr: l.local_addr().unwrap().to_string(), secret: "s".into() })
            .unwrap();
        let server = thread::spawn(move || {
            let (s, _) = l.accept().unwrap();
            let mut line = String::new();
            BufReader::new(s.try_clone().unwrap()).read_line(&mut line).unwrap();
            writeln!(&s, "{}", json!({"type": "nope"})).unwrap();
        });
        let err = Buf::default();
        assert_eq!(run("true", dir.path(), Buf::default(), err.clone()).unwrap(), 0);
        server.join().unwrap();
        assert!(err.text().contains("isn't running"));
    }
}
