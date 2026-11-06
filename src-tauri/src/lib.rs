//! peak — a local process monitor and memory profiler.
//!
//! Everything below the Tauri glue in this file lives in plain modules that
//! are tested without a window. `peak-core` holds what also runs on remote
//! targets (`procfs`, `sampler`, `runner`, `monitor`, `hub`, `collector`). Here:
//! `db` (SQLite history), `remote` (targets and transports), `service` (wiring
//! them together) and `cli` (`peak run`).

pub mod bundled;
pub mod cli;
pub mod db;
pub mod discovery;
pub mod remote;
pub mod service;
pub mod transport;

pub use peak_core::{hub, model, monitor, procfs, runner, sampler};

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use tauri::{Emitter, Manager, RunEvent};

use db::Db;
use hub::Hub;
use model::*;
use monitor::{AgentEnv, Monitor, now_ms};
use procfs::ProcFs;
use remote::{TargetSpec, TargetState};
use service::{AppState, Service};
use transport::{CliConnector, Tools};

type State<'a> = tauri::State<'a, Arc<Service>>;

/// Run blocking work off the main thread.
async fn blocking<T: Send + 'static>(f: impl FnOnce() -> Result<T, String> + Send + 'static) -> Result<T, String> {
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

#[tauri::command]
fn get_state(state: State<'_>) -> AppState {
    state.full_state()
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
async fn stop(state: State<'_>, id: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.stop(&id)).await
}

#[tauri::command]
async fn restart(state: State<'_>, id: String) -> Result<Proc, String> {
    let s = state.inner().clone();
    blocking(move || s.restart(&id)).await
}

#[tauri::command]
fn remove(state: State<'_>, id: String) -> bool {
    state.remove(&id)
}

#[tauri::command]
fn clear_ended(state: State<'_>) -> usize {
    state.clear_ended()
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
    let s = state.inner().clone();
    blocking(move || s.force_gc(&id)).await
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

#[tauri::command]
fn add_alert(state: State<'_>, id: String, alert: Alert) -> Result<(), String> {
    state.add_alert(&id, &alert)
}

#[tauri::command]
fn add_target(state: State<'_>, spec: TargetSpec) -> Result<TargetState, String> {
    state.add_target(spec)
}

#[tauri::command]
fn remove_target(state: State<'_>, id: String) -> Result<(), String> {
    state.remove_target(&id)
}

#[tauri::command]
fn connect_target(state: State<'_>, id: String) -> Result<(), String> {
    state.remote.connect(&id)
}

#[tauri::command]
fn disconnect_target(state: State<'_>, id: String) -> Result<(), String> {
    state.remote.disconnect(&id)
}

#[tauri::command]
async fn list_target_processes(state: State<'_>, id: String) -> Result<Vec<Attachable>, String> {
    let s = state.inner().clone();
    blocking(move || s.remote.list_processes(&id)).await
}

#[tauri::command]
async fn attach_target(state: State<'_>, id: String, pid: u32) -> Result<Proc, String> {
    let s = state.inner().clone();
    blocking(move || s.remote.attach(&id, pid)).await
}

#[tauri::command]
async fn launch_target(state: State<'_>, id: String, spec: LaunchSpec) -> Result<Proc, String> {
    let s = state.inner().clone();
    blocking(move || s.remote.launch(&id, spec)).await
}

#[tauri::command]
async fn detach(state: State<'_>, id: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.detach(&id)).await
}

#[tauri::command]
async fn signal_run(state: State<'_>, id: String, signal: String) -> Result<(), String> {
    let s = state.inner().clone();
    blocking(move || s.remote.signal(&id, &signal)).await
}

#[tauri::command]
async fn docker_contexts() -> Result<Vec<String>, String> {
    blocking(|| transport::docker_contexts(&Tools::default())).await
}

#[tauri::command]
async fn docker_containers(context: String) -> Result<Vec<transport::DockerContainer>, String> {
    blocking(move || transport::docker_containers(&Tools::default(), &context)).await
}

#[tauri::command]
async fn docker_totals(context: String, id: String) -> Result<Option<transport::ContainerTotals>, String> {
    blocking(move || transport::docker_totals(&Tools::default(), &context, &id)).await
}

#[tauri::command]
async fn docker_top(context: String, id: String) -> Result<Vec<transport::ContainerProcess>, String> {
    blocking(move || transport::docker_top(&Tools::default(), &context, &id)).await
}

#[tauri::command]
async fn docker_logs(context: String, id: String, tail: u32) -> Result<String, String> {
    blocking(move || transport::docker_logs(&Tools::default(), &context, &id, tail)).await
}

#[tauri::command]
async fn kube_contexts() -> Result<Vec<String>, String> {
    blocking(|| transport::kube_contexts(&Tools::default())).await
}

#[tauri::command]
async fn kube_namespaces(context: String) -> Result<Vec<String>, String> {
    blocking(move || transport::kube_namespaces(&Tools::default(), &context)).await
}

#[tauri::command]
async fn kube_pods(context: String, namespace: String) -> Result<Vec<transport::KubePod>, String> {
    blocking(move || transport::kube_pods(&Tools::default(), &context, &namespace)).await
}

#[tauri::command]
async fn kube_logs(
    context: String,
    namespace: String,
    pod: String,
    container: String,
    tail: u32,
) -> Result<String, String> {
    blocking(move || transport::kube_logs(&Tools::default(), &context, &namespace, &pod, &container, tail)).await
}

#[tauri::command]
async fn kube_metrics(
    context: String,
    namespace: String,
    pod: String,
) -> Result<Option<Vec<transport::KubeMetrics>>, String> {
    blocking(move || transport::kube_metrics(&Tools::default(), &context, &namespace, &pod)).await
}

#[tauri::command]
async fn kube_access(context: String, namespace: String) -> Result<transport::KubeAccess, String> {
    blocking(move || Ok(transport::kube_access(&Tools::default(), &context, &namespace))).await
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    let app = tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .plugin(tauri_plugin_notification::init())
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
            // Lets `peak run` in a terminal find this instance, for as long as it's open.
            let here = discovery::Here::detect();
            let dirs = discovery::default_dirs();
            discovery::prune(&dirs, &here);
            let publication = Arc::new(discovery::Publication::new(addr, secret, &dirs, &here));
            for problem in publication.publish() {
                eprintln!("peak: `peak run` won't be able to find this app: {problem}");
            }

            let db = Db::open(&dir.join("peak.db")).or_else(|e| {
                eprintln!("peak: {e}; history will not be saved");
                Db::open_in_memory()
            })?;
            let connector = Arc::new(CliConnector { tools: Tools::default() });
            let service = Arc::new(Service::new(monitor, hub, db, connector));

            let s = service.clone();
            let handle = app.handle().clone();
            let published = publication.clone();
            thread::spawn(move || {
                let mut ticks = 0u64;
                loop {
                    thread::sleep(Duration::from_millis(TICK_MS));
                    let _ = handle.emit("peak://tick", s.tick(now_ms()));
                    ticks += 1;
                    if ticks.is_multiple_of(20) {
                        published.ensure();
                    }
                }
            });
            app.manage(service);
            app.manage(publication);
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
            set_settings,
            add_alert,
            add_target,
            remove_target,
            connect_target,
            disconnect_target,
            list_target_processes,
            attach_target,
            launch_target,
            detach,
            signal_run,
            docker_contexts,
            docker_containers,
            docker_totals,
            docker_top,
            docker_logs,
            kube_contexts,
            kube_namespaces,
            kube_pods,
            kube_logs,
            kube_metrics,
            kube_access
        ])
        .build(tauri::generate_context!())
        .expect("error while building peak");

    app.run(|handle, event| {
        if let RunEvent::Exit = event {
            if let Some(publication) = handle.try_state::<Arc<discovery::Publication>>() {
                publication.retire();
            }
            // Processes peak started shouldn't outlive it.
            if let Some(state) = handle.try_state::<Arc<Service>>() {
                state.monitor.lock().unwrap().shutdown();
                // Remote sessions end by the collector's contract: attached services keep
                // running; only commands launched through that session are stopped.
                state.remote.shutdown();
            }
        }
    });
}
