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
