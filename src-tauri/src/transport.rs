//! Connecting through the user's installed `ssh`, `docker` and `kubectl`, so their
//! existing configuration and credentials apply. Also: making the collector
//! available on a target, and discovery that needs no collector at all.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::{Arc, Mutex};
use std::thread;
use std::time::{Duration, Instant};

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::model::TargetKind;
use crate::remote::{Connector, Link, TargetSpec};
use peak_core::protocol::VERSION;

/// Long enough for a slow login, short enough to fail visibly.
const COMMAND_TIMEOUT: Duration = Duration::from_secs(30);
const COLLECTOR_VERSION: &str = env!("CARGO_PKG_VERSION");

#[derive(Clone, Debug)]
pub struct Tools {
    pub ssh: String,
    pub docker: String,
    pub kubectl: String,
    /// Extra `ssh` options, for fixed test setups. Users configure ~/.ssh/config instead.
    pub ssh_options: Vec<String>,
    /// Directory holding `<arch>/peak-collector` builds, tried before the app's own.
    pub collectors: Option<PathBuf>,
    /// Where the embedded collector is unpacked.
    pub data_dir: PathBuf,
}

impl Default for Tools {
    fn default() -> Self {
        Tools {
            ssh: "ssh".into(),
            docker: "docker".into(),
            kubectl: "kubectl".into(),
            ssh_options: vec![],
            collectors: std::env::var_os("PEAK_COLLECTORS").map(PathBuf::from),
            data_dir: crate::hub::default_data_dir(),
        }
    }
}

/// The result of a command, or a message saying what stopped it.
fn run(mut cmd: Command, timeout: Duration, stdin: Option<&Path>) -> Result<String, String> {
    let name = cmd.get_program().to_string_lossy().into_owned();
    match stdin {
        Some(path) => cmd.stdin(std::fs::File::open(path).map_err(|e| format!("{}: {e}", path.display()))?),
        None => cmd.stdin(Stdio::null()),
    };
    let mut child = cmd.stdout(Stdio::piped()).stderr(Stdio::piped()).spawn().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("`{name}` isn't installed or isn't on PATH")
        } else {
            format!("{name}: {e}")
        }
    })?;
    let mut out_pipe = child.stdout.take().expect("piped stdout");
    let mut err_pipe = child.stderr.take().expect("piped stderr");
    let out = thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut out_pipe, &mut s);
        s
    });
    let err = thread::spawn(move || {
        let mut s = String::new();
        let _ = std::io::Read::read_to_string(&mut err_pipe, &mut s);
        s
    });
    let started = Instant::now();
    let status = loop {
        if let Some(status) = child.try_wait().map_err(|e| e.to_string())? {
            break status;
        }
        if started.elapsed() > timeout {
            let _ = child.kill();
            let _ = child.wait();
            return Err(format!("`{name}` didn't finish within {}s", timeout.as_secs()));
        }
        thread::sleep(Duration::from_millis(20));
    };
    let (stdout, stderr) = (out.join().unwrap_or_default(), err.join().unwrap_or_default());
    if status.success() {
        Ok(stdout)
    } else {
        let detail = stderr.trim();
        Err(if detail.is_empty() { format!("`{name}` exited with {status}") } else { detail.to_string() })
    }
}

fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The collector to copy to a target of this architecture. An explicit override comes first,
/// then the static one built into this app. A plain sibling build is the last resort: it's
/// linked against this machine's libc, so it won't run in every container.
pub fn local_collector(tools: &Tools, arch: &str) -> Result<PathBuf, String> {
    let override_path = tools.collectors.as_ref().map(|d| d.join(arch).join("peak-collector"));
    if let Some(p) = override_path.filter(|p| p.is_file()) {
        return Ok(p);
    }
    let unpack_error = match crate::bundled::embedded_collector(arch, &tools.data_dir) {
        Some(Ok(p)) => return Ok(p),
        Some(Err(e)) => Some(format!("couldn't unpack this app's collector into {}: {e}", tools.data_dir.display())),
        None => None,
    };
    let mut beside_app = vec![];
    if let Some(dir) = std::env::current_exe().ok().as_deref().and_then(Path::parent) {
        beside_app.push(dir.join("collectors").join(arch).join("peak-collector"));
        if arch == std::env::consts::ARCH {
            beside_app.push(dir.join("peak-collector"));
        }
    }
    if let Some(p) = beside_app.into_iter().find(|p| p.is_file()) {
        return Ok(p);
    }
    Err(unpack_error.unwrap_or_else(|| missing_collector(arch, crate::bundled::embedded_arch())))
}

/// Why there's no collector, and what can be done about it.
fn missing_collector(arch: &str, included: Option<&str>) -> String {
    let has = match included {
        Some(other) => format!("This app only includes one for {other}."),
        None => "This build of Peak doesn't include one; check its build output for why.".to_string(),
    };
    format!(
        "no peak-collector build for {arch} is available. {has} Detailed monitoring on this target needs one: \
         put a static build at $PEAK_COLLECTORS/{arch}/peak-collector, or prepare it on the target. \
         Container totals and logs still work without it."
    )
}

fn normalize_arch(machine: &str) -> String {
    match machine.trim() {
        "arm64" => "aarch64".to_string(),
        "amd64" => "x86_64".to_string(),
        other => other.to_string(),
    }
}

/// How to run something on a target.
fn exec_command(tools: &Tools, spec: &TargetSpec, argv: &[String], interactive: bool) -> Result<Command, String> {
    match spec.kind {
        Some(TargetKind::Ssh) => {
            if spec.host.is_empty() {
                return Err("no SSH host was given".into());
            }
            let mut c = Command::new(&tools.ssh);
            // -T: structured data needs no terminal. BatchMode: never hang on a password prompt.
            c.args(["-T", "-o", "BatchMode=yes", "-o", "ServerAliveInterval=5", "-o", "ServerAliveCountMax=3"]);
            c.args(&tools.ssh_options);
            if let Some(p) = spec.port {
                c.arg("-p").arg(p.to_string());
            }
            c.arg("--").arg(&spec.host);
            // ssh hands the command to a remote shell, so quote it; ~ stays expandable.
            let line: Vec<String> = argv
                .iter()
                .map(|a| a.strip_prefix("~/").map_or_else(|| shell_quote(a), |rest| format!("~/{}", shell_quote(rest))))
                .collect();
            c.arg(line.join(" "));
            Ok(c)
        }
        Some(TargetKind::Docker) => {
            if spec.container.is_empty() {
                return Err("no container was chosen".into());
            }
            let mut c = Command::new(&tools.docker);
            if !spec.context.is_empty() {
                c.arg("--context").arg(&spec.context);
            }
            c.arg("exec");
            if interactive {
                c.arg("-i");
            }
            c.arg(&spec.container).args(argv);
            Ok(c)
        }
        Some(TargetKind::Kubernetes) => {
            if spec.container.is_empty() {
                return Err("no pod was chosen".into());
            }
            let mut c = kubectl(tools, spec);
            c.arg("exec");
            if interactive {
                c.arg("-i");
            }
            c.arg(&spec.container);
            if !spec.pod_container.is_empty() {
                c.arg("-c").arg(&spec.pod_container);
            }
            c.arg("--").args(argv);
            Ok(c)
        }
        Some(TargetKind::Local) | None => Err("this target has no transport".into()),
    }
}

