//! Ties the monitor, the agent hub and the database together. The Tauri
//! commands in `lib.rs` are thin wrappers over these methods.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::db::Db;
use crate::hub::Hub;
use crate::model::*;
use crate::monitor::{self, Shared, now_ms};
use crate::remote::{Connector, Remote, TargetSpec, TargetState, is_remote_id};

/// Retention runs every this many ticks (10 minutes at 500ms).
const RETENTION_EVERY: u64 = 1200;
const DAY_MS: u64 = 86_400_000;

pub struct Service {
    pub monitor: Shared,
    pub hub: Arc<Hub>,
    pub db: Mutex<Db>,
    pub remote: Remote,
    ticks: AtomicU64,
}

/// What the UI gets on `get_state`: local and remote runs, and the targets.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppState {
    pub procs: Vec<Proc>,
    pub system: SystemInfo,
    pub targets: Vec<TargetState>,
}

/// What the UI gets on every tick.
#[derive(serde::Serialize, Clone, Debug)]
#[serde(rename_all = "camelCase")]
pub struct AppTick {
    pub procs: Vec<ProcDelta>,
    pub system: Option<SystemSample>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub targets: Option<Vec<TargetState>>,
}

impl Service {
    /// Close out runs cut off by a previous crash and apply retention.
    pub fn new(monitor: Shared, hub: Arc<Hub>, db: Db, connector: Arc<dyn Connector>) -> Service {
        let _ = db.close_dangling(now_ms());
        let _ = db.apply_retention(&db.settings(), now_ms());
        let remote = Remote::new(connector);
        for spec in db.targets() {
            remote.add(spec);
        }
        Service { monitor, hub, db: Mutex::new(db), remote, ticks: AtomicU64::new(0) }
    }

    /// Sample everything once and persist what changed. Remote targets deliver on
    /// their own threads; this only collects what has already arrived.
    pub fn tick(&self, t: u64) -> AppTick {
        let (mut payload, mut writes) = {
            let mut m = self.monitor.lock().unwrap();
            let p = m.tick(t);
            (p, m.take_writes())
        };
        let drained = self.remote.drain();
        payload.procs.extend(drained.deltas);
        writes.extend(drained.writes);
        let mut db = self.db.lock().unwrap();
        if let Err(e) = db.write(&writes) {
            eprintln!("peak: {e}");
        }
        if self.ticks.fetch_add(1, Ordering::Relaxed) % RETENTION_EVERY == RETENTION_EVERY - 1 {
            let _ = db.apply_retention(&db.settings(), t);
        }
        AppTick { procs: payload.procs, system: payload.system, targets: drained.targets }
    }

    pub fn full_state(&self) -> AppState {
        let full = self.monitor.lock().unwrap().full_state();
        let mut procs = self.remote.procs();
        procs.extend(full.procs);
        AppState { procs, system: full.system, targets: self.remote.states() }
    }

    // ─── targets ───

    pub fn add_target(&self, spec: TargetSpec) -> Result<TargetState, String> {
        let state = self.remote.add(spec);
        self.db.lock().unwrap().set_targets(&self.remote.specs())?;
        Ok(state)
    }

    pub fn remove_target(&self, id: &str) -> Result<(), String> {
        self.remote.remove(id)?;
        self.db.lock().unwrap().set_targets(&self.remote.specs())
    }

    // ─── actions routed by where the run lives ───

    pub fn stop(&self, id: &str) -> Result<(), String> {
        if is_remote_id(id) {
            return self.remote.stop(id);
        }
        monitor::stop(&self.monitor, id, Duration::from_secs(3))
    }

    pub fn restart(&self, id: &str) -> Result<Proc, String> {
        if !is_remote_id(id) {
            return monitor::restart(&self.monitor, id);
        }
        // A run reopened from history isn't in any session; its stored specification
        // says where and how it ran. It only ever runs again on that target.
        let stored = self.monitor.lock().unwrap().get(id).and_then(|p| p.target.clone());
        let Some(target) = stored else { return self.remote.restart(id) };
        let spec = target.spec.ok_or("peak didn't launch this process, so it can't restart it")?;
        let proc = self.remote.launch(&target.target_id, spec)?;
        self.monitor.lock().unwrap().remove(id);
        Ok(proc)
    }

