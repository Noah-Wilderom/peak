//! Targets beyond this machine: connection state, collector sessions and routing.
//!
//! Each target has its own threads and lock. Nothing here touches the local
//! monitor's mutex, so a slow or unreachable host can't freeze local sampling.
//!
//! Correctness rules this module keeps:
//! * Losing a connection says nothing about a workload. Runs stay `running` while
//!   disconnected, and on reconnect each is re-verified by identity.
//! * A reused PID can't inherit a run: reattaching requires boot, PID namespace and
//!   start ticks to match.
//! * Frames are deduplicated by sequence; a gap triggers a resync. What can't be
//!   recovered is recorded as a gap, never filled in.
//! * Sample times are the target's. Sessions restart its log ids and may restart its
//!   clock, so both are remapped to stay increasing within a run.

use std::collections::HashMap;
use std::io::{BufRead, BufReader, Read, Write};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{self, Sender};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::*;
use crate::monitor::{RunWrite, meta_of, wall_ms};
use peak_core::protocol::*;

/// How patient to be with a target.
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    /// Frames arriving within this count as a healthy connection.
    pub stale_after: Duration,
    /// Quiet for this long, the connection is treated as dead even if the OS hasn't said so.
    pub dead_after: Duration,
    pub ping_every: Duration,
    /// The pause between automatic retries doubles up to this.
    pub retry_max: Duration,
    pub hello_timeout: Duration,
}

impl Default for Timing {
    fn default() -> Self {
        Timing {
            stale_after: Duration::from_secs(3),
            dead_after: Duration::from_secs(45),
            ping_every: Duration::from_secs(5),
            retry_max: Duration::from_secs(30),
            hello_timeout: Duration::from_secs(20),
        }
    }
}

/// Bounds what's kept for runs that haven't been named yet.
const MAX_EARLY: usize = 256;
pub const REQUEST_TIMEOUT: Duration = Duration::from_secs(30);
/// Separates target id from the collector's run id in a run's id.
const ID_SEP: char = '~';

/// How to reach a target. Authentication stays with the user's SSH, Docker or
/// Kubernetes configuration.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase", default)]
pub struct TargetSpec {
    pub id: String,
    pub label: String,
    pub kind: Option<TargetKind>,
    /// SSH destination, as `ssh` would take it (`user@host` or a config alias).
    pub host: String,
    pub port: Option<u16>,
    /// Docker or Kubernetes context ("" = the current one).
    pub context: String,
    /// Docker container id, or Kubernetes pod name.
    pub container: String,
    pub namespace: String,
    /// Kubernetes: the container inside the pod.
    pub pod_container: String,
    /// Kubernetes: the pod instance this target means. A new pod with the same name
    /// is a different target.
    pub pod_uid: String,
    /// Where the collector lives on the target. Empty: a per-user default.
    pub collector_path: String,
    /// Copy the collector over if it's missing. Off means "prepared" targets only.
    pub install: bool,
}

/// One target as the UI sees it.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
#[serde(rename_all = "camelCase")]
pub struct TargetState {
    pub spec: TargetSpec,
    pub state: ConnectionState,
    pub error: Option<String>,
    pub capabilities: Capabilities,
    pub facts: Option<Facts>,
    /// The target's latest machine sample. Host figures, not any one process's.
    pub system: Option<SystemSample>,
    pub clock_offset_ms: i64,
}

/// A live byte stream to a collector.
pub struct Link {
    pub reader: Box<dyn Read + Send>,
    pub writer: Box<dyn Write + Send>,
    /// Tear the transport down. Doesn't by itself mean anything for workloads.
    pub close: Box<dyn FnOnce() + Send>,
    /// Transport diagnostics, shown when a connection fails.
    pub diagnostics: Arc<Mutex<String>>,
}

pub trait Connector: Send + Sync {
    fn connect(&self, spec: &TargetSpec) -> Result<Link, String>;
}

struct Run {
    proc: Proc,
    collector_id: Option<String>,
    cpu_sum: f64,
    samples: u64,
    /// Added to this session's log ids to keep them increasing across sessions.
    log_base: u64,
    /// Added to this session's times if the target's clock restarted behind us.
    time_shift: u64,
    /// When data stopped, while waiting to learn when it resumes.
    gap_from: Option<u64>,
    pending: Option<ProcDelta>,
    dirty: bool,
}

#[derive(Default)]
struct Pending(HashMap<u64, Sender<Result<Value, String>>>);

struct Inner {
    spec: TargetSpec,
    state: ConnectionState,
    error: Option<String>,
    capabilities: Capabilities,
    facts: Option<Facts>,
    system: Option<SystemSample>,
    clock_offset_ms: i64,
    runs: Vec<Run>,
    /// Deltas for runs not registered yet.
    early: Vec<ProcDelta>,
    send: Option<Sender<String>>,
    close: Option<Box<dyn FnOnce() + Send>>,
    pending: Pending,
    /// Highest sequence applied in this session.
    last_seq: u64,
    resync: Option<u64>,
    held: Vec<Tick>,
    last_frame: Instant,
    /// Which session this state belongs to; older threads notice and stop.
    generation: u64,
    /// The user wants this connected: keep retrying after a loss.
    wanted: bool,
    ever_connected: bool,
    changed: bool,
}

impl Inner {
    fn set_state(&mut self, state: ConnectionState, error: Option<String>) {
        if self.state != state || self.error != error {
            self.state = state;
            self.error = error;
            self.changed = true;
        }
    }

    fn snapshot(&self) -> TargetState {
        TargetState {
            spec: self.spec.clone(),
            state: self.state,
            error: self.error.clone(),
            capabilities: self.capabilities.clone(),
            facts: self.facts.clone(),
            system: self.system.clone(),
            clock_offset_ms: self.clock_offset_ms,
        }
    }

    fn run_by_collector(&mut self, collector_id: &str) -> Option<&mut Run> {
        self.runs.iter_mut().find(|r| r.collector_id.as_deref() == Some(collector_id))
    }

    fn apply_tick(&mut self, tick: Tick) {
        if tick.seq <= self.last_seq {
            return; // Already applied.
        }
        self.last_seq = tick.seq;
        self.clock_offset_ms = wall_ms() as i64 - tick.wall as i64;
        if tick.system.is_some() {
            self.system = tick.system;
        }
        for delta in tick.procs {
            self.apply_delta(delta);
        }
    }

    fn apply_delta(&mut self, mut delta: ProcDelta) {
        let offset = self.clock_offset_ms;
        let Some(run) = self.run_by_collector(&delta.id) else {
            // Frames can overtake the reply that names this run. Keep them until it's known.
            if self.early.len() >= MAX_EARLY {
                self.early.remove(0);
            }
            self.early.push(delta);
            return;
        };
        delta.id = run.proc.id.clone();
        let shift = run.time_shift;
        for s in &mut delta.samples {
            s.t += shift;
        }
        delta.peak.t += shift;
        for g in &mut delta.gc {
            g.t += shift;
        }
        for l in &mut delta.logs {
            l.t += shift;
            l.id += run.log_base;
        }
        if let (Some(from), Some(first)) = (run.gap_from, delta.samples.first()) {
            let gap = Gap { from, to: first.t };
            run.proc.gaps.push(gap);
            run.gap_from = None;
        }
        for s in &delta.samples {
            run.cpu_sum += s.cpu;
            run.samples += 1;
        }
        merge_delta(&mut run.proc, &delta);
        if let Some(t) = run.proc.target.as_mut() {
            t.clock_offset_ms = offset;
        }
        // Merged results reach the UI once per drain.
        let (mut samples, mut logs, mut gc) =
            run.pending.take().map_or((vec![], vec![], vec![]), |q| (q.samples, q.logs, q.gc));
        samples.extend(delta.samples.iter().cloned());
        logs.extend(delta.logs.iter().cloned());
        gc.extend(delta.gc.iter().cloned());
        run.pending = Some(ProcDelta { samples, logs, gc, ..delta });
        run.dirty = true;
    }

    /// A run just became known: apply whatever arrived for it first.
    fn claim_early(&mut self, collector_id: &str) {
        let (mine, rest): (Vec<_>, Vec<_>) =
            std::mem::take(&mut self.early).into_iter().partition(|d| d.id == collector_id);
        self.early = rest;
        for d in mine {
            self.apply_delta(d);
        }
    }
}

/// A target and its collector session.
pub struct Target {
    inner: Mutex<Inner>,
    connector: Arc<dyn Connector>,
    next_req: AtomicU64,
    removed: AtomicBool,
    timing: Timing,
}

impl Target {
    fn new(spec: TargetSpec, connector: Arc<dyn Connector>, timing: Timing) -> Arc<Target> {
        Arc::new(Target {
            inner: Mutex::new(Inner {
                spec,
                state: ConnectionState::Disconnected,
                error: None,
                capabilities: Capabilities::default(),
                facts: None,
                system: None,
                clock_offset_ms: 0,
                runs: vec![],
                early: vec![],
                send: None,
                close: None,
                pending: Pending::default(),
                last_seq: 0,
                resync: None,
                held: vec![],
                last_frame: Instant::now(),
                generation: 0,
                wanted: false,
                ever_connected: false,
                changed: true,
            }),
            connector,
            next_req: AtomicU64::new(1),
            removed: AtomicBool::new(false),
            timing,
        })
    }

    pub fn state(&self) -> TargetState {
        self.inner.lock().unwrap().snapshot()
    }

    /// Start connecting, in the background.
    pub fn connect(self: &Arc<Self>) {
        let generation = {
            let mut i = self.inner.lock().unwrap();
            i.wanted = true;
            if matches!(i.state, ConnectionState::Connected | ConnectionState::Connecting | ConnectionState::Stale) {
                return;
            }
            i.set_state(ConnectionState::Connecting, None);
            i.generation += 1;
            i.generation
        };
        let target = self.clone();
        thread::spawn(move || target.connect_loop(generation));
    }