fn kubectl(tools: &Tools, spec: &TargetSpec) -> Command {
    let mut c = Command::new(&tools.kubectl);
    if !spec.context.is_empty() {
        c.arg("--context").arg(&spec.context);
    }
    if !spec.namespace.is_empty() {
        c.arg("-n").arg(&spec.namespace);
    }
    c
}

/// Where the collector goes when the user didn't say.
fn default_collector_path(spec: &TargetSpec) -> String {
    match spec.kind {
        Some(TargetKind::Ssh) => format!("~/.local/share/peak/collector/{COLLECTOR_VERSION}/peak-collector"),
        // One level only: minimal images may have /tmp but no mkdir.
        _ => "/tmp/peak-collector".to_string(),
    }
}

fn collector_path(spec: &TargetSpec) -> String {
    if spec.collector_path.is_empty() { default_collector_path(spec) } else { spec.collector_path.clone() }
}

fn collector_ready(tools: &Tools, spec: &TargetSpec, path: &str) -> Result<bool, String> {
    let c = exec_command(tools, spec, &[path.to_string(), "version".to_string()], false)?;
    match run(c, COMMAND_TIMEOUT, None) {
        Ok(out) => Ok(out.starts_with(COLLECTOR_VERSION) && out.trim_end().ends_with(&format!("protocol {VERSION}"))),
        Err(e) => {
            // Couldn't reach the target at all: that's the real problem, not a missing file.
            if spec.kind == Some(TargetKind::Ssh) && is_ssh_failure(&e) { Err(e) } else { Ok(false) }
        }
    }
}

/// OpenSSH's own failures, as opposed to the remote command's.
fn is_ssh_failure(message: &str) -> bool {
    [
        "Permission denied",
        "Connection refused",
        "Connection timed out",
        "Could not resolve hostname",
        "Host key verification failed",
        "No route to host",
        "Connection closed",
    ]
    .iter()
    .any(|m| message.contains(m))
}

fn target_arch(tools: &Tools, spec: &TargetSpec) -> Result<String, String> {
    if spec.kind == Some(TargetKind::Docker) {
        let mut c = Command::new(&tools.docker);
        if !spec.context.is_empty() {
            c.arg("--context").arg(&spec.context);
        }
        c.args(["version", "--format", "{{.Server.Arch}}"]);
        return run(c, COMMAND_TIMEOUT, None).map(|s| normalize_arch(&s));
    }
    let c = exec_command(tools, spec, &["uname".to_string(), "-m".to_string()], false)?;
    run(c, COMMAND_TIMEOUT, None).map(|s| normalize_arch(&s))
}

/// Copy the collector over: only when the user allowed it, into a user-writable path.
fn install_collector(tools: &Tools, spec: &TargetSpec, path: &str) -> Result<(), String> {
    let arch = target_arch(tools, spec).map_err(|e| {
        format!("couldn't tell the target's architecture. A minimal image needs a collector prepared in advance. {e}")
    })?;
    let binary = local_collector(tools, &arch)?;
    match spec.kind {
        Some(TargetKind::Ssh) => {
            let dir = path.rsplit_once('/').map(|(d, _)| d).unwrap_or(".");
            let q = |p: &str| {
                if let Some(rest) = p.strip_prefix("~/") { format!("~/{}", shell_quote(rest)) } else { shell_quote(p) }
            };
            let script = format!(
                "mkdir -p {d} && cat > {p}.tmp && chmod 755 {p}.tmp && mv {p}.tmp {p}",
                d = q(dir),
                p = q(path)
            );
            let mut c = Command::new(&tools.ssh);
            c.args(["-T", "-o", "BatchMode=yes"]).args(&tools.ssh_options);
            if let Some(port) = spec.port {
                c.arg("-p").arg(port.to_string());
            }
            c.arg("--").arg(&spec.host).arg(script);
            run(c, Duration::from_secs(120), Some(&binary)).map(|_| ())
        }
        Some(TargetKind::Docker) => {
            // docker cp needs no shell inside the image. A read-only root or a stopped
            // container fails here, and the error says so; nothing else is attempted.
            let mut c = Command::new(&tools.docker);
            if !spec.context.is_empty() {
                c.arg("--context").arg(&spec.context);
            }
            c.arg("cp").arg(&binary).arg(format!("{}:{path}", spec.container));
            run(c, Duration::from_secs(120), None).map(|_| ()).map_err(|e| {
                format!("couldn't copy the collector into the container (read-only or stopped?). Container totals and logs still work. {e}")
            })
        }
        Some(TargetKind::Kubernetes) => {
            // kubectl cp needs tar in the container. When it can't, the user prepares the image.
            let mut c = kubectl(tools, spec);
            c.arg("cp").arg(&binary);
            c.arg(format!("{}:{path}", spec.container));
            if !spec.pod_container.is_empty() {
                c.arg("-c").arg(&spec.pod_container);
            }
            run(c, Duration::from_secs(120), None)
                .map_err(|e| format!("couldn't copy the collector (kubectl cp needs tar in the container): {e}"))?;
            let chmod = exec_command(tools, spec, &["chmod".to_string(), "755".to_string(), path.to_string()], false)?;
            run(chmod, COMMAND_TIMEOUT, None).map(|_| ())
        }
        _ => Err("this target has no transport".into()),
    }
}

/// A pod name can come back as a different pod. This one's UID must match.
fn verify_pod(tools: &Tools, spec: &TargetSpec) -> Result<(), String> {
    if spec.pod_uid.is_empty() {
        return Ok(());
    }
    let mut c = kubectl(tools, spec);
    c.args(["get", "pod", &spec.container, "-o", "jsonpath={.metadata.uid}"]);
    let uid = run(c, COMMAND_TIMEOUT, None)?;
    if uid.trim() == spec.pod_uid {
        Ok(())
    } else {
        Err(format!(
            "pod {} was replaced (it was {}, it is now {}). Choose the new pod to monitor it",
            spec.container,
            spec.pod_uid,
            uid.trim()
        ))
    }
}