    /// Reopened remote runs live in the local session, not in a target's.
    pub fn remove(&self, id: &str) -> bool {
        (is_remote_id(id) && self.remote.forget(id)) || self.monitor.lock().unwrap().remove(id)
    }

    pub fn clear_ended(&self) -> usize {
        self.remote.clear_ended() + self.monitor.lock().unwrap().clear_ended()
    }

    pub fn force_gc(&self, id: &str) -> Result<(), String> {
        if is_remote_id(id) {
            return self.remote.force_gc(id);
        }
        self.hub.force_gc(id, Duration::from_secs(30))
    }

    /// Stop watching a remote run, leaving it running.
    pub fn detach(&self, id: &str) -> Result<(), String> {
        self.remote.detach(id)
    }

    /// The local run or the session's remote run with this id.
    fn live(&self, id: &str) -> Option<Proc> {
        let remote = if is_remote_id(id) { self.remote.proc(id) } else { None };
        remote.or_else(|| self.monitor.lock().unwrap().get(id).cloned())
    }

    pub fn list_runs(&self, query: Option<&str>, limit: u32) -> Result<Vec<RunSummary>, String> {
        self.db.lock().unwrap().list_runs(query, limit)
    }

    /// Load a stored run into the session so it can be viewed (and re-run).
    pub fn open_run(&self, id: &str) -> Result<Proc, String> {
        if let Some(p) = self.live(id) {
            return Ok(p);
        }
        let proc = self.db.lock().unwrap().load_run(id)?.ok_or("run not found")?;
        Ok(self.monitor.lock().unwrap().insert_historical(proc))
    }

    /// Load a stored run without adding it to the session (for comparisons).
    pub fn load_run(&self, id: &str) -> Result<Proc, String> {
        if let Some(p) = self.live(id) {
            return Ok(p);
        }
        self.db.lock().unwrap().load_run(id)?.ok_or_else(|| "run not found".into())
    }

    pub fn delete_run(&self, id: &str) -> Result<bool, String> {
        if self.live(id).is_some_and(|p| p.status == Status::Running) {
            return Err("stop the process before deleting its history".into());
        }
        self.remove(id);
        self.db.lock().unwrap().delete_run(id)
    }

    /// Delete stopped runs older than `older_than_days` (all stopped runs if `None`).
    pub fn prune(&self, older_than_days: Option<u32>) -> Result<usize, String> {
        let before = older_than_days.map(|d| now_ms().saturating_sub(d as u64 * DAY_MS));
        if before.is_none() {
            self.clear_ended();
        }
        self.db.lock().unwrap().prune(before)
    }

    pub fn storage_info(&self) -> Result<StorageInfo, String> {
        self.db.lock().unwrap().storage_info()
    }

    pub fn vacuum(&self) -> Result<(), String> {
        self.db.lock().unwrap().vacuum()
    }

    pub fn settings(&self) -> Settings {
        self.db.lock().unwrap().settings()
    }

    pub fn set_settings(&self, s: &Settings) -> Result<Settings, String> {
        let s = s.sanitized();
        let db = self.db.lock().unwrap();
        db.set_settings(&s)?;
        db.apply_retention(&s, now_ms())?;
        Ok(db.settings())
    }

    /// Record a threshold crossing on the run (the UI evaluates thresholds).
    pub fn add_alert(&self, id: &str, alert: &Alert) -> Result<(), String> {
        self.monitor.lock().unwrap().add_alert(id, alert.clone());
        self.remote.add_alert(id, alert);
        self.db.lock().unwrap().add_alert(id, alert)
    }

    pub fn take_snapshot(&self, id: &str) -> Result<HeapSnapshot, String> {
        let snap = if is_remote_id(id) {
            self.remote.snapshot(id)?
        } else {
            self.hub.take_snapshot(id, Duration::from_secs(120))?
        };
        let _ = self.db.lock().unwrap().add_snapshot(id, &snap);
        Ok(snap)
    }