    /// Stop the session. The collector stops what it launched and leaves attached
    /// processes alone. Runs stay as they are until a reconnect verifies them.
    pub fn disconnect(&self) {
        let (close, send) = {
            let mut i = self.inner.lock().unwrap();
            i.wanted = false;
            i.generation += 1;
            let gap_from: Vec<u64> =
                i.runs.iter().map(|r| r.proc.samples.last().map(|s| s.t).unwrap_or(r.proc.started_at)).collect();
            for (r, from) in i.runs.iter_mut().zip(gap_from) {
                let launched = r.proc.target.as_ref().is_some_and(|t| t.launched);
                if r.proc.status == Status::Running && launched {
                    // By the collector's contract this ends with the session. We asked for
                    // that, so don't leave it looking like it's still going.
                    r.proc.status = Status::Exited;
                    r.proc.ended_at = Some(from);
                    r.proc.signal = Some("stopped with the session".into());
                    r.proc.children.clear();
                    r.dirty = true;
                } else if r.proc.status == Status::Running && r.gap_from.is_none() {
                    r.gap_from = Some(from);
                }
                r.collector_id = None;
            }
            i.capabilities = Capabilities::default();
            i.pending.0.clear();
            i.set_state(ConnectionState::Disconnected, None);
            (i.close.take(), i.send.take())
        };
        if let Some(send) = send {
            let line =
                serde_json::to_string(&ClientFrame { req: 0, request: Request::Shutdown }).expect("frames serialize");
            let _ = send.send(line);
        }
        if let Some(close) = close {
            close();
        }
    }

    fn connect_loop(self: Arc<Self>, generation: u64) {
        let mut wait = Duration::from_secs(1);
        loop {
            match self.connect_once(generation) {
                Ok(()) => return,
                Err(message) => {
                    let retry = {
                        let mut i = self.inner.lock().unwrap();
                        if i.generation != generation {
                            return;
                        }
                        // A first attempt failing is something to fix; it won't heal by retrying.
                        // A target we've reached before is probably just away for now.
                        let retry = i.wanted && i.ever_connected && !is_permanent(&message);
                        let state = if retry { ConnectionState::Disconnected } else { ConnectionState::Failed };
                        i.set_state(state, Some(message));
                        retry
                    };
                    if !retry {
                        return;
                    }
                    thread::sleep(wait.min(self.timing.retry_max));
                    wait = (wait * 2).min(self.timing.retry_max);
                    let mut i = self.inner.lock().unwrap();
                    if i.generation != generation || !i.wanted || self.removed.load(Ordering::Relaxed) {
                        return;
                    }
                    let error = i.error.clone();
                    i.set_state(ConnectionState::Connecting, error);
                }
            }
        }
    }

    fn connect_once(self: &Arc<Self>, generation: u64) -> Result<(), String> {
        let spec = self.inner.lock().unwrap().spec.clone();
        let link = self.connector.connect(&spec)?;
        let diagnostics = link.diagnostics.clone();
        let (send, rx) = mpsc::channel::<String>();
        {
            let mut i = self.inner.lock().unwrap();
            if i.generation != generation {
                (link.close)();
                return Err("connection abandoned".into());
            }
            i.send = Some(send);
            i.close = Some(link.close);
            i.last_seq = 0;
            i.resync = None;
            i.held.clear();
            i.last_frame = Instant::now();
        }
        let mut writer = link.writer;
        thread::spawn(move || {
            for line in rx {
                if writeln!(writer, "{line}").and_then(|_| writer.flush()).is_err() {
                    break;
                }
            }
        });
        let reader = link.reader;
        let t = self.clone();
        thread::spawn(move || t.read_frames(reader, generation, diagnostics));

        // Handshake, then verify every run this target was monitoring.
        let hello = self
            .request(Request::Hello { version: VERSION }, self.timing.hello_timeout)
            .inspect_err(|_| self.abandon(generation))?;
        let facts: Facts = serde_json::from_value(hello).map_err(|e| {
            self.abandon(generation);
            format!("not a compatible collector: {e}")
        })?;
        self.reverify_runs(&facts);
        {
            let mut i = self.inner.lock().unwrap();
            if i.generation != generation {
                return Ok(());
            }
            let kind = i.spec.kind;
            let is_container = matches!(kind, Some(TargetKind::Docker | TargetKind::Kubernetes));
            i.capabilities = Capabilities {
                collector: true,
                attach: true,
                launch: true,
                signal: true,
                runtime_agents: facts.runtime_agents,
                container_totals: kind == Some(TargetKind::Docker),
                container_logs: is_container,
                container_top: kind == Some(TargetKind::Docker),
            };
            i.facts = Some(facts);
            i.ever_connected = true;
            i.last_frame = Instant::now();
            i.set_state(ConnectionState::Connected, None);
        }
        let t = self.clone();
        thread::spawn(move || t.keep_alive(generation));
        Ok(())
    }

    /// Give up on a transport that connected but never spoke the protocol.
    fn abandon(&self, generation: u64) {
        let close = {
            let mut i = self.inner.lock().unwrap();
            if i.generation != generation {
                return;
            }
            i.send = None;
            i.close.take()
        };
        if let Some(close) = close {
            close();
        }
    }

    /// After (re)connecting, each run must prove it's still the same process.
    fn reverify_runs(&self, facts: &Facts) {
        let running: Vec<(String, u32, ProcIdentity, bool)> = {
            let i = self.inner.lock().unwrap();
            i.runs
                .iter()
                .filter(|r| r.proc.status == Status::Running)
                .filter_map(|r| {
                    let t = r.proc.target.as_ref()?;
                    Some((r.proc.id.clone(), r.proc.pid, t.identity.clone(), t.launched))
                })
                .collect()
        };
        for (id, pid, identity, launched) in running {
            let outcome = self.request(Request::Attach { pid, expect: Some(identity) }, REQUEST_TIMEOUT);
            let mut i = self.inner.lock().unwrap();
            let Some(run) = i.runs.iter_mut().find(|r| r.proc.id == id) else { continue };
            let resume_at = run.proc.samples.last().map(|s| s.t).unwrap_or(run.proc.started_at);
            match outcome {
                Ok(reply) => {
                    let collector_id = reply["proc"]["id"].as_str().unwrap_or_default().to_string();
                    run.collector_id = Some(collector_id.clone());
                    // Same process, new session: its log ids restart, its clock may have too.
                    run.log_base = run.proc.logs.last().map(|l| l.id).unwrap_or(run.log_base);
                    let their_now = reply["proc"]["samples"][0]["t"].as_u64().unwrap_or(resume_at + 1);
                    run.time_shift = (resume_at + 1).saturating_sub(their_now);
                    if launched {
                        // Only the session that launched it had its output pipes.
                        let id = run.log_base + 1;
                        run.log_base = id;
                        let text = "[peak] Output capture ended when the connection was lost; monitoring continues without it.";
                        run.proc.logs.push(LogLine { id, t: resume_at, stream: Stream::Stderr, text: text.into() });
                    }
                    i.claim_early(&collector_id);
                }
                Err(reason) => {
                    // It didn't survive, or isn't ours any more. How it ended is unknown.
                    let t = run.gap_from.unwrap_or(resume_at);
                    let p = &mut run.proc;
                    p.status = Status::Exited;
                    p.ended_at = Some(t);
                    p.exit_code = None;
                    p.signal = Some(if reason.contains("rebooted") {
                        "target rebooted".to_string()
                    } else {
                        "ended while disconnected".to_string()
                    });
                    p.children.clear();
                    run.gap_from = None;
                    run.collector_id = None;
                    run.dirty = true;
                }
            }
        }
        let _ = facts;
    }

    fn read_frames(self: Arc<Self>, reader: Box<dyn Read + Send>, generation: u64, diagnostics: Arc<Mutex<String>>) {
        let mut lines = BufReader::new(reader);
        let mut buf = String::new();
        loop {
            buf.clear();
            match lines.read_line(&mut buf) {
                Ok(0) | Err(_) => break,
                Ok(_) => {}
            }
            let Ok(frame) = serde_json::from_str::<ServerFrame>(buf.trim_end()) else {
                // Stdout is reserved for frames, but login shells print banners.
                continue;
            };
            let mut i = self.inner.lock().unwrap();
            if i.generation != generation {
                return;
            }
            i.last_frame = Instant::now();
            if i.state == ConnectionState::Stale {
                i.set_state(ConnectionState::Connected, None);
            }
            match frame {
                ServerFrame::Reply { id, ok, data, error } => {
                    if i.resync == Some(id) {
                        Self::finish_resync(&mut i, data);
                    } else if let Some(tx) = i.pending.0.remove(&id) {
                        let _ = tx.send(if ok {
                            Ok(data.unwrap_or(Value::Null))
                        } else {
                            Err(error.unwrap_or_else(|| "collector error".into()))
                        });
                    }
                }
                ServerFrame::Tick(tick) => {
                    if i.resync.is_some() {
                        i.held.push(tick);
                    } else if tick.seq > i.last_seq + 1 && i.last_seq > 0 {
                        // Frames were dropped under backpressure. Ask for what's missing.
                        let id = self.next_req.fetch_add(1, Ordering::Relaxed);
                        i.resync = Some(id);
                        let since = i.last_seq;
                        i.held.push(tick);
                        let line = serde_json::to_string(&ClientFrame { req: id, request: Request::Resync { since } })
                            .expect("frames serialize");
                        if let Some(send) = &i.send {
                            let _ = send.send(line);
                        }
                    } else {
                        i.apply_tick(tick);
                    }
                }
                ServerFrame::Bye { reason } => {
                    let d = diagnostics.lock().unwrap().clone();
                    drop(i);
                    self.lost(generation, format!("collector ended the session: {reason}{}", suffix(&d)));
                    return;
                }
            }
        }
        let d = diagnostics.lock().unwrap().clone();
        self.lost(generation, format!("connection lost{}", suffix(&d)));
    }