/// Connects by running the collector through the user's CLI tools.
pub struct CliConnector {
    pub tools: Tools,
}

impl Connector for CliConnector {
    fn connect(&self, spec: &TargetSpec) -> Result<Link, String> {
        let tools = &self.tools;
        if spec.kind == Some(TargetKind::Kubernetes) {
            verify_pod(tools, spec)?;
        }
        let path = collector_path(spec);
        if !collector_ready(tools, spec, &path)? {
            if !spec.install {
                return Err(format!(
                    "no compatible collector at {path}. Prepare it on the target, or allow peak to copy it there"
                ));
            }
            install_collector(tools, spec, &path)?;
            if !collector_ready(tools, spec, &path)? {
                return Err(format!(
                    "the collector was copied to {path} but won't run there (blocked execution, or an incompatible image)"
                ));
            }
        }
        let mut cmd = exec_command(tools, spec, &[path, "serve".to_string()], true)?;
        let mut child = cmd
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|e| format!("{}: {e}", cmd.get_program().to_string_lossy()))?;
        let reader = child.stdout.take().expect("piped stdout");
        let writer = child.stdin.take().expect("piped stdin");
        let stderr = child.stderr.take().expect("piped stderr");
        let diagnostics = Arc::new(Mutex::new(String::new()));
        let d = diagnostics.clone();
        thread::spawn(move || {
            peak_core::runner::pump_lines(stderr, |line| {
                let mut s = d.lock().unwrap();
                // Keep only the most recent words from the transport.
                if s.len() > 4000 {
                    s.clear();
                }
                s.push_str(&line);
                s.push('\n');
            });
        });
        let child = Arc::new(Mutex::new(Some(child)));
        Ok(Link {
            reader: Box::new(reader),
            writer: Box::new(writer),
            close: Box::new(move || close_child(&child)),
            diagnostics,
        })
    }
}

/// End the transport client. Killing `ssh` or `kubectl` isn't a remote cancellation:
/// the collector on the far side notices its stdin close, then follows its contract.
fn close_child(child: &Mutex<Option<Child>>) {
    if let Some(mut c) = child.lock().unwrap().take() {
        let _ = c.kill();
        let _ = c.wait();
    }
}

// ─── discovery, without a collector ─────────────────────────────────────────

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct DockerContainer {
    pub id: String,
    pub name: String,
    pub image: String,
    pub state: String,
    pub status: String,
}

/// Container-wide figures from `docker stats`. A different series from a process tree.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerTotals {
    pub cpu_percent: Option<f64>,
    pub memory_used: Option<f64>,
    pub memory_limit: Option<f64>,
    pub pids: Option<u64>,
    pub raw_net: String,
    pub raw_block: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct ContainerProcess {
    /// As the daemon sees it. Not the PID inside the container.
    pub pid: String,
    pub user: String,
    pub command: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KubeContainer {
    pub name: String,
    pub ready: bool,
    pub state: String,
    pub restarts: u64,
    pub container_id: String,
}

#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KubePod {
    pub name: String,
    pub uid: String,
    pub namespace: String,
    pub phase: String,
    pub node: String,
    pub containers: Vec<KubeContainer>,
}

/// CPU and memory for one container, from the optional metrics API.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KubeMetrics {
    pub container: String,
    pub cpu: String,
    pub memory: String,
}

/// What a set of permissions allows, asked of the cluster rather than assumed.
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq, Default)]
#[serde(rename_all = "camelCase")]
pub struct KubeAccess {
    pub list_pods: bool,
    pub read_logs: bool,
    pub exec: bool,
}

/// Parse a size like "1.5GiB", "20MB" or "512B" as docker prints it.
pub fn parse_size(s: &str) -> Option<f64> {
    let s = s.trim();
    let split = s.find(|c: char| !c.is_ascii_digit() && c != '.')?;
    let (num, unit) = s.split_at(split);
    let n: f64 = num.parse().ok()?;
    let k = match unit.trim() {
        "B" | "b" => 1.0,
        "kB" | "KB" | "kb" => 1e3,
        "MB" | "mb" => 1e6,
        "GB" | "gb" => 1e9,
        "TB" | "tb" => 1e12,
        "KiB" => 1024.0,
        "MiB" => 1024.0_f64.powi(2),
        "GiB" => 1024.0_f64.powi(3),
        "TiB" => 1024.0_f64.powi(4),
        _ => return None,
    };
    Some(n * k)
}

pub fn parse_docker_ps(out: &str) -> Vec<DockerContainer> {
    out.lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
        .map(|v| {
            let s = |k: &str| v[k].as_str().unwrap_or_default().to_string();
            DockerContainer { id: s("ID"), name: s("Names"), image: s("Image"), state: s("State"), status: s("Status") }
        })
        .collect()
}

pub fn parse_docker_stats(out: &str) -> Option<ContainerTotals> {
    let v: Value = serde_json::from_str(out.lines().next()?).ok()?;
    let s = |k: &str| v[k].as_str().unwrap_or_default();
    let (used, limit) = s("MemUsage").split_once(" / ").unwrap_or(("", ""));
    Some(ContainerTotals {
        cpu_percent: s("CPUPerc").trim_end_matches('%').parse().ok(),
        memory_used: parse_size(used),
        memory_limit: parse_size(limit),
        pids: s("PIDs").parse().ok(),
        raw_net: s("NetIO").to_string(),
        raw_block: s("BlockIO").to_string(),
    })
}

/// `docker top` columns vary with the host's ps; find them by header.
pub fn parse_docker_top(out: &str) -> Vec<ContainerProcess> {
    let mut lines = out.lines();
    let Some(header) = lines.next() else { return vec![] };
    let columns: Vec<&str> = header.split_whitespace().collect();
    let pid = columns.iter().position(|c| *c == "PID");
    let user = columns.iter().position(|c| *c == "UID" || *c == "USER");
    let Some(cmd) = columns.iter().position(|c| *c == "CMD" || *c == "COMMAND") else { return vec![] };
    lines
        .filter_map(|line| {
            let mut fields: Vec<&str> = line.split_whitespace().collect();
            if fields.len() <= cmd {
                return None;
            }
            let command = fields.split_off(cmd).join(" ");
            Some(ContainerProcess {
                pid: pid.and_then(|i| fields.get(i)).unwrap_or(&"").to_string(),
                user: user.and_then(|i| fields.get(i)).unwrap_or(&"").to_string(),
                command,
            })
        })
        .collect()
}

