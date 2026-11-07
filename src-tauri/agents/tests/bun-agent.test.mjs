import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { copyFileSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { startHub, run } from "./harness.mjs"

const agent = fileURLToPath(new URL("../bun/peak-agent-bun.js", import.meta.url))
const bun = process.env.PEAK_TEST_BUN || "bun"
const available = spawnSync(bun, ["--version"]).status === 0

const APP = `
class LeakyThing { constructor(i) { this.payload = "x".repeat(64) + i } }
const keep = []
function hotLoop() { let x = 0; const end = performance.now() + 50; while (performance.now() < end) x += Math.sqrt(x + 1); return x }
setInterval(() => { for (let i = 0; i < 200; i++) keep.push(new LeakyThing(i)); hotLoop() }, 60)
setTimeout(() => process.exit(0), 60000)
`

const flat = (f, out = []) => {
  out.push(f)
  for (const c of f.children) flat(c, out)
  return out
}

test("bun agent reports only what it measures and answers requests", { skip: !available }, async () => {
  const hub = await startHub()
  const child = run(bun, ["-e", APP], {
    PEAK_AGENT_ADDR: hub.addr,
    PEAK_AGENT_TOKEN: "tok-b",
    PEAK_AGENT_VERSION: "9.9.9",
    BUN_OPTIONS: `"--preload=${agent}"`,
  })
  try {
    const hello = await hub.waitFor((m) => m.type === "hello")
    assert.equal(hello.runtime, "bun")
    assert.equal(hello.pid, child.pid)
    assert.equal(hello.agent.agentVersion, "9.9.9")
    assert.match(hello.agent.runtimeVersion, /^\d+\.\d+\.\d+/)
    // Bun before 1.3.7 throws on any use of node:inspector, and the agent has to say so.
    const [major, minor, patch] = hello.agent.runtimeVersion.split(".").map(Number)
    const hasCpu = major > 1 || minor > 3 || (minor === 3 && patch >= 7)
    assert.deepEqual([...hello.agent.capabilities].sort(), [...(hasCpu ? ["cpu"] : []), "forcegc", "heap", "lag", "snapshot"])
    if (!hasCpu) assert.match(hello.agent.unavailable.cpu, /1\.3\.7/)
    assert.ok(hello.agent.unavailable.gc, "says why there are no GC events")

    const heap = await hub.waitFor((m) => m.type === "heap" && typeof m.loopLag === "number")
    assert.ok(heap.heapUsed > 0 && heap.heapTotal >= heap.heapUsed)
    // Busy for 50 ms at a stretch, which a 20 ms timer can't miss.
    await hub.waitFor((m) => m.type === "heap" && m.loopLag > 10)
    const gauges = await hub.waitFor((m) => m.type === "gauges")
    assert.ok(gauges.values.find((g) => g.name === "Live objects").value > 100)

    if (hasCpu) {
      const cpu = await hub.request("cpuprofile", 1, { ms: 1500 })
      assert.equal(cpu.ok, true, cpu.error)
      assert.equal(cpu.data.sampling, "jsc")
      assert.ok(cpu.data.durationMs >= 1400)
      const frames = flat(cpu.data.root)
      const hot = frames.find((f) => f.name === "hotLoop")
      assert.ok(hot, `no hotLoop in ${frames.map((f) => f.name)}`)
      const sampled = frames.reduce((sum, f) => sum + f.self, 0)
      assert.ok(sampled > 100 && sampled < 5000, `sampled ${sampled} ms in 1.5 s`)
      assert.ok(hot.self > 50, `hotLoop self ${hot.self} ms`)
    }

    const snap = await hub.request("snapshot", 2)
    assert.equal(snap.ok, true, snap.error)
    assert.ok(snap.data.heapUsed > 0)
    const leaky = snap.data.entries.find((e) => e.name === "LeakyThing")
    assert.ok(leaky && leaky.count > 50, JSON.stringify(snap.data.entries.slice(0, 5)))
    assert.equal(snap.data.sites, undefined, "no allocation stacks are claimed")

    assert.equal((await hub.request("gc", 3)).ok, true)
    assert.equal((await hub.request("nope", 4)).ok, false)
    assert.ok(!hub.messages.some((m) => m.type === "gc"), "no collections are invented")
  } finally {
    child.kill("SIGKILL")
    await hub.close()
  }
})

test("bun agent stays out of the way", { skip: !available }, async () => {
  const hub = await startHub()
  const env = { ...process.env, PEAK_AGENT_ADDR: hub.addr, PEAK_AGENT_TOKEN: "t", BUN_OPTIONS: `"--preload=${agent}"` }
  // Lets the program finish on its own, and its exit code through.
  const done = await new Promise((resolve) => {
    const c = run(bun, ["-e", "process.exit(7)"], env)
    c.on("exit", resolve)
  })
  assert.equal(done, 7)
  await new Promise((resolve, reject) => {
    const c = run(bun, ["-e", "console.log(1)"], env)
    const t = setTimeout(() => reject(new Error("the agent kept the program alive")), 15000)
    c.on("exit", () => {
      clearTimeout(t)
      resolve()
    })
  })
  // With no hub, a program runs as usual.
  const alone = spawnSync(bun, ["-e", "console.log('ok')"], { env: { ...env, PEAK_AGENT_ADDR: "127.0.0.1:1" } })
  assert.equal(alone.status, 0)
  assert.match(String(alone.stdout), /ok/)
  // Bun's other commands still work with the agent in place.
  const help = spawnSync(bun, ["install", "--help"], { env })
  assert.equal(help.status, 0)
  await hub.close()
})

// macOS keeps the agent under "Application Support", and Bun drops a preload that's quoted any other way.
test("bun loads the agent from a path with a space, next to a user's own options", { skip: !available }, async () => {
  const dir = mkdtempSync(join(tmpdir(), "peak agent with space "))
  const spaced = join(dir, "peak-agent-bun.js")
  copyFileSync(agent, spaced)
  const hub = await startHub()
  const child = run(bun, ["-e", "setTimeout(() => {}, 20000)"], {
    PEAK_AGENT_ADDR: hub.addr,
    PEAK_AGENT_TOKEN: "t",
    BUN_OPTIONS: `"--preload=${spaced.replaceAll("\\", "/")}" --smol`,
  })
  try {
    const hello = await hub.waitFor((m) => m.type === "hello")
    assert.equal(hello.runtime, "bun")
    if (process.env.PEAK_TEST_BUN_VERSION) assert.equal(hello.agent.runtimeVersion, process.env.PEAK_TEST_BUN_VERSION)
  } finally {
    child.kill("SIGKILL")
    await hub.close()
  }
})