    pub fn cpu_profile(&self, id: &str, ms: u64) -> Result<CpuProfile, String> {
        let ms = ms.clamp(500, 60_000);
        let profile = if is_remote_id(id) { self.remote.cpu_profile(id, ms)? } else { self.hub.cpu_profile(id, ms)? };
        let _ = self.db.lock().unwrap().add_cpu_profile(id, &profile);
        Ok(profile)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::{self, AgentEnv, Monitor, Origin};
    use crate::procfs::ProcFs;
    use serde_json::{Value, json};
    use std::io::{BufRead, BufReader, Write};
    use std::net::TcpStream;
    use std::thread;

    fn service() -> Service {
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m.clone(), "s".into(), Arc::new(|_| {})).unwrap();
        Service::new(m, hub, Db::open_in_memory().unwrap(), Arc::new(NoConnector))
    }

    struct NoConnector;
    impl Connector for NoConnector {
        fn connect(&self, _: &TargetSpec) -> Result<crate::remote::Link, String> {
            Err("no transport in this test".into())
        }
    }

    fn wait_ended(s: &Service, id: &str) {
        for _ in 0..400 {
            s.tick(now_ms());
            if s.monitor.lock().unwrap().get(id).is_some_and(|p| p.status != Status::Running) {
                s.tick(now_ms());
                return;
            }
            thread::sleep(Duration::from_millis(20));
        }
        panic!("never ended");
    }

    #[test]
    fn persists_runs_and_reopens_them() {
        let s = service();
        let p = monitor::capture(&s.monitor, "echo stored; exit 0", "/tmp").unwrap();
        wait_ended(&s, &p.id);
        let runs = s.list_runs(None, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].status, Status::Exited);
        assert!(runs[0].samples >= 1);