pub fn parse_pods(out: &str) -> Result<Vec<KubePod>, String> {
    let v: Value = serde_json::from_str(out).map_err(|e| format!("couldn't read kubectl's output: {e}"))?;
    let items = v["items"].as_array().cloned().unwrap_or_default();
    Ok(items
        .iter()
        .map(|p| {
            let meta = &p["metadata"];
            let status = &p["status"];
            let statuses = status["containerStatuses"].as_array().cloned().unwrap_or_default();
            let containers = p["spec"]["containers"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|c| {
                    let name = c["name"].as_str().unwrap_or_default().to_string();
                    let st = statuses.iter().find(|s| s["name"].as_str() == Some(&name));
                    let state = st
                        .and_then(|s| s["state"].as_object())
                        .and_then(|o| o.keys().next().cloned())
                        .unwrap_or_else(|| "unknown".into());
                    KubeContainer {
                        ready: st.and_then(|s| s["ready"].as_bool()).unwrap_or(false),
                        restarts: st.and_then(|s| s["restartCount"].as_u64()).unwrap_or(0),
                        container_id: st.and_then(|s| s["containerID"].as_str()).unwrap_or_default().to_string(),
                        state,
                        name,
                    }
                })
                .collect();
            KubePod {
                name: meta["name"].as_str().unwrap_or_default().to_string(),
                uid: meta["uid"].as_str().unwrap_or_default().to_string(),
                namespace: meta["namespace"].as_str().unwrap_or_default().to_string(),
                phase: status["phase"].as_str().unwrap_or_default().to_string(),
                node: p["spec"]["nodeName"].as_str().unwrap_or_default().to_string(),
                containers,
            }
        })
        .collect())
}

/// `kubectl top pod --containers --no-headers`: POD CONTAINER CPU MEMORY.
pub fn parse_kube_top(out: &str, pod: &str) -> Vec<KubeMetrics> {
    out.lines()
        .filter_map(|l| {
            let f: Vec<&str> = l.split_whitespace().collect();
            (f.len() >= 4 && f[0] == pod).then(|| KubeMetrics {
                container: f[1].into(),
                cpu: f[2].into(),
                memory: f[3].into(),
            })
        })
        .collect()
}

fn docker(tools: &Tools, context: &str) -> Command {
    let mut c = Command::new(&tools.docker);
    if !context.is_empty() {
        c.arg("--context").arg(context);
    }
    c
}

pub fn docker_contexts(tools: &Tools) -> Result<Vec<String>, String> {
    let mut c = Command::new(&tools.docker);
    c.args(["context", "ls", "--format", "{{.Name}}"]);
    Ok(run(c, COMMAND_TIMEOUT, None)?.lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
}

pub fn docker_containers(tools: &Tools, context: &str) -> Result<Vec<DockerContainer>, String> {
    let mut c = docker(tools, context);
    c.args(["ps", "-a", "--no-trunc", "--format", "{{json .}}"]);
    Ok(parse_docker_ps(&run(c, COMMAND_TIMEOUT, None)?))
}

pub fn docker_totals(tools: &Tools, context: &str, id: &str) -> Result<Option<ContainerTotals>, String> {
    let mut c = docker(tools, context);
    c.args(["stats", "--no-stream", "--format", "{{json .}}", id]);
    Ok(parse_docker_stats(&run(c, COMMAND_TIMEOUT, None)?))
}

pub fn docker_top(tools: &Tools, context: &str, id: &str) -> Result<Vec<ContainerProcess>, String> {
    let mut c = docker(tools, context);
    c.args(["top", id]);
    Ok(parse_docker_top(&run(c, COMMAND_TIMEOUT, None)?))
}

/// Recent lines the daemon recorded. Their availability depends on the logging driver.
pub fn docker_logs(tools: &Tools, context: &str, id: &str, tail: u32) -> Result<String, String> {
    let mut c = docker(tools, context);
    c.args(["logs", "--timestamps", "--tail", &tail.to_string(), id]);
    combined(c)
}

/// stdout and stderr together: container platforms send workload output to both.
fn combined(mut cmd: Command) -> Result<String, String> {
    let out = cmd.stdin(Stdio::null()).output().map_err(|e| {
        if e.kind() == std::io::ErrorKind::NotFound {
            format!("`{}` isn't installed or isn't on PATH", cmd.get_program().to_string_lossy())
        } else {
            e.to_string()
        }
    })?;
    let text = format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr));
    if out.status.success() { Ok(text) } else { Err(text.trim().to_string()) }
}

pub fn kube_contexts(tools: &Tools) -> Result<Vec<String>, String> {
    let mut c = Command::new(&tools.kubectl);
    c.args(["config", "get-contexts", "-o", "name"]);
    Ok(run(c, COMMAND_TIMEOUT, None)?.lines().map(str::to_string).filter(|s| !s.is_empty()).collect())
}

pub fn kube_namespaces(tools: &Tools, context: &str) -> Result<Vec<String>, String> {
    let spec = TargetSpec { context: context.into(), ..Default::default() };
    let mut c = kubectl(tools, &spec);
    c.args(["get", "namespaces", "-o", "jsonpath={.items[*].metadata.name}"]);
    Ok(run(c, COMMAND_TIMEOUT, None)?.split_whitespace().map(str::to_string).collect())
}

pub fn kube_pods(tools: &Tools, context: &str, namespace: &str) -> Result<Vec<KubePod>, String> {
    let spec = TargetSpec { context: context.into(), namespace: namespace.into(), ..Default::default() };
    let mut c = kubectl(tools, &spec);
    c.args(["get", "pods", "-o", "json"]);
    parse_pods(&run(c, COMMAND_TIMEOUT, None)?)
}

pub fn kube_logs(
    tools: &Tools,
    context: &str,
    namespace: &str,
    pod: &str,
    container: &str,
    tail: u32,
) -> Result<String, String> {
    let spec = TargetSpec { context: context.into(), namespace: namespace.into(), ..Default::default() };
    let mut c = kubectl(tools, &spec);
    c.args(["logs", "--timestamps", &format!("--tail={tail}"), pod, "-c", container]);
    combined(c)
}

