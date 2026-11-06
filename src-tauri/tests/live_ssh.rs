//! Live validation over real OpenSSH, against a disposable `sshd` this test starts
//! on a high port with throwaway keys. Nothing else on the machine is touched.
//!
//! Ignored by default because it needs `sshd` and a built collector:
//!
//! ```sh
//! cargo test --test live_ssh -- --ignored --test-threads=1 --nocapture
//! ```

use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use peak_lib::model::*;
use peak_lib::remote::{Remote, TargetSpec, Timing};
use peak_lib::transport::{CliConnector, Tools};

#[allow(dead_code)]
struct Sshd {
    dir: tempfile::TempDir,
    port: u16,
    listener: Option<Child>,
}

fn free_port() -> u16 {
    std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port()
}

fn keygen(path: &Path) {
    let ok =
        Command::new("ssh-keygen").args(["-q", "-t", "ed25519", "-N", "", "-f"]).arg(path).status().unwrap().success();
    assert!(ok, "ssh-keygen failed");
}

impl Sshd {
    fn start() -> Sshd {
        let dir = tempfile::tempdir().unwrap();
        let d = dir.path();
        keygen(&d.join("host"));
        keygen(&d.join("client"));
        std::fs::copy(d.join("client.pub"), d.join("authorized_keys")).unwrap();
        // sshd insists on strict permissions.
        std::fs::set_permissions(d, std::os::unix::fs::PermissionsExt::from_mode(0o700)).unwrap();
        let port = free_port();
        let config = format!(
            "Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host\nPidFile {d}/pid\nAuthorizedKeysFile {d}/authorized_keys\nPasswordAuthentication no\nKbdInteractiveAuthentication no\nUsePAM no\nStrictModes no\n",
            d = d.display()
        );
        std::fs::write(d.join("sshd_config"), config).unwrap();
        let mut s = Sshd { dir, port, listener: None };
        s.up();
        s
    }

    fn up(&mut self) {
        let d = self.dir.path();
        let child = Command::new("/usr/sbin/sshd")
            .args(["-D", "-e", "-f"])
            .arg(d.join("sshd_config"))
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(std::fs::File::create(d.join("sshd.log")).unwrap())
            .spawn()
            .unwrap();
        self.listener = Some(child);
        for _ in 0..100 {
            if std::net::TcpStream::connect(("127.0.0.1", self.port)).is_ok() {
                return;
            }
            thread::sleep(Duration::from_millis(50));
        }
        panic!("sshd didn't start: {}", std::fs::read_to_string(d.join("sshd.log")).unwrap_or_default());
    }

    /// Stop the server and drop every session, as a network failure would look
    /// from the client side. Workloads on the "remote" side aren't touched.
    fn down(&mut self) {
        let Some(mut listener) = self.listener.take() else { return };
        let root = listener.id();
        let sessions = descendants(root);
        let _ = listener.kill();
        let _ = listener.wait();
        for pid in sessions {
            let comm = std::fs::read_to_string(format!("/proc/{pid}/comm")).unwrap_or_default();
            if comm.starts_with("sshd") {
                let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
            }
        }
    }