    fn finish_resync(i: &mut Inner, data: Option<Value>) {
        i.resync = None;
        let data = data.unwrap_or(Value::Null);
        let complete = data["complete"].as_bool().unwrap_or(false);
        let replay: Vec<Tick> = data["ticks"]
            .as_array()
            .map(|a| a.iter().filter_map(|f| serde_json::from_value::<ServerFrame>(f.clone()).ok()).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|f| if let ServerFrame::Tick(t) = f { Some(t) } else { None })
            .collect();
        if !complete {
            // More was lost than the collector kept. Say so on the timeline.
            let resumes = replay.first().map(|t| t.t).unwrap_or(0);
            for r in i.runs.iter_mut().filter(|r| r.proc.status == Status::Running) {
                let from = r.proc.samples.last().map(|s| s.t).unwrap_or(r.proc.started_at);
                r.proc.gaps.push(Gap { from, to: resumes.max(from) });
            }
        }
        for t in replay {
            i.apply_tick(t);
        }
        for t in std::mem::take(&mut i.held) {
            i.apply_tick(t);
        }
    }

    /// The transport is gone. Runs keep their status: this isn't evidence they ended.
    fn lost(self: &Arc<Self>, generation: u64, message: String) {
        let reconnect = {
            let mut i = self.inner.lock().unwrap();
            if i.generation != generation {
                return;
            }
            let from: Vec<u64> =
                i.runs.iter().map(|r| r.proc.samples.last().map(|s| s.t).unwrap_or(r.proc.started_at)).collect();
            for (r, from) in i.runs.iter_mut().zip(from) {
                if r.proc.status == Status::Running && r.gap_from.is_none() {
                    r.gap_from = Some(from);
                }
                r.collector_id = None;
                r.dirty = true;
            }
            for (_, tx) in i.pending.0.drain() {
                let _ = tx.send(Err("connection lost".into()));
            }
            i.send = None;
            i.capabilities = Capabilities::default();
            i.generation += 1;
            let reconnect = i.wanted && i.ever_connected && !self.removed.load(Ordering::Relaxed);
            if let Some(close) = i.close.take() {
                close();
            }
            let state = if reconnect { ConnectionState::Connecting } else { ConnectionState::Disconnected };
            i.set_state(state, Some(message));
            reconnect.then_some(i.generation)
        };
        if let Some(generation) = reconnect {
            let t = self.clone();
            thread::spawn(move || {
                thread::sleep(Duration::from_millis(200).min(t.timing.retry_max));
                t.connect_loop(generation);
            });
        }
    }

    fn keep_alive(self: Arc<Self>, generation: u64) {
        let mut since_ping = Instant::now();
        loop {
            thread::sleep(self.timing.stale_after.min(Duration::from_millis(250)));
            let dead = {
                let mut i = self.inner.lock().unwrap();
                if i.generation != generation {
                    return;
                }
                let quiet = i.last_frame.elapsed();
                if quiet > self.timing.stale_after && i.state == ConnectionState::Connected {
                    let error = Some(format!("No data for {}s", quiet.as_secs()));
                    i.set_state(ConnectionState::Stale, error);
                }
                quiet > self.timing.dead_after
            };
            if dead {
                self.lost(generation, "connection went silent".into());
                return;
            }
            if since_ping.elapsed() >= self.timing.ping_every {
                since_ping = Instant::now();
                let id = self.next_req.fetch_add(1, Ordering::Relaxed);
                let i = self.inner.lock().unwrap();
                if let Some(send) = &i.send {
                    let line = serde_json::to_string(&ClientFrame { req: id, request: Request::Ping })
                        .expect("frames serialize");
                    let _ = send.send(line);
                }
            }
        }
    }

    /// Send one request and wait. Writes go through a queue, so no lock is held on I/O.
    pub fn request(&self, request: Request, timeout: Duration) -> Result<Value, String> {
        let id = self.next_req.fetch_add(1, Ordering::Relaxed);
        let (tx, rx) = mpsc::channel();
        {
            let mut i = self.inner.lock().unwrap();
            let send = i.send.as_ref().ok_or("target is not connected")?;
            let line = serde_json::to_string(&ClientFrame { req: id, request }).expect("frames serialize");
            send.send(line).map_err(|_| "target is not connected".to_string())?;
            i.pending.0.insert(id, tx);
        }
        let result = rx.recv_timeout(timeout).unwrap_or_else(|_| Err("target did not answer in time".into()));
        self.inner.lock().unwrap().pending.0.remove(&id);
        result
    }

    fn adopt(&self, reply: Value, launched: bool, spec: Option<LaunchSpec>) -> Result<Proc, String> {
        let mut proc: Proc =
            serde_json::from_value(reply["proc"].clone()).map_err(|e| format!("bad reply from collector: {e}"))?;
        let mut identity: ProcIdentity =
            serde_json::from_value(reply["identity"].clone()).map_err(|e| format!("bad reply from collector: {e}"))?;
        let mut i = self.inner.lock().unwrap();
        let s = &i.spec;
        let kind = s.kind.unwrap_or(TargetKind::Ssh);
        if kind == TargetKind::Docker {
            identity.container_id = Some(s.container.clone());
        }
        if kind == TargetKind::Kubernetes {
            identity.pod_uid = Some(s.pod_uid.clone());
        }
        let collector_id = proc.id.clone();
        proc.id = format!("{}{ID_SEP}{collector_id}", s.id);
        proc.target = Some(ProcTarget {
            target_id: s.id.clone(),
            label: s.label.clone(),
            kind,
            identity,
            launched,
            spec,
            clock_offset_ms: i.clock_offset_ms,
        });
        let run = Run {
            proc: proc.clone(),
            collector_id: Some(collector_id.clone()),
            cpu_sum: 0.0,
            samples: 0,
            log_base: 0,
            time_shift: 0,
            gap_from: None,
            pending: None,
            dirty: true,
        };
        i.runs.insert(0, run);
        i.claim_early(&collector_id);
        Ok(i.runs[0].proc.clone())
    }

    fn collector_id(&self, id: &str) -> Result<String, String> {
        let i = self.inner.lock().unwrap();
        if !matches!(i.state, ConnectionState::Connected | ConnectionState::Stale) {
            return Err("target is not connected; nothing was sent".into());
        }
        let run = i.runs.iter().find(|r| r.proc.id == id).ok_or("unknown process")?;
        run.collector_id.clone().ok_or_else(|| "this run isn't connected to a collector".into())
    }

    fn deltas(&self) -> (Vec<ProcDelta>, Vec<RunWrite>) {
        let mut i = self.inner.lock().unwrap();
        let (mut deltas, mut writes) = (vec![], vec![]);
        for run in i.runs.iter_mut().filter(|r| r.dirty) {
            run.dirty = false;
            // Current facts, always: status can change between ticks (detach, a failed
            // reverify), and a queued delta's copy of them may already be out of date.
            let mut delta = delta_of(&run.proc);
            if let Some(q) = run.pending.take() {
                (delta.samples, delta.logs, delta.gc) = (q.samples, q.logs, q.gc);
            }
            // The desktop owns these; the UI needs them with every update.
            delta.gaps = run.proc.gaps.clone();
            delta.clock_offset_ms = run.proc.target.as_ref().map(|t| t.clock_offset_ms);
            writes.push(RunWrite {
                meta: meta_of(&mut run.proc),
                avg_cpu: run.cpu_sum / run.samples.max(1) as f64,
                samples: delta.samples.clone(),
                logs: delta.logs.clone(),
                gc: delta.gc.clone(),
            });
            deltas.push(delta);
        }
        (deltas, writes)
    }

    fn take_changed(&self) -> bool {
        std::mem::take(&mut self.inner.lock().unwrap().changed)
    }
}

/// This target is gone for good: retrying can't bring back a replaced pod.
fn is_permanent(message: &str) -> bool {
    ["was replaced", "No such container"].iter().any(|m| message.contains(m))
}

fn suffix(diagnostics: &str) -> String {
    let d = diagnostics.trim();
    if d.is_empty() { String::new() } else { format!(": {d}") }
}

/// An update carrying a run's current facts and no new series.
fn delta_of(p: &Proc) -> ProcDelta {
    ProcDelta {
        id: p.id.clone(),
        samples: vec![],
        logs: vec![],
        gc: vec![],
        status: p.status,
        ended_at: p.ended_at,
        exit_code: p.exit_code,
        signal: p.signal.clone(),
        runtime: p.runtime,
        exe: p.exe.clone(),
        ppid: p.ppid,
        nice: p.nice,
        threads: p.threads,
        vsz: p.vsz,
        swap: p.swap,
        fds: p.fds,
        counters: p.counters.clone(),
        peak: p.peak.clone(),
        children: p.children.clone(),
        child_names: p.child_names.clone(),
        ports: p.ports.clone(),
        has_gc: p.has_gc,
        profiling: p.profiling,
        agent: p.agent.clone(),
        unavailable: p.unavailable.clone(),
        gaps: vec![],
        clock_offset_ms: None,
    }
}

pub fn is_remote_id(id: &str) -> bool {
    id.contains(ID_SEP)
}

/// All targets. Each has its own lock; this one is held only to look them up.
pub struct Remote {
    targets: Mutex<Vec<Arc<Target>>>,
    connector: Arc<dyn Connector>,
    timing: Timing,
}

/// What changed across all targets since the last drain.
#[derive(Default)]
pub struct Drained {
    pub deltas: Vec<ProcDelta>,
    pub writes: Vec<RunWrite>,
    pub targets: Option<Vec<TargetState>>,
}

impl Remote {
    pub fn new(connector: Arc<dyn Connector>) -> Remote {
        Remote::with_timing(connector, Timing::default())
    }

    pub fn with_timing(connector: Arc<dyn Connector>, timing: Timing) -> Remote {
        Remote { targets: Mutex::new(vec![]), connector, timing }
    }

