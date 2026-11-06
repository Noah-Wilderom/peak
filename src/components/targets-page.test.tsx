import { render, screen, waitFor, within } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { afterEach, describe, expect, it, vi } from "vitest"
import { Toaster } from "@/components/ui/sonner"
import { TargetsPage } from "@/components/targets-page"
import { monitor, NEW_TARGET, type ContainerTotals, type DockerContainer, type KubePod, type TargetFacts, type TargetState } from "@/lib/monitor"

const NONE = { collector: false, attach: false, launch: false, signal: false, runtimeAgents: false, containerTotals: false, containerLogs: false, containerTop: false }
const GiB = 1024 ** 3
const facts: TargetFacts = {
  protocol: 1, collectorVersion: "0.1.0", arch: "x86_64", kernel: "6.8", hostname: "h", bootId: "b", pidNs: "n", uid: 1, clkTck: 100, cpus: 4,
  hostMemory: 8 * GiB, limits: { version: 2, memoryMax: GiB, memoryCurrent: GiB / 2, cpuQuotaCores: 0.5 }, runtimeAgents: true,
}
const target = (over: Partial<TargetState>): TargetState => ({
  spec: { ...NEW_TARGET, id: "t", label: "box", kind: "ssh" }, state: "disconnected", error: null, capabilities: NONE, facts: null, system: null, clockOffsetMs: 0, ...over,
})

function show(targets: TargetState[] = []) {
  const onClose = vi.fn()
  render(
    <>
      <TargetsPage targets={targets} onClose={onClose} />
      <Toaster />
    </>,
  )
  return { onClose, user: userEvent.setup() }
}

afterEach(() => vi.useRealTimers())

describe("target cards", () => {
  it("separates host capacity from container limits and shows what's possible", async () => {
    const { user, onClose } = show([
      target({
        state: "connected", facts, clockOffsetMs: -1500,
        capabilities: { ...NONE, attach: true, launch: true, signal: true, runtimeAgents: true, containerTotals: true, containerLogs: true },
        system: { t: 1, memTotal: 8 * GiB, memAvailable: 6 * GiB, swapTotal: 0, swapFree: 0, psiSome: null, psiFull: null, load1: 0, cpu: 0 },
      }),
    ])
    const card = screen.getByRole("region", { name: "Target box" })
    expect(within(card).getByText("Connected")).toBeInTheDocument()
    expect(within(card).getByText("8 GiB")).toBeInTheDocument()
    expect(within(card).getByText("2 GiB in use")).toBeInTheDocument()
    expect(within(card).getByText("1 GiB")).toBeInTheDocument()
    expect(within(card).getByText("512 MiB charged")).toBeInTheDocument()
    expect(within(card).getByText("0.5 cores")).toBeInTheDocument()
    expect(within(card).getByText("−1.5s")).toBeInTheDocument()
    for (const c of ["Attach", "Launch", "Signals", "Runtime agents", "Container totals", "Container logs"]) expect(within(card).getByText(c)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Close" }))
    expect(onClose).toHaveBeenCalled()
  })

  it("doesn't invent a limit where none is set", () => {
    const noLimits = { ...facts, limits: { version: null, memoryMax: null, memoryCurrent: null, cpuQuotaCores: null } }
    show([target({ state: "stale", facts: noLimits, clockOffsetMs: 200, error: "No data for 4s" })])
    expect(screen.getAllByText("None set")).toHaveLength(2)
    expect(screen.getByText("No recent data")).toBeInTheDocument()
    expect(screen.getByText("+200ms")).toBeInTheDocument()
    expect(screen.getByRole("alert")).toHaveClass("bg-secondary")
  })

  it("connects, disconnects and removes, reporting errors", async () => {
    const connect = vi.spyOn(monitor, "connectTarget").mockResolvedValueOnce().mockRejectedValueOnce(new Error("x"))
    const disconnect = vi.spyOn(monitor, "disconnectTarget").mockRejectedValue(new Error("x"))
    const remove = vi.spyOn(monitor, "removeTarget").mockRejectedValue(new Error("in use"))
    const { user } = show([
      target({ state: "failed", error: "Permission denied" }),
      target({ spec: { ...NEW_TARGET, id: "u", label: "up", kind: null }, state: "connecting" }),
    ])
    const failed = screen.getByRole("region", { name: "Target box" })
    expect(within(failed).getByRole("alert")).toHaveClass("bg-danger/10")
    expect(within(failed).getByText("SSH")).toBeInTheDocument()
    await user.click(within(failed).getByRole("button", { name: "Connect" }))
    expect(connect).toHaveBeenCalledWith("t")
    await user.click(within(failed).getByRole("button", { name: "Connect" }))
    expect(await screen.findByText("Couldn't connect", { selector: "[data-title], div" })).toBeInTheDocument()
    const up = screen.getByRole("region", { name: "Target up" })
    expect(within(up).getByText("This machine")).toBeInTheDocument()
    await user.click(within(up).getByRole("button", { name: "Disconnect" }))
    expect(disconnect).toHaveBeenCalledWith("u")
    await user.click(within(failed).getByRole("button", { name: "Remove" }))
    expect(remove).toHaveBeenCalledWith("t")
    expect(await screen.findByText("Couldn't remove this target")).toBeInTheDocument()
  })
})

describe("adding over SSH", () => {
  it("adds and connects, and only allows copying with the box ticked", async () => {
    const add = vi.spyOn(monitor, "addTarget").mockResolvedValue(target({}))
    const connect = vi.spyOn(monitor, "connectTarget").mockResolvedValue()
    const { user } = show()
    expect(screen.getByText(/No targets yet/)).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Add and connect" })).toBeDisabled()
    await user.type(screen.getByPlaceholderText("me@build-box"), " me@box ")
    await user.type(screen.getByPlaceholderText("22"), "2222")
    await user.type(screen.getByPlaceholderText(/collector/), "/opt/c")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Add and connect" }))
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: "ssh", host: "me@box", label: "me@box", port: 2222, collectorPath: "/opt/c", install: false }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith("t"))
    expect(screen.getByPlaceholderText("me@build-box")).toHaveValue("")
    add.mockRejectedValue(new Error("no"))
    await user.clear(screen.getByPlaceholderText("22"))
    await user.type(screen.getByPlaceholderText("me@build-box"), "x")
    await user.click(screen.getByRole("button", { name: "Add and connect" }))
    expect((await screen.findAllByText("Couldn't add this target")).length).toBeGreaterThan(0)
    expect(add.mock.calls[0][0].id).toBe("")
    expect(add.mock.calls[1][0].port, "the default port is ssh's business").toBeNull()
  })
})

