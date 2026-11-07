//! `peak run -- <command>`: run a command in the terminal while streaming it
//! to the peak app (output is tee'd, the exit status is forwarded).

use std::io::{self, BufRead, BufReader, Write};
use std::net::TcpStream;
use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::Duration;

use serde_json::{Value, json};

use crate::discovery::{Candidate, Here, Record, Standing, discover, start_ticks};
use crate::monitor::with_inherited;
use crate::runner::pump_lines;
#[cfg(unix)]
use std::os::unix::process::CommandExt;

#[derive(Debug, PartialEq, Eq)]
pub enum Cli {
    Run(String),
    Agents,
    Ps { json: bool },
    Profile(ProfileArgs),
    Open(String),
    Collector,
    Version,
    Help,
}

#[derive(Debug, PartialEq, Eq)]
pub struct ProfileArgs {
    pub target: String,
    pub action: &'static str,
    pub ms: u64,
    pub json: bool,
}

pub const USAGE: &str = "usage: peak                      open the app\n       peak run [--] <command> [args…]\n       peak ps [--json]\n       peak profile <run id or pid> [--ms N | --snapshot | --gc] [--json]\n       peak open <run id or pid>\n       peak agents\n       peak collector\n       peak version\n\nrun: runs <command> and streams its memory, CPU and output to the peak app.\nps: lists the runs in the open app, and what each one's runtime agent reports.\nprofile: records a CPU profile (5000 ms unless --ms says otherwise), takes a heap snapshot or forces a collection. Results are saved with the run.\nopen: shows a run's profiler in the open app.\nagents: shows what it takes to profile each runtime.\ncollector: shows the collector this build copies to remote targets.\nversion: shows this build's version, commit and how it was installed.";

const DEFAULT_PROFILE_MS: u64 = 5000;

fn parse_profile(args: &[String]) -> Option<ProfileArgs> {
    let (target, flags) = args.split_first()?;
    if target.starts_with('-') {
        return None;
    }
    let mut parsed = ProfileArgs { target: target.clone(), action: "cpu", ms: DEFAULT_PROFILE_MS, json: false };
    let mut flags = flags.iter();
    while let Some(flag) = flags.next() {
        match flag.as_str() {
            "--ms" => parsed.ms = flags.next()?.parse().ok()?,
            "--snapshot" => parsed.action = "snapshot",
            "--gc" => parsed.action = "gc",
            "--json" => parsed.json = true,
            _ => return None,
        }
    }
    Some(parsed)
}

/// `None` means "no CLI arguments — start the desktop app".
pub fn parse_args(args: &[String]) -> Option<Cli> {
    let (first, rest) = args.split_first()?;
    match first.as_str() {
        "run" => {
            let rest = if rest.first().map(String::as_str) == Some("--") { &rest[1..] } else { rest };
            if rest.is_empty() { Some(Cli::Help) } else { Some(Cli::Run(shell_join(rest))) }
        }
        "agents" => Some(Cli::Agents),
        "ps" => Some(Cli::Ps { json: rest.iter().any(|a| a == "--json") }),
        "profile" => Some(parse_profile(rest).map_or(Cli::Help, Cli::Profile)),
        "open" => Some(rest.first().map_or(Cli::Help, |target| Cli::Open(target.clone()))),
        "collector" => Some(Cli::Collector),
        "version" | "--version" | "-V" => Some(Cli::Version),
        "help" | "--help" | "-h" => Some(Cli::Help),
        // Tauri/WebKit may pass its own flags; anything unknown starts the app.
        _ => None,
    }
}

