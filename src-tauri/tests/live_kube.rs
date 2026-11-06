//! Live validation against a real Kubernetes API: a disposable single-container k3s
//! cluster named `peak-live-k3s`, created and removed by this test.
//!
//! ```sh
//! PATH=<dir with kubectl>:$PATH PEAK_COLLECTORS=<dir with x86_64/peak-collector> \
//!   cargo test --test live_kube -- --ignored --test-threads=1 --nocapture
//! ```

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::Arc;
use std::thread;
use std::time::Duration;

use peak_lib::model::*;
use peak_lib::remote::{Remote, TargetSpec, Timing};
use peak_lib::transport::{self, CliConnector, Tools};

const NAME: &str = "peak-live-k3s";
const IMAGE: &str = "rancher/k3s:v1.31.4-k3s1";

struct Cluster {
    dir: tempfile::TempDir,
}

impl Drop for Cluster {
    fn drop(&mut self) {
        let _ = sh("docker", &["rm", "-f", "-v", NAME]);
    }
}

fn sh(prog: &str, args: &[&str]) -> Result<String, String> {
    let out = Command::new(prog).args(args).stdin(Stdio::null()).output().map_err(|e| e.to_string())?;
    if out.status.success() {
        Ok(String::from_utf8_lossy(&out.stdout).into_owned())
    } else {
        Err(String::from_utf8_lossy(&out.stderr).into_owned())
    }
}

fn eventually(what: &str, secs: u64, mut f: impl FnMut() -> bool) {
    for _ in 0..secs * 2 {
        if f() {
            println!("  ok: {what}");
            return;
        }
        thread::sleep(Duration::from_millis(500));
    }
    panic!("timed out: {what}");
}

impl Cluster {
    fn start() -> Cluster {
        let _ = sh("docker", &["rm", "-f", "-v", NAME]);
        sh(
            "docker",
            &[
                "run",
                "-d",
                "--name",
                NAME,
                "--privileged",
                "-p",
                "127.0.0.1::6443",
                IMAGE,
                "server",
                "--disable=traefik,servicelb",
                "--write-kubeconfig-mode=644",
                // This cluster shares a small disk with other work; don't evict over free space.
                "--kubelet-arg=eviction-hard=nodefs.available<1%,imagefs.available<1%",
            ],
        )
        .expect("start k3s");
        let c = Cluster { dir: tempfile::tempdir().unwrap() };
        let port = sh("docker", &["port", NAME, "6443"]).unwrap();
        let port = port.lines().next().unwrap().rsplit(':').next().unwrap().to_string();
        eventually("kubeconfig written", 90, || {
            sh("docker", &["exec", NAME, "test", "-s", "/etc/rancher/k3s/k3s.yaml"]).is_ok()
        });
        let config = sh("docker", &["exec", NAME, "cat", "/etc/rancher/k3s/k3s.yaml"]).unwrap();
        let config = config.replace("127.0.0.1:6443", &format!("127.0.0.1:{port}")).replace(": default", ": peak-live");
        std::fs::write(c.kubeconfig(), config).unwrap();
        // SAFETY: set before any test threads read it; the tests run one at a time.
        unsafe { std::env::set_var("KUBECONFIG", c.kubeconfig()) };
        eventually("API up and node ready", 120, || {
            kubectl(&["get", "nodes", "--no-headers"]).is_ok_and(|o| o.contains(" Ready"))
        });
        c
    }

    fn kubeconfig(&self) -> PathBuf {
        self.dir.path().join("config")
    }
}

fn kubectl(args: &[&str]) -> Result<String, String> {
    let mut a = vec!["--context", "peak-live"];
    a.extend_from_slice(args);
    sh("kubectl", &a)
}

fn apply(yaml: &str) {
    let path = std::env::temp_dir().join(format!("peak-live-{}.yaml", std::process::id()));
    std::fs::write(&path, yaml).unwrap();
    // A new namespace's default service account appears a moment later.
    eventually("applied", 60, || kubectl(&["apply", "-f", path.to_str().unwrap()]).is_ok());
    let _ = std::fs::remove_file(path);
}

fn collectors() -> PathBuf {
    PathBuf::from(std::env::var_os("PEAK_COLLECTORS").expect("set PEAK_COLLECTORS"))
}

fn tools() -> Tools {
    Tools { collectors: Some(collectors()), ..Default::default() }
}

fn remote() -> Arc<Remote> {
    let timing = Timing { retry_max: Duration::from_secs(1), ..Default::default() };
    Arc::new(Remote::with_timing(Arc::new(CliConnector { tools: tools() }), timing))
}

fn state(r: &Remote, id: &str) -> ConnectionState {
    r.states().into_iter().find(|s| s.spec.id == id).unwrap().state
}

