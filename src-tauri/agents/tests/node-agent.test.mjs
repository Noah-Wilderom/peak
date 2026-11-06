import { test } from "node:test"
import assert from "node:assert/strict"
import { fileURLToPath } from "node:url"
import { startHub, run } from "./harness.mjs"

const agent = fileURLToPath(new URL("../peak-agent.cjs", import.meta.url))

// A small app with an obvious leak.
const APP = `
class LeakyThing { constructor(i) { this.payload = "x".repeat(256) + i } }
const keep = []
setInterval(() => { for (let i = 0; i < 2000; i++) keep.push(new LeakyThing(i)) }, 20)
setTimeout(() => process.exit(0), 60000)
`

test("node agent streams heap and GC data and answers requests", async () => {
  const hub = await startHub()
  const child = run(process.execPath, ["-e", APP], {
    PEAK_AGENT_ADDR: hub.addr,
    PEAK_AGENT_TOKEN: "tok-1",
    NODE_OPTIONS: `--require "${agent}"`,
  })
  try {
    const hello = await hub.waitFor((m) => m.type === "hello")
    assert.equal(hello.token, "tok-1")
    assert.equal(hello.pid, child.pid)
    assert.equal(hello.runtime, "node")

    const heap = await hub.waitFor((m) => m.type === "heap" && m.heapUsed > 0)
    assert.ok(heap.heapTotal >= heap.heapUsed)
    assert.ok(heap.external >= 0)

    const gc = await hub.waitFor((m) => m.type === "gc")
    assert.ok(["minor", "major"].includes(gc.kind))
    assert.ok(gc.pauseMs >= 0)
    assert.ok(gc.t > 1e12)

    const snap = await hub.request("snapshot", 1)
    assert.equal(snap.ok, true, snap.error)
    const leaky = snap.data.entries.find((e) => e.name === "LeakyThing")
    assert.ok(leaky, `LeakyThing missing from ${snap.data.entries.map((e) => e.name).join(", ")}`)
    assert.ok(leaky.count > 100)
    assert.ok(leaky.shallow > 0 && leaky.retained >= leaky.shallow)
    assert.ok(snap.data.entries.some((e) => e.name === "(string)"))
    assert.ok(snap.data.heapUsed > 0)
    assert.equal(snap.data.sites.name, "(root)")
    assert.ok(Array.isArray(snap.data.sites.children))

    const gcReply = await hub.request("gc", 2)
    assert.equal(gcReply.ok, true)

    const bad = await hub.request("nope", 3)
    assert.equal(bad.ok, false)
    assert.match(bad.error, /unknown command/)
  } finally {
    child.kill()
    await hub.close()
  }
})

function total(frame) {
  return frame.self + frame.children.reduce((sum, c) => sum + total(c), 0)
}

function findFrame(frame, name) {
  if (frame.name === name) return frame
  for (const c of frame.children) {
    const hit = findFrame(c, name)
    if (hit) return hit
  }
  return null
}

// Burns CPU in a named function, then blocks the loop for 150ms every 300ms.
const BUSY_APP = `
function burnCycles() { const end = Date.now() + 150; let x = 0; while (Date.now() < end) x += Math.sqrt(x + 1); return x }
setInterval(burnCycles, 300)
setTimeout(() => process.exit(0), 60000)
`

test("node agent reports event-loop lag and records CPU profiles alongside heap data", async () => {
  const hub = await startHub()
  // V8 can't see code it optimized on-stack (OSR) before the profiler started, so
  // that time is charged to the caller. Time stays correct; only attribution moves.
  // Disabling OSR keeps this assertion about tree structure deterministic.
  const child = run(process.execPath, ["--no-use-osr", "-e", BUSY_APP], {
    PEAK_AGENT_ADDR: hub.addr,
    PEAK_AGENT_TOKEN: "tok-2",
    NODE_OPTIONS: `--require "${agent}"`,
  })
  try {
    // A loop blocked for 150ms at a time must show lag well above an idle reading.
    const lagged = await hub.waitFor((m) => m.type === "heap" && m.loopLag > 50)
    assert.ok(lagged.loopLag < 5000, `implausible lag ${lagged.loopLag}`)

    const reply = await hub.request("cpuprofile", 10, { ms: 1000 })
    assert.equal(reply.ok, true, reply.error)
    const { durationMs, root, sampling } = reply.data
    assert.equal(sampling, "v8")
    assert.ok(durationMs >= 950 && durationMs < 5000, `duration ${durationMs}`)
    assert.equal(root.name, "(root)")
    const burn = findFrame(root, "burnCycles")
    assert.ok(burn, "the hot function appears in the call tree")
    assert.ok(burn.self > 100, `burnCycles self ${burn.self}ms`)
    assert.match(burn.file ?? "", /:\d+$/)
    const sum = total(root)
    assert.ok(sum > 0.5 * durationMs && sum < 1.2 * durationMs, `tree sums to ${sum}ms of ${durationMs}ms`)

    // Heap snapshots still work after profiling, and a second profile can run.
    const snap = await hub.request("snapshot", 11)
    assert.equal(snap.ok, true, snap.error)
    assert.ok(snap.data.entries.length > 0)

    const [a, b] = await Promise.all([hub.request("cpuprofile", 12, { ms: 300 }), hub.request("cpuprofile", 13, { ms: 300 })])
    assert.deepEqual([a.ok, b.ok].sort(), [false, true], "overlapping recordings are refused, not merged")
    assert.match((a.ok ? b : a).error, /already being recorded/)
    assert.equal((await hub.request("cpuprofile", 14, { ms: 100 })).ok, true)
  } finally {
    child.kill()
    await hub.close()
  }
})

test("node agent is inert without peak's environment", async () => {
  const child = run(process.execPath, ["-e", "console.log(typeof globalThis.__peakAgent)"], {
    NODE_OPTIONS: `--require "${agent}"`,
    PEAK_AGENT_ADDR: "",
  })
  let out = ""
  child.stdout.on("data", (d) => (out += d))
  const code = await new Promise((r) => child.on("exit", r))
  assert.equal(code, 0)
  assert.equal(out.trim(), "undefined")
})

test("node agent does not keep the host alive or crash it when the hub is gone", async () => {
  const child = run(process.execPath, ["-e", "setTimeout(() => {}, 200)"], {
    NODE_OPTIONS: `--require "${agent}"`,
    PEAK_AGENT_ADDR: "127.0.0.1:1",
    PEAK_AGENT_TOKEN: "t",
  })
  const code = await new Promise((r) => child.on("exit", r))
  assert.equal(code, 0)
})
