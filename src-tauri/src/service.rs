//! Ties the monitor, the agent hub and the database together. The Tauri
//! commands in `lib.rs` are thin wrappers over these methods.

use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use crate::db::Db;
use crate::hub::Hub;
use crate::model::*;
use crate::monitor::{Shared, now_ms};

/// Retention runs every this many ticks (10 minutes at 500ms).
const RETENTION_EVERY: u64 = 1200;
const DAY_MS: u64 = 86_400_000;

pub struct Service {
    pub monitor: Shared,
    pub hub: Arc<Hub>,
    pub db: Mutex<Db>,
    ticks: AtomicU64,
}

impl Service {
    /// Close out runs cut off by a previous crash and apply retention.
    pub fn new(monitor: Shared, hub: Arc<Hub>, db: Db) -> Service {
        let _ = db.close_dangling(now_ms());
        let _ = db.apply_retention(&db.settings(), now_ms());
        Service { monitor, hub, db: Mutex::new(db), ticks: AtomicU64::new(0) }
    }

    /// Sample everything once and persist what changed.
    pub fn tick(&self, t: u64) -> TickPayload {
        let (payload, writes) = {
            let mut m = self.monitor.lock().unwrap();
            let p = m.tick(t);
            (p, m.take_writes())
        };
        let mut db = self.db.lock().unwrap();
        if let Err(e) = db.write(&writes) {
            eprintln!("peak: {e}");
        }
        if self.ticks.fetch_add(1, Ordering::Relaxed) % RETENTION_EVERY == RETENTION_EVERY - 1 {
            let _ = db.apply_retention(&db.settings(), t);
        }
        payload
    }

    pub fn list_runs(&self, query: Option<&str>, limit: u32) -> Result<Vec<RunSummary>, String> {
        self.db.lock().unwrap().list_runs(query, limit)
    }

    /// Load a stored run into the session so it can be viewed (and re-run).
    pub fn open_run(&self, id: &str) -> Result<Proc, String> {
        if let Some(p) = self.monitor.lock().unwrap().get(id) {
            return Ok(p.clone());
        }
        let proc = self.db.lock().unwrap().load_run(id)?.ok_or("run not found")?;
        Ok(self.monitor.lock().unwrap().insert_historical(proc))
    }

    /// Load a stored run without adding it to the session (for comparisons).
    pub fn load_run(&self, id: &str) -> Result<Proc, String> {
        if let Some(p) = self.monitor.lock().unwrap().get(id) {
            return Ok(p.clone());
        }
        self.db.lock().unwrap().load_run(id)?.ok_or_else(|| "run not found".into())
    }

    pub fn delete_run(&self, id: &str) -> Result<bool, String> {
        if self.monitor.lock().unwrap().get(id).is_some_and(|p| p.status == Status::Running) {
            return Err("stop the process before deleting its history".into());
        }
        self.monitor.lock().unwrap().remove(id);
        self.db.lock().unwrap().delete_run(id)
    }

    /// Delete stopped runs older than `older_than_days` (all stopped runs if `None`).
    pub fn prune(&self, older_than_days: Option<u32>) -> Result<usize, String> {
        let before = older_than_days.map(|d| now_ms().saturating_sub(d as u64 * DAY_MS));
        if before.is_none() {
            self.monitor.lock().unwrap().clear_ended();
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
        let db = self.db.lock().unwrap();
        db.set_settings(s)?;
        db.apply_retention(s, now_ms())?;
        Ok(db.settings())
    }

    pub fn take_snapshot(&self, id: &str) -> Result<HeapSnapshot, String> {
        let snap = self.hub.take_snapshot(id, Duration::from_secs(120))?;
        let _ = self.db.lock().unwrap().add_snapshot(id, &snap);
        Ok(snap)
    }

    pub fn cpu_profile(&self, id: &str, ms: u64) -> Result<CpuProfile, String> {
        let profile = self.hub.cpu_profile(id, ms.clamp(500, 60_000))?;
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
        Service::new(m, hub, Db::open_in_memory().unwrap())
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
        let s = Service::new(m, hub, Db::open_in_memory().unwrap());
        assert_eq!(s.settings(), Settings::default());
        let next = Settings { max_runs: 3, alert_memory_mib: 256.0, ..Default::default() };
        assert_eq!(s.set_settings(&next).unwrap(), next);
        for _ in 0..RETENTION_EVERY {
            s.tick(now_ms());
        }
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
        responder.join().unwrap();
        let stored = s.db.lock().unwrap().load_run(&id).unwrap().unwrap();
        assert_eq!((stored.snapshots.len(), stored.cpu_profiles.len()), (1, 1));
        assert!(s.take_snapshot("nope").is_err());
        assert!(s.cpu_profile("nope", 1000).is_err());
    }
}