        // Gone from the session but still on disk: open brings it back.
        s.monitor.lock().unwrap().remove(&p.id);
        assert!(s.monitor.lock().unwrap().get(&p.id).is_none());
        let loaded = s.load_run(&p.id).unwrap();
        assert!(loaded.logs.iter().any(|l| l.text == "stored"));
        assert!(s.monitor.lock().unwrap().get(&p.id).is_none(), "load does not add to the session");
        let opened = s.open_run(&p.id).unwrap();
        assert_eq!(opened.id, p.id);
        assert!(s.monitor.lock().unwrap().get(&p.id).is_some());
        assert_eq!(s.open_run(&p.id).unwrap().id, p.id, "already open");
        assert_eq!(s.load_run(&p.id).unwrap().id, p.id, "served from the session");
        assert!(s.open_run("nope").is_err());
        assert!(s.load_run("nope").is_err());
    }

    #[test]
    fn reopened_runs_are_marked_and_alerts_persist() {
        let s = service();
        let p = monitor::capture(&s.monitor, "exit 0", "/tmp").unwrap();
        wait_ended(&s, &p.id);
        let alert = Alert { t: now_ms(), kind: "memory".into(), message: "over".into(), value: 2.0, threshold: 1.0 };
        s.add_alert(&p.id, &alert).unwrap();
        assert_eq!(s.monitor.lock().unwrap().get(&p.id).unwrap().alerts, vec![alert.clone()]);
        assert!(!s.monitor.lock().unwrap().get(&p.id).unwrap().historical);

        s.monitor.lock().unwrap().remove(&p.id);
        let loaded = s.load_run(&p.id).unwrap();
        assert!(!loaded.historical, "a comparison load is not a reopened run");
        assert_eq!(loaded.alerts, vec![alert]);
        let opened = s.open_run(&p.id).unwrap();
        assert!(opened.historical);
        assert!(s.monitor.lock().unwrap().get(&p.id).unwrap().historical);
        // Unknown runs can't take alerts: the foreign key refuses them.
        let a = Alert { t: 1, kind: "cpu".into(), message: "m".into(), value: 1.0, threshold: 1.0 };
        assert!(s.add_alert("nope", &a).is_err());
    }

    #[test]
    fn targets_persist_and_route_without_touching_local_runs() {
        let db = Db::open_in_memory().unwrap();
        let spec = TargetSpec { id: "saved".into(), kind: Some(TargetKind::Ssh), ..Default::default() };
        db.set_targets(std::slice::from_ref(&spec)).unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m.clone(), "s".into(), Arc::new(|_| {})).unwrap();
        let s = Service::new(m, hub, db, Arc::new(NoConnector));
        assert_eq!(s.full_state().targets[0].spec.id, "saved", "known targets survive restarts");
        assert_eq!(s.full_state().targets[0].state, ConnectionState::Disconnected, "and don't connect themselves");

        s.add_target(TargetSpec { id: "new".into(), ..Default::default() }).unwrap();
        assert_eq!(s.db.lock().unwrap().targets().len(), 2);
        s.remove_target("new").unwrap();
        assert_eq!(s.db.lock().unwrap().targets().len(), 1);
        assert!(s.remove_target("new").is_err());

        // Remote ids go to the remote side, whose answer is honest about the link.
        let far = "saved~p1";
        assert!(s.stop(far).is_err() && s.restart(far).is_err() && s.force_gc(far).is_err());
        assert!(s.take_snapshot(far).is_err() && s.cpu_profile(far, 500).is_err() && s.detach(far).is_err());
        assert!(!s.remove(far));
        assert!(s.open_run(far).is_err() && s.load_run(far).is_err());
        assert!(s.tick(now_ms()).targets.is_some(), "the UI hears about targets");

        // A local run in the same service still works as before.
        let local = monitor::capture(&s.monitor, "sleep 30", "/tmp").unwrap();
        assert!(s.force_gc(&local.id).is_err(), "no agent on a shell command");
        s.stop(&local.id).unwrap();
        wait_ended(&s, &local.id);
        let again = s.restart(&local.id).unwrap();
        s.stop(&again.id).unwrap();
        wait_ended(&s, &again.id);
        assert!(s.remove(&again.id));
        assert_eq!(s.clear_ended(), 0);
    }

    #[test]
    fn a_reopened_remote_run_is_handled_where_it_now_lives() {
        let s = service();
        let spec = LaunchSpec { command: Some("x".into()), argv: None, cwd: "/".into() };
        let target = |spec: Option<LaunchSpec>| ProcTarget {
            target_id: "gone".into(),
            label: "l".into(),
            kind: TargetKind::Ssh,
            identity: ProcIdentity::default(),
            launched: spec.is_some(),
            spec,
            clock_offset_ms: 0,
        };
        let p = monitor::attach(&s.monitor, std::process::id()).unwrap();
        let stored =
            |id: &str, t: ProcTarget| Proc { id: id.into(), status: Status::Exited, target: Some(t), ..p.clone() };
        {
            let mut m = s.monitor.lock().unwrap();
            m.insert_historical(stored("gone~launched", target(Some(spec))));
            m.insert_historical(stored("gone~attached", target(None)));
        }
        assert_eq!(s.open_run("gone~launched").unwrap().id, "gone~launched", "served from the session");
        assert!(s.restart("gone~attached").unwrap_err().contains("didn't launch"));
        assert!(
            s.restart("gone~launched").unwrap_err().contains("unknown target"),
            "only on its own target, never locally"
        );
        assert!(s.remove("gone~attached"));
        assert!(!s.remove("gone~attached"));
        assert!(!s.delete_run("gone~launched").unwrap(), "nothing stored for this made-up run");
        assert!(s.monitor.lock().unwrap().get("gone~launched").is_none());
        s.monitor.lock().unwrap().forget(&p.id);
    }

    /// A real collector session on pipes.
    struct OnPipes;
    impl Connector for OnPipes {
        fn connect(&self, _: &TargetSpec) -> Result<crate::remote::Link, String> {
            let (in_r, in_w) = std::io::pipe().map_err(|e| e.to_string())?;
            let (out_r, out_w) = std::io::pipe().map_err(|e| e.to_string())?;
            let dir = tempfile::tempdir().map_err(|e| e.to_string())?;
            let opts = peak_core::collector::Options { data_dir: Some(dir.path().to_path_buf()), ..Default::default() };
            thread::spawn(move || {
                let _keep = dir;
                peak_core::collector::serve(BufReader::new(in_r), out_w, opts);
            });
            Ok(crate::remote::Link {
                reader: Box::new(out_r),
                writer: Box::new(in_w),
                close: Box::new(|| {}),
                diagnostics: Default::default(),
            })
        }
    }

    #[test]
    fn a_reopened_launched_run_only_runs_again_on_its_own_target() {
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m.clone(), "s".into(), Arc::new(|_| {})).unwrap();
        let s = Service::new(m, hub, Db::open_in_memory().unwrap(), Arc::new(OnPipes));
        s.add_target(TargetSpec {
            id: "t".into(),
            label: "box".into(),
            kind: Some(TargetKind::Ssh),
            ..Default::default()
        })
        .unwrap();
        s.remote.connect("t").unwrap();
        for _ in 0..500 {
            if s.remote.states()[0].state == ConnectionState::Connected {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        let spec = LaunchSpec { command: Some("sleep 30".into()), argv: None, cwd: "/tmp".into() };
        let first = s.remote.launch("t", spec).unwrap();
        // What a reopened run looks like: in the local session, ended, with its spec.
        let local = monitor::attach(&s.monitor, std::process::id()).unwrap();
        s.monitor.lock().unwrap().forget(&local.id);
        let stored = Proc { id: "t~stored".into(), status: Status::Exited, target: first.target.clone(), ..local };
        s.monitor.lock().unwrap().insert_historical(stored);

        let again = s.restart("t~stored").unwrap();
        assert!(again.id.starts_with("t~") && again.id != "t~stored");
        assert_eq!(again.target.unwrap().target_id, "t");
        assert!(s.monitor.lock().unwrap().get("t~stored").is_none(), "it took the old entry's place");
        s.remote.shutdown();
    }

    #[test]
    fn settings_are_sanitized_before_they_are_stored() {
        let s = service();
        let next = Settings { alert_memory_mib: -5.0, ..Default::default() };
        assert_eq!(s.set_settings(&next).unwrap().alert_memory_mib, 0.0);
    }

    #[test]
    fn deletes_prunes_and_reports_storage() {
        let s = service();
        let a = monitor::capture(&s.monitor, "exit 0", "/tmp").unwrap();
        wait_ended(&s, &a.id);
        let live = monitor::capture(&s.monitor, "sleep 30", "/tmp").unwrap();
        s.tick(now_ms());
        assert!(s.delete_run(&live.id).is_err());
        assert_eq!(s.storage_info().unwrap().runs, 2);
        assert_eq!(s.prune(Some(30)).unwrap(), 0, "nothing is that old");
        assert!(s.delete_run(&a.id).unwrap());
        assert!(!s.delete_run(&a.id).unwrap());
        let b = monitor::capture(&s.monitor, "exit 0", "/tmp").unwrap();
        wait_ended(&s, &b.id);
        assert_eq!(s.prune(None).unwrap(), 1);
        assert!(
            s.monitor.lock().unwrap().get(&b.id).is_none(),
            "pruning everything clears ended runs from the session"
        );
        s.vacuum().unwrap();
        monitor::stop(&s.monitor, &live.id, Duration::from_millis(100)).unwrap();
        wait_ended(&s, &live.id);
    }

    #[test]
    fn settings_round_trip_and_retention_ticks() {
        // An empty fake /proc keeps 1200 ticks cheap.
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::new(dir.path(), "/nope"), AgentEnv::default()).shared();
        let hub = Hub::start(m.clone(), "s".into(), Arc::new(|_| {})).unwrap();
        let s = Service::new(m, hub, Db::open_in_memory().unwrap(), Arc::new(NoConnector));
        assert_eq!(s.settings(), Settings::default());
        let next = Settings { max_runs: 3, alert_memory_mib: 256.0, ..Default::default() };
        assert_eq!(s.set_settings(&next).unwrap(), next);
        for _ in 0..RETENTION_EVERY {
            s.tick(now_ms());
        }
    }

    /// The real agents, launched by the monitor and served by the hub: lag reaches
    /// samples and a CPU profile lands on the run and in the database.
    fn profiles_a_real_runtime(command: &str, expect_frame: &str) {
        let dir = tempfile::tempdir().unwrap();
        let m = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
        let hub = Hub::start(m.clone(), "s".into(), Arc::new(|_| {})).unwrap();
        let env = crate::hub::install_agents(dir.path(), &hub.addr().to_string()).unwrap();
        m.lock().unwrap().agent_env = env;
        let s = Service::new(m, hub, Db::open_in_memory().unwrap(), Arc::new(NoConnector));
        let p = monitor::capture(&s.monitor, command, dir.path().to_str().unwrap()).unwrap();

        let mut lag = None;
        for _ in 0..200 {
            s.tick(now_ms());
            let proc = s.monitor.lock().unwrap().get(&p.id).unwrap().clone();
            assert_eq!(proc.status, Status::Running, "{:?}", proc.logs);
            lag = proc.samples.last().and_then(|x| x.loop_lag).filter(|_| proc.profiling);
            if lag.is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(50));
        }
        assert!(lag.is_some_and(|l| l >= 0.0), "no runtime lag reached the samples");

        let profile = s.cpu_profile(&p.id, 600).unwrap();
        assert!(profile.duration_ms >= 500.0, "{}", profile.duration_ms);
        assert_eq!(profile.root.name, "(root)");
        assert_ne!(profile.sampling, "unknown", "real agents say how they sampled");
        fn has(f: &AllocFrame, name: &str) -> bool {
            f.name == name || f.children.iter().any(|c| has(c, name))
        }
        assert!(has(&profile.root, expect_frame), "{expect_frame} missing from {:#?}", profile.root);
        assert_eq!(s.monitor.lock().unwrap().get(&p.id).unwrap().cpu_profiles.len(), 1);

        monitor::stop(&s.monitor, &p.id, Duration::from_millis(200)).unwrap();
        wait_ended(&s, &p.id);
        let stored = s.load_run(&p.id).unwrap();
        assert_eq!(stored.cpu_profiles.len(), 1);
        let stored = s.db.lock().unwrap().load_run(&p.id).unwrap().unwrap();
        assert_eq!(stored.cpu_profiles[0].root, profile.root);
        assert!(stored.samples.iter().any(|x| x.loop_lag.is_some()), "lag is persisted");
    }

    #[test]
    fn profiles_real_node_processes() {
        profiles_a_real_runtime(
            "node --no-use-osr -e 'function busyWork(){const e=Date.now()+50;while(Date.now()<e);} setInterval(busyWork,60)'",
            "busyWork",
        );
    }

    #[test]
    fn profiles_real_python_processes() {
        profiles_a_real_runtime(
            "python3 -c 'import time\ndef busy_work():\n  e=time.time()+0.05\n  while time.time()<e: pass\nwhile True: busy_work()'",
            "busy_work",
        );
    }

    #[test]
    fn stores_artifacts_from_agents() {
        let s = service();
        let id = {
            let mut m = s.monitor.lock().unwrap();
            let id = m.new_id();
            m.insert(id.clone(), Origin::External, std::process::id(), "node a.js", "/tmp", now_ms());
            id
        };
        s.tick(now_ms()); // writes the run row
        let mut agent = TcpStream::connect(s.hub.addr()).unwrap();
        writeln!(agent, "{}", json!({"type": "hello", "token": id, "pid": 9, "runtime": "node"})).unwrap();
        let mut lines = BufReader::new(agent.try_clone().unwrap()).lines();
        let responder = thread::spawn(move || {
            for _ in 0..2 {
                let req: Value = serde_json::from_str(&lines.next().unwrap().unwrap()).unwrap();
                let data = match req["cmd"].as_str().unwrap() {
                    "snapshot" => json!({"heapUsed": 1, "entries": []}),
                    _ => {
                        assert_eq!(req["ms"], 500);
                        json!({"durationMs": 500, "root": {"name": "(root)", "self": 0, "children": []}})
                    }
                };
                writeln!(agent, "{}", json!({"type": "reply", "reqId": req["reqId"], "ok": true, "data": data}))
                    .unwrap();
            }
        });
        for _ in 0..100 {
            if s.monitor.lock().unwrap().primary_agent(&id).is_some() {
                break;
            }
            thread::sleep(Duration::from_millis(10));
        }
        s.take_snapshot(&id).unwrap();
        let prof = s.cpu_profile(&id, 10).unwrap(); // clamped up to 500ms
        assert_eq!(prof.duration_ms, 500.0);
        assert_eq!(prof.sampling, "unknown", "an agent that doesn't say isn't assumed on-CPU");
        responder.join().unwrap();
        let stored = s.db.lock().unwrap().load_run(&id).unwrap().unwrap();
        assert_eq!((stored.snapshots.len(), stored.cpu_profiles.len()), (1, 1));
        assert!(s.take_snapshot("nope").is_err());
        assert!(s.cpu_profile("nope", 1000).is_err());
    }
}