    pub fn add(&self, mut spec: TargetSpec) -> TargetState {
        if spec.id.is_empty() {
            spec.id = format!("t{:x}", wall_ms());
        }
        // The id goes into run ids, where the separator has a meaning.
        spec.id = spec.id.replace(ID_SEP, "-");
        let mut targets = self.targets.lock().unwrap();
        if let Some(t) = targets.iter().find(|t| t.inner.lock().unwrap().spec.id == spec.id) {
            let mut i = t.inner.lock().unwrap();
            i.spec = spec;
            i.changed = true;
            return i.snapshot();
        }
        let target = Target::new(spec, self.connector.clone(), self.timing);
        let state = target.state();
        targets.push(target);
        state
    }

    fn target(&self, target_id: &str) -> Result<Arc<Target>, String> {
        let targets = self.targets.lock().unwrap();
        targets
            .iter()
            .find(|t| t.inner.lock().unwrap().spec.id == target_id)
            .cloned()
            .ok_or_else(|| "unknown target".into())
    }

    fn target_of(&self, run_id: &str) -> Result<Arc<Target>, String> {
        self.target(run_id.split(ID_SEP).next().unwrap_or(""))
    }

    pub fn connect(&self, target_id: &str) -> Result<(), String> {
        self.target(target_id)?.connect();
        Ok(())
    }

    pub fn disconnect(&self, target_id: &str) -> Result<(), String> {
        self.target(target_id)?.disconnect();
        Ok(())
    }

    /// Forget a target. Refused while it has running workloads being watched.
    pub fn remove(&self, target_id: &str) -> Result<(), String> {
        let t = self.target(target_id)?;
        if t.inner.lock().unwrap().runs.iter().any(|r| r.proc.status == Status::Running) {
            return Err("detach from this target's processes first".into());
        }
        t.removed.store(true, Ordering::Relaxed);
        t.disconnect();
        self.targets.lock().unwrap().retain(|x| !Arc::ptr_eq(x, &t));
        Ok(())
    }

    pub fn states(&self) -> Vec<TargetState> {
        self.targets.lock().unwrap().iter().map(|t| t.state()).collect()
    }

    pub fn specs(&self) -> Vec<TargetSpec> {
        self.states().into_iter().map(|s| s.spec).collect()
    }

    pub fn procs(&self) -> Vec<Proc> {
        let targets = self.targets.lock().unwrap().clone();
        targets
            .iter()
            .flat_map(|t| t.inner.lock().unwrap().runs.iter().map(|r| r.proc.clone()).collect::<Vec<_>>())
            .collect()
    }

    pub fn proc(&self, id: &str) -> Option<Proc> {
        let t = self.target_of(id).ok()?;
        let i = t.inner.lock().unwrap();
        i.runs.iter().find(|r| r.proc.id == id).map(|r| r.proc.clone())
    }

    /// Everything new since the last call, ready for the UI and the database.
    pub fn drain(&self) -> Drained {
        let targets = self.targets.lock().unwrap().clone();
        let mut out = Drained::default();
        let mut changed = false;
        for t in &targets {
            let (deltas, writes) = t.deltas();
            out.deltas.extend(deltas);
            out.writes.extend(writes);
            changed |= t.take_changed();
            // Machine figures move with every tick.
            changed |= !targets.is_empty();
        }
        if changed {
            out.targets = Some(targets.iter().map(|t| t.state()).collect());
        }
        out
    }

    pub fn list_processes(&self, target_id: &str) -> Result<Vec<Attachable>, String> {
        let reply = self.target(target_id)?.request(Request::ListProcesses { limit: 200 }, REQUEST_TIMEOUT)?;
        serde_json::from_value(reply).map_err(|e| format!("bad reply from collector: {e}"))
    }

    pub fn attach(&self, target_id: &str, pid: u32) -> Result<Proc, String> {
        let t = self.target(target_id)?;
        let reply = t.request(Request::Attach { pid, expect: None }, REQUEST_TIMEOUT)?;
        t.adopt(reply, false, None)
    }

    pub fn launch(&self, target_id: &str, spec: LaunchSpec) -> Result<Proc, String> {
        let t = self.target(target_id)?;
        let reply = t.request(Request::Launch { spec: spec.clone() }, REQUEST_TIMEOUT)?;
        t.adopt(reply, true, Some(spec))
    }

    /// Stop observing a run. Never signals it. Its record says monitoring stopped,
    /// because how it fares from here is unknown.
    pub fn detach(&self, id: &str) -> Result<(), String> {
        let t = self.target_of(id)?;
        if let Ok(collector_id) = t.collector_id(id) {
            t.request(Request::Detach { id: collector_id }, REQUEST_TIMEOUT)?;
        }
        let mut i = t.inner.lock().unwrap();
        let run = i.runs.iter_mut().find(|r| r.proc.id == id).ok_or("unknown process")?;
        let last = run.proc.samples.last().map(|s| s.t).unwrap_or(run.proc.started_at);
        run.proc.status = Status::Exited;
        run.proc.ended_at = Some(last);
        run.proc.signal = Some("monitoring stopped".into());
        run.proc.children.clear();
        run.collector_id = None;
        run.gap_from = None;
        run.dirty = true;
        Ok(())
    }

    /// Stop a command this target's collector launched. An attached service is only
    /// stopped by an explicit `signal`, which is a different decision.
    pub fn stop(&self, id: &str) -> Result<(), String> {
        let t = self.target_of(id)?;
        let launched = {
            let i = t.inner.lock().unwrap();
            let run = i.runs.iter().find(|r| r.proc.id == id).ok_or("unknown process")?;
            run.proc.target.as_ref().is_some_and(|x| x.launched)
        };
        if !launched {
            return Err(
                "peak didn't launch this process. Detach to stop watching it, or send a signal deliberately".into()
            );
        }
        let collector_id = t.collector_id(id)?;
        t.request(Request::Stop { id: collector_id }, REQUEST_TIMEOUT).map(|_| ())
    }

    pub fn signal(&self, id: &str, signal: &str) -> Result<(), String> {
        let t = self.target_of(id)?;
        let collector_id = t.collector_id(id)?;
        t.request(Request::Signal { id: collector_id, signal: signal.to_string() }, REQUEST_TIMEOUT).map(|_| ())
    }

    /// Run a launched command again on its own target. Nothing else is restartable:
    /// peak won't recapture an attached service locally or restart a container for you.
    pub fn restart(&self, id: &str) -> Result<Proc, String> {
        let t = self.target_of(id)?;
        let (target_id, spec, running) = {
            let i = t.inner.lock().unwrap();
            let run = i.runs.iter().find(|r| r.proc.id == id).ok_or("unknown process")?;
            let target = run.proc.target.as_ref().ok_or("unknown process")?;
            let spec = target.spec.clone().ok_or("peak didn't launch this process, so it can't restart it")?;
            (i.spec.id.clone(), spec, run.proc.status == Status::Running)
        };
        if running {
            return Err("stop it first".into());
        }
        let proc = self.launch(&target_id, spec)?;
        t.inner.lock().unwrap().runs.retain(|r| r.proc.id != id);
        Ok(proc)
    }

    /// Keep an alert on the run, so a reloaded UI still knows about it.
    pub fn add_alert(&self, id: &str, alert: &Alert) {
        if let Ok(t) = self.target_of(id) {
            let mut i = t.inner.lock().unwrap();
            if let Some(r) = i.runs.iter_mut().find(|r| r.proc.id == id) {
                r.proc.alerts.push(alert.clone());
            }
        }
    }

    /// Drop a finished run from the session. It stays in history.
    pub fn forget(&self, id: &str) -> bool {
        let Ok(t) = self.target_of(id) else { return false };
        let mut i = t.inner.lock().unwrap();
        let before = i.runs.len();
        i.runs.retain(|r| r.proc.id != id || r.proc.status == Status::Running);
        before != i.runs.len()
    }

    pub fn clear_ended(&self) -> usize {
        let targets = self.targets.lock().unwrap().clone();
        targets
            .iter()
            .map(|t| {
                let mut i = t.inner.lock().unwrap();
                let before = i.runs.len();
                i.runs.retain(|r| r.proc.status == Status::Running);
                before - i.runs.len()
            })
            .sum()
    }

    pub fn snapshot(&self, id: &str) -> Result<HeapSnapshot, String> {
        let t = self.target_of(id)?;
        let collector_id = t.collector_id(id)?;
        let reply = t.request(Request::Snapshot { id: collector_id }, Duration::from_secs(130))?;
        let snap: HeapSnapshot = serde_json::from_value(reply).map_err(|e| format!("bad snapshot: {e}"))?;
        let mut i = t.inner.lock().unwrap();
        if let Some(r) = i.runs.iter_mut().find(|r| r.proc.id == id) {
            r.proc.snapshots.push(snap.clone());
        }
        Ok(snap)
    }

    pub fn force_gc(&self, id: &str) -> Result<(), String> {
        let t = self.target_of(id)?;
        let collector_id = t.collector_id(id)?;
        t.request(Request::Gc { id: collector_id }, Duration::from_secs(40)).map(|_| ())
    }

    pub fn cpu_profile(&self, id: &str, ms: u64) -> Result<CpuProfile, String> {
        let t = self.target_of(id)?;
        let collector_id = t.collector_id(id)?;
        let reply = t.request(Request::CpuProfile { id: collector_id, ms }, Duration::from_millis(ms + 30_000))?;
        let profile: CpuProfile = serde_json::from_value(reply).map_err(|e| format!("bad profile: {e}"))?;
        let mut i = t.inner.lock().unwrap();
        if let Some(r) = i.runs.iter_mut().find(|r| r.proc.id == id) {
            r.proc.cpu_profiles.push(profile.clone());
        }
        Ok(profile)
    }

    /// Leave everything running remotely as the disconnect contract says. Used at exit.
    pub fn shutdown(&self) {
        let targets = self.targets.lock().unwrap().clone();
        for t in targets {
            t.disconnect();
        }
    }
}

#[cfg(all(test, target_os = "linux"))]
mod tests {
    use super::*;
    use peak_core::collector::{self, Options};
    use serde_json::json;
    use std::io::{BufRead, BufReader, PipeReader, PipeWriter};
    use std::process::{Child, Command, Stdio};

