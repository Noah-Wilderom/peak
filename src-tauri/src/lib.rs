//! peak — a local process monitor and memory profiler.
//!
//! Everything below the Tauri glue in this file lives in plain modules that
//! are tested without a window: `procfs` (reading /proc), `sampler` (rates and
//! composition), `runner` (spawning and signals), `monitor` (state and
//! deltas), `hub` (runtime agents and the CLI socket), `db` (SQLite history),
//! `service` (wiring them together) and `cli` (`peak run`).

pub mod cli;
pub mod db;
pub mod hub;
pub mod model;
pub mod monitor;
pub mod procfs;
pub mod runner;
pub mod sampler;
pub mod service;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

use db::Db;
use hub::{ControlFile, Hub};
use model::*;
use monitor::{AgentEnv, Monitor, now_ms};
use procfs::ProcFs;
use service::Service;

type State<'a> = tauri::State<'a, Arc<Service>>;

/// Run blocking work off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_state(state: State<'_>) -> FullState {
    state.monitor.lock().unwrap().full_state()
}

#[tauri::command]
fn capture(state: State<'_>, command: String, cwd: String) -> Result<Proc, String> {
    monitor::capture(&state.monitor, &command, &cwd)
}

#[tauri::command]
fn attach(state: State<'_>, pid: u32) -> Result<Proc, String> {
    monitor::attach(&state.monitor, pid)
}

#[tauri::command]
fn list_attachable(state: State<'_>) -> Vec<Attachable> {
    state.monitor.lock().unwrap().list_attachable(80)
}

#[tauri::command]
fn stop(state: State<'_>, id: String) -> Result<(), String> {
    monitor::stop(&state.monitor, &id, Duration::from_secs(3))
}

#[tauri::command]
async fn restart(state: State<'_>, id: String) -> Result<Proc, String> {
    let m = state.monitor.clone();
    blocking(move || monitor::restart(&m, &id)).await
}

#[tauri::command]
fn remove(state: State<'_>, id: String) -> bool {
    state.monitor.lock().unwrap().remove(&id)
}

#[tauri::command]
fn clear_ended(state: State<'_>) -> usize {
    state.monitor.lock().unwrap().clear_ended()
}

#[tauri::command]
async fn take_snapshot(state: State<'_>, id: String) -> Result<HeapSnapshot, String> {
    let s = state.inner().clone();
    blocking(move || s.take_snapshot(&id)).await
}

#[tauri::command]
async fn cpu_profile(state: State<'_>, id: String, ms: u64) -> Result<CpuProfile, String> {
    let s = state.inner().clone();
    blocking(move || s.cpu_profile(&id, ms)).await
}

#[tauri::command]
async fn force_gc(state: State<'_>, id: String) -> Result<(), String> {
    let hub = state.hub.clone();
    blocking(move || hub.force_gc(&id, Duration::from_secs(30))).await
}

#[tauri::command]
fn list_runs(state: State<'_>, query: Option<String>, limit: Option<u32>) -> Result<Vec<RunSummary>, String> {
    state.list_runs(query.as_deref(), limit.unwrap_or(500))
}

#[tauri::command]
fn open_run(state: State<'_>, id: String) -> Result<Proc, String> {
    state.open_run(&id)
}

#[tauri::command]
fn load_run(state: State<'_>, id: String) -> Result<Proc, String> {
    state.load_run(&id)
}

#[tauri::command]
fn delete_run(state: State<'_>, id: String) -> Result<bool, String> {
    state.delete_run(&id)
}

#[tauri::command]
fn prune_runs(state: State<'_>, older_than_days: Option<u32>) -> Result<usize, String> {
    state.prune(older_than_days)
}

#[tauri::command]
fn storage_info(state: State<'_>) -> Result<StorageInfo, String> {
    state.storage_info()
}

#[tauri::command]
async fn vacuum(state: State<'_>) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.vacuum()).await
}

#[tauri::command]
fn get_settings(state: State<'_>) -> Settings {
    state.settings()
}

#[tauri::command]
fn set_settings(state: State<'_>, settings: Settings) -> Result<Settings, String> {
    state.set_settings(&settings)
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .setup(|app| {
            let monitor = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
            let handle = app.handle().clone();
            let secret = hub::random_hex(16);
            let hub = Hub::start(
                monitor.clone(),
                secret.clone(),
                Arc::new(move |p: Proc| {
                    let _ = handle.emit("peak://proc", p);
                }),
            )?;
            let addr = hub.addr().to_string();
            let dir = hub::default_data_dir();
            let env = hub::install_agents(&dir, &addr).unwrap_or(AgentEnv { addr: addr.clone(), ..Default::default() });
            monitor.lock().unwrap().agent_env = env;
            // Lets `peak run` in a terminal find this instance.
            let _ = hub::write_control_file(&dir, &ControlFile { addr, secret });

            let db = Db::open(&dir.join("peak.db")).or_else(|e| {
                eprintln!("peak: {e}; history will not be saved");
                Db::open_in_memory()
            })?;
            let service = Arc::new(Service::new(monitor, hub, db));

            let s = service.clone();
            let handle = app.handle().clone();
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_millis(TICK_MS));
                    let _ = handle.emit("peak://tick", s.tick(now_ms()));
                }
            });
            app.manage(service);
            Ok(())
        })
        .invoke_handler(tauri::generate_handler![
            get_state,
            capture,
            attach,
            list_attachable,
            stop,
            restart,
            remove,
            clear_ended,
            take_snapshot,
            cpu_profile,
            force_gc,
            list_runs,
            open_run,
            load_run,
            delete_run,
            prune_runs,
            storage_info,
            vacuum,
            get_settings,
            set_settings
        ])
        .build(tauri::generate_context!())
        .expect("error while building peak");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Processes peak started shouldn't outlive it.
            if let Some(state) = handle.try_state::<Arc<Service>>() {
                state.monitor.lock().unwrap().shutdown();
            }
        }
    });
}