/// Optional: `Ok(None)` when the cluster has no metrics API, which is not an error.
/// `Ok(Some(empty))` when it has one but no measurement for this pod: the API answers
/// NotFound then, even though the pod exists, and new pods can stay that way for minutes.
pub fn kube_metrics(
    tools: &Tools,
    context: &str,
    namespace: &str,
    pod: &str,
) -> Result<Option<Vec<KubeMetrics>>, String> {
    let spec = TargetSpec { context: context.into(), namespace: namespace.into(), ..Default::default() };
    let mut c = kubectl(tools, &spec);
    c.args(["top", "pod", pod, "--containers", "--no-headers"]);
    match run(c, COMMAND_TIMEOUT, None) {
        Ok(out) => Ok(Some(parse_kube_top(&out, pod))),
        Err(e)
            if e.contains("Metrics API not available")
                || e.contains("metrics.k8s.io")
                || e.contains("could not find the requested resource") =>
        {
            Ok(None)
        }
        Err(e) if e.contains("(NotFound)") => Ok(Some(vec![])),
        Err(e) => Err(e),
    }
}

/// Ask rather than assume; the answer decides which actions make sense.
pub fn kube_access(tools: &Tools, context: &str, namespace: &str) -> KubeAccess {
    // Subresources need --subresource: "pods/log" would ask about a pod named "log".
    let can = |verb: &str, subresource: Option<&str>| {
        let spec = TargetSpec { context: context.into(), namespace: namespace.into(), ..Default::default() };
        let mut c = kubectl(tools, &spec);
        c.args(["auth", "can-i", verb, "pods"]);
        if let Some(sub) = subresource {
            c.arg(format!("--subresource={sub}"));
        }
        run(c, COMMAND_TIMEOUT, None).is_ok_and(|s| s.trim() == "yes")
    };
    KubeAccess { list_pods: can("list", None), read_logs: can("get", Some("log")), exec: can("create", Some("exec")) }
}

