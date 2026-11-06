//! The real runtime on whichever OS this runs on: no fixtures. Most other tests are tied to
//! Linux's `/proc` and shell, so this is what runs natively on macOS and Windows as well.

use std::sync::Arc;
use std::thread::sleep;
use std::time::{Duration, Instant};

use peak_lib::discovery::{Here, Publication, Standing, discover, start_ticks};
use peak_lib::hub::Hub;
use peak_lib::model::Status;
use peak_lib::monitor::{AgentEnv, Monitor, capture, now_ms};
use peak_lib::procfs::ProcFs;

fn wait_until(what: &str, mut ok: impl FnMut() -> bool) {
    let end = Instant::now() + Duration::from_secs(20);
    while !ok() {
        assert!(Instant::now() < end, "timed out waiting for {what}");
        sleep(Duration::from_millis(50));
    }
}

#[test]
fn monitors_a_real_command_to_its_exit() {
    let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
    let cwd = std::env::temp_dir().display().to_string();
    let line = if cfg!(windows) {
        "echo out-line& ping -n 3 127.0.0.1 >NUL& exit 3"
    } else {
        "echo out-line; sleep 2; exit 3"
    };
    let p = capture(&m, line, &cwd).unwrap();
    let mut peak = 0.0f64;
    wait_until("the exit", || {
        m.lock().unwrap().tick(now_ms());
        let g = m.lock().unwrap();
        let proc = g.get(&p.id).unwrap();
        peak = peak.max(proc.samples.iter().map(|s| s.rss).fold(0.0, f64::max));
        proc.status != Status::Running
    });
    let g = m.lock().unwrap();
    let done = g.get(&p.id).unwrap();
    assert_eq!(done.status, Status::Crashed);
    assert_eq!(done.exit_code, Some(3));
    assert!(done.logs.iter().any(|l| l.text.contains("out-line")), "output captured");
    assert!(peak > 0.0, "memory was sampled");
}

#[test]
fn stops_a_real_command() {
    let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
    let cwd = std::env::temp_dir().display().to_string();
    let line = if cfg!(windows) { "ping -n 60 127.0.0.1 >NUL" } else { "sleep 60" };
    let p = capture(&m, line, &cwd).unwrap();
    sleep(Duration::from_millis(300));
    let started = Instant::now();
    let pid = m.lock().unwrap().request_stop(&p.id).unwrap();
    sleep(Duration::from_millis(500));
    if m.lock().unwrap().get(&p.id).unwrap().status == Status::Running {
        // Programs without a window can ignore being asked. The app escalates the same way.
        peak_lib::runner::signal_group(pid, peak_lib::runner::SIGKILL);
    }
    wait_until("the stop", || m.lock().unwrap().get(&p.id).unwrap().status != Status::Running);
    assert!(started.elapsed() < Duration::from_secs(30));
    assert_eq!(m.lock().unwrap().get(&p.id).unwrap().status, Status::Exited);
}

#[test]
fn the_cli_reaches_a_published_app() {
    let dir = tempfile::tempdir().unwrap();
    let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
    let hub = Hub::start(m.clone(), "sek".into(), Arc::new(|_| {})).unwrap();
    let dirs = vec![dir.path().to_path_buf()];
    let here = Here::detect();
    let published = Publication::new(hub.addr().to_string(), "sek".into(), &dirs, &here);
    assert!(published.publish().is_empty());
    let found = discover(&dirs, &here, &start_ticks);
    assert_eq!(found.candidates.len(), 1);
    assert_eq!(found.candidates[0].standing, Standing::Live);

    let code = peak_lib::cli::run("exit 7", &dirs, std::io::sink(), std::io::sink()).unwrap();
    assert_eq!(code, 7);
    wait_until("the run in the app", || {
        m.lock().unwrap().full_state().procs.iter().any(|p| p.exit_code == Some(7) && p.status == Status::Crashed)
    });
    published.retire();
    assert!(discover(&dirs, &here, &start_ticks).candidates.is_empty());
}

#[test]
fn embeds_a_linux_collector() {
    let dir = tempfile::tempdir().unwrap();
    let arches: &[&str] = if cfg!(target_os = "linux") { &[std::env::consts::ARCH] } else { &["x86_64", "aarch64"] };
    for arch in arches {
        let path = peak_lib::bundled::embedded_collector(arch, dir.path())
            .unwrap_or_else(|| panic!("no collector for {arch}"))
            .unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(&bytes[..4], b"\x7fELF", "{arch} is a Linux binary");
    }
}

#[test]
fn a_finished_process_no_longer_counts_as_running() {
    let line = if cfg!(windows) { ["cmd", "/C", "exit 0"] } else { ["sh", "-c", "exit 0"] };
    let mut child = std::process::Command::new(line[0]).args(&line[1..]).spawn().unwrap();
    let pid = child.id();
    // Not reaped yet, so on Unix it's a zombie.
    sleep(Duration::from_millis(500));
    assert_eq!(start_ticks(pid), None);
    child.wait().unwrap();
}

#[test]
fn keeps_its_data_per_user() {
    assert!(peak_lib::hub::default_data_dir().ends_with("peak"));
    assert!(!peak_lib::discovery::default_dirs().is_empty());
    let info = peak_lib::release::InstallInfo::detect();
    assert_eq!(info.version, env!("CARGO_PKG_VERSION"));
    assert!(!info.updatable, "a test binary isn't an installed release");
}