const web: DockerContainer = { id: "abc123def456xxx", name: "web", image: "nginx", state: "running", status: "Up 2 hours" }
const stopped: DockerContainer = { id: "dead", name: "old", image: "nginx", state: "exited", status: "Exited (0)" }
const totals: ContainerTotals = { cpuPercent: 12.5, memoryUsed: GiB, memoryLimit: 2 * GiB, pids: 7, rawNet: "1kB / 2kB", rawBlock: "0B / 0B" }

function dockerSpies() {
  vi.spyOn(monitor, "dockerContexts").mockResolvedValue(["default", "remote"])
  const list = vi.spyOn(monitor, "dockerContainers").mockResolvedValue([web, stopped])
  const t = vi.spyOn(monitor, "dockerTotals").mockResolvedValue(totals)
  const top = vi.spyOn(monitor, "dockerTop").mockResolvedValue([{ pid: "4242", user: "root", command: "nginx: master" }])
  const logs = vi.spyOn(monitor, "dockerLogs").mockResolvedValue("hello from logs")
  return { list, t, top, logs }
}

describe("browsing Docker without a collector", () => {
  it("shows labelled totals, daemon-view processes and platform logs, then adds a target", async () => {
    dockerSpies()
    const add = vi.spyOn(monitor, "addTarget").mockResolvedValue(target({ spec: { ...NEW_TARGET, id: "d" } }))
    const connect = vi.spyOn(monitor, "connectTarget").mockResolvedValue()
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Docker" }))
    expect(await screen.findByRole("option", { name: "Current context" })).toHaveValue("")
    await user.selectOptions(await screen.findByRole("combobox", { name: "Docker context" }), "remote")
    await user.click(await screen.findByRole("button", { name: /^web/ }))
    expect(monitor.dockerContainers).toHaveBeenLastCalledWith("remote")
    expect(await screen.findByText("12.5%")).toBeInTheDocument()
    expect(screen.getByText(/The whole container, not one process tree/)).toBeInTheDocument()
    expect(screen.getByText("limit 2 GiB")).toBeInTheDocument()
    expect(await screen.findByText("nginx: master")).toBeInTheDocument()
    expect(screen.getByText(/These PIDs differ from the ones inside/)).toBeInTheDocument()
    expect(await screen.findByText("hello from logs")).toBeInTheDocument()
    expect(screen.getByText(/recorded by the daemon/)).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Monitor in detail" }))
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ id: "docker-abc123def456", label: "web", kind: "docker", context: "remote", container: web.id, install: true }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith("d"))
    add.mockRejectedValue(new Error("no"))
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Monitor in detail" }))
    expect((await screen.findAllByText("Couldn't add this target")).length).toBeGreaterThan(0)
  })

  it("keeps unknown figures unknown and handles stopped containers", async () => {
    const s = dockerSpies()
    s.t.mockResolvedValue({ cpuPercent: null, memoryUsed: null, memoryLimit: null, pids: null, rawNet: "", rawBlock: "" })
    s.logs.mockResolvedValue("")
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Docker" }))
    await user.click(await screen.findByRole("button", { name: /^web/ }))
    await waitFor(() => expect(screen.getAllByText("Unknown")).toHaveLength(4))
    expect(await screen.findByText("No logs recorded.")).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: /^old/ }))
    expect(await screen.findByText(/This container isn't running/)).toBeInTheDocument()
    expect(screen.queryByRole("button", { name: "Monitor in detail" })).not.toBeInTheDocument()
  })

  it("explains failures and an empty context", async () => {
    const s = dockerSpies()
    s.t.mockRejectedValue(new Error("no stats"))
    s.top.mockRejectedValue(new Error("no top"))
    s.logs.mockRejectedValue(new Error("no logs"))
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Docker" }))
    await user.click(await screen.findByRole("button", { name: /^web/ }))
    for (const m of ["no stats", "no top", "no logs"]) expect(await screen.findByText(`Error: ${m}`)).toBeInTheDocument()
    s.list.mockResolvedValue([])
    await user.selectOptions(screen.getByRole("combobox", { name: "Docker context" }), "default")
    expect(await screen.findByText("No containers in this context.")).toBeInTheDocument()
    s.list.mockRejectedValue(new Error("daemon down"))
    await user.selectOptions(screen.getByRole("combobox", { name: "Docker context" }), "remote")
    expect(await screen.findByText("Error: daemon down")).toBeInTheDocument()
  })

  it("says when the CLI isn't there", async () => {
    vi.spyOn(monitor, "dockerContexts").mockRejectedValue(new Error("`docker` isn't installed or isn't on PATH"))
    vi.spyOn(monitor, "dockerContainers").mockResolvedValue([])
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Docker" }))
    expect(await screen.findByText(/isn't installed/)).toBeInTheDocument()
  })

  it("refreshes totals while open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const s = dockerSpies()
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Docker" }))
    await user.click(await screen.findByRole("button", { name: /^web/ }))
    await screen.findByText("12.5%")
    const before = s.t.mock.calls.length
    vi.advanceTimersByTime(3100)
    await waitFor(() => expect(s.t.mock.calls.length).toBeGreaterThan(before))
  })
})