/// Feed a payload to a process's stdin and wait (test helper for fake tools).
#[doc(hidden)]
pub fn pipe_to(mut cmd: Command, payload: &[u8]) -> std::io::Result<String> {
    let mut child = cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).spawn()?;
    child.stdin.take().expect("piped stdin").write_all(payload)?;
    let out = child.wait_with_output()?;
    Ok(String::from_utf8_lossy(&out.stdout).into_owned())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::os::unix::fs::PermissionsExt;

    /// A stand-in CLI: records its arguments and runs a script.
    fn fake(dir: &Path, name: &str, script: &str) -> String {
        let path = dir.join(name);
        let log = dir.join(format!("{name}.log"));
        std::fs::write(&path, format!("#!/bin/sh\necho \"$@\" >> {}\n{script}\n", log.display())).unwrap();
        std::fs::set_permissions(&path, std::fs::Permissions::from_mode(0o755)).unwrap();
        path.display().to_string()
    }

    fn calls(dir: &Path, name: &str) -> String {
        std::fs::read_to_string(dir.join(format!("{name}.log"))).unwrap_or_default()
    }

    fn ssh_spec() -> TargetSpec {
        TargetSpec {
            id: "t".into(),
            kind: Some(TargetKind::Ssh),
            host: "me@box".into(),
            port: Some(2222),
            ..Default::default()
        }
    }

    fn argv(c: &Command) -> Vec<String> {
        c.get_args().map(|a| a.to_string_lossy().into_owned()).collect()
    }

    #[test]
    fn ssh_commands_use_no_tty_and_never_prompt() {
        let tools = Tools { ssh_options: vec!["-F".into(), "/x".into()], ..Default::default() };
        let c = exec_command(&tools, &ssh_spec(), &["~/a b/c".to_string(), "serve".to_string()], true).unwrap();
        assert_eq!(c.get_program(), "ssh");
        let a = argv(&c);
        assert_eq!(a[0], "-T");
        assert!(a.iter().any(|x| x == "BatchMode=yes"));
        assert!(a.windows(2).any(|w| w[0] == "-p" && w[1] == "2222"));
        assert!(a.windows(2).any(|w| w[0] == "-F" && w[1] == "/x"));
        assert!(a.windows(2).any(|w| w[0] == "--" && w[1] == "me@box"), "a host can't be read as an option");
        assert_eq!(a.last().unwrap(), "~/'a b/c' 'serve'");
        let no_host = TargetSpec { host: String::new(), ..ssh_spec() };
        assert!(exec_command(&tools, &no_host, &[], true).is_err());
    }

    #[test]
    fn docker_exec_selects_context_per_invocation_and_stays_off_the_tty() {
        let tools = Tools::default();
        let spec = TargetSpec {
            kind: Some(TargetKind::Docker),
            context: "prod".into(),
            container: "abc".into(),
            ..Default::default()
        };
        let a = argv(&exec_command(&tools, &spec, &["/c".to_string(), "serve".to_string()], true).unwrap());
        assert_eq!(a, ["--context", "prod", "exec", "-i", "abc", "/c", "serve"]);
        assert!(!a.iter().any(|x| x == "-t" || x == "--privileged"));
        let quiet = TargetSpec { context: String::new(), ..spec.clone() };
        assert_eq!(argv(&exec_command(&tools, &quiet, &["/c".to_string()], false).unwrap()), ["exec", "abc", "/c"]);
        let none = TargetSpec { container: String::new(), ..spec };
        assert!(exec_command(&tools, &none, &[], true).is_err());
    }

    #[test]
    fn kubectl_exec_names_context_namespace_pod_and_container() {
        let tools = Tools::default();
        let spec = TargetSpec {
            kind: Some(TargetKind::Kubernetes),
            context: "kind".into(),
            namespace: "web".into(),
            container: "pod-1".into(),
            pod_container: "app".into(),
            ..Default::default()
        };
        let a = argv(&exec_command(&tools, &spec, &["/c".to_string(), "serve".to_string()], true).unwrap());
        assert_eq!(a, ["--context", "kind", "-n", "web", "exec", "-i", "pod-1", "-c", "app", "--", "/c", "serve"]);
        let bare = TargetSpec { kind: Some(TargetKind::Kubernetes), container: "p".into(), ..Default::default() };
        assert_eq!(argv(&exec_command(&tools, &bare, &["/c".to_string()], false).unwrap()), ["exec", "p", "--", "/c"]);
        let none = TargetSpec { kind: Some(TargetKind::Kubernetes), ..Default::default() };
        assert!(exec_command(&tools, &none, &[], true).is_err());
        assert!(exec_command(&tools, &TargetSpec::default(), &[], true).is_err());
    }

    #[test]
    fn prepared_targets_are_not_touched_without_permission() {
        let d = tempfile::tempdir().unwrap();
        let ssh = fake(d.path(), "ssh", "exit 127");
        let c = CliConnector { tools: Tools { ssh, ..Default::default() } };
        let e = c.connect(&ssh_spec()).err().unwrap();
        assert!(e.contains("no compatible collector"), "{e}");
        assert!(!calls(d.path(), "ssh").contains("cat >"), "nothing was installed");
    }

    #[test]
    fn transport_failures_are_reported_as_such() {
        let d = tempfile::tempdir().unwrap();
        let ssh = fake(d.path(), "ssh", "echo 'ssh: connect to host box port 22: Connection refused' >&2; exit 255");
        let c = CliConnector { tools: Tools { ssh, ..Default::default() } };
        let e = c.connect(&ssh_spec()).err().unwrap();
        assert!(e.contains("Connection refused"), "not a missing collector: {e}");
        let missing = CliConnector { tools: Tools { ssh: "/no/such/ssh".into(), ..Default::default() } };
        let e = missing.connect(&ssh_spec()).err().unwrap();
        assert!(e.contains("no compatible collector"), "{e}");
    }

    #[test]
    fn installs_the_right_architecture_when_allowed() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("collectors");
        std::fs::create_dir_all(store.join("aarch64")).unwrap();
        std::fs::write(store.join("aarch64/peak-collector"), "binary").unwrap();
        let marker = d.path().join("installed");
        let script = format!(
            "case \"$*\" in\n  *uname*) echo arm64;;\n  *'cat >'*) cat > {m};;\n  *version*) test -f {m} || exit 127; echo '{COLLECTOR_VERSION} protocol {VERSION}';;\n  *serve*) cat;;\nesac",
            m = marker.display()
        );
        let ssh = fake(d.path(), "ssh", &script);
        let tools = Tools { ssh, collectors: Some(store), ..Default::default() };
        let c = CliConnector { tools };
        let spec = TargetSpec { install: true, ..ssh_spec() };
        let Ok(link) = c.connect(&spec) else { panic!("should connect") };
        assert_eq!(std::fs::read_to_string(&marker).unwrap(), "binary");
        let log = calls(d.path(), "ssh");
        assert!(log.contains("mkdir -p ~/'.local/share/peak/collector"), "{log}");
        (link.close)();
    }

    #[test]
    fn missing_or_broken_collectors_say_what_is_wrong() {
        let d = tempfile::tempdir().unwrap();
        // Copying "works" but the binary never runs, as with noexec or a wrong libc.
        let ssh = fake(
            d.path(),
            "ssh",
            "case \"$*\" in *uname*) echo x86_64;; *'cat >'*) cat >/dev/null;; *) exit 126;; esac",
        );
        let store = d.path().join("c");
        std::fs::create_dir_all(store.join("x86_64")).unwrap();
        std::fs::write(store.join("x86_64/peak-collector"), "b").unwrap();
        let c = CliConnector { tools: Tools { ssh: ssh.clone(), collectors: Some(store), ..Default::default() } };
        let spec = TargetSpec { install: true, ..ssh_spec() };
        assert!(c.connect(&spec).err().unwrap().contains("won't run there"));

        // A target architecture we have no build for.
        let d2 = tempfile::tempdir().unwrap();
        let ssh = fake(d2.path(), "ssh", "case \"$*\" in *uname*) echo riscv64;; *) exit 127;; esac");
        let c = CliConnector { tools: Tools { ssh, collectors: None, ..Default::default() } };
        assert!(c.connect(&spec).err().unwrap().contains("no peak-collector build for riscv64"));

        // Architecture can't be read at all.
        let d3 = tempfile::tempdir().unwrap();
        let ssh = fake(d3.path(), "ssh", "exit 127");
        let c = CliConnector { tools: Tools { ssh, ..Default::default() } };
        assert!(c.connect(&spec).err().unwrap().contains("architecture"));
    }

    #[test]
    fn docker_install_uses_docker_cp_and_reports_read_only_images() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("c");
        std::fs::create_dir_all(store.join("x86_64")).unwrap();
        std::fs::write(store.join("x86_64/peak-collector"), "b").unwrap();
        let docker = fake(
            d.path(),
            "docker",
            "case \"$*\" in\n  *Server.Arch*) echo amd64;;\n  *' cp '*) echo 'read-only file system' >&2; exit 1;;\n  *) exit 127;;\nesac",
        );
        let spec = TargetSpec {
            kind: Some(TargetKind::Docker),
            context: "c1".into(),
            container: "abc".into(),
            install: true,
            ..Default::default()
        };
        let c = CliConnector { tools: Tools { docker, collectors: Some(store), ..Default::default() } };
        let e = c.connect(&spec).err().unwrap();
        assert!(e.contains("read-only"), "{e}");
        let log = calls(d.path(), "docker");
        assert!(log.contains("--context c1 cp"), "{log}");
        assert!(!log.contains("--privileged") && !log.contains("docker.sock"));
    }

    #[test]
    fn kubernetes_install_explains_tar_and_a_replaced_pod_is_refused() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("c");
        std::fs::create_dir_all(store.join("x86_64")).unwrap();
        std::fs::write(store.join("x86_64/peak-collector"), "b").unwrap();
        let kubectl = fake(
            d.path(),
            "kubectl",
            "case \"$*\" in\n  *uid*) printf new-uid;;\n  *uname*) echo x86_64;;\n  *' cp '*) echo 'tar: not found' >&2; exit 1;;\n  *) exit 127;;\nesac",
        );
        let c = CliConnector { tools: Tools { kubectl, collectors: Some(store), ..Default::default() } };
        let spec = TargetSpec {
            kind: Some(TargetKind::Kubernetes),
            container: "pod-1".into(),
            pod_container: "app".into(),
            namespace: "web".into(),
            pod_uid: "old-uid".into(),
            install: true,
            ..Default::default()
        };
        let e = c.connect(&spec).err().unwrap();
        assert!(e.contains("was replaced") && e.contains("old-uid") && e.contains("new-uid"), "{e}");
        let same = TargetSpec { pod_uid: "new-uid".into(), ..spec.clone() };
        let e = c.connect(&same).err().unwrap();
        assert!(e.contains("needs tar"), "{e}");
        let none = TargetSpec { pod_uid: String::new(), ..spec };
        assert!(c.connect(&none).is_err());
    }

    #[test]
    fn the_transport_s_own_words_are_kept_for_diagnostics() {
        let d = tempfile::tempdir().unwrap();
        let ssh = fake(
            d.path(),
            "ssh",
            &format!(
                "case \"$*\" in *version*) echo '{COLLECTOR_VERSION} protocol {VERSION}';; *serve*) echo 'bad thing' >&2; cat;; esac"
            ),
        );
        let c = CliConnector { tools: Tools { ssh, ..Default::default() } };
        let Ok(link) = c.connect(&ssh_spec()) else { panic!("should connect") };
        let seen = (0..200).any(|_| {
            thread::sleep(Duration::from_millis(10));
            link.diagnostics.lock().unwrap().contains("bad thing")
        });
        assert!(seen);
        (link.close)();
    }

    #[test]
    fn kubernetes_install_copies_then_makes_it_executable() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("c");
        std::fs::create_dir_all(store.join("x86_64")).unwrap();
        std::fs::write(store.join("x86_64/peak-collector"), "b").unwrap();
        let marker = d.path().join("copied");
        let kubectl = fake(
            d.path(),
            "kubectl",
            &format!(
                "case \" $*\" in\n  *uname*) echo x86_64;;\n  *' cp '*) touch {m};;\n  *chmod*) ;;\n  *version*) test -f {m} || exit 127; echo '{COLLECTOR_VERSION} protocol {VERSION}';;\n  *serve*) cat;;\nesac",
                m = marker.display()
            ),
        );
        let spec = TargetSpec {
            kind: Some(TargetKind::Kubernetes),
            container: "p".into(),
            pod_container: "app".into(),
            install: true,
            ..Default::default()
        };
        let c = CliConnector { tools: Tools { kubectl, collectors: Some(store), ..Default::default() } };
        let Ok(link) = c.connect(&spec) else { panic!("should connect") };
        assert!(calls(d.path(), "kubectl").contains("chmod 755 /tmp/peak-collector"));
        (link.close)();
    }

    /// An override wins, for testing other builds. Without one, an ordinary build of the app
    /// finds its own collector: no environment, no prebuilt file.
    #[test]
    fn collector_lookup_needs_nothing_beyond_the_app() {
        let d = tempfile::tempdir().unwrap();
        let store = d.path().join("store");
        std::fs::create_dir_all(store.join("x86_64")).unwrap();
        let chosen = store.join("x86_64/peak-collector");
        std::fs::write(&chosen, "b").unwrap();
        let data = d.path().join("data");
        let with = Tools { collectors: Some(store), data_dir: data.clone(), ..Default::default() };
        assert_eq!(local_collector(&with, "x86_64").unwrap(), chosen);

        let without = Tools { collectors: None, data_dir: data.clone(), ..Default::default() };
        assert!(local_collector(&without, "riscv64").unwrap_err().contains("riscv64"));
        #[cfg(peak_embedded_collector)]
        {
            let arch = crate::bundled::embedded_arch().unwrap();
            let found = local_collector(&without, arch).unwrap();
            assert!(found.starts_with(&data), "unpacked from the app itself: {found:?}");

            // An unusable data directory is reported as what it is, not as a missing build.
            let file = d.path().join("a-file");
            std::fs::write(&file, "").unwrap();
            let blocked = Tools { collectors: None, data_dir: file, ..Default::default() };
            assert!(local_collector(&blocked, arch).unwrap_err().contains("couldn't unpack"));
        }
    }

    #[test]
    fn custom_collector_paths_and_default_locations() {
        assert!(default_collector_path(&ssh_spec()).starts_with("~/.local/share/peak/collector/"));
        let docker = TargetSpec { kind: Some(TargetKind::Docker), ..Default::default() };
        assert_eq!(default_collector_path(&docker), "/tmp/peak-collector");
        let custom = TargetSpec { collector_path: "/opt/c".into(), ..ssh_spec() };
        assert_eq!(collector_path(&custom), "/opt/c");
    }

    #[test]
    fn parses_docker_output() {
        let ps = r#"{"ID":"abc","Names":"web","Image":"nginx","State":"running","Status":"Up 2 hours"}
not json
"#;
        let c = parse_docker_ps(ps);
        assert_eq!(c.len(), 1);
        assert_eq!((c[0].id.as_str(), c[0].name.as_str(), c[0].state.as_str()), ("abc", "web", "running"));

        let stats =
            r#"{"CPUPerc":"12.5%","MemUsage":"1.5GiB / 2GiB","PIDs":"7","NetIO":"1kB / 2kB","BlockIO":"0B / 0B"}"#;
        let t = parse_docker_stats(stats).unwrap();
        assert_eq!(t.cpu_percent, Some(12.5));
        assert_eq!(t.memory_used, Some(1.5 * 1024.0_f64.powi(3)));
        assert_eq!(t.memory_limit, Some(2.0 * 1024.0_f64.powi(3)));
        assert_eq!(t.pids, Some(7));
        assert_eq!(t.raw_net, "1kB / 2kB");
        assert_eq!(parse_docker_stats(""), None);
        assert_eq!(parse_docker_stats("nope"), None);
        let blank = parse_docker_stats(r#"{"CPUPerc":"--","MemUsage":"-- / --","PIDs":"--"}"#).unwrap();
        assert_eq!((blank.cpu_percent, blank.memory_used, blank.pids), (None, None, None), "unknown stays unknown");

        let top = "UID PID PPID C STIME TTY TIME CMD\nroot 42 1 0 10:00 ? 00:00:00 nginx: master process\nshort\n";
        let p = parse_docker_top(top);
        assert_eq!(
            p,
            vec![ContainerProcess { pid: "42".into(), user: "root".into(), command: "nginx: master process".into() }]
        );
        assert!(parse_docker_top("").is_empty());
        assert!(parse_docker_top("UID PID\nroot 1\n").is_empty(), "no command column, nothing to show");
        let odd = parse_docker_top("COMMAND\nsh\n");
        assert_eq!(odd[0], ContainerProcess { pid: String::new(), user: String::new(), command: "sh".into() });
    }

    #[test]
    fn parses_sizes() {
        for (s, want) in [
            ("512B", 512.0),
            ("1kB", 1e3),
            ("1KB", 1e3),
            ("2MB", 2e6),
            ("3GB", 3e9),
            ("1TB", 1e12),
            ("1KiB", 1024.0),
            ("1MiB", 1048576.0),
            ("1TiB", 1099511627776.0),
        ] {
            assert_eq!(parse_size(s), Some(want), "{s}");
        }
        for s in ["", "12", "abc", "1XB", "--"] {
            assert_eq!(parse_size(s), None, "{s}");
        }
    }

    #[test]
    fn parses_kubernetes_output() {
        let pods = r#"{"items":[{"metadata":{"name":"p1","uid":"u1","namespace":"web"},
          "spec":{"nodeName":"n1","containers":[{"name":"app"},{"name":"side"}]},
          "status":{"phase":"Running","containerStatuses":[
            {"name":"app","ready":true,"restartCount":2,"containerID":"containerd://x","state":{"running":{}}}]}}]}"#;
        let p = parse_pods(pods).unwrap();
        assert_eq!((p[0].name.as_str(), p[0].uid.as_str(), p[0].phase.as_str()), ("p1", "u1", "Running"));
        let app = &p[0].containers[0];
        assert_eq!((app.ready, app.restarts, app.state.as_str()), (true, 2, "running"));
        assert_eq!(p[0].containers[1].state, "unknown", "no status isn't a claim of running");
        assert!(parse_pods("{}").unwrap().is_empty());
        assert!(parse_pods("nope").is_err());

        let top = "p1 app 5m 20Mi\np2 app 1m 1Mi\nbad\n";
        assert_eq!(
            parse_kube_top(top, "p1"),
            vec![KubeMetrics { container: "app".into(), cpu: "5m".into(), memory: "20Mi".into() }]
        );
    }

    #[test]
    fn docker_discovery_goes_through_the_cli() {
        let d = tempfile::tempdir().unwrap();
        let docker = fake(
            d.path(),
            "docker",
            r#"case " $*" in
  *"context ls"*) printf 'default\nremote\n';;
  *" ps "*) echo '{"ID":"abc","Names":"web","Image":"i","State":"running","Status":"Up"}';;
  *" stats "*) echo '{"CPUPerc":"1%","MemUsage":"1MiB / 2MiB","PIDs":"1","NetIO":"","BlockIO":""}';;
  *" top "*) printf 'PID CMD\n7 sleep 1\n';;
  *" logs "*) echo out; echo err >&2;;
