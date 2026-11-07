"use strict"
// peak runtime agent for Node.js — loaded with NODE_OPTIONS="--require …".
// Streams heap statistics and GC events to the peak app and answers heap
// snapshot / GC requests. It must never throw into, or keep alive, the host.
;(() => {
  const addr = process.env.PEAK_AGENT_ADDR
  const token = process.env.PEAK_AGENT_TOKEN
  if (!addr || !token || globalThis.__peakAgent) return
  globalThis.__peakAgent = true

  const net = require("node:net")
  const { PerformanceObserver, constants, monitorEventLoopDelay } = require("node:perf_hooks")
  const v8 = require("node:v8")
  let inspector = null
  try {
    inspector = require("node:inspector")
  } catch {}

  const sep = addr.lastIndexOf(":")
  const sock = net.connect({ host: addr.slice(0, sep), port: Number(addr.slice(sep + 1)) })
  sock.setNoDelay(true)
  sock.unref()
  sock.on("error", () => {})
  const send = (msg) => {
    if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n")
  }
  const canInspect = (() => {
    if (!inspector) return false
    try {
      const probe = new inspector.Session()
      probe.connect()
      probe.disconnect()
      return true
    } catch {
      return false
    }
  })()
  const noInspector = "This Node.js build has no usable inspector, which this needs."
  send({
    type: "hello",
    token,
    pid: process.pid,
    runtime: process.versions.bun ? "bun" : "node",
    agent: {
      runtimeVersion: process.versions.bun || process.versions.node,
      agentVersion: process.env.PEAK_AGENT_VERSION || "unknown",
      capabilities: ["heap", "gc", "lag", ...(canInspect ? ["cpu", "snapshot", "forcegc"] : [])],
      unavailable: canInspect ? {} : { cpu: noInspector, snapshot: noInspector, forcegc: noInspector },
      notes: {
        lag: "Event-loop delay, p99",
        cpu: "V8's sampling profiler. Time waiting on the event loop shows as (idle).",
        freed: "Change in used heap across the collection.",
      },
    },
  })

  // ─── heap stats ───
  let lastUsed = 0
  // Event-loop responsiveness. The histogram's resolution timer is subtracted so
  // an idle loop reads near zero rather than near the sampling period. Absent
  // (not zero) until the histogram has data or where the runtime lacks it.
  const LAG_RESOLUTION_MS = 10
  let delay = null
  try {
    delay = monitorEventLoopDelay({ resolution: LAG_RESOLUTION_MS })
    delay.enable()
  } catch {
    delay = null
  }
  const readLag = () => {
    if (!delay || delay.count === 0) return undefined
    const ms = Math.max(0, delay.percentile(99) / 1e6 - LAG_RESOLUTION_MS)
    delay.reset()
    return ms
  }
  const heap = () => {
    const m = process.memoryUsage()
    lastUsed = m.heapUsed
    send({ type: "heap", heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, loopLag: readLag() })
  }
  heap()
  setInterval(heap, 500).unref()

  // ─── GC events ───
  const MAJOR = (constants.NODE_PERFORMANCE_GC_MAJOR || 4) | (constants.NODE_PERFORMANCE_GC_INCREMENTAL || 8)
  try {
    const obs = new PerformanceObserver((list) => {
      const used = v8.getHeapStatistics().used_heap_size
      const freed = Math.max(0, lastUsed - used)
      lastUsed = used
      for (const e of list.getEntries()) {
        const kind = (e.detail && e.detail.kind) ?? e.kind
        send({
          type: "gc",
          kind: kind & MAJOR ? "major" : "minor",
          pauseMs: e.duration,
          freed,
          t: Math.round(performance.timeOrigin + e.startTime),
        })
      }
    })
    obs.observe({ entryTypes: ["gc"] })
  } catch {}

  // ─── inspector session: allocation sampling, snapshots, GC ───
  let session = null
  if (inspector) {
    try {
      session = new inspector.Session()
      session.connect()
      session.post("HeapProfiler.enable")
      session.post("HeapProfiler.startSampling", { samplingInterval: 32768 })
    } catch {
      session = null
    }
  }
  const post = (method, params) =>
    new Promise((resolve, reject) => session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res))))

  const CATEGORY = {
    closure: "(closure)",
    string: "(string)",
    "concatenated string": "(string)",
    "sliced string": "(string)",
    code: "(compiled code)",
    array: "(array)",
    hidden: "(system)",
    number: "(number)",
    regexp: "RegExp",
    bigint: "(bigint)",
    symbol: "(symbol)",
  }

  /** Aggregate a .heapsnapshot by constructor / category. */
  function summarize(raw) {
    const snap = JSON.parse(raw)
    const meta = snap.snapshot.meta
    const fields = meta.node_fields
    const types = meta.node_types[0]
    const nf = fields.length
    const iType = fields.indexOf("type")
    const iName = fields.indexOf("name")
    const iSize = fields.indexOf("self_size")
    const { nodes, strings } = snap
    const groups = new Map()
    for (let i = 0; i < nodes.length; i += nf) {
      const type = types[nodes[i + iType]]
      if (type === "synthetic") continue
      const name =
        CATEGORY[type] ?? (type === "object" || type === "native" ? strings[nodes[i + iName]] || "Object" : `(${type})`)
      const size = nodes[i + iSize]
      const g = groups.get(name)
      if (g) {
        g.count++
        g.shallow += size
      } else groups.set(name, { name, count: 1, shallow: size })
    }
    return [...groups.values()]
      .sort((a, b) => b.shallow - a.shallow)
      .slice(0, 60)
      .map((g) => ({ ...g, retained: g.shallow }))
  }

  function frames(node, min, depth) {
    const cf = node.callFrame
    const file = cf.url ? `${cf.url.replace(/^file:\/\//, "").split("/").slice(-2).join("/")}:${cf.lineNumber + 1}` : undefined
    const children = []
    let total = node.selfSize
    for (const c of node.children) {
      const f = frames(c, min, depth + 1)
      total += f.total
      if (f.total >= min && depth < 40) children.push(f.frame)
    }
    return { total, frame: { name: cf.functionName || (cf.url ? "(anonymous)" : "(root)"), file, self: node.selfSize, children } }
  }

  async function snapshot() {
    if (!session) throw new Error("node:inspector is unavailable in this runtime")
    const chunks = []
    const onChunk = (m) => chunks.push(m.params.chunk)
    session.on("HeapProfiler.addHeapSnapshotChunk", onChunk)
    try {
      await post("HeapProfiler.takeHeapSnapshot", { reportProgress: false })
    } finally {
      session.removeListener("HeapProfiler.addHeapSnapshotChunk", onChunk)
    }
    const entries = summarize(chunks.join(""))
    let sites
    try {
      const { profile } = await post("HeapProfiler.getSamplingProfile")
      const whole = frames(profile.head, 0, 0).total
      sites = frames(profile.head, whole * 0.002, 0).frame
      sites.name = "(root)"
    } catch {}
    return { heapUsed: process.memoryUsage().heapUsed, entries, sites }
  }

  /**
   * Convert a V8 CPU profile (flat nodes + hit counts) into a call tree whose
   * `self` is sampled milliseconds. Time comes from `timeDeltas`, attributed to
   * the sampled node, so the tree sums to the recording's elapsed time. Loop
   * waits land in (idle); synchronous blocking stays with the calling frame.
   */
  function cpuTree(profile) {
    const selfMs = new Map()
    const { samples = [], timeDeltas = [] } = profile
    for (let i = 0; i < samples.length; i++) {
      selfMs.set(samples[i], (selfMs.get(samples[i]) || 0) + (timeDeltas[i] || 0) / 1000)
    }
    const byId = new Map(profile.nodes.map((n) => [n.id, n]))
    const build = (node, depth) => {
      const cf = node.callFrame
      const file = cf.url ? `${cf.url.replace(/^file:\/\//, "").split("/").slice(-2).join("/")}:${cf.lineNumber + 1}` : undefined
      const children = []
      if (depth < 200) {
        for (const id of node.children || []) {
          const child = build(byId.get(id), depth + 1)
          // Drop subtrees that were never on-CPU; they carry no timing.
          if (child.self > 0 || child.children.length) children.push(child)
        }
      }
      return { name: cf.functionName || (cf.url ? "(anonymous)" : cf.functionName || "(root)"), file, self: selfMs.get(node.id) || 0, children }
    }
    const root = build(profile.nodes[0], 0)
    root.name = "(root)"
    return root
  }

  let profiling = false
  async function cpuprofile(ms) {
    if (!session) throw new Error("node:inspector is unavailable in this runtime")
    if (profiling) throw new Error("a CPU profile is already being recorded")
    profiling = true
    try {
      await post("Profiler.enable")
      await post("Profiler.setSamplingInterval", { interval: 1000 })
      await post("Profiler.start")
      const began = performance.now()
      await new Promise((r) => setTimeout(r, Math.max(1, Number(ms) || 1000)))
      const { profile } = await post("Profiler.stop")
      // V8's own range: starting the profiler can take a while on a busy machine, and samples from
      // that time count, so a timer started around the call would come up short of them.
      const range = (profile.endTime - profile.startTime) / 1000
      return { durationMs: range > 0 ? range : performance.now() - began, sampling: "v8", root: cpuTree(profile) }
    } finally {
      profiling = false
      post("Profiler.disable").catch(() => {})
    }
  }

  async function handle(line) {
    let req
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    try {
      let data = null
      if (req.cmd === "snapshot") data = await snapshot()
      else if (req.cmd === "cpuprofile") data = await cpuprofile(req.ms)
      else if (req.cmd === "gc") {
        if (!session) throw new Error("node:inspector is unavailable")
        await post("HeapProfiler.collectGarbage")
      } else throw new Error(`unknown command ${req.cmd}`)
      send({ type: "reply", reqId: req.reqId, ok: true, data })
    } catch (err) {
      send({ type: "reply", reqId: req.reqId, ok: false, error: String((err && err.message) || err) })
    }
  }

  let buf = ""
  sock.on("data", (d) => {
    buf += d
    let nl
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl)
      buf = buf.slice(nl + 1)
      void handle(line)
    }
  })

  module.exports = { summarize, frames, cpuTree }
})()