    /// A real collector on real pipes: everything but the network.
    #[derive(Default)]
    struct InProcess {
        /// Refuse this many connections, like an unreachable host.
        refuse: AtomicU64,
        /// Hang on connect, like a host that drops packets.
        hang: AtomicBool,
        /// Bytes to send instead of a collector, like a shell banner with no collector.
        garbage: AtomicBool,
        connects: AtomicU64,
    }

    impl Connector for InProcess {
        fn connect(&self, _: &TargetSpec) -> Result<Link, String> {
            self.connects.fetch_add(1, Ordering::Relaxed);
            while self.hang.load(Ordering::Relaxed) {
                thread::sleep(Duration::from_millis(10));
            }
            if self.refuse.load(Ordering::Relaxed) > 0 {
                self.refuse.fetch_sub(1, Ordering::Relaxed);
                return Err("ssh: connect to host: Connection refused".into());
            }
            let (in_r, in_w): (PipeReader, PipeWriter) = std::io::pipe().unwrap();
            let (out_r, mut out_w) = std::io::pipe().unwrap();
            if self.garbage.load(Ordering::Relaxed) {
                writeln!(out_w, "Welcome to host!").unwrap();
                drop(out_w);
                return Ok(Link {
                    reader: Box::new(out_r),
                    writer: Box::new(in_w),
                    close: Box::new(|| {}),
                    diagnostics: Arc::new(Mutex::new("sh: peak-collector: not found".into())),
                });
            }
            let dir = tempfile::tempdir().unwrap();
            let opts = Options {
                tick: Duration::from_millis(30),
                stop_grace: Duration::from_millis(300),
                data_dir: Some(dir.path().to_path_buf()),
                ..Default::default()
            };
            thread::spawn(move || {
                let _keep = dir;
                collector::serve(BufReader::new(in_r), out_w, opts);
            });
            // Closing our end of its stdin is what a dropped SSH connection looks like.
            let writer = Arc::new(Mutex::new(Some(in_w)));
            Ok(Link {
                reader: Box::new(out_r),
                writer: Box::new(Shared(writer.clone())),
                close: Box::new(move || {
                    writer.lock().unwrap().take();
                }),
                diagnostics: Arc::new(Mutex::new(String::new())),
            })
        }
    }