    fn options(&self) -> Vec<String> {
        let d = self.dir.path();
        [
            "-i",
            d.join("client").to_str().unwrap(),
            "-o",
            &format!("UserKnownHostsFile={}", d.join("known_hosts").display()),
            "-o",
            "StrictHostKeyChecking=accept-new",
            "-o",
            "IdentitiesOnly=yes",
            "-o",
            "ConnectTimeout=5",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect()
    }

    /// Run a command on the "remote" side, as a user would over ssh.
    fn ssh(&self, command: &str) -> String {
        let out = Command::new("ssh")
            .args(["-T", "-p", &self.port.to_string()])
            .args(self.options())
            .arg("127.0.0.1")
            .arg(command)
            .stdin(Stdio::null())
            .output()
            .unwrap();
        assert!(out.status.success(), "ssh failed: {}", String::from_utf8_lossy(&out.stderr));
        String::from_utf8_lossy(&out.stdout).trim().to_string()
    }
}

impl Drop for Sshd {
    fn drop(&mut self) {
        self.down();
    }
}

fn descendants(root: u32) -> Vec<u32> {
    let mut out = vec![];
    let mut frontier = vec![root];
    while let Some(p) = frontier.pop() {
        let children = Command::new("pgrep").args(["-P", &p.to_string()]).output().unwrap();
        for c in String::from_utf8_lossy(&children.stdout).split_whitespace() {
            let c: u32 = c.parse().unwrap();
            out.push(c);
            frontier.push(c);
        }
    }
    out
}

fn eventually(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    for _ in 0..secs * 20 {
        if f() {
            println!("  ok: {what}");
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
    panic!("timed out: {what}");
}

fn exists(pid: u32) -> bool {
    Path::new(&format!("/proc/{pid}")).exists()
}

/// Normally unset: the app's own embedded collector is what these should exercise.
fn collectors() -> Option<PathBuf> {
    std::env::var_os("PEAK_COLLECTORS").map(PathBuf::from)
}

fn setup(sshd: &Sshd, path: &Path) -> (Arc<Remote>, String) {
    let tools = Tools { ssh_options: sshd.options(), collectors: collectors(), ..Default::default() };
    let timing = Timing { retry_max: Duration::from_secs(1), ..Default::default() };
    let r = Arc::new(Remote::with_timing(Arc::new(CliConnector { tools }), timing));
    let spec = TargetSpec {
        id: "live".into(),
        label: "disposable sshd".into(),
        kind: Some(TargetKind::Ssh),
        host: "127.0.0.1".into(),
        port: Some(sshd.port),
        collector_path: path.display().to_string(),
        install: true,
        ..Default::default()
    };
    let id = r.add(spec).spec.id;
    (r, id)
}

fn state(r: &Remote, id: &str) -> ConnectionState {
    r.states().into_iter().find(|s| s.spec.id == id).unwrap().state
}

#[test]
#[ignore = "needs sshd"]
fn observes_and_controls_over_real_ssh() {
    let mut sshd = Sshd::start();
    let install = tempfile::tempdir().unwrap();
    let path = install.path().join("collector/peak-collector");
    let (r, id) = setup(&sshd, &path);

    println!("connect: installs the collector, handshakes");
    r.connect(&id).unwrap();
    eventually("connected", 30, || state(&r, &id) == ConnectionState::Connected);
    assert!(path.is_file(), "the collector was copied over ssh");
    let st = r.states().remove(0);
    let facts = st.facts.unwrap();
    println!("  facts: {} {} boot={} cgroup={:?}", facts.arch, facts.kernel, facts.boot_id, facts.limits.version);
    assert!(st.capabilities.attach && st.capabilities.launch && st.capabilities.signal);

    println!("discover and attach a process started independently on the target");
    let pid: u32 = sshd.ssh("nohup sleep 600 >/dev/null 2>&1 & echo $!").parse().unwrap();
    let listed = r.list_processes(&id).unwrap();
    assert!(listed.iter().any(|a| a.pid == pid), "same-user process is listed");
    let p = r.attach(&id, pid).unwrap();
    assert_eq!(p.target.as_ref().unwrap().identity.pid, pid);
    eventually("real samples flow", 15, || {
        r.proc(&p.id).is_some_and(|x| x.samples.len() >= 4 && x.samples.last().unwrap().rss > 0.0)
    });
    let offset = r.proc(&p.id).unwrap().target.unwrap().clock_offset_ms;
    println!("  clock offset desktop-target: {offset} ms");
    assert!(offset.abs() < 5000, "same machine: {offset}");

    println!("permission limits are reported, not faked");
    let init = r.attach(&id, 1).unwrap();
    eventually("another user's process reports what can't be read", 10, || {
        r.proc(&init.id)
            .is_some_and(|x| x.unavailable.iter().any(|u| u == "io") && x.unavailable.iter().any(|u| u == "fds"))
    });
    r.detach(&init.id).unwrap();

    println!("drop every session and the listener: a disconnect, not an exit");
    let before = r.proc(&p.id).unwrap().samples.len();
    sshd.down();
    eventually("notices the loss", 15, || state(&r, &id) != ConnectionState::Connected);
    let during = r.proc(&p.id).unwrap();
    assert_eq!(during.status, Status::Running, "the workload isn't assumed dead");
    assert!(r.signal(&p.id, "TERM").is_err(), "and nothing can be sent to it");
    assert!(exists(pid), "the workload is untouched");

    println!("reconnect: identity verified, same run, gap recorded, no duplicates");
    thread::sleep(Duration::from_secs(2));
    sshd.up();
    eventually("reconnected", 30, || state(&r, &id) == ConnectionState::Connected);
    eventually("gap recorded", 15, || !r.proc(&p.id).unwrap().gaps.is_empty());
    eventually("samples resume", 15, || r.proc(&p.id).unwrap().samples.len() > before + 2);
    let after = r.proc(&p.id).unwrap();
    assert_eq!(after.id, p.id);
    let g = after.gaps[0];
    println!("  gap: {} ms", g.to - g.from);
    assert!(g.to - g.from >= 2000, "the gap covers the outage: {g:?}");
    let times: Vec<u64> = after.samples.iter().map(|s| s.t).collect();
    assert!(times.windows(2).all(|w| w[1] > w[0]), "strictly increasing");

    println!("workload dies during an outage: exit is unknown, not invented");
    sshd.down();
    eventually("loss noticed", 15, || state(&r, &id) != ConnectionState::Connected);
    sshd_kill(pid);
    sshd.up();
    eventually("marked ended", 30, || r.proc(&p.id).unwrap().status != Status::Running);
    let gone = r.proc(&p.id).unwrap();
    assert_eq!(gone.signal.as_deref(), Some("ended while disconnected"));
    assert_eq!(gone.exit_code, None);
    eventually("reconnected", 30, || state(&r, &id) == ConnectionState::Connected);

    println!("launch: exact output, exit status, stop, restart, all on the target");
    let spec = LaunchSpec {
        command: Some("echo hello-out; echo hello-err >&2; exit 7".into()),
        argv: None,
        cwd: "/tmp".into(),
    };
    let l = r.launch(&id, spec).unwrap();
    eventually("ended", 15, || r.proc(&l.id).unwrap().status != Status::Running);
    let done = r.proc(&l.id).unwrap();
    assert_eq!((done.status, done.exit_code), (Status::Crashed, Some(7)));
    assert!(done.logs.iter().any(|x| x.text == "hello-out" && x.stream == Stream::Stdout));
    assert!(done.logs.iter().any(|x| x.text == "hello-err" && x.stream == Stream::Stderr));

    let spec = LaunchSpec { command: None, argv: Some(vec!["/bin/sleep".into(), "300".into()]), cwd: "/tmp".into() };
    let l = r.launch(&id, spec).unwrap();
    assert!(exists(l.pid));
    r.stop(&l.id).unwrap();
    eventually("stopped by request", 15, || r.proc(&l.id).unwrap().status == Status::Exited);
    let l2 = r.restart(&l.id).unwrap();
    assert_ne!(l2.id, l.id);
    assert!(exists(l2.pid), "restart ran it on the target again");

    println!("runtime agents travel with the collector");
    let node = which("node");
    let spec = LaunchSpec {
        command: Some(format!(
            "{node} --no-use-osr -e 'function busyWork(){{const e=Date.now()+50;while(Date.now()<e);}} setInterval(busyWork,60)'"
        )),
        argv: None,
        cwd: "/tmp".into(),
    };
    let n = r.launch(&id, spec).unwrap();
    eventually("agent connected on the target", 20, || r.proc(&n.id).unwrap().profiling);
    let prof = r.cpu_profile(&n.id, 1000).unwrap();
    assert_eq!(prof.sampling, "v8");
    assert!(!r.snapshot(&n.id).unwrap().entries.is_empty());
    eventually("runtime lag arrives", 10, || r.proc(&n.id).unwrap().samples.iter().any(|s| s.loop_lag.is_some()));

    println!("shutdown contract: attached stays, launched stops");
    let keep: u32 = sshd.ssh("nohup sleep 600 >/dev/null 2>&1 & echo $!").parse().unwrap();
    r.attach(&id, keep).unwrap();
    let (launched_a, launched_b) = (l2.pid, n.pid);
    r.shutdown();
    eventually("launched commands stopped", 15, || !exists(launched_a) && !exists(launched_b));
    assert!(exists(keep), "desktop shutdown leaves an attached service running");
    sshd_kill(keep);
    println!("PASS");
}

#[test]
#[ignore = "needs sshd"]
fn a_black_holed_host_blocks_nothing() {
    // 192.0.2.0/24 is reserved for documentation, so packets go nowhere.
    let tools = Tools {
        ssh_options: vec!["-o".into(), "ConnectTimeout=20".into()],
        collectors: collectors(),
        ..Default::default()
    };
    let r = Remote::new(Arc::new(CliConnector { tools }));
    r.add(TargetSpec {
        id: "hole".into(),
        kind: Some(TargetKind::Ssh),
        host: "192.0.2.1".into(),
        install: true,
        ..Default::default()
    });
    r.connect("hole").unwrap();
    let start = std::time::Instant::now();
    let mut worst = Duration::ZERO;
    while start.elapsed() < Duration::from_secs(3) {
        let t = std::time::Instant::now();
        r.drain();
        r.states();
        r.procs();
        worst = worst.max(t.elapsed());
        thread::sleep(Duration::from_millis(20));
    }
    println!("  worst pass while connecting: {worst:?}, state {:?}", state(&r, "hole"));
    assert!(worst < Duration::from_millis(100), "{worst:?}");
    assert_eq!(state(&r, "hole"), ConnectionState::Connecting);
    println!("PASS");
}

#[test]
#[ignore = "needs sshd"]
fn failures_over_real_ssh_are_honest() {
    let mut sshd = Sshd::start();
    let install = tempfile::tempdir().unwrap();
    let path = install.path().join("c/peak-collector");

    println!("wrong key: authentication stays with ssh, and fails visibly");
    let other = tempfile::tempdir().unwrap();
    keygen(&other.path().join("key"));
    let mut opts = sshd.options();
    opts[1] = other.path().join("key").display().to_string();
    let tools = Tools { ssh_options: opts, collectors: collectors(), ..Default::default() };
    let r = Remote::new(Arc::new(CliConnector { tools }));
    let spec = TargetSpec {
        id: "bad".into(),
        kind: Some(TargetKind::Ssh),
        host: "127.0.0.1".into(),
        port: Some(sshd.port),
        collector_path: path.display().to_string(),
        install: true,
        ..Default::default()
    };
    r.add(spec.clone());
    r.connect("bad").unwrap();
    eventually("fails", 20, || state(&r, "bad") == ConnectionState::Failed);
    let e = r.states().remove(0).error.unwrap();
    println!("  {e}");
    assert!(e.contains("Permission denied"), "{e}");
    assert!(!path.exists());

    println!("not prepared and not allowed to install");
    let (r2, id) = setup(&sshd, &path);
    r2.add(TargetSpec { install: false, ..r2.specs().remove(0) });
    r2.connect(&id).unwrap();
    eventually("fails", 20, || state(&r2, &id) == ConnectionState::Failed);
    assert!(r2.states().remove(0).error.unwrap().contains("no compatible collector"));
    assert!(!path.exists(), "nothing was copied without permission");

    println!("unreachable");
    sshd.down();
    r.add(TargetSpec { id: "gone".into(), ..spec });
    let (r3, id3) = setup(&sshd, &path);
    r3.connect(&id3).unwrap();
    eventually("fails", 20, || state(&r3, &id3) == ConnectionState::Failed);
    assert!(r3.states().remove(0).error.unwrap().contains("Connection refused"));
    println!("PASS");
}

fn sshd_kill(pid: u32) {
    let _ = Command::new("kill").arg("-9").arg(pid.to_string()).status();
    // These were started over ssh and reparented, so nothing here reaps them; a
    // brief wait lets init clear the entry.
    for _ in 0..40 {
        if !exists(pid) {
            return;
        }
        thread::sleep(Duration::from_millis(50));
    }
}

fn which(name: &str) -> String {
    let out = Command::new("sh").arg("-c").arg(format!("command -v {name}")).output().unwrap();
    String::from_utf8_lossy(&out.stdout).trim().to_string()
}
