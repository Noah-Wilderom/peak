import { test } from "node:test"
import assert from "node:assert/strict"
import { spawnSync } from "node:child_process"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, delimiter } from "node:path"
import { fileURLToPath } from "node:url"
import { startHub, run } from "./harness.mjs"

const agent = fileURLToPath(new URL("../php/peak-agent.php", import.meta.url))
const php = process.env.PEAK_TEST_PHP || "php"
const excimer = process.env.PEAK_TEST_EXCIMER ? ["-d", `extension=${process.env.PEAK_TEST_EXCIMER}`] : []
const available = spawnSync(php, ["--version"]).status === 0
const has = (flags) => String(spawnSync(php, [...flags, "-m"]).stdout).toLowerCase().includes("excimer")
const hasExcimer = available && has(excimer)
const noExcimer = available && !has([])

const dir = mkdtempSync(join(tmpdir(), "peak-php-"))
writeFileSync(join(dir, "peak.ini"), `auto_prepend_file="${agent.replaceAll("\\", "/")}"\n`)
const scan = `${delimiter}${dir}`

const script = (name, text) => {
  const p = join(dir, name)
  writeFileSync(p, text)
  return p
}

const LIVE = `<?php
class Node2 { public $other; }
function hot_loop() { $x = 0.0; $end = microtime(true) + 0.05; while (microtime(true) < $end) { $x += sqrt($x + 1); } return $x; }
function make_cycles() { for ($i = 0; $i < 20000; $i++) { $a = new Node2; $b = new Node2; $a->other = $b; $b->other = $a; } }
$keep = [];
$end = microtime(true) + 60;
while (microtime(true) < $end) { hot_loop(); make_cycles(); $keep[] = str_repeat("x", 4096); }
`

const flat = (f, out = []) => {
  out.push(f)
  for (const c of f.children) flat(c, out)
  return out
}

test("php agent with Excimer reports live and profiles", { skip: !hasExcimer }, async () => {
  const hub = await startHub()
  const child = run(php, [...excimer, script("live.php", LIVE)], {
    PEAK_AGENT_ADDR: hub.addr,
    PEAK_AGENT_TOKEN: "tok-p",
    PEAK_AGENT_VERSION: "9.9.9",
    PHP_INI_SCAN_DIR: scan,
  })
  try {
    const hello = await hub.waitFor((m) => m.type === "hello")
    assert.equal(hello.runtime, "php")
    assert.equal(hello.pid, child.pid)
    assert.equal(hello.agent.agentVersion, "9.9.9")
    assert.match(hello.agent.runtimeVersion, /^\d+\.\d+\.\d+/)
    for (const c of ["heap", "cpu", "forcegc"]) assert.ok(hello.agent.capabilities.includes(c), c)
    assert.ok(!hello.agent.capabilities.includes("lag"))
    assert.ok(!hello.agent.capabilities.includes("snapshot"))
    assert.ok(hello.agent.unavailable.lag && hello.agent.unavailable.snapshot)

    const first = await hub.waitFor((m) => m.type === "heap")
    assert.ok(first.heapUsed > 0 && first.heapTotal >= first.heapUsed)
    assert.equal(first.loopLag, undefined, "no delay is claimed")
    await hub.waitFor((m) => m.type === "heap" && m.heapUsed > first.heapUsed)
    const gauges = await hub.waitFor((m) => m.type === "gauges" && m.values.find((g) => g.name === "Collector runs").value > 0)
    assert.ok(gauges.values.find((g) => g.name === "Values collected").value > 0)
    if (hello.agent.capabilities.includes("gc")) {
      const gc = await hub.waitFor((m) => m.type === "gc")
      assert.ok(gc.pauseMs > 0, "a real pause")
      assert.equal(gc.freed, 0)
      assert.ok(hello.agent.unavailable.gcFreed, "and freed bytes are marked as not measured")
    } else {
      assert.ok(hello.agent.unavailable.gc)
    }

    const cpu = await hub.request("cpuprofile", 1, { ms: 1000 })
    assert.equal(cpu.ok, true, cpu.error)
    assert.match(cpu.data.sampling, /^excimer-(cpu|wall)$/)
    assert.ok(cpu.data.durationMs >= 950 && cpu.data.durationMs < 4000, String(cpu.data.durationMs))
    const frames = flat(cpu.data.root)
    assert.ok(frames.some((f) => f.name === "hot_loop"), frames.map((f) => f.name).join())
    assert.ok(frames.some((f) => f.name === "make_cycles"))
    assert.ok(!frames.some((f) => f.name.includes("PeakAgent")), "the agent isn't part of the profile")
    const sampled = frames.reduce((sum, f) => sum + f.self, 0)
    assert.ok(sampled > 300 && sampled < 4000, `sampled ${sampled} ms in 1 s`)

    const before = (await hub.request("gc", 2))
    assert.equal(before.ok, true)
    const snap = await hub.request("snapshot", 3)
    assert.equal(snap.ok, false)
    assert.equal((await hub.request("nope", 4)).ok, false)
  } finally {
    child.kill("SIGKILL")
    await hub.close()
  }
})

