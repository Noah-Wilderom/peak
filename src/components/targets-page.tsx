import { useEffect, useState } from "react"
import { motion } from "motion/react"
import { XIcon } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Card } from "@/components/card"
import { Segmented } from "@/components/segmented"
import {
  monitor,
  NEW_TARGET,
  type ConnectionState,
  type ContainerProcess,
  type ContainerTotals,
  type DockerContainer,
  type KubeAccess,
  type KubeMetrics,
  type KubePod,
  type TargetKind,
  type TargetState,
} from "@/lib/monitor"
import { formatBytes, formatMs, formatPercent } from "@/lib/format"
import { cn } from "@/lib/utils"

const STATE: Record<ConnectionState, { label: string; tone: string }> = {
  connected: { label: "Connected", tone: "bg-success/12 text-success" },
  connecting: { label: "Connecting…", tone: "bg-secondary text-muted-foreground" },
  stale: { label: "No recent data", tone: "bg-warning/12 text-warning" },
  disconnected: { label: "Disconnected", tone: "bg-secondary text-muted-foreground" },
  failed: { label: "Couldn't connect", tone: "bg-danger/12 text-danger" },
}

const KIND: Record<TargetKind, string> = { local: "This machine", ssh: "SSH", docker: "Docker", kubernetes: "Kubernetes" }

const fail = (what: string) => (e: unknown) => toast.error(what, { description: String(e) })

/** Other machines and containers: how they're reached, and what's true of each. */
export function TargetsPage({ targets, onClose }: { targets: TargetState[]; onClose: () => void }) {
  const [adding, setAdding] = useState<"ssh" | "docker" | "kubernetes">("ssh")

  return (
    <motion.div
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, y: -4 }}
      transition={{ duration: 0.2, ease: [0.25, 1, 0.5, 1] }}
      className="flex min-w-0 flex-1 flex-col overflow-y-auto"
    >
      <div className="mx-auto flex w-full max-w-[1100px] min-w-0 flex-col gap-4 px-10 pt-12 pb-10">
        <div className="mb-4 flex items-start justify-between gap-6">
          <div>
            <h1 className="text-[44px] leading-[1.05] font-[650]">Targets.</h1>
            <p className="mt-3 max-w-2xl text-[19px] leading-snug font-light text-muted-foreground">
              Watch workloads on other machines and in containers, through your own SSH, Docker and Kubernetes access. Peak never stores credentials.
            </p>
          </div>
          <Button variant="secondary" size="icon" onClick={onClose} aria-label="Close">
            <XIcon />
          </Button>
        </div>

        {targets.map((t) => (
          <TargetCard key={t.spec.id} target={t} />
        ))}
        {targets.length === 0 && (
          <p className="rounded-card bg-secondary px-6 py-8 text-center text-sm text-muted-foreground">No targets yet. Add one below.</p>
        )}

        <Card title="Add a target.">
          <Segmented
            className="mb-4"
            value={adding}
            onChange={setAdding}
            options={[
              { value: "ssh", label: "SSH" },
              { value: "docker", label: "Docker" },
              { value: "kubernetes", label: "Kubernetes" },
            ]}
          />
          {adding === "ssh" && <SshForm />}
          {adding === "docker" && <DockerBrowser />}
          {adding === "kubernetes" && <KubeBrowser />}
        </Card>
      </div>
    </motion.div>
  )
}

