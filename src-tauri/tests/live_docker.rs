//! Live validation against the real Docker daemon, using disposable containers
//! named `peak-live-*` that this test creates and removes. It only ever addresses
//! containers it created.
//!
//! ```sh
//! PEAK_COLLECTORS=<dir with x86_64/peak-collector> \
//!   cargo test --test live_docker -- --ignored --test-threads=1 --nocapture
//! ```

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use peak_lib::model::*;
use peak_lib::remote::{Remote, TargetSpec, Timing};
use peak_lib::transport::{self, CliConnector, Tools};

/// A disposable container, removed even if the test fails.
struct Container {
    id: String,
}

impl Container {
    fn run(name: &str, args: &[&str], cmd: &[&str]) -> Container {
        let _ = docker(&["rm", "-f", name]);
        let mut a = vec!["run", "-d", "--name", name];
        a.extend_from_slice(args);
        a.push(IMAGE);
        a.extend_from_slice(cmd);
        let id = docker(&a).expect("docker run");
        Container { id: id.trim().to_string() }
    }
}

impl Drop for Container {
    fn drop(&mut self) {
        let _ = docker(&["rm", "-f", &self.id]);
    }
}

const IMAGE: &str = "alpine:3.20";

fn docker(args: &[&str]) -> Result<String, String> {
    let out = Command::new("docker").args(args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
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

fn collectors() -> PathBuf {
    PathBuf::from(std::env::var_os("PEAK_COLLECTORS").expect("set PEAK_COLLECTORS"))
}

fn tools() -> Tools {
    Tools { collectors: Some(collectors()), ..Default::default() }
}

fn remote() -> Arc<Remote> {
    let timing = Timing { retry_max: Duration::from_secs(1), ..Default::default() };
    Arc::new(Remote::with_timing(Arc::new(CliConnector { tools: tools() }), timing))
}

fn target(r: &Remote, id: &str, container: &str) -> String {
    r.add(TargetSpec {
        id: id.into(),
        label: format!("container {id}"),
        kind: Some(TargetKind::Docker),
        container: container.into(),
        install: true,
        ..Default::default()
    })
    .spec
    .id
}

fn state(r: &Remote, id: &str) -> ConnectionState {
    r.states().into_iter().find(|s| s.spec.id == id).unwrap().state
}

#[test]
#[ignore = "needs a Docker daemon and a built static collector"]
fn observes_a_real_container() {
    docker(&["pull", "-q", IMAGE]).unwrap();
    let c = Container::run(
        "peak-live-main",
        &["--memory", "128m", "--cpus", "0.5"],
        &["sh", "-c", "echo started-out; echo started-err >&2; while true; do sleep 1; done"],
    );
    let t = tools();

    println!("discovery and totals need no collector");
    assert!(!transport::docker_contexts(&t).unwrap().is_empty());
    let list = transport::docker_containers(&t, "").unwrap();
    let me = list.iter().find(|x| x.id == c.id).expect("our container is listed");
    assert_eq!((me.name.as_str(), me.state.as_str()), ("peak-live-main", "running"));
    let totals = transport::docker_totals(&t, "", &c.id).unwrap().unwrap();
    println!("  totals: {totals:?}");
    assert!(totals.memory_used.unwrap() > 0.0);
    assert_eq!(totals.memory_limit.unwrap(), 128.0 * 1024.0 * 1024.0, "the container's limit, not the host's memory");
    let top = transport::docker_top(&t, "", &c.id).unwrap();
    println!("  top (daemon's PIDs): {top:?}");
    assert!(top.iter().any(|p| p.command.contains("while true") || p.command.contains("sh -c")));
    let logs = transport::docker_logs(&t, "", &c.id, 50).unwrap();
    assert!(logs.contains("started-out") && logs.contains("started-err"), "both streams: {logs}");

    println!("connect a collector for detailed metrics");
    let r = remote();
    let id = target(&r, "main", &c.id);
    r.connect(&id).unwrap();
    eventually("connected", 30, || state(&r, &id) == ConnectionState::Connected);
    let st = r.states().remove(0);
    let facts = st.facts.unwrap();
    assert!(st.capabilities.container_totals && st.capabilities.container_logs);
    println!("  facts: pidNs={} limits={:?} hostMemory={}", facts.pid_ns, facts.limits, facts.host_memory);
    assert_eq!(facts.limits.memory_max, Some(128.0 * 1024.0 * 1024.0), "container limit, read from cgroups");
    assert_eq!(facts.limits.cpu_quota_cores, Some(0.5));
    assert!(facts.host_memory > 128.0 * 1024.0 * 1024.0, "host capacity stays a separate figure");

    println!("PIDs inside the container aren't the daemon's");
    let inside = r.list_processes(&id).unwrap();
    println!("  inside: {:?}", inside.iter().map(|a| (a.pid, a.command.clone())).collect::<Vec<_>>());
    let main_proc = inside.iter().find(|a| a.pid == 1).expect("the workload is PID 1 inside");
    let daemon_pids: Vec<&str> = top.iter().map(|p| p.pid.as_str()).collect();
    assert!(!daemon_pids.contains(&"1"), "daemon-view PIDs differ: {daemon_pids:?}");
    assert!(main_proc.command.contains("while true"));

    println!("attach and stream, labelled with the container");
    let p = r.attach(&id, 1).unwrap();
    assert_eq!(p.target.as_ref().unwrap().identity.container_id.as_deref(), Some(c.id.as_str()));
    eventually("samples", 15, || r.proc(&p.id).unwrap().samples.len() >= 4);
    assert!(r.proc(&p.id).unwrap().samples.last().unwrap().rss > 0.0);

    println!("launch inside the container; no shell needed with argv");
    let spec = LaunchSpec { command: None, argv: Some(vec!["/bin/echo".into(), "from-argv".into()]), cwd: "/".into() };
    let l = r.launch(&id, spec).unwrap();
    eventually("captured", 15, || r.proc(&l.id).unwrap().logs.iter().any(|x| x.text == "from-argv"));

    println!("the container stopping is a lost connection until proven otherwise");
    docker(&["kill", &c.id]).unwrap();
    eventually("noticed", 20, || state(&r, &id) != ConnectionState::Connected);
    assert_eq!(r.proc(&p.id).unwrap().exit_code, None, "no exit code is invented from the transport ending");
    println!("  state: {:?}, run status {:?}", state(&r, &id), r.proc(&p.id).unwrap().status);

    println!("a replacement container with the same name isn't this target");
    drop(c);
    let replacement = Container::run("peak-live-main", &[], &["sleep", "300"]);
    thread::sleep(Duration::from_secs(3));
    assert_ne!(state(&r, &id), ConnectionState::Connected, "the target means the old container's id");
    assert_eq!(r.proc(&p.id).unwrap().status, Status::Running, "its history isn't given to the newcomer");
    drop(replacement);
    r.disconnect(&id).unwrap();
    println!("PASS");
}

#[test]
#[ignore = "needs a Docker daemon and a built static collector"]
fn minimal_and_locked_down_containers_fail_honestly() {
    docker(&["pull", "-q", IMAGE]).unwrap();
    println!("read-only filesystem: the collector can't be copied in");
    let ro = Container::run("peak-live-ro", &["--read-only"], &["sleep", "300"]);
    let r = remote();
    let id = target(&r, "ro", &ro.id);
    r.connect(&id).unwrap();
    eventually("failed", 30, || state(&r, &id) == ConnectionState::Failed);
    let e = r.states().remove(0).error.unwrap();
    println!("  {e}");
    assert!(!e.is_empty());
    println!("  aggregate monitoring still works without the collector");
    let t = tools();
    assert!(transport::docker_totals(&t, "", &ro.id).unwrap().unwrap().memory_used.unwrap() > 0.0);
    assert!(!transport::docker_top(&t, "", &ro.id).unwrap().is_empty());

    println!("not prepared and not allowed to copy");
    let plain = Container::run("peak-live-plain", &[], &["sleep", "300"]);
    let r = remote();
    r.add(TargetSpec {
        id: "p".into(),
        kind: Some(TargetKind::Docker),
        container: plain.id.clone(),
        ..Default::default()
    });
    r.connect("p").unwrap();
    eventually("failed", 30, || state(&r, "p") == ConnectionState::Failed);
    assert!(r.states().remove(0).error.unwrap().contains("no compatible collector"));
    assert!(docker(&["exec", &plain.id, "ls", "/tmp/peak-collector"]).is_err(), "nothing was copied");

    println!("a stopped container");
    docker(&["kill", &plain.id]).unwrap();
    let r = remote();
    let id = target(&r, "stopped", &plain.id);
    r.connect(&id).unwrap();
    eventually("failed", 30, || state(&r, &id) == ConnectionState::Failed);
    println!("  {}", r.states().remove(0).error.unwrap());
    assert!(transport::docker_logs(&t, "", "peak-live-does-not-exist", 1).is_err());
    println!("PASS");
}

/// A Docker context that reaches the daemon through SSH, as a remote engine would.
/// It uses a disposable sshd and a private HOME and DOCKER_CONFIG, so the user's real
/// Docker contexts and SSH configuration aren't read or changed. It's still this
/// machine's daemon, so it proves the path, not a far-away engine.
#[test]
#[ignore = "needs a Docker daemon, sshd and a built static collector"]
fn works_through_an_ssh_docker_context() {
    docker(&["pull", "-q", IMAGE]).unwrap();
    let home = tempfile::tempdir().unwrap();
    let h = home.path();
    let ssh_dir = h.join(".ssh");
    std::fs::create_dir_all(&ssh_dir).unwrap();
    for name in ["host", "client"] {
        assert!(
            Command::new("ssh-keygen")
                .args(["-q", "-t", "ed25519", "-N", "", "-f"])
                .arg(ssh_dir.join(name))
                .status()
                .unwrap()
                .success()
        );
    }
    std::fs::copy(ssh_dir.join("client.pub"), ssh_dir.join("authorized_keys")).unwrap();
    let port = std::net::TcpListener::bind("127.0.0.1:0").unwrap().local_addr().unwrap().port();
    let d = ssh_dir.display();
    std::fs::write(
        ssh_dir.join("sshd_config"),
        format!("Port {port}\nListenAddress 127.0.0.1\nHostKey {d}/host\nPidFile {d}/pid\nAuthorizedKeysFile {d}/authorized_keys\nPasswordAuthentication no\nUsePAM no\nStrictModes no\n"),
    )
    .unwrap();
    std::fs::write(
        ssh_dir.join("config"),
        format!("Host peak-engine\n  HostName 127.0.0.1\n  Port {port}\n  IdentityFile {d}/client\n  IdentitiesOnly yes\n  StrictHostKeyChecking accept-new\n  UserKnownHostsFile {d}/known\n"),
    )
    .unwrap();
    let mut sshd = Command::new("/usr/sbin/sshd")
        .args(["-D", "-f"])
        .arg(ssh_dir.join("sshd_config"))
        .stdin(Stdio::null())
        .spawn()
        .unwrap();
    for _ in 0..100 {
        if std::net::TcpStream::connect(("127.0.0.1", port)).is_ok() {
            break;
        }
        thread::sleep(Duration::from_millis(50));
    }

    let c = Container::run("peak-live-engine", &[], &["sleep", "300"]);

    // OpenSSH finds ~/.ssh through the passwd entry, not $HOME, so point it at the
    // private config with a wrapper rather than touching the real one.
    let bin = h.join("bin");
    std::fs::create_dir_all(&bin).unwrap();
    let wrapper = bin.join("ssh");
    std::fs::write(&wrapper, format!("#!/bin/sh\nexec /usr/bin/ssh -F {d}/config \"$@\"\n")).unwrap();
    std::fs::set_permissions(&wrapper, std::os::unix::fs::PermissionsExt::from_mode(0o755)).unwrap();

    // SAFETY: these tests run one at a time. Private settings for what follows.
    let real_path = std::env::var_os("PATH").unwrap();
    unsafe {
        std::env::set_var("PATH", format!("{}:{}", bin.display(), real_path.to_string_lossy()));
        std::env::set_var("DOCKER_CONFIG", h.join("docker"));
    }
    let user = std::env::var("USER").unwrap_or_else(|_| "dev".into());
    docker(&["context", "create", "peak-remote", "--docker", &format!("host=ssh://{user}@peak-engine")]).unwrap();

    let t = tools();
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        println!("the context is listed and used per invocation, leaving the current one alone");
        assert!(transport::docker_contexts(&t).unwrap().contains(&"peak-remote".to_string()));
        let list = transport::docker_containers(&t, "peak-remote").unwrap();
        assert!(list.iter().any(|x| x.id == c.id), "found through the ssh context");
        assert!(docker(&["context", "show"]).unwrap().trim() == "default", "global selection unchanged");
        assert!(transport::docker_totals(&t, "peak-remote", &c.id).unwrap().unwrap().memory_used.unwrap() > 0.0);
        assert!(!transport::docker_top(&t, "peak-remote", &c.id).unwrap().is_empty());

        println!("the collector runs through it too");
        let r = remote();
        r.add(TargetSpec {
            id: "far".into(),
            label: "engine".into(),
            kind: Some(TargetKind::Docker),
            context: "peak-remote".into(),
            container: c.id.clone(),
            install: true,
            ..Default::default()
        });
        r.connect("far").unwrap();
        eventually("connected", 60, || state(&r, "far") == ConnectionState::Connected);
        let p = r.attach("far", 1).unwrap();
        eventually("samples", 20, || r.proc(&p.id).unwrap().samples.len() >= 3);
        r.shutdown();
    }));
    unsafe {
        std::env::set_var("PATH", real_path);
        std::env::remove_var("DOCKER_CONFIG");
    }
    drop(c);
    let _ = sshd.kill();
    let _ = sshd.wait();
    result.unwrap();
    println!("PASS");
}