const PODS: &str = r#"
apiVersion: v1
kind: Namespace
metadata: { name: peak-test }
---
apiVersion: v1
kind: Pod
metadata: { name: web, namespace: peak-test }
spec:
  terminationGracePeriodSeconds: 1
  containers:
  - name: app
    image: alpine:3.20
    command: ["sh", "-c", "echo app-started; while true; do sleep 1; done"]
    resources: { limits: { memory: "64Mi", cpu: "250m" } }
  - name: sidecar
    image: alpine:3.20
    command: ["sh", "-c", "echo sidecar-started; while true; do sleep 1; done"]
---
apiVersion: v1
kind: Pod
metadata: { name: minimal, namespace: peak-test }
spec:
  terminationGracePeriodSeconds: 1
  containers:
  - name: only
    image: rancher/mirrored-pause:3.6
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: readonly, namespace: peak-test }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: Role
metadata: { name: pod-reader, namespace: peak-test }
rules:
- apiGroups: [""]
  resources: ["pods"]
  verbs: ["get", "list", "watch"]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: RoleBinding
metadata: { name: pod-reader, namespace: peak-test }
subjects: [{ kind: ServiceAccount, name: readonly, namespace: peak-test }]
roleRef: { kind: Role, name: pod-reader, apiGroup: rbac.authorization.k8s.io }
"#;