const pod: KubePod = {
  name: "api", uid: "uid-12345678", namespace: "web", phase: "Running", node: "n1",
  containers: [{ name: "app", ready: true, state: "running", restarts: 2, containerId: "c1" }, { name: "proxy", ready: false, state: "waiting", restarts: 0, containerId: "c2" }],
}

function kubeSpies() {
  vi.spyOn(monitor, "kubeContexts").mockResolvedValue(["kind"])
  const ns = vi.spyOn(monitor, "kubeNamespaces").mockResolvedValue(["web", "other"])
  const pods = vi.spyOn(monitor, "kubePods").mockResolvedValue([pod])
  const access = vi.spyOn(monitor, "kubeAccess").mockResolvedValue({ listPods: true, readLogs: true, exec: true })
  const logs = vi.spyOn(monitor, "kubeLogs").mockResolvedValue("kube log line")
  const metrics = vi.spyOn(monitor, "kubeMetrics").mockResolvedValue(null)
  return { ns, pods, access, logs, metrics }
}

describe("browsing Kubernetes", () => {
  it("walks context, namespace, pod and container, and targets the exact pod instance", async () => {
    const s = kubeSpies()
    s.metrics.mockResolvedValue([{ container: "app", cpu: "5m", memory: "20Mi" }])
    const add = vi.spyOn(monitor, "addTarget").mockResolvedValue(target({ spec: { ...NEW_TARGET, id: "k" } }))
    const connect = vi.spyOn(monitor, "connectTarget").mockResolvedValue()
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Kubernetes" }))
    await user.click(await screen.findByRole("button", { name: /^api \/ app/ }))
    expect(s.logs).toHaveBeenCalledWith("kind", "web", "api", "app", 200)
    expect(await screen.findByText("kube log line")).toBeInTheDocument()
    expect(await screen.findByText(/CPU 5m · Memory 20Mi/)).toBeInTheDocument()
    expect(screen.getByText(/A new pod with this name is a different target/)).toBeInTheDocument()
    await user.type(screen.getByPlaceholderText("/tmp/peak-collector"), " /opt/peak ")
    await user.click(screen.getByRole("checkbox"))
    await user.click(screen.getByRole("button", { name: "Monitor in detail" }))
    expect(add).toHaveBeenCalledWith(expect.objectContaining({ kind: "kubernetes", context: "kind", namespace: "web", container: "api", podContainer: "app", podUid: "uid-12345678", collectorPath: "/opt/peak", install: true, label: "web/api/app" }))
    await waitFor(() => expect(connect).toHaveBeenCalledWith("k"))
    add.mockRejectedValue(new Error("no"))
    await user.click(screen.getByRole("button", { name: "Monitor in detail" }))
    expect((await screen.findAllByText("Couldn't add this target")).length).toBeGreaterThan(0)

    await user.selectOptions(screen.getByRole("combobox", { name: "Namespace" }), "other")
    await waitFor(() => expect(s.pods).toHaveBeenLastCalledWith("kind", "other"))
    await user.selectOptions(screen.getByRole("combobox", { name: "Context" }), "kind")
  })

  it("is honest about optional metrics and restricted access", async () => {
    const s = kubeSpies()
    s.access.mockResolvedValue({ listPods: false, readLogs: false, exec: false })
    s.logs.mockRejectedValue(new Error("Forbidden"))
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Kubernetes" }))
    expect(await screen.findByText(/doesn't include listing pods, reading logs, running a collector/)).toBeInTheDocument()
    await user.click(await screen.findByRole("button", { name: /^api \/ proxy/ }))
    expect(await screen.findByText("This cluster has no metrics API available right now.")).toBeInTheDocument()
    expect(await screen.findByText("Error: Forbidden")).toBeInTheDocument()
    expect(screen.getByRole("button", { name: "Monitor in detail" }), "exec isn't permitted").toBeDisabled()
  })

  it("tells a running container with no measurement yet from a missing metrics API", async () => {
    const s = kubeSpies()
    s.metrics.mockResolvedValue([])
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Kubernetes" }))
    await user.click(await screen.findByRole("button", { name: /^api \/ app/ }))
    expect(await screen.findByText(/No measurement for this container yet/)).toBeInTheDocument()
    expect(screen.queryByText(/no metrics API/)).not.toBeInTheDocument()
  })

  it("reports failures, empty namespaces and missing logs", async () => {
    const s = kubeSpies()
    s.metrics.mockRejectedValue(new Error("metrics broke"))
    s.logs.mockResolvedValue("")
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Kubernetes" }))
    await user.click(await screen.findByRole("button", { name: /^api \/ app/ }))
    expect(await screen.findByText("Error: metrics broke")).toBeInTheDocument()
    expect(await screen.findByText("No logs recorded.")).toBeInTheDocument()
    expect(await screen.findByText(/on n1/)).toBeInTheDocument()
    s.pods.mockResolvedValue([])
    await user.selectOptions(screen.getByRole("combobox", { name: "Namespace" }), "other")
    expect(await screen.findByText("No pods in this namespace.")).toBeInTheDocument()
    s.pods.mockRejectedValue(new Error("pods forbidden"))
    await user.selectOptions(screen.getByRole("combobox", { name: "Namespace" }), "web")
    expect(await screen.findByText("Error: pods forbidden")).toBeInTheDocument()
  })

  it("handles a pod with no node yet, unlisted namespaces and a missing CLI", async () => {
    const s = kubeSpies()
    s.ns.mockRejectedValue(new Error("forbidden namespaces"))
    s.pods.mockResolvedValue([{ ...pod, node: "" }])
    const a = show()
    await a.user.click(screen.getByRole("radio", { name: "Kubernetes" }))
    expect(await screen.findByText(/Can't list namespaces/)).toBeInTheDocument()
    await a.user.click(await screen.findByRole("button", { name: /^api \/ app/ }))
    expect(await screen.findByText(/on an unknown node/)).toBeInTheDocument()
  })

  it("says when kubectl isn't there", async () => {
    kubeSpies()
    vi.spyOn(monitor, "kubeContexts").mockRejectedValue(new Error("`kubectl` isn't installed"))
    const { user } = show()
    await user.click(screen.getByRole("radio", { name: "Kubernetes" }))
    expect(await screen.findByText(/isn't installed/)).toBeInTheDocument()
  })
})