function TargetCard({ target }: { target: TargetState }) {
  const { spec, state, error, facts, system, capabilities: c } = target
  const on = state === "connected" || state === "stale" || state === "connecting"
  const s = STATE[state]
  const chips = [
    c.attach && "Attach",
    c.launch && "Launch",
    c.signal && "Signals",
    c.runtimeAgents && "Runtime agents",
    c.containerTotals && "Container totals",
    c.containerLogs && "Container logs",
  ].filter((x): x is string => !!x)

  return (
    <section aria-label={`Target ${spec.label}`} className="rounded-card border border-border p-6">
      <div className="flex items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-3">
            <h2 className="truncate text-[15px] font-semibold">{spec.label}</h2>
            <span className={cn("inline-flex h-6 shrink-0 items-center rounded-full px-2.5 text-label", s.tone)}>{s.label}</span>
          </div>
          <p className="mt-0.5 text-xs text-muted-foreground">{KIND[spec.kind ?? "local"]}</p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {on ? (
            <Button size="sm" variant="outline" onClick={() => void monitor.disconnectTarget(spec.id).catch(fail("Couldn't disconnect"))}>
              Disconnect
            </Button>
          ) : (
            <Button size="sm" onClick={() => void monitor.connectTarget(spec.id).catch(fail("Couldn't connect"))}>
              Connect
            </Button>
          )}
          <Button size="sm" variant="secondary" onClick={() => void monitor.removeTarget(spec.id).catch(fail("Couldn't remove this target"))}>
            Remove
          </Button>
        </div>
      </div>
      {error && (
        <p role="alert" className={cn("mt-3 rounded-2xl px-3.5 py-2.5 text-xs break-words", state === "failed" ? "bg-danger/10 text-danger" : "bg-secondary text-muted-foreground")}>
          {error}
        </p>
      )}
      {facts && (
        <dl className="mt-4 grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
          <Fact label="Host memory" value={formatBytes(facts.hostMemory)} hint={system ? `${formatBytes(system.memTotal - system.memAvailable)} in use` : undefined} />
          <Fact label="Memory limit (cgroup)" value={facts.limits.memoryMax === null ? "None set" : formatBytes(facts.limits.memoryMax)} hint={facts.limits.memoryCurrent === null ? undefined : `${formatBytes(facts.limits.memoryCurrent)} charged`} />
          <Fact label="CPU limit (cgroup)" value={facts.limits.cpuQuotaCores === null ? "None set" : `${facts.limits.cpuQuotaCores} cores`} hint={`${facts.cpus} CPUs usable`} />
          <Fact label="Clock offset" value={`${target.clockOffsetMs >= 0 ? "+" : "−"}${formatMs(Math.abs(target.clockOffsetMs))}`} hint={`${facts.arch} · ${facts.kernel}`} />
        </dl>
      )}
      {chips.length > 0 && (
        <p className="mt-3 flex flex-wrap gap-1.5">
          {chips.map((x) => (
            <span key={x} className="rounded-full bg-secondary px-2.5 py-0.5 text-[11px] font-semibold text-muted-foreground">{x}</span>
          ))}
        </p>
      )}
    </section>
  )
}

function Fact({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="truncate font-semibold tabular-nums">{value}</dd>
      {hint && <dd className="truncate text-xs text-muted-foreground" title={hint}>{hint}</dd>}
    </div>
  )
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-1 flex-col gap-1.5">
      <span className="text-xs font-semibold text-muted-foreground">{label}</span>
      {children}
    </label>
  )
}