#[test]
#[ignore = "starts a disposable k3s cluster; needs Docker, kubectl and a built static collector"]
fn observes_real_pods() {
    let _cluster = Cluster::start();
    let t = tools();

    println!("discovery");
    assert!(transport::kube_contexts(&t).unwrap().contains(&"peak-live".to_string()));
    apply(PODS);
    eventually("namespace listed", 30, || {
        transport::kube_namespaces(&t, "peak-live").unwrap().contains(&"peak-test".to_string())
    });
    eventually("web pod running", 180, || {
        transport::kube_pods(&t, "peak-live", "peak-test")
            .unwrap()
            .iter()
            .any(|p| p.name == "web" && p.phase == "Running" && p.containers.iter().all(|c| c.ready))
    });
    let pods = transport::kube_pods(&t, "peak-live", "peak-test").unwrap();
    let web = pods.iter().find(|p| p.name == "web").unwrap().clone();
    assert_eq!(web.containers.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["app", "sidecar"]);
    assert!(!web.uid.is_empty());
    println!(
        "  web: uid={} containers={:?}",
        web.uid,
        web.containers.iter().map(|c| &c.container_id).collect::<Vec<_>>()
    );

    println!("logs per container");
    eventually("app logs", 30, || {
        transport::kube_logs(&t, "peak-live", "peak-test", "web", "app", 20).is_ok_and(|l| l.contains("app-started"))
    });
    let side = transport::kube_logs(&t, "peak-live", "peak-test", "web", "sidecar", 20).unwrap();
    assert!(side.contains("sidecar-started") && !side.contains("app-started"), "the selected container's own logs");

    println!("access is asked, not assumed");
    let admin = transport::kube_access(&t, "peak-live", "peak-test");
    assert!(admin.list_pods && admin.exec && admin.read_logs);

    println!("metrics are optional");
    let metrics = transport::kube_metrics(&t, "peak-live", "peak-test", "web");
    println!("  metrics now: {metrics:?}");
    assert!(metrics.is_ok(), "absent or present, never a hard failure: {metrics:?}");

    println!("connect a collector to the chosen container");
    let r = remote();
    let spec = TargetSpec {
        id: "web".into(),
        label: "peak-test/web/app".into(),
        kind: Some(TargetKind::Kubernetes),
        context: "peak-live".into(),
        namespace: "peak-test".into(),
        container: "web".into(),
        pod_container: "app".into(),
        pod_uid: web.uid.clone(),
        install: true,
        ..Default::default()
    };
    r.add(spec.clone());
    r.connect("web").unwrap();
    eventually("connected through kubectl exec", 60, || state(&r, "web") == ConnectionState::Connected);
    let st = r.states().remove(0);
    let facts = st.facts.unwrap();
    println!("  limits={:?} host={}", facts.limits, facts.host_memory);
    assert_eq!(facts.limits.memory_max, Some(64.0 * 1024.0 * 1024.0));
    assert_eq!(facts.limits.cpu_quota_cores, Some(0.25));
    assert!(st.capabilities.container_logs && !st.capabilities.container_totals);

    println!("only the selected container's processes are visible");
    let inside = r.list_processes("web").unwrap();
    println!("  inside: {:?}", inside.iter().map(|a| (a.pid, a.command.clone())).collect::<Vec<_>>());
    assert!(inside.iter().any(|a| a.command.contains("app-started")));
    assert!(!inside.iter().any(|a| a.command.contains("sidecar-started")));

    let p = r.attach("web", 1).unwrap();
    assert_eq!(p.target.as_ref().unwrap().identity.pod_uid.as_deref(), Some(web.uid.as_str()));
    eventually("samples", 20, || r.proc(&p.id).unwrap().samples.len() >= 4);

    println!("launch in the container");
    let spec2 = LaunchSpec { command: Some("echo in-pod; exit 4".into()), argv: None, cwd: "/".into() };
    let l = r.launch("web", spec2).unwrap();
    eventually("output and exit captured", 20, || {
        r.proc(&l.id).is_some_and(|x| x.exit_code == Some(4) && x.logs.iter().any(|m| m.text == "in-pod"))
    });

    println!("restricted RBAC: what the service account can't do is visible");
    let token = kubectl(&["-n", "peak-test", "create", "token", "readonly"]).unwrap();
    let cfg = _cluster.kubeconfig();
    let cfg = cfg.to_str().unwrap();
    sh("kubectl", &["--kubeconfig", cfg, "config", "set-credentials", "ro", "--token", token.trim()]).unwrap();
    sh("kubectl", &["--kubeconfig", cfg, "config", "set-context", "peak-ro", "--cluster=peak-live", "--user=ro"])
        .unwrap();
    let ro = transport::kube_access(&t, "peak-ro", "peak-test");
    println!("  {ro:?}");
    assert!(ro.list_pods && !ro.exec && !ro.read_logs);
    assert!(!transport::kube_pods(&t, "peak-ro", "peak-test").unwrap().is_empty(), "browsing still works");
    let denied = transport::kube_logs(&t, "peak-ro", "peak-test", "web", "app", 5).unwrap_err();
    assert!(denied.contains("Forbidden") || denied.contains("forbidden"), "{denied}");
    let r2 = remote();
    r2.add(TargetSpec { id: "ro".into(), context: "peak-ro".into(), ..spec.clone() });
    r2.connect("ro").unwrap();
    eventually("connect refused by RBAC", 40, || state(&r2, "ro") == ConnectionState::Failed);
    println!("  {}", r2.states().remove(0).error.unwrap());

    println!("minimal image: no tar, so no copy, and it says why");
    eventually("minimal pod running", 180, || {
        transport::kube_pods(&t, "peak-live", "peak-test")
            .unwrap()
            .iter()
            .any(|p| p.name == "minimal" && p.phase == "Running")
    });
    let min_uid = transport::kube_pods(&t, "peak-live", "peak-test")
        .unwrap()
        .iter()
        .find(|p| p.name == "minimal")
        .unwrap()
        .uid
        .clone();
    let r3 = remote();
    r3.add(TargetSpec {
        id: "min".into(),
        kind: Some(TargetKind::Kubernetes),
        context: "peak-live".into(),
        namespace: "peak-test".into(),
        container: "minimal".into(),
        pod_container: "only".into(),
        pod_uid: min_uid,
        install: true,
        ..Default::default()
    });
    r3.connect("min").unwrap();
    eventually("minimal image fails honestly", 60, || state(&r3, "min") == ConnectionState::Failed);
    println!("  {}", r3.states().remove(0).error.unwrap());
    assert!(transport::kube_logs(&t, "peak-live", "peak-test", "minimal", "only", 5).is_ok(), "logs remain available");

    println!("pod replaced under the same name: a different target");
    kubectl(&["-n", "peak-test", "delete", "pod", "web", "--grace-period=1"]).unwrap();
    eventually("connection lost", 40, || state(&r, "web") != ConnectionState::Connected);
    assert_eq!(r.proc(&p.id).unwrap().exit_code, None, "no exit status from a lost exec session");
    apply(PODS);
    eventually("new pod up", 120, || {
        transport::kube_pods(&t, "peak-live", "peak-test")
            .unwrap()
            .iter()
            .any(|x| x.name == "web" && x.uid != web.uid && x.phase == "Running")
    });
    r.disconnect("web").unwrap();
    r.connect("web").unwrap();
    eventually("refuses the replacement", 40, || state(&r, "web") == ConnectionState::Failed);
    let e = r.states().remove(0).error.unwrap();
    println!("  {e}");
    assert!(e.contains("was replaced"), "{e}");
    assert_eq!(
        r.proc(&p.id).unwrap().target.unwrap().identity.pod_uid.as_deref(),
        Some(web.uid.as_str()),
        "history stays with the old pod"
    );

    println!("metrics: the measured path, against a system pod the server has data for");
    let system = transport::kube_pods(&t, "peak-live", "kube-system").unwrap();
    let coredns = system.iter().find(|p| p.name.starts_with("coredns")).expect("coredns").name.clone();
    eventually("metrics measured", 180, || {
        transport::kube_metrics(&t, "peak-live", "kube-system", &coredns)
            .is_ok_and(|m| m.is_some_and(|v| !v.is_empty()))
    });
    println!("  {coredns}: {:?}", transport::kube_metrics(&t, "peak-live", "kube-system", &coredns).unwrap());
    // A running pod: measured, or the API's NotFound reported as "nothing yet". API
    // discovery can flap just after startup, so give it time to settle into an answer.
    eventually("the API answers for a running pod", 120, || {
        transport::kube_metrics(&t, "peak-live", "peak-test", "web").is_ok_and(|m| m.is_some())
    });
    println!("  web: {:?}", transport::kube_metrics(&t, "peak-live", "peak-test", "web"));
    println!("PASS");
}