    struct Shared(Arc<Mutex<Option<PipeWriter>>>);
    impl Write for Shared {
        fn write(&mut self, buf: &[u8]) -> std::io::Result<usize> {
            match self.0.lock().unwrap().as_mut() {
                Some(w) => w.write(buf),
                None => Err(std::io::ErrorKind::BrokenPipe.into()),
            }
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    fn fast() -> Timing {
        Timing { retry_max: Duration::from_millis(50), ..Default::default() }
    }

    /// A hand-played collector: the test decides what comes back and when.
    struct Scripted {
        /// Requests the desktop sent, as lines.
        heard: Arc<Mutex<Vec<String>>>,
        /// Frames to send, written as-is.
        say: Mutex<Option<PipeWriter>>,
    }

    impl Scripted {
        fn say(&self, line: &str) {
            let mut w = self.say.lock().unwrap();
            writeln!(w.as_mut().expect("link is up"), "{line}").unwrap();
        }

        fn frame(&self, f: &ServerFrame) {
            self.say(&serde_json::to_string(f).unwrap());
        }

        /// Wait for a request matching `op` and return its id.
        fn expect(&self, op: &str) -> (u64, Value) {
            let mut found = None;
            eventually(op, || {
                let heard = self.heard.lock().unwrap();
                found =
                    heard.iter().filter_map(|l| serde_json::from_str::<Value>(l).ok()).rev().find(|v| v["op"] == op);
                found.is_some()
            });
            let v = found.unwrap();
            (v["req"].as_u64().unwrap(), v)
        }

        fn answer(&self, req: u64, data: Value) {
            self.frame(&ServerFrame::Reply { id: req, ok: true, data: Some(data), error: None });
        }

        fn hello(&self) {
            let (req, _) = self.expect("hello");
            self.answer(req, serde_json::to_value(peak_core::collector::facts()).unwrap());
        }

        fn close(&self) {
            self.say.lock().unwrap().take();
        }
    }

    impl Connector for Scripted {
        fn connect(&self, _: &TargetSpec) -> Result<Link, String> {
            let (in_r, in_w): (PipeReader, PipeWriter) = std::io::pipe().unwrap();
            let (out_r, out_w) = std::io::pipe().unwrap();
            *self.say.lock().unwrap() = Some(out_w);
            let heard = self.heard.clone();
            thread::spawn(move || {
                for line in BufReader::new(in_r).lines().map_while(Result::ok) {
                    heard.lock().unwrap().push(line);
                }
            });
            Ok(Link {
                reader: Box::new(out_r),
                writer: Box::new(in_w),
                close: Box::new(|| {}),
                diagnostics: Arc::new(Mutex::new("from transport".into())),
            })
        }
    }

    fn scripted(timing: Timing) -> (Remote, Arc<Scripted>, String) {
        let c = Arc::new(Scripted { heard: Default::default(), say: Mutex::new(None) });
        let r = Remote::with_timing(c.clone(), timing);
        let spec =
            TargetSpec { id: "s".into(), label: "scripted".into(), kind: Some(TargetKind::Ssh), ..Default::default() };
        let id = r.add(spec).spec.id;
        (r, c, id)
    }

    fn up(r: &Remote, c: &Scripted, id: &str) {
        r.connect(id).unwrap();
        c.hello();
        eventually("connected", || state_of(r, id) == ConnectionState::Connected);
    }

    fn tick(seq: u64, t: u64, procs: Vec<ProcDelta>) -> ServerFrame {
        ServerFrame::Tick(Tick { seq, t, wall: wall_ms(), procs, system: None })
    }

    /// A run adopted through a scripted attach reply.
    fn adopted(r: &Arc<Remote>, c: &Arc<Scripted>, id: &str, launched: bool) -> Proc {
        let proc = reply_proc();
        let (r2, id2) = (r.clone(), id.to_string());
        let spec = LaunchSpec { command: Some("x".into()), argv: None, cwd: String::new() };
        let call = thread::spawn(move || if launched { r2.launch(&id2, spec) } else { r2.attach(&id2, 1) });
        let (req, _) = c.expect(if launched { "launch" } else { "attach" });
        let identity =
            ProcIdentity { boot_id: "b".into(), pid_ns: "n".into(), pid: 1, start_ticks: 5, ..Default::default() };
        c.answer(req, serde_json::json!({ "proc": proc, "identity": identity }));
        call.join().unwrap().unwrap()
    }

    fn sample_delta(p: &Proc, collector_id: &str, t: u64) -> ProcDelta {
        let mut d = delta_of(p);
        d.id = collector_id.to_string();
        d.samples = vec![Sample { t, ..Default::default() }];
        d
    }

    #[test]
    fn silence_reads_as_stale_then_recovers_and_finally_counts_as_lost() {
        let timing = Timing {
            stale_after: Duration::from_millis(100),
            dead_after: Duration::from_millis(700),
            ping_every: Duration::from_millis(50),
            ..fast()
        };
        let (r, c, id) = scripted(timing);
        up(&r, &c, &id);
        // Pings keep going out while it's quiet.
        c.expect("ping");
        eventually("stale", || state_of(&r, &id) == ConnectionState::Stale);
        assert!(r.target(&id).unwrap().state().error.unwrap().contains("No data"));
        c.frame(&tick(1, 1, vec![]));
        eventually("recovered", || state_of(&r, &id) == ConnectionState::Connected);
        assert_eq!(r.target(&id).unwrap().state().error, None);
        // Nothing more arrives: treated as gone, even though the pipe is still open.
        eventually("lost", || r.target(&id).unwrap().state().error.as_deref() == Some("connection went silent"));
    }

    #[test]
    fn a_sequence_gap_asks_for_a_replay_and_applies_frames_in_order_without_duplicates() {
        let (r, c, id) = scripted(fast());
        let r = Arc::new(r);
        up(&r, &c, &id);
        let p = adopted(&r, &c, &id, false);
        let cid = p.id.split(ID_SEP).nth(1).unwrap().to_string();
        let base = 10_000_000_000_000u64;
        c.frame(&tick(1, base, vec![sample_delta(&p, &cid, base + 1)]));
        eventually("first", || r.proc(&p.id).unwrap().samples.iter().any(|s| s.t == base + 1));

        // Tick 2 went missing; 3 and 4 arrive first and must wait for the replay.
        c.frame(&tick(3, base, vec![sample_delta(&p, &cid, base + 3)]));
        c.frame(&tick(4, base, vec![sample_delta(&p, &cid, base + 4)]));
        let (req, ask) = c.expect("resync");
        assert_eq!(ask["since"], 1);
        assert!(r.proc(&p.id).unwrap().samples.iter().all(|s| s.t != base + 3), "held until the replay");
        let replayed: Vec<Value> = [2u64, 3]
            .iter()
            .map(|n| serde_json::to_value(tick(*n, base, vec![sample_delta(&p, &cid, base + n)])).unwrap())
            .collect();
        c.answer(req, serde_json::json!({ "complete": true, "ticks": replayed }));
        eventually("replayed", || r.proc(&p.id).unwrap().samples.iter().any(|s| s.t == base + 4));
        let times: Vec<u64> = r.proc(&p.id).unwrap().samples.iter().filter(|s| s.t >= base).map(|s| s.t).collect();
        assert_eq!(times, [base + 1, base + 2, base + 3, base + 4]);
        assert!(r.proc(&p.id).unwrap().gaps.is_empty());
        r.shutdown();
    }

    #[test]
    fn frames_that_overtake_the_reply_naming_a_run_are_kept() {
        let (r, c, id) = scripted(fast());
        let r = Arc::new(r);
        up(&r, &c, &id);
        let proc = reply_proc();
        let cid = proc["id"].as_str().unwrap().to_string();
        let as_proc: Proc = serde_json::from_value(proc.clone()).unwrap();
        let t0 = 20_000_000_000_000u64;
        let (r2, id2) = (r.clone(), id.clone());
        let call = thread::spawn(move || r2.attach(&id2, 1));
        let (req, _) = c.expect("attach");
        // The collector samples before its reply gets through.
        c.frame(&tick(1, t0, vec![sample_delta(&as_proc, &cid, t0)]));
        c.frame(&tick(2, t0, vec![sample_delta(&as_proc, "someone-else", t0)]));
        eventually("held", || !r.target(&id).unwrap().inner.lock().unwrap().early.is_empty());
        let identity =
            ProcIdentity { boot_id: "b".into(), pid_ns: "n".into(), pid: 1, start_ticks: 5, ..Default::default() };
        c.answer(req, serde_json::json!({ "proc": proc, "identity": identity }));
        let p = call.join().unwrap().unwrap();
        assert!(p.samples.iter().any(|s| s.t == t0), "nothing before the reply was lost");
        let t = r.target(&id).unwrap();
        assert_eq!(t.inner.lock().unwrap().early.len(), 1, "other runs' frames still wait");
        // And what's held stays bounded.
        for n in 0..MAX_EARLY + 5 {
            t.inner.lock().unwrap().apply_delta(sample_delta(&as_proc, &format!("x{n}"), t0));
        }
        assert_eq!(t.inner.lock().unwrap().early.len(), MAX_EARLY);
        r.shutdown();
    }

    #[test]
    fn a_handshake_failure_is_failure_not_a_hang() {
        let (r, c, id) = scripted(Timing { hello_timeout: Duration::from_millis(100), ..fast() });
        r.connect(&id).unwrap();
        // A collector that never answers.
        eventually("timed out", || state_of(&r, &id) == ConnectionState::Failed);
        assert!(r.target(&id).unwrap().state().error.unwrap().contains("in time"));

        let (r, c2, id2) = scripted(fast());
        r.connect(&id2).unwrap();
        let (req, _) = c2.expect("hello");
        c2.answer(req, serde_json::json!({"nonsense": true}));
        eventually("rejected", || state_of(&r, &id2) == ConnectionState::Failed);
        assert!(r.target(&id2).unwrap().state().error.unwrap().contains("not a compatible collector"));
        drop(c);
    }

    #[test]
    fn a_protocol_mismatch_reads_in_the_collectors_own_words() {
        let (r, c, id) = scripted(fast());
        r.connect(&id).unwrap();
        let (req, _) = c.expect("hello");
        c.frame(&ServerFrame::Reply { id: req, ok: false, data: None, error: Some("protocol mismatch".into()) });
        eventually("failed", || state_of(&r, &id) == ConnectionState::Failed);
        assert_eq!(r.target(&id).unwrap().state().error.as_deref(), Some("protocol mismatch"));
    }

    #[test]
    fn a_goodbye_or_eof_explains_itself_with_transport_diagnostics() {
        let (r, c, id) = scripted(Timing { retry_max: Duration::from_secs(60), ..fast() });
        up(&r, &c, &id);
        c.frame(&ServerFrame::Bye { reason: "no word from the desktop".into() });
        eventually("told", || {
            r.target(&id)
                .unwrap()
                .state()
                .error
                .is_some_and(|e| e.contains("no word from the desktop") && e.contains("from transport"))
        });

        let (r, c, id) = scripted(fast());
        up(&r, &c, &id);
        r.target(&id).unwrap().inner.lock().unwrap().wanted = false;
        c.close();
        eventually("eof", || state_of(&r, &id) == ConnectionState::Disconnected);
        assert!(r.target(&id).unwrap().state().error.unwrap().contains("connection lost: from transport"));
    }

    #[test]
    fn a_reattached_launched_command_says_its_output_capture_ended() {
        let (r, c, id) = scripted(fast());
        let r = Arc::new(r);
        up(&r, &c, &id);
        let p = adopted(&r, &c, &id, true);
        assert!(p.target.as_ref().unwrap().launched);

        c.heard.lock().unwrap().clear();
        c.close();
        c.hello(); // the automatic reconnect
        let (req, ask) = c.expect("attach");
        assert_eq!(ask["expect"]["startTicks"], 5, "reconnecting proves identity");
        let proc = reply_proc();
        c.answer(req, serde_json::json!({ "proc": proc, "identity": {} }));
        eventually("noted", || r.proc(&p.id).unwrap().logs.iter().any(|l| l.text.contains("Output capture ended")));
        assert_eq!(r.proc(&p.id).unwrap().status, Status::Running);
        r.shutdown();
    }

    #[test]
    fn container_identity_is_part_of_a_run() {
        for (kind, check) in [
            (
                TargetKind::Docker,
                Box::new(|i: &ProcIdentity| i.container_id.as_deref() == Some("cid"))
                    as Box<dyn Fn(&ProcIdentity) -> bool>,
            ),
            (TargetKind::Kubernetes, Box::new(|i: &ProcIdentity| i.pod_uid.as_deref() == Some("uid"))),
        ] {
            let c = Arc::new(Scripted { heard: Default::default(), say: Mutex::new(None) });
            let r = Arc::new(Remote::with_timing(c.clone(), fast()));
            let id = r
                .add(TargetSpec {
                    id: "x".into(),
                    kind: Some(kind),
                    container: "cid".into(),
                    pod_uid: "uid".into(),
                    ..Default::default()
                })
                .spec
                .id;
            up(&r, &c, &id);
            let p = adopted(&r, &c, &id, false);
            assert!(check(&p.target.unwrap().identity));
            r.shutdown();
        }
    }

    #[test]
    fn bad_replies_are_errors_and_banners_are_tolerated() {
        let (r, c, id) = scripted(fast());
        let r = Arc::new(r);
        c.heard.lock().unwrap().clear();
        r.connect(&id).unwrap();
        eventually("link", || c.say.lock().unwrap().is_some());
        c.say("Welcome to Ubuntu"); // a login banner, before anything else
        c.hello();
        eventually("connected", || state_of(&r, &id) == ConnectionState::Connected);
        for (op, go) in [
            (
                "listProcesses",
                Box::new(|r: Arc<Remote>, id: String| r.list_processes(&id).map(|_| ()))
                    as Box<dyn FnOnce(Arc<Remote>, String) -> Result<(), String> + Send>,
            ),
            ("attach", Box::new(|r: Arc<Remote>, id: String| r.attach(&id, 1).map(|_| ()))),
        ] {
            c.heard.lock().unwrap().clear();
            let (r2, id2) = (r.clone(), id.clone());
            let call = thread::spawn(move || go(r2, id2));
            let (req, _) = c.expect(op);
            c.answer(req, serde_json::json!({"proc": 1}));
            assert!(call.join().unwrap().unwrap_err().contains("bad reply"), "{op}");
        }
        c.heard.lock().unwrap().clear();
        let p = adopted(&r, &c, &id, false);
        let (r2, pid) = (r.clone(), p.id.clone());
        let call = thread::spawn(move || r2.snapshot(&pid));
        let (req, _) = c.expect("snapshot");
        c.answer(req, serde_json::json!({"x": 1}));
        assert!(call.join().unwrap().unwrap_err().contains("bad snapshot"));
        let (r2, pid) = (r.clone(), p.id.clone());
        let call = thread::spawn(move || r2.cpu_profile(&pid, 1));
        let (req, _) = c.expect("cpuProfile");
        c.answer(req, serde_json::json!({"x": 1}));
        assert!(call.join().unwrap().unwrap_err().contains("bad profile"));
        r.shutdown();
    }

    fn setup() -> (Remote, Arc<InProcess>, String) {
        let c = Arc::new(InProcess::default());
        let r = Remote::with_timing(c.clone(), fast());
        let spec = TargetSpec {
            id: "box".into(),
            label: "test box".into(),
            kind: Some(TargetKind::Ssh),
            ..Default::default()
        };
        let id = r.add(spec).spec.id;
        (r, c, id)
    }

    fn eventually(what: &str, mut f: impl FnMut() -> bool) {
        for _ in 0..800 {
            if f() {
                return;
            }
            thread::sleep(Duration::from_millis(10));
        }
        panic!("never happened: {what}");
    }

    fn state_of(r: &Remote, id: &str) -> ConnectionState {
        r.target(id).unwrap().state().state
    }

    fn connected(r: &Remote, id: &str) {
        r.connect(id).unwrap();
        eventually("connected", || state_of(r, id) == ConnectionState::Connected);
    }

    fn sleeper() -> Child {
        Command::new("sleep").arg("60").stdout(Stdio::null()).spawn().unwrap()
    }

    fn kill(c: &mut Child) {
        c.kill().unwrap();
        c.wait().unwrap();
    }

    /// Cut the transport as the network would, without telling anyone.
    fn cut(r: &Remote, id: &str) {
        let t = r.target(id).unwrap();
        let close = t.inner.lock().unwrap().close.take().unwrap();
        close();
    }

    fn with_samples(r: &Remote, run: &str) {
        eventually("samples", || r.proc(run).is_some_and(|p| p.samples.len() >= 3));
    }

    #[test]
    fn connects_and_reports_state_and_capabilities() {
        let (r, _, id) = setup();
        let before = r.target(&id).unwrap().state();
        assert_eq!(before.state, ConnectionState::Disconnected);
        assert!(!before.capabilities.attach, "nothing is promised before a collector answers");
        connected(&r, &id);
        let s = r.target(&id).unwrap().state();
        assert!(s.capabilities.attach && s.capabilities.signal && s.capabilities.runtime_agents);
        assert!(!s.capabilities.container_totals, "SSH isn't a container platform");
        assert!(s.facts.as_ref().unwrap().host_memory > 0.0);
        eventually("machine sample", || r.target(&id).unwrap().state().system.is_some());
        r.disconnect(&id).unwrap();
        assert_eq!(state_of(&r, &id), ConnectionState::Disconnected);
        assert!(!r.target(&id).unwrap().state().capabilities.attach);
    }

    #[test]
    fn container_kinds_advertise_their_platform_capabilities() {
        let c = Arc::new(InProcess::default());
        let r = Remote::with_timing(c, fast());
        let d = r.add(TargetSpec { id: "d".into(), kind: Some(TargetKind::Docker), ..Default::default() }).spec.id;
        let k = r.add(TargetSpec { id: "k".into(), kind: Some(TargetKind::Kubernetes), ..Default::default() }).spec.id;
        connected(&r, &d);
        connected(&r, &k);
        let dc = r.target(&d).unwrap().state().capabilities;
        assert!(dc.container_totals && dc.container_logs && dc.container_top);
        let kc = r.target(&k).unwrap().state().capabilities;
        assert!(kc.container_logs && !kc.container_totals, "pod totals need the optional metrics API");
        r.shutdown();
    }

    #[test]
    fn a_first_failure_is_reported_and_not_retried_forever() {
        let (r, c, id) = setup();
        c.refuse.store(1, Ordering::Relaxed);
        r.connect(&id).unwrap();
        eventually("failed", || state_of(&r, &id) == ConnectionState::Failed);
        assert!(r.target(&id).unwrap().state().error.unwrap().contains("Connection refused"));
        thread::sleep(Duration::from_millis(200));
        assert_eq!(c.connects.load(Ordering::Relaxed), 1);
        connected(&r, &id);
        r.shutdown();
    }

    #[test]
    fn a_transport_without_a_collector_explains_itself() {
        let (r, c, id) = setup();
        c.garbage.store(true, Ordering::Relaxed);
        r.connect(&id).unwrap();
        eventually("failed", || {
            let s = r.target(&id).unwrap().state();
            s.state != ConnectionState::Connecting && s.error.is_some()
        });
        let s = r.target(&id).unwrap().state();
        assert!(s.error.unwrap().contains("not found"), "shows the transport's own words");
        assert!(r.attach(&id, 1).is_err());
    }

    #[test]
    fn attaches_and_streams_through_drain_with_target_identity() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        assert!(r.list_processes(&id).unwrap().iter().any(|a| a.pid == child.id()));
        let p = r.attach(&id, child.id()).unwrap();
        assert!(is_remote_id(&p.id) && p.id.starts_with("box~"));
        let t = p.target.clone().unwrap();
        assert_eq!((t.kind, t.label.as_str(), t.launched), (TargetKind::Ssh, "test box", false));
        assert_eq!(t.identity.pid, child.id());
        assert!(t.identity.start_ticks > 0);
        with_samples(&r, &p.id);
        let drained = r.drain();
        let d = drained.deltas.iter().find(|d| d.id == p.id).expect("a delta under the desktop's run id");
        assert!(!d.samples.is_empty());
        let w = drained.writes.iter().find(|w| w.meta.id == p.id).unwrap();
        assert!(w.meta.target.is_some(), "stored runs remember their target");
        assert_eq!(drained.targets.unwrap().len(), 1);
        let times: Vec<u64> = r.proc(&p.id).unwrap().samples.iter().map(|s| s.t).collect();
        assert!(times.windows(2).all(|w| w[1] > w[0]));
        r.shutdown();
        kill(&mut child);
    }

