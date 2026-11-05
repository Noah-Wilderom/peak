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
  const { PerformanceObserver, constants } = require("node:perf_hooks")
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
  send({ type: "hello", token, pid: process.pid, runtime: process.versions.bun ? "bun" : "node" })

  // ─── heap stats ───
  let lastUsed = 0
  const heap = () => {
    const m = process.memoryUsage()
    lastUsed = m.heapUsed
    send({ type: "heap", heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external })
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

  module.exports = { summarize, frames }
})()