esac"#,
        );
        let t = Tools { docker, ..Default::default() };
        assert_eq!(docker_contexts(&t).unwrap(), ["default", "remote"]);
        assert_eq!(docker_containers(&t, "remote").unwrap()[0].id, "abc");
        assert!(calls(d.path(), "docker").contains("--context remote ps"));
        assert_eq!(docker_totals(&t, "", "abc").unwrap().unwrap().pids, Some(1));
        assert_eq!(docker_top(&t, "", "abc").unwrap()[0].pid, "7");
        let logs = docker_logs(&t, "", "abc", 10).unwrap();
        assert!(logs.contains("out") && logs.contains("err"), "both streams");
    }

    #[test]
    fn kubernetes_discovery_goes_through_the_cli_and_handles_optional_services() {
        let d = tempfile::tempdir().unwrap();
        let kubectl = fake(
            d.path(),
            "kubectl",
            r#"case "$*" in
  *get-contexts*) printf 'ctx\n';;
  *"get namespaces"*) printf 'default web';;
  *"get pods"*) echo '{"items":[]}';;
  *" logs "*) echo line;;
  *"can-i list pods"*) echo yes;;
  *"can-i get pods --subresource=log"*) echo no; exit 1;;
  *"can-i create pods --subresource=exec"*) echo yes;;
  *" top "*) echo 'error: Metrics API not available' >&2; exit 1;;