    #[test]
    fn losing_the_connection_is_not_a_workload_exit_and_reconnect_verifies_identity() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        with_samples(&r, &p.id);
        let before = r.proc(&p.id).unwrap().samples.len();

        cut(&r, &id);
        eventually("noticed", || r.target(&id).unwrap().state().error.is_some());
        assert_eq!(r.proc(&p.id).unwrap().status, Status::Running, "still running as far as anyone knows");
        assert!(r.stop(&p.id).is_err() && r.signal(&p.id, "TERM").is_err(), "nothing can be sent right now");

        // Reconnects on its own and resumes the same run, recording the gap.
        eventually("reconnected", || state_of(&r, &id) == ConnectionState::Connected);
        eventually("gap recorded", || !r.proc(&p.id).unwrap().gaps.is_empty());
        let after = r.proc(&p.id).unwrap();
        assert_eq!(after.id, p.id, "same run, same history");
        assert!(after.samples.len() >= before);
        assert!(after.gaps[0].to >= after.gaps[0].from);
        assert_eq!(
            after.target.as_ref().unwrap().identity.start_ticks,
            p.target.as_ref().unwrap().identity.start_ticks
        );
        let told = r.drain();
        let d = told.deltas.iter().find(|d| d.id == p.id).expect("the UI hears about this run");
        assert_eq!(d.gaps, after.gaps, "and about its gaps, which it can't work out for itself");
        assert!(d.clock_offset_ms.is_some());
        let times: Vec<u64> = r.proc(&p.id).unwrap().samples.iter().map(|s| s.t).collect();
        assert!(times.windows(2).all(|w| w[1] > w[0]), "no duplicates across the reconnect: {times:?}");
        assert!(child.try_wait().unwrap().is_none(), "the workload never noticed");
        r.shutdown();
        kill(&mut child);
    }

    #[test]
    fn a_process_gone_after_reconnect_is_not_called_a_crash_or_given_an_exit_code() {
        let (r, c, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        with_samples(&r, &p.id);
        // Stays unreachable until the process has died unobserved.
        c.refuse.store(u64::MAX, Ordering::Relaxed);
        cut(&r, &id);
        eventually("noticed", || r.target(&id).unwrap().state().error.is_some());
        kill(&mut child);
        c.refuse.store(0, Ordering::Relaxed);
        eventually("marked", || r.proc(&p.id).unwrap().status != Status::Running);
        let after = r.proc(&p.id).unwrap();
        assert_eq!(after.status, Status::Exited);
        assert_eq!(after.exit_code, None);
        assert_eq!(after.signal.as_deref(), Some("ended while disconnected"));
        let w = r.drain().writes;
        assert!(w.iter().any(|w| w.meta.signal.as_deref() == Some("ended while disconnected")));
        r.shutdown();
    }

    #[test]
    fn a_reused_pid_does_not_inherit_the_run() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        with_samples(&r, &p.id);
        // As if the PID now belonged to something started later.
        r.target(&id).unwrap().inner.lock().unwrap().runs[0].proc.target.as_mut().unwrap().identity.start_ticks += 1;
        cut(&r, &id);
        eventually("refused", || r.proc(&p.id).unwrap().status == Status::Exited);
        assert!(child.try_wait().unwrap().is_none(), "and the new owner of that PID is untouched");
        r.shutdown();
        kill(&mut child);
    }

