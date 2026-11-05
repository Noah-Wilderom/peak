//! peak — a local process monitor and memory profiler.
//!
//! Everything below the Tauri glue in this file lives in plain modules that
//! are tested without a window: `procfs` (reading /proc), `sampler` (rates and
//! composition), `runner` (spawning and signals), `monitor` (state and
//! deltas), `hub` (runtime agents and the CLI socket) and `cli` (`peak run`).

pub mod cli;
pub mod hub;
pub mod model;
pub mod monitor;
pub mod procfs;
pub mod runner;
pub mod sampler;

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

use hub::{ControlFile, Hub};
use model::*;
use monitor::{AgentEnv, Monitor, Shared, now_ms};
use procfs::ProcFs;

struct AppState {
    monitor: Shared,
    hub: Arc<Hub>,
}

#[tauri::command]
fn get_state(state: tauri::State<'_, AppState>) -> FullState {
    state.monitor.lock().unwrap().full_state()
}

#[tauri::command]
fn capture(state: tauri::State<'_, AppState>, command: String, cwd: String) -> Result<Proc, String> {
    monitor::capture(&state.monitor, &command, &cwd)
}

#[tauri::command]
fn attach(state: tauri::State<'_, AppState>, pid: u32) -> Result<Proc, String> {
    monitor::attach(&state.monitor, pid)
}

#[tauri::command]
fn list_attachable(state: tauri::State<'_, AppState>) -> Vec<Attachable> {
    state.monitor.lock().unwrap().list_attachable(80)
}

#[tauri::command]
fn stop(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    monitor::stop(&state.monitor, &id, Duration::from_secs(3))
}

#[tauri::command]
async fn restart(state: tauri::State<'_, AppState>, id: String) -> Result<Proc, String> {
    let m = state.monitor.clone();
    tauri::async_runtime::spawn_blocking(move || monitor::restart(&m, &id)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn remove(state: tauri::State<'_, AppState>, id: String) -> bool {
    state.monitor.lock().unwrap().remove(&id)
}

#[tauri::command]
fn clear_ended(state: tauri::State<'_, AppState>) -> usize {
    state.monitor.lock().unwrap().clear_ended()
}

#[tauri::command]
async fn take_snapshot(state: tauri::State<'_, AppState>, id: String) -> Result<HeapSnapshot, String> {
    let hub = state.hub.clone();
    tauri::async_runtime::spawn_blocking(move || hub.take_snapshot(&id, Duration::from_secs(120)))
        .await
        .map_err(|e| e.to_string())?
}

#[tauri::command]
async fn force_gc(state: tauri::State<'_, AppState>, id: String) -> Result<(), String> {
    let hub = state.hub.clone();
    tauri::async_runtime::spawn_blocking(move || hub.force_gc(&id, Duration::from_secs(30)))
        .await
        .map_err(|e| e.to_string())?
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

            let m = monitor.clone();
            let handle = app.handle().clone();
            thread::spawn(move || {
                loop {
                    thread::sleep(Duration::from_millis(TICK_MS));
                    let deltas = m.lock().unwrap().tick(now_ms());
                    if !deltas.is_empty() {
                        let _ = handle.emit("peak://tick", deltas);
                    }
                }
            });
            app.manage(AppState { monitor, hub });
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
            force_gc
        ])
        .build(tauri::generate_context!())
        .expect("error while building peak");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            // Processes peak started shouldn't outlive it.
            if let Some(state) = handle.try_state::<AppState>() {
                state.monitor.lock().unwrap().shutdown();
            }
        }
    });
}
