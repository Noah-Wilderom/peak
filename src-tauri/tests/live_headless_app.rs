//! The app without its window, for trying the CLI and agents on a machine with no desktop
//! libraries, as with `PEAK_SMOKE_APP` in scripts/e2e/smoke. Runs until it's killed.
//!
//!     cargo test -p peak --test live_headless_app -- --ignored --nocapture

use std::sync::Arc;
use std::thread;
use std::time::Duration;

use peak_lib::db::Db;
use peak_lib::discovery::{self, Publication};
use peak_lib::hub::{self, Hub};
use peak_lib::monitor::{AgentEnv, Monitor, now_ms};
use peak_lib::procfs::ProcFs;
use peak_lib::service::Service;
use peak_lib::transport::{CliConnector, Tools};

#[test]
#[ignore = "runs until killed"]
fn serve() {
    let monitor = Monitor::new(ProcFs::default(), AgentEnv::default()).shared();
    let secret = hub::random_hex(16);
    let hub = Hub::start(monitor.clone(), secret.clone(), Arc::new(|_| {})).unwrap();
    let addr = hub.addr().to_string();
    let dir = hub::default_data_dir();
    monitor.lock().unwrap().agent_env = hub::install_agents(&dir, &addr).unwrap();
    let here = discovery::Here::detect();
    let publication = Publication::new(addr, secret, &discovery::default_dirs(), &here);
    assert!(publication.publish().is_empty());
    let db = Db::open(&dir.join("peak.db")).unwrap();
    let service = Arc::new(Service::new(monitor, hub.clone(), db, Arc::new(CliConnector { tools: Tools::default() })));
    let s = service.clone();
    hub.set_control(Arc::new(move |action, id, ms| match action {
        "open" => Ok(serde_json::Value::Null),
        _ => s.control(action, id, ms),
    }));
    loop {
        thread::sleep(Duration::from_millis(500));
        service.tick(now_ms());
    }
}