/// Quote arguments for `cmd /C` so `peak-cli run -- node "my file.js"` round-trips.
#[cfg(windows)]
pub fn shell_join(args: &[String]) -> String {
    args.iter()
        .map(|a| {
            if !a.is_empty() && !a.chars().any(|c| c.is_whitespace() || "\"&|<>^%()".contains(c)) {
                a.clone()
            } else {
                format!("\"{}\"", a.replace('"', "\\\""))
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Quote arguments for `sh -c` so `peak run -- node "my file.js"` round-trips.
#[cfg(unix)]
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
    let mut cmd = crate::runner::shell_command(command);
    cmd.stdin(Stdio::inherit()).stdout(Stdio::piped()).stderr(Stdio::piped());
    if let Some((_, env)) = &link {
        cmd.envs(with_inherited(env.clone(), &|key| std::env::var(key).ok()));
    }
    // SAFETY: reset_signals only calls async-signal-safe functions.
    #[cfg(unix)]
    unsafe {
        cmd.pre_exec(crate::runner::reset_signals)
    };
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
    let ended = crate::runner::ExitInfo::from(child.wait()?);
    let _ = t1.join();
    let _ = t2.join();
    // SAFETY: restoring the previous disposition.
    unsafe { libc::signal(libc::SIGINT, prev) };

    if let Some((l, _)) = &link {
        l.send(json!({ "type": "exit", "code": ended.code, "signal": ended.signal }));
    }
    Ok(exit_code(ended.code, ended.signal))
}

/// Ask one app to do something. The outer error says the app couldn't be asked; the inner one is
/// its answer.
fn ask(record: &Record, action: &str, target: &str, ms: u64, wait: Duration) -> Result<Result<Value, String>, Failure> {
    let addr = record.addr.parse().map_err(|_| Failure::BadReply)?;
    let stream = TcpStream::connect_timeout(&addr, ANSWER_TIMEOUT)?;
    stream.set_read_timeout(Some(wait))?;
    let mut w = stream.try_clone()?;
    let request = json!({ "type": "control", "secret": record.secret, "action": action, "target": target, "ms": ms });
    writeln!(w, "{request}")?;
    let mut line = String::new();
    if BufReader::new(stream).read_line(&mut line)? == 0 {
        return Err(Failure::Rejected);
    }
    let reply: Value = serde_json::from_str(&line).map_err(|_| Failure::BadReply)?;
    match reply["type"].as_str() {
        Some("control") if reply["ok"] == true => Ok(Ok(reply["data"].clone())),
        Some("control") => Ok(Err(reply["error"].as_str().unwrap_or("the app couldn't do that").to_string())),
        Some("rejected") => Err(Failure::Rejected),
        _ => Err(Failure::BadReply),
    }
}

/// Runs in every open app.
fn list_runs(dirs: &[PathBuf], here: &Here) -> Result<Vec<Value>, String> {
    let found = discover(dirs, here, &start_ticks);
    let mut runs = vec![];
    let mut answered = false;
    let mut failed = vec![];
    for c in &found.candidates {
        match ask(&c.record, "list", "", 0, ANSWER_TIMEOUT) {
            Ok(Ok(Value::Array(list))) => {
                answered = true;
                runs.extend(list);
            }
            Ok(Ok(_)) => failed.push("the app gave a reply this version can't read".to_string()),
            Ok(Err(why)) => failed.push(why),
            Err(f) => failed.extend(describe(c, &f)),
        }
    }
    if answered {
        return Ok(runs);
    }
    failed.extend(found.obstacles);
    Err(failed
        .into_iter()
        .next()
        .unwrap_or_else(|| format!("the app isn't running on {} for {}", here.host, here.user)))
}

/// Carry out a profile request in whichever open app has that run.
fn profile(args: &ProfileArgs, dirs: &[PathBuf], here: &Here) -> Result<Value, String> {
    let found = discover(dirs, here, &start_ticks);
    let wait = Duration::from_millis(args.ms) + Duration::from_secs(150);
    let mut failed = vec![];
    for c in &found.candidates {
        match ask(&c.record, args.action, &args.target, args.ms, wait) {
            Ok(Ok(data)) => return Ok(data),
            Ok(Err(why)) => failed.push(why),
            Err(f) => failed.extend(describe(c, &f)),
        }
    }
    failed.extend(found.obstacles);
    Err(failed
        .into_iter()
        .next()
        .unwrap_or_else(|| format!("the app isn't running on {} for {}", here.host, here.user)))
}

/// One row per run. An agent's version and capabilities, or why there's nothing to report.
pub fn format_runs(runs: &[Value]) -> String {
    let mut out = format!("{:<14} {:>8} {:<8} {:<7} {:<40} COMMAND\n", "ID", "PID", "STATUS", "RUNTIME", "AGENT");
    for run in runs {
        let text = |key: &str| run[key].as_str().unwrap_or("").to_string();
        let agent = match run["agent"].as_object() {
            None => "none".to_string(),
            Some(a) => {
                let list =
                    a["capabilities"].as_array().map_or(vec![], |c| c.iter().filter_map(Value::as_str).collect());
                let got = if list.is_empty() { "figures at exit".to_string() } else { list.join(",") };
                let state = if run["profiling"] == true { "" } else { "ended " };
                format!("{state}{} {got}", a["runtimeVersion"].as_str().unwrap_or("?"))
            }
        };
        out.push_str(&format!(
            "{:<14} {:>8} {:<8} {:<7} {:<40} {}\n",
            text("id"),
            run["pid"],
            text("status"),
            text("runtime"),
            agent,
            text("command"),
        ));
    }
    out
}

fn frames_by_self<'a>(frame: &'a Value, out: &mut Vec<&'a Value>) {
    out.push(frame);
    for child in frame["children"].as_array().into_iter().flatten() {
        frames_by_self(child, out);
    }
}

/// What a profile found, in units a person can read.
pub fn format_result(action: &str, data: &Value) -> String {
    match action {
        "cpu" => {
            let mut frames = vec![];
            frames_by_self(&data["root"], &mut frames);
            frames.sort_by(|a, b| b["self"].as_f64().unwrap_or(0.0).total_cmp(&a["self"].as_f64().unwrap_or(0.0)));
            let mut out = format!(
                "CPU profile: {:.0} ms by {}, saved with the run\n",
                data["durationMs"].as_f64().unwrap_or(0.0),
                data["sampling"].as_str().unwrap_or("?"),
            );
            for f in frames.iter().filter(|f| f["self"].as_f64().unwrap_or(0.0) > 0.0).take(15) {
                out.push_str(&format!(
                    "{:>10.1} ms  {} {}\n",
                    f["self"].as_f64().unwrap_or(0.0),
                    f["name"].as_str().unwrap_or("?"),
                    f["file"].as_str().unwrap_or(""),
                ));
            }
            out
        }
        "snapshot" => {
            let mut out = format!(
                "Heap snapshot: {:.1} MB in use, saved with the run\n",
                data["heapUsed"].as_f64().unwrap_or(0.0) / 1_048_576.0,
            );
            for e in data["entries"].as_array().into_iter().flatten().take(15) {
                out.push_str(&format!(
                    "{:>10.1} KB  {:>9.0}  {}\n",
                    e["shallow"].as_f64().unwrap_or(0.0) / 1024.0,
                    e["count"].as_f64().unwrap_or(0.0),
                    e["name"].as_str().unwrap_or("?"),
                ));
            }
            out
        }
        _ => "Collection finished.\n".to_string(),
    }
}

fn print_json(v: &Value) -> i32 {
    println!("{v}");
    0
}

fn fail(why: String) -> i32 {
    eprintln!("peak: {why}");
    1
}

/// Which collector this build copies to a target of `arch`. It's a Linux program, so it can
/// only say its own version where this machine can run it.
fn collector_line(arch: &str) -> Result<String, String> {
    let path = crate::transport::local_collector(&crate::transport::Tools::default(), arch)?;
    if !cfg!(target_os = "linux") {
        return Ok(format!("{arch}: {} (for Linux targets)", path.display()));
    }
    let version = Command::new(&path).arg("version").output();
    let version = version.map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string());
    Ok(format!("{arch}: {} ({})", path.display(), version.unwrap_or_else(|e| e.to_string())))
}

pub fn main(cli: Cli, dirs: &[PathBuf]) -> i32 {
    match cli {
        Cli::Help => {
            println!("{USAGE}");
            0
        }
        Cli::Version => {
            println!("{}", crate::release::InstallInfo::detect().line());
            0
        }
        Cli::Agents => {
            println!("{}", crate::hub::agent_setup(&crate::hub::default_data_dir()));
            0
        }
        Cli::Ps { json } => match list_runs(dirs, &Here::detect()) {
            Ok(runs) if json => print_json(&Value::Array(runs)),
            Ok(runs) => {
                print!("{}", format_runs(&runs));
                0
            }
            Err(why) => fail(why),
        },
        Cli::Profile(args) => match profile(&args, dirs, &Here::detect()) {
            Ok(data) if args.json => print_json(&data),
            Ok(data) => {
                print!("{}", format_result(args.action, &data));
                0
            }
            Err(why) => fail(why),
        },
        Cli::Open(target) => {
            let args = ProfileArgs { target, action: "open", ms: 0, json: false };
            match profile(&args, dirs, &Here::detect()) {
                Ok(_) => 0,
                Err(why) => fail(why),
            }
        }
        Cli::Collector => match collector_line(std::env::consts::ARCH) {
            Ok(line) => {
                println!("{line}");
                0
            }
            Err(e) => {
                eprintln!("peak: {e}");
                1
            }
        },
        Cli::Run(command) => match run(&command, dirs, io::stdout(), io::stderr()) {
            Ok(code) => code,
            Err(e) => {
                eprintln!("peak: {e}");
                127
            }
        },
    }
}

#[cfg(all(test, target_os = "linux"))]
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
        assert_eq!(parse_args(&s(&["version"])), Some(Cli::Version));
        assert_eq!(parse_args(&s(&["--version"])), Some(Cli::Version));
        assert_eq!(parse_args(&s(&["-V"])), Some(Cli::Version));
        assert_eq!(parse_args(&s(&["agents"])), Some(Cli::Agents));
        assert_eq!(parse_args(&s(&["ps"])), Some(Cli::Ps { json: false }));
        assert_eq!(parse_args(&s(&["ps", "--json"])), Some(Cli::Ps { json: true }));
        assert_eq!(parse_args(&s(&["open", "r1"])), Some(Cli::Open("r1".into())));
        assert_eq!(parse_args(&s(&["open"])), Some(Cli::Help));
        let profile = |action, ms, json| Some(Cli::Profile(ProfileArgs { target: "r1".into(), action, ms, json }));
        assert_eq!(parse_args(&s(&["profile", "r1"])), profile("cpu", 5000, false));
        assert_eq!(parse_args(&s(&["profile", "r1", "--ms", "900", "--json"])), profile("cpu", 900, true));
        assert_eq!(parse_args(&s(&["profile", "r1", "--snapshot"])), profile("snapshot", 5000, false));
        assert_eq!(parse_args(&s(&["profile", "r1", "--gc"])), profile("gc", 5000, false));
        for bad in [
            &["profile"][..],
            &["profile", "--gc"],
            &["profile", "r1", "--wat"],
            &["profile", "r1", "--ms"],
            &["profile", "r1", "--ms", "x"],
        ] {
            assert_eq!(parse_args(&s(bad)), Some(Cli::Help), "{bad:?}");
        }
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

    /// The real hub answering the real commands, with a stand-in agent on the other end.
    #[test]
    fn lists_and_profiles_runs_in_the_open_app() {
        let m = Monitor::new(ProcFs::default(), AgentEnv { addr: "x".into(), ..Default::default() }).shared();
        let hub = Hub::start(m.clone(), "sekrit".into(), Arc::new(ignore_proc)).unwrap();
        let dir = tempfile::tempdir().unwrap();
        let dirs = publish(dir.path(), hub.addr().to_string(), "sekrit");
        let here = Here::detect();
        assert_eq!(list_runs(&dirs, &here).unwrap(), Vec::<Value>::new());
        assert_eq!(main(Cli::Ps { json: true }, &dirs), 0);
        assert_eq!(main(Cli::Ps { json: false }, &dirs), 0);

        let id = {
            let mut g = m.lock().unwrap();
            let id = g.new_id();
            g.insert(id.clone(), crate::monitor::Origin::External, std::process::id(), "go run .", "/tmp", 1);
            id
        };
        let cpu = |target: &str, action| ProfileArgs { target: target.into(), action, ms: 500, json: true };
        assert!(profile(&cpu(&id, "cpu"), &dirs, &here).unwrap_err().contains("no profiling agent"));
        assert!(profile(&cpu("nope", "cpu"), &dirs, &here).unwrap_err().contains("no run in this session"));
        assert_eq!(main(Cli::Profile(cpu("nope", "cpu")), &dirs), 1);
        assert_eq!(main(Cli::Open("nope".into()), &dirs), 1);
        let direct = hub.clone();
        hub.set_control(Arc::new(
            move |action, id, ms| {
                if action == "open" { Ok(Value::Null) } else { direct.perform(action, id, ms) }
            },
        ));
        assert_eq!(main(Cli::Open(id.clone()), &dirs), 0);

        let mut agent = TcpStream::connect(hub.addr()).unwrap();
        let hello = json!({ "type": "hello", "token": id, "pid": 4242, "runtime": "go", "agent": {
            "runtimeVersion": "1.27", "agentVersion": "0.1.1", "capabilities": ["cpu", "forcegc"],
            "unavailable": { "snapshot": "not on this one" }
        }});
        writeln!(agent, "{hello}").unwrap();
        let runs = (0..200)
            .find_map(|_| {
                let runs = list_runs(&dirs, &here).unwrap();
                if runs[0]["profiling"] == true {
                    return Some(runs);
                }
                thread::sleep(Duration::from_millis(10));
                None
            })
            .unwrap();
        assert_eq!(runs[0]["runtime"], "go");
        assert_eq!(runs[0]["agent"]["runtimeVersion"], "1.27");
        assert!(format_runs(&runs).contains("1.27 cpu,forcegc"));
        assert!(format_runs(&runs).contains("go run ."));

        // Told what it can't do without asking the agent, which may not be able to answer.
        let by_pid = cpu("4242", "snapshot");
        assert_eq!(profile(&by_pid, &dirs, &here).unwrap_err(), "not on this one");

        let answers = BufReader::new(agent.try_clone().unwrap());
        let responder = thread::spawn(move || {
            for line in answers.lines().map_while(Result::ok).take(2) {
                let req: Value = serde_json::from_str(&line).unwrap();
                let data = json!({ "durationMs": 500, "sampling": "pprof", "root": {
                    "name": "(root)", "self": 0, "children": [{ "name": "main.work", "file": "a.go:3", "self": 400, "children": [] }]
                }});
                let reply = json!({ "type": "reply", "reqId": req["reqId"], "ok": true, "data": data });
                writeln!(agent, "{reply}").unwrap();
            }
        });
        let data = profile(&cpu(&id, "cpu"), &dirs, &here).unwrap();
        assert_eq!(data["sampling"], "pprof");
        assert_eq!(m.lock().unwrap().get(&id).unwrap().cpu_profiles.len(), 1);
        let readable = ProfileArgs { json: false, ..cpu(&id, "cpu") };
        assert_eq!(main(Cli::Profile(readable), &dirs), 0);
        responder.join().unwrap();
        // The agent has gone. What it said stays with the run, but it's no longer live.
        let ended = (0..200)
            .find_map(|_| {
                let runs = list_runs(&dirs, &here).unwrap();
                if runs[0]["profiling"] != true {
                    return Some(runs);
                }
                thread::sleep(Duration::from_millis(10));
                None
            })
            .unwrap();
        assert!(format_runs(&ended).contains("ended 1.27"));
    }

    #[test]
    fn control_says_why_it_cant_get_an_answer() {
        let dir = tempfile::tempdir().unwrap();
        let here = Here::detect();
        let cpu = ProfileArgs { target: "r".into(), action: "cpu", ms: 500, json: false };
        assert!(list_runs(&[dir.path().to_path_buf()], &here).unwrap_err().contains("isn't running"));
        assert!(profile(&cpu, &[dir.path().to_path_buf()], &here).unwrap_err().contains("isn't running"));

        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m, "right".into(), Arc::new(ignore_proc)).unwrap();
        let dirs = publish(dir.path(), hub.addr().to_string(), "wrong");
        assert!(list_runs(&dirs, &here).unwrap_err().contains("turned this connection away"));
        assert!(profile(&cpu, &dirs, &here).unwrap_err().contains("turned this connection away"));
        assert_eq!(main(Cli::Ps { json: false }, &dirs), 1);

        // Something answering, but not like Peak, or in a shape this doesn't expect.
        for (reply, expected) in [
            ("hello there", "doesn't answer"),
            ("{\"type\":\"other\"}", "can't read"),
            ("{\"type\":\"control\",\"ok\":true,\"data\":5}", "can't read"),
            ("{\"type\":\"control\",\"ok\":false}", "couldn't do that"),
            ("{\"type\":\"rejected\"}", "turned this connection away"),
        ] {
            let dir = tempfile::tempdir().unwrap();
            let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
            let dirs = publish(dir.path(), listener.local_addr().unwrap().to_string(), "s");
            let reply = reply.to_string();
            thread::spawn(move || {
                let (mut c, _) = listener.accept().unwrap();
                let mut line = String::new();
                BufReader::new(c.try_clone().unwrap()).read_line(&mut line).unwrap();
                writeln!(c, "{reply}").unwrap();
            });
            let why = list_runs(&dirs, &here).unwrap_err();
            assert!(why.contains(expected) || why.contains("gave a reply"), "{why}");
        }
    }

    #[test]
    fn formats_results_for_people() {
        let cpu = json!({ "durationMs": 1000.4, "sampling": "pprof", "root": { "name": "(root)", "self": 0, "children": [
            { "name": "main.hot", "file": "a.go:1", "self": 900, "children": [{ "name": "leaf", "self": 50, "children": [] }] }
        ]}});
        let text = format_result("cpu", &cpu);
        assert!(text.starts_with("CPU profile: 1000 ms by pprof"));
        assert!(text.find("main.hot").unwrap() < text.find("leaf").unwrap());
        assert!(!text.contains("(root)"), "a frame with no time of its own isn't listed");
        let snap = json!({ "heapUsed": 2_097_152, "entries": [{ "name": "Thing", "count": 3, "shallow": 2048, "retained": 2048 }] });
        let text = format_result("snapshot", &snap);
        assert!(text.contains("2.0 MB") && text.contains("2.0 KB") && text.contains("Thing"));
        assert_eq!(format_result("gc", &Value::Null), "Collection finished.\n");
        let no_exit_figures = json!({ "id": "r", "pid": 1, "status": "running", "runtime": "php", "profiling": true, "command": "php a", "agent": { "runtimeVersion": "8.3", "capabilities": [] } });
        assert!(format_runs(&[no_exit_figures]).contains("8.3 figures at exit"));
        let none = json!({ "id": "r", "pid": 1, "status": "running", "runtime": "shell", "command": "sleep" });
        assert!(format_runs(&[none]).contains("none"));
        assert_eq!(main(Cli::Agents, &[]), 0);
    }

    #[test]
    fn says_when_there_is_no_collector_for_an_architecture() {
        assert!(collector_line("riscv64").unwrap_err().contains("riscv64"));
    }

    #[test]
    fn help_and_spawn_errors() {
        let dir = tempfile::tempdir().unwrap();
        let dirs = vec![dir.path().to_path_buf()];
        assert_eq!(main(Cli::Help, &dirs), 0);
        assert_eq!(main(Cli::Version, &dirs), 0);
        #[cfg(any(peak_collector_x86_64, peak_collector_aarch64))]
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