    #[test]
    fn a_rebooted_target_is_named_as_such() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        with_samples(&r, &p.id);
        r.target(&id).unwrap().inner.lock().unwrap().runs[0].proc.target.as_mut().unwrap().identity.boot_id =
            "old".into();
        cut(&r, &id);
        eventually("marked", || r.proc(&p.id).unwrap().signal.as_deref() == Some("target rebooted"));
        r.shutdown();
        kill(&mut child);
    }

    #[test]
    fn an_unreachable_target_keeps_retrying_and_keeps_its_runs() {
        let (r, c, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        with_samples(&r, &p.id);
        c.refuse.store(3, Ordering::Relaxed);
        cut(&r, &id);
        eventually("retries", || c.refuse.load(Ordering::Relaxed) == 0);
        eventually("back", || state_of(&r, &id) == ConnectionState::Connected);
        assert_eq!(r.proc(&p.id).unwrap().status, Status::Running);
        r.shutdown();
        kill(&mut child);
    }

    #[test]
    fn a_replaced_target_stops_retrying() {
        struct Replaced(AtomicU64);
        impl Connector for Replaced {
            fn connect(&self, _: &TargetSpec) -> Result<Link, String> {
                self.0.fetch_add(1, Ordering::Relaxed);
                Err("pod web was replaced (it was a, it is now b)".into())
            }
        }
        assert!(is_permanent("Error: No such container: abc"));
        assert!(!is_permanent("Connection refused"));
        let c = Arc::new(Replaced(AtomicU64::new(0)));
        let r = Remote::with_timing(c.clone(), fast());
        let id = r.add(TargetSpec { id: "x".into(), ..Default::default() }).spec.id;
        // As if it had worked earlier: temporary failures would keep retrying.
        {
            let t = r.target(&id).unwrap();
            t.inner.lock().unwrap().ever_connected = true;
        }
        r.connect(&id).unwrap();
        eventually("failed", || state_of(&r, &id) == ConnectionState::Failed);
        thread::sleep(Duration::from_millis(150));
        assert_eq!(c.0.load(Ordering::Relaxed), 1);
    }

    #[test]
    fn a_hung_target_blocks_nothing_else() {
        let (r, c, id) = setup();
        c.hang.store(true, Ordering::Relaxed);
        r.connect(&id).unwrap();
        let started = Instant::now();
        for _ in 0..20 {
            r.drain();
            r.states();
            r.procs();
        }
        assert!(started.elapsed() < Duration::from_millis(500), "{:?}", started.elapsed());
        assert_eq!(state_of(&r, &id), ConnectionState::Connecting);
        assert!(r.list_processes(&id).is_err(), "not connected yet, and says so at once");
        c.hang.store(false, Ordering::Relaxed);
        eventually("connected", || state_of(&r, &id) == ConnectionState::Connected);
        r.shutdown();
    }

    #[test]
    fn launches_stop_signal_and_restart_are_routed_to_the_target() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let spec = LaunchSpec { command: Some("echo hello; sleep 60".into()), argv: None, cwd: "/tmp".into() };
        let p = r.launch(&id, spec.clone()).unwrap();
        let t = p.target.as_ref().unwrap();
        assert!(t.launched);
        assert_eq!(t.spec.as_ref(), Some(&spec));
        eventually("output", || r.proc(&p.id).unwrap().logs.iter().any(|l| l.text == "hello"));
        assert!(r.restart(&p.id).unwrap_err().contains("stop it first"));
        r.stop(&p.id).unwrap();
        eventually("ended", || r.proc(&p.id).unwrap().status != Status::Running);
        assert_eq!(r.proc(&p.id).unwrap().status, Status::Exited, "a requested stop isn't a crash");

        let again = r.restart(&p.id).unwrap();
        assert_ne!(again.id, p.id, "a new run, on the same target");
        assert!(r.proc(&p.id).is_none());
        assert_eq!(again.target.as_ref().unwrap().target_id, "box");
        r.signal(&again.id, "TERM").unwrap();
        eventually("signalled", || r.proc(&again.id).unwrap().status != Status::Running);
        assert!(r.signal(&again.id, "USR1").unwrap_err().contains("not allowed"));
        assert!(r.forget(&again.id));
        assert!(!r.forget(&again.id));
        assert!(!r.forget("nothing~here"));
        r.shutdown();
    }

    #[test]
    fn attached_services_are_never_stopped_or_restarted_implicitly() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        assert!(r.stop(&p.id).unwrap_err().contains("didn't launch"));
        assert!(r.restart(&p.id).unwrap_err().contains("didn't launch"));
        assert!(r.remove(&id).unwrap_err().contains("detach"), "can't forget a target mid-watch");
        assert!(!r.forget(&p.id), "running runs stay");
        with_samples(&r, &p.id);

        r.detach(&p.id).unwrap();
        let told = r.drain().deltas.into_iter().find(|d| d.id == p.id).unwrap();
        assert_eq!(told.signal.as_deref(), Some("monitoring stopped"), "queued samples can't hide the new status");
        assert_eq!(told.status, Status::Exited);
        let after = r.proc(&p.id).unwrap();
        assert_eq!(
            (after.status, after.signal.as_deref(), after.exit_code),
            (Status::Exited, Some("monitoring stopped"), None)
        );
        assert!(child.try_wait().unwrap().is_none(), "detaching leaves it running");
        let alert = Alert { t: 1, kind: "memory".into(), message: "m".into(), value: 1.0, threshold: 1.0 };
        r.add_alert(&p.id, &alert);
        r.add_alert("box~nope", &alert);
        r.add_alert("nothing~here", &alert);
        assert_eq!(r.proc(&p.id).unwrap().alerts, vec![alert]);
        assert!(r.detach("box~nope").is_err());
        assert_eq!(r.clear_ended(), 1);
        r.remove(&id).unwrap();
        assert!(r.states().is_empty());
        assert!(child.try_wait().unwrap().is_none(), "and so does removing the target");
        kill(&mut child);
    }

    #[test]
    fn disconnecting_leaves_attached_alone_and_runs_verified_later() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let mut child = sleeper();
        let p = r.attach(&id, child.id()).unwrap();
        with_samples(&r, &p.id);
        r.disconnect(&id).unwrap();
        assert_eq!(r.proc(&p.id).unwrap().status, Status::Running);
        assert!(r.stop(&p.id).is_err());
        assert!(r.snapshot(&p.id).is_err() && r.force_gc(&p.id).is_err() && r.cpu_profile(&p.id, 1000).is_err());
        assert!(r.detach(&p.id).is_ok(), "you can stop watching while disconnected");
        kill(&mut child);
        assert!(r.connect("nope").is_err() && r.disconnect("nope").is_err() && r.remove("nope").is_err());
    }

    #[test]
    fn disconnecting_on_purpose_ends_launched_commands_and_says_so() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let spec = LaunchSpec { command: Some("sleep 60".into()), argv: None, cwd: "/tmp".into() };
        let p = r.launch(&id, spec).unwrap();
        with_samples(&r, &p.id);
        r.disconnect(&id).unwrap();
        let after = r.proc(&p.id).unwrap();
        assert_eq!(
            (after.status, after.signal.as_deref(), after.exit_code),
            (Status::Exited, Some("stopped with the session"), None)
        );
    }

    #[test]
    fn a_launched_command_stopped_by_the_contract_reads_as_ended_while_disconnected() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let spec = LaunchSpec { command: Some("sleep 60".into()), argv: None, cwd: "/tmp".into() };
        let p = r.launch(&id, spec).unwrap();
        with_samples(&r, &p.id);
        cut(&r, &id);
        eventually("marked", || r.proc(&p.id).unwrap().status != Status::Running);
        assert_eq!(r.proc(&p.id).unwrap().signal.as_deref(), Some("ended while disconnected"));
        r.shutdown();
    }

    #[test]
    fn runtime_requests_go_to_the_target_and_land_on_the_run() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let spec = LaunchSpec {
            command: Some("node --no-use-osr -e 'function busyWork(){const e=Date.now()+50;while(Date.now()<e);} setInterval(busyWork,60)'".into()),
            argv: None,
            cwd: "/tmp".into(),
        };
        let p = r.launch(&id, spec).unwrap();
        eventually("agent", || r.proc(&p.id).unwrap().profiling);
        let profile = r.cpu_profile(&p.id, 500).unwrap();
        assert_eq!(profile.sampling, "v8");
        assert_eq!(r.proc(&p.id).unwrap().cpu_profiles.len(), 1);
        assert!(!r.snapshot(&p.id).unwrap().entries.is_empty());
        assert_eq!(r.proc(&p.id).unwrap().snapshots.len(), 1);
        r.force_gc(&p.id).unwrap();
        r.shutdown();
    }

    #[test]
    fn duplicate_ticks_and_sequence_gaps_are_handled() {
        let (r, _, id) = setup();
        connected(&r, &id);
        let t = r.target(&id).unwrap();
        let mut i = t.inner.lock().unwrap();
        // Hold the session still so only these frames apply.
        i.generation += 1;
        i.last_seq = 10;
        let frame = |seq: u64, sample_t: u64| Tick {
            seq,
            t: sample_t,
            wall: wall_ms(),
            procs: vec![],
            system: Some(SystemSample { t: sample_t, ..Default::default() }),
        };
        i.apply_tick(frame(10, 1));
        assert!(i.system.as_ref().is_none_or(|s| s.t != 1), "an already-applied sequence is ignored");
        i.apply_tick(frame(11, 2));
        assert_eq!(i.system.as_ref().unwrap().t, 2);
        assert_eq!(i.last_seq, 11);

        // An incomplete resync records a gap across running runs; complete ones don't.
        let mut proc: Proc = serde_json::from_value(reply_proc()).unwrap();
        proc.samples = vec![Sample { t: 100, ..Default::default() }];
        i.runs.push(Run {
            proc,
            collector_id: Some("c".into()),
            cpu_sum: 0.0,
            samples: 0,
            log_base: 0,
            time_shift: 0,
            gap_from: None,
            pending: None,
            dirty: false,
        });
        i.held.push(frame(14, 500));
        let replay = |seq: u64| serde_json::to_value(ServerFrame::Tick(frame(seq, 400))).unwrap();
        Target::finish_resync(&mut i, Some(json!({"complete": false, "ticks": [replay(13)]})));
        assert_eq!(i.runs[0].proc.gaps, vec![Gap { from: 100, to: 400 }]);
        assert_eq!(i.last_seq, 14, "the held tick applies after the replay");
        Target::finish_resync(&mut i, Some(json!({"complete": true, "ticks": []})));
        assert_eq!(i.runs[0].proc.gaps.len(), 1);
        Target::finish_resync(&mut i, None);
        assert_eq!(i.runs[0].proc.gaps.len(), 2, "no information means assume the worst");
    }

    #[test]
    fn sessions_remap_log_ids_and_clock_restarts_so_a_run_stays_increasing() {
        let (r, _, id) = setup();
        let t = r.target(&id).unwrap();
        let mut proc: Proc = serde_json::from_value(reply_proc()).unwrap();
        proc.id = "box~run".into();
        proc.samples = vec![Sample { t: 1000, ..Default::default() }];
        proc.logs = vec![LogLine { id: 50, t: 1000, stream: Stream::Stdout, text: "old".into() }];
        let mut delta = delta_of(&proc);
        let mut i = t.inner.lock().unwrap();
        i.runs.push(Run {
            proc,
            collector_id: Some("c2".into()),
            cpu_sum: 0.0,
            samples: 0,
            log_base: 50,
            time_shift: 901,
            gap_from: Some(1000),
            pending: None,
            dirty: false,
        });
        delta.id = "c2".into();
        delta.samples = vec![Sample { t: 100, cpu: 50.0, ..Default::default() }];
        delta.logs = vec![LogLine { id: 1, t: 100, stream: Stream::Stdout, text: "new".into() }];
        delta.gc = vec![GcEvent { t: 100, kind: GcKind::Minor, pause_ms: 1.0, freed: 0.0 }];
        i.apply_tick(Tick { seq: 1, t: 100, wall: wall_ms(), procs: vec![delta], system: None });
        let run = &i.runs[0];
        assert_eq!(run.proc.samples.last().unwrap().t, 1001);
        assert_eq!(run.proc.logs.last().unwrap().id, 51);
        assert_eq!(run.proc.logs.last().unwrap().t, 1001);
        assert_eq!(run.proc.gc.last().unwrap().t, 1001);
        assert_eq!(run.proc.gaps, vec![Gap { from: 1000, to: 1001 }]);
        assert_eq!(run.proc.id, "box~run");
        assert_eq!((run.cpu_sum, run.samples), (50.0, 1));
    }

    #[test]
    fn specs_are_normalized_and_updatable() {
        let (r, _, _) = setup();
        let s = r.add(TargetSpec { id: "a~b".into(), ..Default::default() });
        assert_eq!(s.spec.id, "a-b", "the separator can't appear in a target id");
        let auto = r.add(TargetSpec::default());
        assert!(!auto.spec.id.is_empty());
        let updated = r.add(TargetSpec { id: "a-b".into(), label: "renamed".into(), ..Default::default() });
        assert_eq!(updated.spec.label, "renamed");
        assert_eq!(r.specs().iter().filter(|s| s.id == "a-b").count(), 1);
    }

    fn reply_proc() -> Value {
        let m = peak_core::monitor::Monitor::new(peak_core::procfs::ProcFs::default(), Default::default()).shared();
        let p = peak_core::monitor::attach(&m, std::process::id()).unwrap();
        serde_json::to_value(p).unwrap()
    }
}