/** Runs a loader whenever `key` changes and tracks its result or failure. */
function useLoad<T>(load: () => Promise<T>, key: string, every?: number) {
  const [state, setState] = useState<{ key: string; value?: T; error?: string } | null>(null)
  useEffect(() => {
    let live = true
    const run = () =>
      load()
        .then((value) => live && setState({ key, value }))
        .catch((e) => live && setState({ key, error: String(e) }))
    void run()
    const timer = every ? setInterval(run, every) : undefined
    return () => {
      live = false
      clearInterval(timer)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state?.key === key ? state : null
}

function Problem({ children }: { children: React.ReactNode }) {
  return <p role="alert" className="rounded-2xl bg-secondary px-3.5 py-2.5 text-xs break-words text-muted-foreground">{children}</p>
}

function SshForm() {
  const [host, setHost] = useState("")
  const [port, setPort] = useState("")
  const [path, setPath] = useState("")
  const [install, setInstall] = useState(true)

  const add = async () => {
    const dest = host.trim()
    try {
      const t = await monitor.addTarget({
        ...NEW_TARGET,
        label: dest,
        kind: "ssh",
        host: dest,
        port: Number(port) || null,
        collectorPath: path.trim(),
        install,
      })
      await monitor.connectTarget(t.spec.id)
      setHost("")
    } catch (e) {
      fail("Couldn't add this target")(e)
    }
  }

  return (
    <form
      className="flex flex-col gap-3"
      onSubmit={(e) => {
        e.preventDefault()
        void add()
      }}
    >
      <p className="text-sm text-muted-foreground">Uses your installed <code className="font-mono text-xs">ssh</code>, so your keys, config and jump hosts apply. It won't prompt for a password.</p>
      <div className="flex flex-wrap gap-3">
        <Field label="Host"><Input value={host} onChange={(e) => setHost(e.target.value)} placeholder="me@build-box" className="font-mono" /></Field>
        <div className="w-24"><Field label="Port"><Input value={port} onChange={(e) => setPort(e.target.value)} inputMode="numeric" placeholder="22" className="font-mono" /></Field></div>
      </div>
      <Field label="Collector path (optional)"><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="~/.local/share/peak/collector/…" className="font-mono" /></Field>
      <CopyChoice value={install} onChange={setInstall} />
      <Button type="submit" className="self-start" disabled={!host.trim()}>Add and connect</Button>
    </form>
  )
}

function CopyChoice({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="flex items-center gap-2 text-sm">
      <input type="checkbox" checked={value} onChange={(e) => onChange(e.target.checked)} className="size-4 accent-foreground" />
      Copy the collector to the target if it's missing
    </label>
  )
}

function Select({ label, value, options, onChange }: { label: string; value: string; options: string[]; onChange: (v: string) => void }) {
  return (
    <Field label={label}>
      <select value={value} onChange={(e) => onChange(e.target.value)} className="h-9 rounded-2xl bg-field px-3 text-sm outline-none focus-visible:ring-2 focus-visible:ring-foreground">
        {options.map((o) => (
          <option key={o} value={o}>{o || "Current context"}</option>
        ))}
      </select>
    </Field>
  )
}

function DockerBrowser() {
  const contexts = useLoad(() => monitor.dockerContexts(), "contexts")
  const [context, setContext] = useState("")
  const containers = useLoad(() => monitor.dockerContainers(context), `c:${context}`, 5000)
  const [selected, setSelected] = useState<DockerContainer | null>(null)

  if (contexts?.error) return <Problem>{contexts.error}</Problem>
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Container lists, totals and logs need no collector. Detailed process charts add one with <code className="font-mono text-xs">docker exec</code>.</p>
      <Select label="Docker context" value={context} options={["", ...(contexts?.value ?? [])]} onChange={setContext} />
      {containers?.error && <Problem>{containers.error}</Problem>}
      <ul className="flex flex-col gap-1">
        {containers?.value?.map((c) => (
          <li key={c.id}>
            <button
              onClick={() => setSelected(c)}
              className={cn("flex w-full items-center justify-between gap-4 rounded-2xl px-3.5 py-2.5 text-left text-sm", selected?.id === c.id ? "bg-secondary" : "hover:bg-secondary/60")}
            >
              <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">{c.name}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{c.image} · {c.status}</span>
            </button>
          </li>
        ))}
        {containers?.value?.length === 0 && <li className="px-3.5 py-2.5 text-sm text-muted-foreground">No containers in this context.</li>}
      </ul>
      {selected && <ContainerPanel key={selected.id} context={context} container={selected} />}
    </div>
  )
}

function ContainerPanel({ context, container }: { context: string; container: DockerContainer }) {
  const running = container.state === "running"
  const totals = useLoad<ContainerTotals | null>(() => (running ? monitor.dockerTotals(context, container.id) : Promise.resolve(null)), "t", 3000)
  const top = useLoad<ContainerProcess[]>(() => (running ? monitor.dockerTop(context, container.id) : Promise.resolve([])), "p", 5000)
  const logs = useLoad(() => monitor.dockerLogs(context, container.id, 200), "l", 5000)
  const [install, setInstall] = useState(true)

  const monitorIt = async () => {
    try {
      const t = await monitor.addTarget({ ...NEW_TARGET, id: `docker-${container.id.slice(0, 12)}`, label: container.name, kind: "docker", context, container: container.id, install })
      await monitor.connectTarget(t.spec.id)
    } catch (e) {
      fail("Couldn't add this target")(e)
    }
  }

  const t = totals?.value
  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <div>
        <p className="text-xs font-semibold text-muted-foreground">Container totals, from docker stats. The whole container, not one process tree.</p>
        {!running && <p className="mt-1 text-sm text-muted-foreground">This container isn't running ({container.status}).</p>}
        {totals?.error && <Problem>{totals.error}</Problem>}
        {t && (
          <dl className="mt-2 grid grid-cols-2 gap-x-6 gap-y-3 text-sm lg:grid-cols-4">
            <Fact label="CPU (100% per core)" value={t.cpuPercent === null ? "Unknown" : formatPercent(t.cpuPercent)} />
            <Fact label="Memory" value={t.memoryUsed === null ? "Unknown" : formatBytes(t.memoryUsed)} hint={t.memoryLimit === null ? undefined : `limit ${formatBytes(t.memoryLimit)}`} />
            <Fact label="Tasks" value={t.pids === null ? "Unknown" : String(t.pids)} />
            <Fact label="Network / block" value={t.rawNet || "Unknown"} hint={t.rawBlock || undefined} />
          </dl>
        )}
      </div>
      {running && (
        <div>
          <p className="text-xs font-semibold text-muted-foreground">Processes, as the daemon sees them. These PIDs differ from the ones inside the container.</p>
          {top?.error && <Problem>{top.error}</Problem>}
          <ul className="mt-1 flex flex-col font-mono text-[12px]">
            {top?.value?.map((p) => (
              <li key={p.pid} className="flex gap-3 py-0.5">
                <span className="w-16 shrink-0 text-right tabular-nums text-muted-foreground">{p.pid}</span>
                <span className="truncate">{p.command}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <div>
        <p className="text-xs font-semibold text-muted-foreground">Container logs, as recorded by the daemon. Limited by its logging driver and rotation.</p>
        {logs?.error && <Problem>{logs.error}</Problem>}
        {logs?.value !== undefined && (
          <pre className="mt-1 max-h-48 overflow-auto rounded-2xl bg-secondary p-3 font-mono text-[11px] whitespace-pre-wrap select-text">{logs.value || "No logs recorded."}</pre>
        )}
      </div>
      {running && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          <CopyChoice value={install} onChange={setInstall} />
          <Button className="self-start" onClick={() => void monitorIt()}>Monitor in detail</Button>
        </div>
      )}
    </div>
  )
}

function KubeBrowser() {
  const contexts = useLoad(() => monitor.kubeContexts(), "contexts")
  const [context, setContext] = useState("")
  const ctx = context || contexts?.value?.[0] || ""
  const namespaces = useLoad(() => monitor.kubeNamespaces(ctx), `n:${ctx}`)
  const [namespace, setNamespace] = useState("")
  const ns = namespace || namespaces?.value?.[0] || "default"
  const pods = useLoad(() => monitor.kubePods(ctx, ns), `p:${ctx}/${ns}`, 5000)
  const access = useLoad(() => monitor.kubeAccess(ctx, ns), `a:${ctx}/${ns}`)
  const [selected, setSelected] = useState<{ pod: KubePod; container: string } | null>(null)

  if (contexts?.error) return <Problem>{contexts.error}</Problem>
  return (
    <div className="flex flex-col gap-3">
      <p className="text-sm text-muted-foreground">Pods and logs come from your <code className="font-mono text-xs">kubectl</code> access. Detailed charts run a collector in the chosen container with <code className="font-mono text-xs">kubectl exec</code>, which is command execution even when it only observes.</p>
      <div className="flex flex-wrap gap-3">
        <Select label="Context" value={ctx} options={contexts?.value ?? []} onChange={setContext} />
        <Select label="Namespace" value={ns} options={namespaces?.value ?? [ns]} onChange={setNamespace} />
      </div>
      {access?.value && <AccessNote access={access.value} />}
      {namespaces?.error && <Problem>Can't list namespaces: {namespaces.error}</Problem>}
      {pods?.error && <Problem>{pods.error}</Problem>}
      <ul className="flex flex-col gap-1">
        {pods?.value?.map((pod) =>
          pod.containers.map((c) => (
            <li key={`${pod.uid}/${c.name}`}>
              <button
                onClick={() => setSelected({ pod, container: c.name })}
                className={cn("flex w-full items-center justify-between gap-4 rounded-2xl px-3.5 py-2.5 text-left text-sm", selected?.pod.uid === pod.uid && selected.container === c.name ? "bg-secondary" : "hover:bg-secondary/60")}
              >
                <span className="min-w-0 truncate font-mono text-[12.5px] font-medium">{pod.name} / {c.name}</span>
                <span className="shrink-0 text-xs text-muted-foreground">{pod.phase} · {c.state} · {c.restarts} restarts</span>
              </button>
            </li>
          )),
        )}
        {pods?.value?.length === 0 && <li className="px-3.5 py-2.5 text-sm text-muted-foreground">No pods in this namespace.</li>}
      </ul>
      {selected && <PodPanel key={`${selected.pod.uid}/${selected.container}`} context={ctx} pod={selected.pod} container={selected.container} canExec={access?.value?.exec ?? false} />}
    </div>
  )
}

function AccessNote({ access }: { access: KubeAccess }) {
  const no = [!access.listPods && "listing pods", !access.readLogs && "reading logs", !access.exec && "running a collector (pods/exec)"].filter(Boolean)
  return no.length ? <Problem>Your access here doesn't include {no.join(", ")}.</Problem> : null
}

function PodPanel({ context, pod, container, canExec }: { context: string; pod: KubePod; container: string; canExec: boolean }) {
  const logs = useLoad(() => monitor.kubeLogs(context, pod.namespace, pod.name, container, 200), "l", 5000)
  const metrics = useLoad<KubeMetrics[] | null>(() => monitor.kubeMetrics(context, pod.namespace, pod.name), "m", 10_000)
  const [path, setPath] = useState("")
  const [install, setInstall] = useState(false)
  const measured = metrics?.value?.find((m) => m.container === container)

  const monitorIt = async () => {
    try {
      const t = await monitor.addTarget({
        ...NEW_TARGET,
        id: `kube-${pod.uid.slice(0, 8)}-${container}`,
        label: `${pod.namespace}/${pod.name}/${container}`,
        kind: "kubernetes",
        context,
        namespace: pod.namespace,
        container: pod.name,
        podContainer: container,
        podUid: pod.uid,
        collectorPath: path.trim(),
        install,
      })
      await monitor.connectTarget(t.spec.id)
    } catch (e) {
      fail("Couldn't add this target")(e)
    }
  }

  return (
    <div className="flex flex-col gap-3 rounded-2xl border border-border p-4">
      <p className="text-xs text-muted-foreground">Pod UID <span className="font-mono">{pod.uid}</span> on {pod.node || "an unknown node"}. A new pod with this name is a different target.</p>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">Resource usage, from the cluster's metrics API. A container total, updated slowly.</p>
        {metrics?.error && <Problem>{metrics.error}</Problem>}
        {metrics && metrics.value === null && <p className="mt-1 text-sm text-muted-foreground">This cluster has no metrics API available right now.</p>}
        {measured && <p className="mt-1 text-sm tabular-nums">CPU {measured.cpu} · Memory {measured.memory}</p>}
        {metrics?.value && !measured && <p className="mt-1 text-sm text-muted-foreground">No measurement for this container yet. New pods can take a while to appear.</p>}
      </div>
      <div>
        <p className="text-xs font-semibold text-muted-foreground">Container logs, as kept by the cluster. Rotation limits how far back they go.</p>
        {logs?.error && <Problem>{logs.error}</Problem>}
        {logs?.value !== undefined && (
          <pre className="mt-1 max-h-48 overflow-auto rounded-2xl bg-secondary p-3 font-mono text-[11px] whitespace-pre-wrap select-text">{logs.value || "No logs recorded."}</pre>
        )}
      </div>
      <div className="flex flex-col gap-2 border-t border-border pt-3">
        <Field label="Collector path in the container"><Input value={path} onChange={(e) => setPath(e.target.value)} placeholder="/tmp/peak-collector" className="font-mono" /></Field>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={install} onChange={(e) => setInstall(e.target.checked)} className="size-4 accent-foreground" />
          Copy it with kubectl cp if missing (needs tar in the image)
        </label>
        <Button className="self-start" disabled={!canExec} title={canExec ? undefined : "Your access doesn't include pods/exec"} onClick={() => void monitorIt()}>Monitor in detail</Button>
      </div>
    </div>
  )
}