esac"#,
        );
        let t = Tools { kubectl, ..Default::default() };
        assert_eq!(kube_contexts(&t).unwrap(), ["ctx"]);
        assert_eq!(kube_namespaces(&t, "ctx").unwrap(), ["default", "web"]);
        assert!(kube_pods(&t, "ctx", "web").unwrap().is_empty());
        assert!(calls(d.path(), "kubectl").contains("--context ctx -n web get pods"));
        assert!(kube_logs(&t, "ctx", "web", "p", "app", 5).unwrap().contains("line"));
        assert_eq!(kube_metrics(&t, "ctx", "web", "p").unwrap(), None, "absent metrics aren't an error");
        assert_eq!(kube_access(&t, "ctx", "web"), KubeAccess { list_pods: true, read_logs: false, exec: true });

        let d2 = tempfile::tempdir().unwrap();
        let denied = fake(d2.path(), "kubectl", "echo 'Error from server (Forbidden): pods is forbidden' >&2; exit 1");
        let t = Tools { kubectl: denied, ..Default::default() };
        assert!(kube_metrics(&t, "c", "n", "p").unwrap_err().contains("Forbidden"), "denial stays visible");
        assert!(kube_pods(&t, "c", "n").unwrap_err().contains("Forbidden"));
        let d4 = tempfile::tempdir().unwrap();
        let unmeasured =
            fake(d4.path(), "kubectl", "echo 'Error from server (NotFound): pods \"p\" not found' >&2; exit 1");
        let t = Tools { kubectl: unmeasured, ..Default::default() };
        assert_eq!(
            kube_metrics(&t, "c", "n", "p").unwrap(),
            Some(vec![]),
            "no measurement isn't an error, or a missing pod"
        );
        let d3 = tempfile::tempdir().unwrap();
        let top = fake(d3.path(), "kubectl", "echo 'p app 5m 20Mi'");
        let t = Tools { kubectl: top, ..Default::default() };
        assert_eq!(kube_metrics(&t, "c", "n", "p").unwrap().unwrap().len(), 1);
    }

    #[test]
    fn commands_time_out_and_missing_tools_are_named() {
        let d = tempfile::tempdir().unwrap();
        let slow = fake(d.path(), "slow", "sleep 30");
        let e = run(Command::new(&slow), Duration::from_millis(100), None).unwrap_err();
        assert!(e.contains("didn't finish"), "{e}");
        let quiet = fake(d.path(), "quiet", "exit 3");
        assert!(run(Command::new(&quiet), COMMAND_TIMEOUT, None).unwrap_err().contains("exited with"));
        assert!(run(Command::new("/no/such"), COMMAND_TIMEOUT, None).unwrap_err().contains("isn't installed"));
        let t = Tools { docker: "/no/such".into(), kubectl: "/no/such".into(), ..Default::default() };
        assert!(docker_contexts(&t).unwrap_err().contains("isn't installed"));
        assert!(kube_contexts(&t).unwrap_err().contains("isn't installed"));
        assert!(docker_logs(&t, "", "x", 1).unwrap_err().contains("isn't installed"));
        let stdin_missing = run(Command::new(&quiet), COMMAND_TIMEOUT, Some(Path::new("/no/such/file")));
        assert!(stdin_missing.is_err());
        assert_eq!(normalize_arch("amd64\n"), "x86_64");
        assert_eq!(normalize_arch("arm64"), "aarch64");
        assert_eq!(normalize_arch("riscv64"), "riscv64");
        let other = missing_collector("aarch64", Some("x86_64"));
        assert!(
            other.contains("no peak-collector build for aarch64") && other.contains("only includes one for x86_64"),
            "{other}"
        );
        assert!(missing_collector("x86_64", None).contains("doesn't include one"));
        let Err(_) = local_collector(&Tools { collectors: Some(d.path().into()), ..Default::default() }, "nope") else {
            panic!()
        };
        assert_eq!(pipe_to(Command::new("cat"), b"x").unwrap(), "x");
    }
}
