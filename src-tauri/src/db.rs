//! SQLite persistence: every run, its samples, output, GC events, heap
//! snapshots and CPU profiles, plus app settings and retention.

use std::path::{Path, PathBuf};

use rusqlite::{Connection, OptionalExtension, params};

use crate::model::*;
use crate::monitor::RunWrite;
use crate::remote::TargetSpec;

const SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS runs (
    id TEXT PRIMARY KEY,
    pid INTEGER NOT NULL,
    command TEXT NOT NULL,
    cwd TEXT NOT NULL,
    runtime TEXT NOT NULL,
    status TEXT NOT NULL,
    started_at INTEGER NOT NULL,
    ended_at INTEGER,
    exit_code INTEGER,
    signal TEXT,
    peak_rss REAL NOT NULL DEFAULT 0,
    avg_cpu REAL NOT NULL DEFAULT 0,
    samples INTEGER NOT NULL DEFAULT 0,
    meta TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS runs_started ON runs(started_at);
CREATE INDEX IF NOT EXISTS runs_command ON runs(command);
CREATE TABLE IF NOT EXISTS samples (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    t INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS samples_run ON samples(run_id, t);
CREATE TABLE IF NOT EXISTS logs (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    id INTEGER NOT NULL,
    t INTEGER NOT NULL,
    stream TEXT NOT NULL,
    text TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS logs_run ON logs(run_id, id);
CREATE TABLE IF NOT EXISTS gc (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    t INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS gc_run ON gc(run_id, t);
CREATE TABLE IF NOT EXISTS artifacts (
    run_id TEXT NOT NULL REFERENCES runs(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    t INTEGER NOT NULL,
    data TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artifacts_run ON artifacts(run_id, kind);
CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
";

const DAY_MS: u64 = 86_400_000;

type Result<T> = std::result::Result<T, String>;

fn err(e: impl std::fmt::Display) -> String {
    format!("database: {e}")
}

fn json<T: serde::Serialize>(v: &T) -> String {
    serde_json::to_string(v).expect("model types always serialize")
}

fn enum_str<T: serde::Serialize>(v: &T) -> String {
    json(v).trim_matches('"').to_string()
}

fn parse_enum<T: serde::de::DeserializeOwned>(s: &str) -> Option<T> {
    serde_json::from_str(&format!("\"{s}\"")).ok()
}

pub struct Db {
    conn: Connection,
    path: PathBuf,
}

impl Db {
    pub fn open(path: &Path) -> Result<Db> {
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(err)?;
        }
        Db::init(Connection::open(path).map_err(err)?, path.to_path_buf())
    }

    pub fn open_in_memory() -> Result<Db> {
        Db::init(Connection::open_in_memory().map_err(err)?, PathBuf::from(":memory:"))
    }

    fn init(conn: Connection, path: PathBuf) -> Result<Db> {
        conn.pragma_update(None, "journal_mode", "WAL").map_err(err)?;
        conn.pragma_update(None, "foreign_keys", "ON").map_err(err)?;
        conn.pragma_update(None, "synchronous", "NORMAL").map_err(err)?;
        conn.execute_batch(SCHEMA).map_err(err)?;
        Ok(Db { conn, path })
    }

    /// Persist one tick's worth of changes in a single transaction.
    pub fn write(&mut self, writes: &[RunWrite]) -> Result<()> {
        if writes.is_empty() {
            return Ok(());
        }
        let tx = self.conn.transaction().map_err(err)?;
        {
            let mut run = tx
                .prepare_cached(
                    "INSERT INTO runs (id, pid, command, cwd, runtime, status, started_at, ended_at, exit_code, signal, peak_rss, avg_cpu, samples, meta)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14)
                     ON CONFLICT(id) DO UPDATE SET
                       pid = excluded.pid, runtime = excluded.runtime, status = excluded.status,
                       ended_at = excluded.ended_at, exit_code = excluded.exit_code, signal = excluded.signal,
                       peak_rss = excluded.peak_rss, avg_cpu = excluded.avg_cpu,
                       samples = runs.samples + excluded.samples, meta = excluded.meta",
                )
                .map_err(err)?;
            let mut sample =
                tx.prepare_cached("INSERT INTO samples (run_id, t, data) VALUES (?1, ?2, ?3)").map_err(err)?;
            let mut log = tx
                .prepare_cached("INSERT INTO logs (run_id, id, t, stream, text) VALUES (?1, ?2, ?3, ?4, ?5)")
                .map_err(err)?;
            let mut gc = tx.prepare_cached("INSERT INTO gc (run_id, t, data) VALUES (?1, ?2, ?3)").map_err(err)?;
            for w in writes {
                let m = &w.meta;
                run.execute(params![
                    m.id,
                    m.pid,
                    m.command,
                    m.cwd,
                    enum_str(&m.runtime),
                    enum_str(&m.status),
                    m.started_at as i64,
                    m.ended_at.map(|t| t as i64),
                    m.exit_code,
                    m.signal,
                    m.peak.rss,
                    w.avg_cpu,
                    w.samples.len() as i64,
                    json(m),
                ])
                .map_err(err)?;
                for s in &w.samples {
                    sample.execute(params![m.id, s.t as i64, json(s)]).map_err(err)?;
                }
                for l in &w.logs {
                    log.execute(params![m.id, l.id as i64, l.t as i64, enum_str(&l.stream), l.text]).map_err(err)?;
                }
                for g in &w.gc {
                    gc.execute(params![m.id, g.t as i64, json(g)]).map_err(err)?;
                }
            }
        }
        tx.commit().map_err(err)
    }

    fn add_artifact(&self, run_id: &str, kind: &str, t: u64, data: String) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO artifacts (run_id, kind, t, data) VALUES (?1, ?2, ?3, ?4)",
                params![run_id, kind, t as i64, data],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn add_snapshot(&self, run_id: &str, s: &HeapSnapshot) -> Result<()> {
        self.add_artifact(run_id, "snapshot", s.t, json(s))
    }

    pub fn add_cpu_profile(&self, run_id: &str, p: &CpuProfile) -> Result<()> {
        self.add_artifact(run_id, "cpu", p.t, json(p))
    }

    pub fn add_alert(&self, run_id: &str, a: &Alert) -> Result<()> {
        self.add_artifact(run_id, "alert", a.t, json(a))
    }

    /// Runs, newest first, optionally filtered by a substring of the command.
    pub fn list_runs(&self, query: Option<&str>, limit: u32) -> Result<Vec<RunSummary>> {
        let pattern = format!("%{}%", query.unwrap_or("").replace('%', "\\%").replace('_', "\\_"));
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, pid, command, cwd, runtime, status, started_at, ended_at, exit_code, signal, peak_rss, avg_cpu, samples
                 FROM runs WHERE command LIKE ?1 ESCAPE '\\' ORDER BY started_at DESC LIMIT ?2",
            )
            .map_err(err)?;
        let rows = stmt
            .query_map(params![pattern, limit], |r| {
                Ok(RunSummary {
                    id: r.get(0)?,
                    pid: r.get(1)?,
                    command: r.get(2)?,
                    cwd: r.get(3)?,
                    runtime: parse_enum(&r.get::<_, String>(4)?).unwrap_or(Runtime::Shell),
                    status: parse_enum(&r.get::<_, String>(5)?).unwrap_or(Status::Exited),
                    started_at: r.get::<_, i64>(6)? as u64,
                    ended_at: r.get::<_, Option<i64>>(7)?.map(|t| t as u64),
                    exit_code: r.get(8)?,
                    signal: r.get(9)?,
                    peak_rss: r.get(10)?,
                    avg_cpu: r.get(11)?,
                    samples: r.get::<_, i64>(12)? as u64,
                })
            })
            .map_err(err)?;
        rows.collect::<std::result::Result<_, _>>().map_err(err)
    }

    /// The most recent `limit` rows of `sql` (which must select one JSON column,
    /// ordered newest first), returned oldest first.
    fn recent_json<T: serde::de::DeserializeOwned>(&self, sql: &str, id: &str, limit: usize) -> Result<Vec<T>> {
        let mut stmt = self.conn.prepare(sql).map_err(err)?;
        let rows = stmt.query_map(params![id, limit as i64], |r| r.get::<_, String>(0)).map_err(err)?;
        let mut out: Vec<T> = rows.filter_map(|r| r.ok()).filter_map(|s| serde_json::from_str(&s).ok()).collect();
        out.reverse();
        Ok(out)
    }

    /// A full run (most recent history windows, like the live view keeps).
    pub fn load_run(&self, id: &str) -> Result<Option<Proc>> {
        let row = self
            .conn
            .query_row("SELECT meta, status, ended_at, exit_code, signal FROM runs WHERE id = ?1", params![id], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<i64>>(2)?,
                    r.get::<_, Option<i32>>(3)?,
                    r.get::<_, Option<String>>(4)?,
                ))
            })
            .optional()
            .map_err(err)?;
        let Some((meta, status, ended_at, exit_code, signal)) = row else { return Ok(None) };
        let mut p: Proc = serde_json::from_str(&meta).map_err(err)?;
        // Columns are the source of truth for how the run ended.
        p.status = parse_enum(&status).unwrap_or(Status::Exited);
        p.ended_at = ended_at.map(|t| t as u64);
        p.exit_code = exit_code;
        p.signal = signal;
        p.samples =
            self.recent_json("SELECT data FROM samples WHERE run_id = ?1 ORDER BY t DESC LIMIT ?2", id, MAX_SAMPLES)?;
        p.gc = self.recent_json("SELECT data FROM gc WHERE run_id = ?1 ORDER BY t DESC LIMIT ?2", id, MAX_GC)?;
        p.snapshots = self.recent_json(
            "SELECT data FROM artifacts WHERE run_id = ?1 AND kind = 'snapshot' ORDER BY t DESC LIMIT ?2",
            id,
            100,
        )?;
        p.cpu_profiles = self.recent_json(
            "SELECT data FROM artifacts WHERE run_id = ?1 AND kind = 'cpu' ORDER BY t DESC LIMIT ?2",
            id,
            100,
        )?;
        p.alerts = self.recent_json(
            "SELECT data FROM artifacts WHERE run_id = ?1 AND kind = 'alert' ORDER BY t DESC LIMIT ?2",
            id,
            1000,
        )?;
        let mut stmt = self
            .conn
            .prepare("SELECT id, t, stream, text FROM logs WHERE run_id = ?1 ORDER BY id DESC LIMIT ?2")
            .map_err(err)?;
        let mut logs: Vec<LogLine> = stmt
            .query_map(params![id, MAX_LOGS as i64], |r| {
                Ok(LogLine {
                    id: r.get::<_, i64>(0)? as u64,
                    t: r.get::<_, i64>(1)? as u64,
                    stream: parse_enum(&r.get::<_, String>(2)?).unwrap_or(Stream::Stdout),
                    text: r.get(3)?,
                })
            })
            .map_err(err)?
            .filter_map(|r| r.ok())
            .collect();
        logs.reverse();
        p.logs = logs;
        if p.samples.is_empty() {
            p.samples.push(Sample { t: p.started_at, ..Default::default() });
        }
        Ok(Some(p))
    }

    pub fn delete_run(&self, id: &str) -> Result<bool> {
        self.conn.execute("DELETE FROM runs WHERE id = ?1", params![id]).map(|n| n > 0).map_err(err)
    }

    /// Delete stopped runs that ended before `before` (all stopped runs if `None`).
    pub fn prune(&self, before: Option<u64>) -> Result<usize> {
        let sql = "DELETE FROM runs WHERE status != 'running' AND COALESCE(ended_at, started_at) < ?1";
        self.conn.execute(sql, params![before.map(|b| b as i64).unwrap_or(i64::MAX)]).map_err(err)
    }

    /// Keep only the newest `keep` stopped runs.
    pub fn prune_to(&self, keep: u32) -> Result<usize> {
        self.conn
            .execute(
                "DELETE FROM runs WHERE id IN (
                   SELECT id FROM runs WHERE status != 'running' ORDER BY started_at DESC LIMIT -1 OFFSET ?1)",
                params![keep],
            )
            .map_err(err)
    }

    /// Apply the retention policy. Returns how many runs were removed.
    pub fn apply_retention(&self, s: &Settings, now: u64) -> Result<usize> {
        let mut n = 0;
        if s.retention_days > 0 {
            n += self.prune(Some(now.saturating_sub(s.retention_days as u64 * DAY_MS)))?;
        }
        if s.max_runs > 0 {
            n += self.prune_to(s.max_runs)?;
        }
        Ok(n)
    }

    /// Runs still marked running were cut off when peak last quit.
    pub fn close_dangling(&self, now: u64) -> Result<usize> {
        self.conn
            .execute(
                "UPDATE runs SET status = 'exited', ended_at = COALESCE(ended_at, ?1), signal = COALESCE(signal, 'peak closed')
                 WHERE status = 'running'",
                params![now as i64],
            )
            .map_err(err)
    }

    /// Targets the user has set up. Connection state isn't stored: nothing reconnects by itself.
    pub fn targets(&self) -> Vec<TargetSpec> {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = 'targets'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default()
    }

    pub fn set_targets(&self, targets: &[TargetSpec]) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO settings (key, value) VALUES ('targets', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![json(&targets)],
            )
            .map(|_| ())
            .map_err(err)
    }

    pub fn storage_info(&self) -> Result<StorageInfo> {
        let count = |sql: &str| self.conn.query_row(sql, [], |r| r.get::<_, i64>(0)).map(|n| n as u64).map_err(err);
        let size = |p: PathBuf| std::fs::metadata(p).map(|m| m.len()).unwrap_or(0);
        let wal = PathBuf::from(format!("{}-wal", self.path.display()));
        Ok(StorageInfo {
            path: self.path.display().to_string(),
            bytes: size(self.path.clone()) + size(wal),
            runs: count("SELECT COUNT(*) FROM runs")?,
            stopped_runs: count("SELECT COUNT(*) FROM runs WHERE status != 'running'")?,
            samples: count("SELECT COUNT(*) FROM samples")?,
        })
    }

    pub fn vacuum(&self) -> Result<()> {
        self.conn.execute_batch("PRAGMA wal_checkpoint(TRUNCATE); VACUUM;").map_err(err)
    }

    pub fn settings(&self) -> Settings {
        self.conn
            .query_row("SELECT value FROM settings WHERE key = 'settings'", [], |r| r.get::<_, String>(0))
            .ok()
            .and_then(|v| serde_json::from_str(&v).ok())
            .unwrap_or_default()
    }

    pub fn set_settings(&self, s: &Settings) -> Result<()> {
        self.conn
            .execute("INSERT INTO settings (key, value) VALUES ('settings', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![json(s)])
            .map(|_| ())
            .map_err(err)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::monitor::meta_of;

    fn proc(id: &str, command: &str, status: Status, started_at: u64, ended_at: Option<u64>) -> Proc {
        let s = Sample { t: started_at, rss: 100.0, ..Default::default() };
        Proc {
            id: id.into(),
            pid: 42,
            ppid: 1,
            user: "noah".into(),
            exe: "/bin/x".into(),
            command: command.into(),
            cwd: "/tmp".into(),
            runtime: Runtime::Node,
            status,
            started_at,
            ended_at,
            exit_code: ended_at.map(|_| 0),
            signal: None,
            nice: 0,
            threads: 1,
            vsz: 0.0,
            swap: 0.0,
            fds: Fds::default(),
            counters: Counters::default(),
            samples: vec![s.clone()],
            peak: s,
            gc: vec![],
            has_gc: true,
            profiling: true,
            snapshots: vec![],
            logs: vec![],
            children: vec![],
            child_names: Default::default(),
            ports: vec![],
            cpu_profiles: vec![],
            alerts: vec![],
            historical: false,
            unavailable: vec![],
            target: None,
            gaps: vec![],
        }
    }

    fn write(db: &mut Db, mut p: Proc, samples: Vec<Sample>, logs: Vec<LogLine>, gc: Vec<GcEvent>) {
        db.write(&[RunWrite { meta: meta_of(&mut p), avg_cpu: 12.5, samples, logs, gc }]).unwrap();
    }

    fn s(t: u64, rss: f64) -> Sample {
        Sample { t, rss, ..Default::default() }
    }

    #[test]
    fn round_trips_a_run() {
        let mut db = Db::open_in_memory().unwrap();
        db.write(&[]).unwrap();
        let p = proc("a", "node app.js", Status::Running, 1000, None);
        let log = LogLine { id: 7, t: 1100, stream: Stream::Stderr, text: "boom".into() };
        let gc = GcEvent { t: 1200, kind: GcKind::Major, pause_ms: 3.0, freed: 10.0 };
        write(&mut db, p.clone(), vec![s(1000, 1.0), s(1500, 2.0)], vec![log.clone()], vec![gc.clone()]);
        let mut ended = p.clone();
        ended.status = Status::Crashed;
        ended.ended_at = Some(2000);
        ended.exit_code = Some(1);
        ended.signal = Some("SIGSEGV".into());
        write(&mut db, ended, vec![s(2000, 3.0)], vec![], vec![]);

        let runs = db.list_runs(None, 10).unwrap();
        assert_eq!(runs.len(), 1);
        assert_eq!(runs[0].samples, 3);
        assert_eq!(runs[0].status, Status::Crashed);
        assert_eq!(runs[0].avg_cpu, 12.5);
        assert_eq!(runs[0].runtime, Runtime::Node);

        let loaded = db.load_run("a").unwrap().unwrap();
        assert_eq!(loaded.samples.iter().map(|s| s.t).collect::<Vec<_>>(), vec![1000, 1500, 2000]);
        assert_eq!(loaded.logs, vec![log]);
        assert_eq!(loaded.gc, vec![gc]);
        assert_eq!(
            (loaded.status, loaded.exit_code, loaded.signal.as_deref()),
            (Status::Crashed, Some(1), Some("SIGSEGV"))
        );
        assert!(db.load_run("nope").unwrap().is_none());
    }

    #[test]
    fn stores_artifacts_and_fills_empty_history() {
        let mut db = Db::open_in_memory().unwrap();
        write(&mut db, proc("a", "x", Status::Exited, 5, Some(6)), vec![], vec![], vec![]);
        let root = AllocFrame { name: "(root)".into(), file: None, self_bytes: 1.0, children: vec![] };
        db.add_snapshot(
            "a",
            &HeapSnapshot { id: "s1".into(), t: 5, heap_used: 1.0, entries: vec![], sites: root.clone() },
        )
        .unwrap();
        db.add_cpu_profile("a", &CpuProfile { id: "c1".into(), t: 6, duration_ms: 100.0, sampling: "v8".into(), root })
            .unwrap();
        let p = db.load_run("a").unwrap().unwrap();
        assert_eq!(p.snapshots[0].id, "s1");
        assert_eq!(p.cpu_profiles[0].id, "c1");
        assert_eq!(p.samples, vec![Sample { t: 5, ..Default::default() }]);
        // Artifacts for unknown runs violate the foreign key.
        assert!(db.add_snapshot("ghost", &p.snapshots[0]).is_err());
    }

    #[test]
    fn filters_deletes_and_prunes() {
        let mut db = Db::open_in_memory().unwrap();
        write(&mut db, proc("old", "npm test", Status::Exited, 1_000, Some(2_000)), vec![s(1, 1.0)], vec![], vec![]);
        write(&mut db, proc("mid", "npm run build", Status::Exited, 3_000, Some(4_000)), vec![], vec![], vec![]);
        write(&mut db, proc("new", "100%_done", Status::Exited, 5_000, Some(6_000)), vec![], vec![], vec![]);
        write(&mut db, proc("live", "npm run dev", Status::Running, 7_000, None), vec![], vec![], vec![]);
        assert_eq!(
            db.list_runs(Some("npm"), 10).unwrap().iter().map(|r| r.id.as_str()).collect::<Vec<_>>(),
            vec!["live", "mid", "old"]
        );
        assert_eq!(db.list_runs(Some("100%"), 10).unwrap().len(), 1);
        assert_eq!(db.list_runs(Some("_"), 10).unwrap().len(), 1);
        assert_eq!(db.list_runs(None, 2).unwrap().len(), 2);

        assert_eq!(db.prune(Some(2_500)).unwrap(), 1);
        assert_eq!(db.prune_to(1).unwrap(), 1);
        let left: Vec<_> = db.list_runs(None, 10).unwrap().into_iter().map(|r| r.id).collect();
        assert_eq!(left, vec!["live", "new"]);
        assert!(db.delete_run("new").unwrap());
        assert!(!db.delete_run("new").unwrap());
        assert_eq!(db.prune(None).unwrap(), 0, "running runs are never pruned");
        assert_eq!(db.storage_info().unwrap().samples, 0, "samples cascade with their run");
    }

    #[test]
    fn applies_retention_and_closes_dangling_runs() {
        let mut db = Db::open_in_memory().unwrap();
        let now = 100 * DAY_MS;
        write(&mut db, proc("ancient", "a", Status::Exited, 0, Some(DAY_MS)), vec![], vec![], vec![]);
        for i in 0..3 {
            write(
                &mut db,
                proc(&format!("r{i}"), "a", Status::Exited, now - 10 + i, Some(now - 5)),
                vec![],
                vec![],
                vec![],
            );
        }
        let s = Settings { retention_days: 30, max_runs: 2, ..Default::default() };
        assert_eq!(db.apply_retention(&s, now).unwrap(), 2);
        assert_eq!(db.apply_retention(&Settings { retention_days: 0, max_runs: 0, ..s }, now).unwrap(), 0);

        write(&mut db, proc("cut", "a", Status::Running, now, None), vec![], vec![], vec![]);
        assert_eq!(db.close_dangling(now + 1).unwrap(), 1);
        let p = db.load_run("cut").unwrap().unwrap();
        assert_eq!((p.status, p.ended_at, p.signal.as_deref()), (Status::Exited, Some(now + 1), Some("peak closed")));
    }

    #[test]
    fn settings_storage_and_files() {
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("nested/peak.db");
        let mut db = Db::open(&path).unwrap();
        assert_eq!(db.settings(), Settings::default());
        let custom = Settings { retention_days: 7, alert_memory_mib: 512.0, ..Default::default() };
        db.set_settings(&custom).unwrap();
        db.set_settings(&custom).unwrap();
        assert_eq!(db.settings(), custom);
        write(&mut db, proc("a", "x", Status::Exited, 1, Some(2)), vec![s(1, 1.0)], vec![], vec![]);
        let info = db.storage_info().unwrap();
        assert_eq!((info.runs, info.stopped_runs, info.samples), (1, 1, 1));
        assert!(info.bytes > 0);
        assert_eq!(info.path, path.display().to_string());
        db.vacuum().unwrap();
        drop(db);
        // Reopening keeps everything.
        let db = Db::open(&path).unwrap();
        assert_eq!(db.settings().retention_days, 7);
        // Its parent can't be created, because a file is in the way.
        let blocker = dir.path().join("blocker");
        std::fs::write(&blocker, "").unwrap();
        assert!(Db::open(&blocker.join("sub/peak.db")).is_err());
        // Settings that fail to parse fall back to defaults.
        db.conn.execute("UPDATE settings SET value = 'nope'", []).unwrap();
        assert_eq!(db.settings(), Settings::default());
        assert_eq!(parse_enum::<Status>("bogus"), None);
    }
}