test("php agent without Excimer says so, and reports at exit", { skip: !noExcimer }, async () => {
  const hub = await startHub()
  const child = run(php, [script("short.php", `<?php $a = str_repeat("x", 3000000); echo "done"; exit(3);`)], {
    PEAK_AGENT_ADDR: hub.addr,
    PEAK_AGENT_TOKEN: "t",
    PHP_INI_SCAN_DIR: scan,
  })
  const code = await new Promise((r) => child.on("exit", r))
  assert.equal(code, 3, "exit status is the program's")
  const hello = await hub.waitFor((m) => m.type === "hello")
  assert.deepEqual(hello.agent.capabilities, [])
  for (const c of ["heap", "gc", "cpu", "forcegc"]) assert.match(hello.agent.unavailable[c], /pecl install excimer/)
  const gauges = await hub.waitFor((m) => m.type === "gauges")
  assert.ok(gauges.values.find((g) => g.name === "Peak memory").value >= 3000000)
  assert.ok(!hub.messages.some((m) => m.type === "heap"), "no live figures are claimed")
  await hub.close()
})

test("php agent keeps programs and their own prepend file working", { skip: !available }, async () => {
  // Outside Peak it does nothing.
  const alone = spawnSync(php, ["-r", 'echo class_exists("PeakAgent\\\\Agent", false) ? "yes" : "no";'], {
    env: { ...process.env, PHP_INI_SCAN_DIR: scan, PEAK_AGENT_ADDR: "" },
  })
  assert.equal(alone.status, 0)
  // A hub that can't be reached changes nothing.
  const prog = script("hello.php", `<?php echo "ran:" . (defined("USER_PREPEND") ? "prepended" : "alone");`)
  const env = { ...process.env, PEAK_AGENT_ADDR: "127.0.0.1:1", PEAK_AGENT_TOKEN: "t" }
  const unreachable = spawnSync(php, [prog], { env: { ...env, PHP_INI_SCAN_DIR: scan } })
  assert.equal(String(unreachable.stdout), "ran:alone")

  // A prepend file set in the user's own ini still runs.
  const own = script("own.php", `<?php define("USER_PREPEND", true);`)
  const iniDir = mkdtempSync(join(tmpdir(), "peak-php-user-"))
  writeFileSync(join(iniDir, "user.ini"), `auto_prepend_file="${own.replaceAll("\\", "/")}"\n`)
  const both = spawnSync(php, [prog], { env: { ...env, PHP_INI_SCAN_DIR: `${iniDir}${delimiter}${dir}` } })
  assert.equal(String(both.stdout), "ran:prepended", String(both.stderr))
})
