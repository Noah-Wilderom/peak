// peak runtime agent for Bun, loaded with BUN_OPTIONS="--preload=…".
// Reports heap figures and timer delay and answers CPU profile, heap snapshot and GC requests.
// It must never throw into, or keep alive, the host.
const start = () => {
  const addr = process.env.PEAK_AGENT_ADDR
  const token = process.env.PEAK_AGENT_TOKEN
  if (!addr || !token || globalThis.__peakAgent || typeof Bun === "undefined" || !Bun.isMainThread) return
  globalThis.__peakAgent = true

  const net = require("node:net")
  const jsc = require("bun:jsc")
  let inspector = null
  try {
    inspector = require("node:inspector")
  } catch {}

  const capabilities = ["heap", "lag", "snapshot", "forcegc"]
  const unavailable = { gc: "Bun doesn't publish individual garbage collections, so none are listed." }
  if (inspector) capabilities.push("cpu")
  else unavailable.cpu = "This version of Bun has no node:inspector, which CPU profiles need."

  const sep = addr.lastIndexOf(":")
  const sock = net.connect({ host: addr.slice(0, sep), port: Number(addr.slice(sep + 1)) })
  sock.setNoDelay(true)
  sock.unref()
  sock.on("error", () => {})
  const send = (msg) => {
    if (!sock.destroyed) sock.write(JSON.stringify(msg) + "\n")
  }
  send({
    type: "hello",
    token,
    pid: process.pid,
    runtime: "bun",
    agent: {
      runtimeVersion: Bun.version,
      agentVersion: process.env.PEAK_AGENT_VERSION || "unknown",
      capabilities,
      unavailable,
      notes: {
        lag: "How late a 20 ms timer fired, p99",
        cpu: "JavaScriptCore's sampling profiler. Time waiting on the event loop shows as (idle) or (program).",
        snapshot: "Objects by type, from JavaScriptCore's heap. Bun has no allocation stacks here, and retained size equals own size.",
      },
    },
  })

  // ─── heap and delay ───
  const LAG_PERIOD_MS = 20
  let late = []
  let expected = performance.now() + LAG_PERIOD_MS
  setInterval(() => {
    const now = performance.now()
    late.push(Math.max(0, now - expected))
    expected = now + LAG_PERIOD_MS
  }, LAG_PERIOD_MS).unref()
  const readLag = () => {
    if (!late.length) return undefined
    const sorted = late.sort((a, b) => a - b)
    late = []
    return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * 0.99) - 1)]
  }

  const heap = () => {
    const m = process.memoryUsage()
    send({ type: "heap", heapUsed: m.heapUsed, heapTotal: m.heapTotal, external: m.external, loopLag: readLag() })
  }
  heap()
  setInterval(heap, 500).unref()

  // Walks the heap, so far less often than the rest.
  const gauges = () => {
    const s = jsc.heapStats()
    send({
      type: "gauges",
      values: [
        { name: "Live objects", value: s.objectCount, unit: "count" },
        { name: "Protected objects", value: s.protectedObjectCount, unit: "count" },
        { name: "Extra memory", value: s.extraMemorySize, unit: "bytes" },
      ],
    })
  }
  setTimeout(gauges, 250).unref()
  setInterval(gauges, 5000).unref()

  // ─── profiles ───
  const post = (session, method, params) =>
    new Promise((resolve, reject) => session.post(method, params || {}, (err, res) => (err ? reject(err) : resolve(res))))

  const tree = (profile) => {
    const { samples = [], timeDeltas = [] } = profile
    const selfMs = new Map()
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
          if (child.self > 0 || child.children.length) children.push(child)
        }
      }
      return { name: cf.functionName || (cf.url ? "(anonymous)" : "(program)"), file, self: selfMs.get(node.id) || 0, children }
    }
    const root = build(profile.nodes[0], 0)
    root.name = "(root)"
    return root
  }

  let profiling = false
  const cpuprofile = async (ms) => {
    if (!inspector) throw new Error(unavailable.cpu)
    if (profiling) throw new Error("a CPU profile is already being recorded")
    profiling = true
    const session = new inspector.Session()
    try {
      session.connect()
      await post(session, "Profiler.enable")
      await post(session, "Profiler.setSamplingInterval", { interval: 1000 })
      await post(session, "Profiler.start")
      const began = performance.now()
      await new Promise((r) => setTimeout(r, Math.max(1, Number(ms) || 1000)))
      const { profile } = await post(session, "Profiler.stop")
      return { durationMs: performance.now() - began, sampling: "jsc", root: tree(profile) }
    } finally {
      profiling = false
      try {
        session.disconnect()
      } catch {}
    }
  }

  const CATEGORY = { closure: "(closure)", string: "(string)", "concatenated string": "(string)", "sliced string": "(string)", code: "(compiled code)", array: "(array)", hidden: "(system)", number: "(number)", regexp: "RegExp", bigint: "(bigint)", symbol: "(symbol)" }

  const summarize = (raw) => {
    const snap = JSON.parse(raw)
    const { node_fields: fields, node_types: nodeTypes } = snap.snapshot.meta
    const types = nodeTypes[0]
    const nf = fields.length
    const iType = fields.indexOf("type")
    const iName = fields.indexOf("name")
    const iSize = fields.indexOf("self_size")
    const groups = new Map()
    for (let i = 0; i < snap.nodes.length; i += nf) {
      const type = types[snap.nodes[i + iType]]
      if (type === "synthetic") continue
      const name = CATEGORY[type] ?? (type === "object" || type === "native" ? snap.strings[snap.nodes[i + iName]] || "Object" : `(${type})`)
      const size = snap.nodes[i + iSize]
      const g = groups.get(name)
      if (g) {
        g.count++
        g.shallow += size
      } else groups.set(name, { name, count: 1, shallow: size })
    }
    return [...groups.values()].sort((a, b) => b.shallow - a.shallow).slice(0, 60).map((g) => ({ ...g, retained: g.shallow }))
  }

  const snapshot = () => ({ heapUsed: process.memoryUsage().heapUsed, entries: summarize(Bun.generateHeapSnapshot("v8")) })

  const handle = async (line) => {
    let req
    try {
      req = JSON.parse(line)
    } catch {
      return
    }
    try {
      let data = null
      if (req.cmd === "snapshot") data = snapshot()
      else if (req.cmd === "cpuprofile") data = await cpuprofile(req.ms)
      else if (req.cmd === "gc") Bun.gc(true)
      else throw new Error(`unknown command ${req.cmd}`)
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
}

try {
  start()
} catch {}
