// Real programs of every runtime through the installed app and a separate CLI process.
import { spawnSync } from "node:child_process"
import { IS_WINDOWS, PLATFORM, cli, dataDir, join, log, mkdtempSync, shot, sleep, storedRunById, storedSamples, tmpdir, waitFor, writeFileSync } from "./lib.mjs"

/** `PEAK_SMOKE_REQUIRE` lists the runtimes that have to be here: a missing one fails rather than being skipped. */
export async function runProbes({ check, record, out, only }) {
  const wanted = (name) => !only || only.includes(name)
  const versionNumber = (await cli(["--version"]).done).out.match(/\d+\.\d+\.\d+/)?.[0]
  const required = (process.env.PEAK_SMOKE_REQUIRE ?? "").split(",").filter(Boolean)
  const works = (bin, ...args) => spawnSync(bin, args, { encoding: "utf8", shell: IS_WINDOWS }).status === 0
  const sourceDir = () => mkdtempSync(join(tmpdir(), "peak runtime "))
  const flatten = (f, out = []) => (out.push(f), (f.children ?? []).forEach((c) => flatten(c, out)), out)
  const asJson = (text) => {
    try {
      return JSON.parse(text)
    } catch {
      return null
    }
  }

  /**
   * One real program of a runtime through the installed app and a separate CLI process: the agent
   * says what it is, its profiles hold the program's own functions, what it can't do is refused for
   * a reason, the app shows it, and all of it is still in the database once the program has ended.
   */
  async function probeRuntime({ name, runtime, command, cwd, frame, caps, missing = [], sampling, lag, entry, gauges = false }) {
    const label = (what) => `${name}: ${what}`
    const id = command.find((part) => part.includes("work-"))
    const running = cli(["run", "--", ...command], { cwd })
    const found = await waitFor(`the ${name} run's agent`, async () => {
      const runs = asJson((await cli(["ps", "--json"]).done).out) ?? []
      return runs.find((r) => r.command.includes(id) && r.profiling) ?? null
    }, 90_000).catch((e) => (check(label("agent connected"), false, e.message), null))
    if (!found) {
      await running.done
      return
    }
    const agent = found.agent ?? {}
    record[label("identity")] = { ok: true, detail: agent }
    check(label("identifies its runtime and agent"), found.runtime === runtime && /^\d/.test(agent.runtimeVersion ?? "") && agent.agentVersion === versionNumber, `${found.runtime} ${agent.runtimeVersion}, agent ${agent.agentVersion}`)
    for (const c of caps) check(label(`offers ${c}`), agent.capabilities?.includes(c), (agent.capabilities ?? []).join(","))
    for (const c of missing) check(label(`says why there's no ${c}`), !agent.capabilities?.includes(c) && !!agent.unavailable?.[c], agent.unavailable?.[c])

    if (caps.includes("cpu")) {
      const cpu = await cli(["profile", found.id, "--ms", "2000", "--json"]).done
      const profile = asJson(cpu.out)
      const frames = profile ? flatten(profile.root) : []
      const sampled = frames.reduce((sum, f) => sum + (f.self ?? 0), 0)
      check(label("CPU profile holds the program's own function, in milliseconds"), frames.some((f) => f.name.includes(frame)) && sampled > 100 && sampled < 20_000 && profile.durationMs >= 1900, `${profile?.sampling}, ${Math.round(sampled)} ms sampled in ${Math.round(profile?.durationMs)} ms: ${cpu.err.trim()}`)
      if (sampling) check(label("says how it sampled"), sampling.includes(profile?.sampling), profile?.sampling)
    } else {
      const cpu = await cli(["profile", found.id, "--ms", "500"]).done
      check(label("a CPU profile is refused, with how to get one"), cpu.code === 1 && cpu.err.includes(agent.unavailable?.cpu ?? "?"), cpu.err.trim())
    }
    if (caps.includes("snapshot")) {
      const snap = await cli(["profile", found.id, "--snapshot", "--json"]).done
      const heap = asJson(snap.out)
      check(label("heap snapshot holds what the program allocated"), heap?.heapUsed > 0 && heap.entries.some((e) => e.name.includes(entry)), `${heap?.entries?.length} entries, top ${heap?.entries?.[0]?.name}: ${snap.err.trim()}`)
    } else {
      const snap = await cli(["profile", found.id, "--snapshot"]).done
      check(label("a snapshot is refused, with the reason"), snap.code === 1 && snap.err.includes(agent.unavailable?.snapshot ?? "?"), snap.err.trim())
    }
    if (caps.includes("forcegc")) {
      const gc = await cli(["profile", found.id, "--gc"]).done
      check(label("forces a collection"), gc.code === 0, gc.err.trim())
    }
    // What a person would see. The full-size capture is kept with the evidence.
    const opened = await cli(["open", found.id]).done
    check(label("the app opens its profiler"), opened.code === 0, opened.err.trim())
    await sleep(2500)
    shot(out, `${PLATFORM}-${name}-profiler`)

    const ended = await running.done
    check(label("the program's exit code is its own"), ended.code === 0, `exit ${ended.code}: ${ended.err.split("\n")[0]}`)
    const stored = await waitFor(`the ${name} run stored`, () => {
      const r = storedRunById(found.id)
      return r && r.meta.status !== "running" && r.exit_code !== null ? r : null
    }, 30_000).catch((e) => (check(label("stored"), false, e.message), null))
    if (stored) {
      const kept = stored.meta.agent ?? {}
      check(label("history keeps what the agent reported"), kept.agentVersion === versionNumber && kept.runtimeVersion === agent.runtimeVersion && (!gauges || (kept.gauges ?? []).length > 0), JSON.stringify(kept.gauges))
      if (caps.includes("cpu")) check(label("history keeps the CPU profile"), stored.cpuProfiles >= 1, `${stored.cpuProfiles}`)
      if (caps.includes("snapshot")) check(label("history keeps the snapshot"), stored.snapshots >= 1, `${stored.snapshots}`)
      const samples = storedSamples(id)
      if (lag) check(label("delay reached the samples"), samples.some((s) => typeof s.loopLag === "number"), `${samples.filter((s) => typeof s.loopLag === "number").length} of ${samples.length}`)
      else check(label("no delay is claimed"), !samples.some((s) => typeof s.loopLag === "number"))
      if (caps.includes("heap")) check(label("live heap reached the samples"), samples.some((s) => s.heap > 0))
      if (caps.includes("gc")) check(label("collections are stored"), stored.gc > 0, `${stored.gc}`)
      else check(label("no collections are invented"), stored.gc === 0, `${stored.gc}`)
    }
  }

  function requireRuntime(name, available) {
    if (available) return true
    if (required.includes(name)) check(`${name} is here to test`, false)
    else log(`no ${name} on this machine: its agent wasn't checked`)
    return false
  }

  const SECONDS = 18
  const nodeId = `work-node-${Date.now()}.js`
  if (wanted("node") && requireRuntime("node", works("node", "--version"))) {
    const dir = sourceDir()
    writeFileSync(join(dir, nodeId), `class SmokeThing { constructor(i) { this.v = "x".repeat(64) + i } }\nconst keep = []\nfunction busyWork() { const e = Date.now() + 40; while (Date.now() < e); for (let i = 0; i < 100; i++) keep.push(new SmokeThing(i)) }\nconst t = setInterval(busyWork, 50)\nsetTimeout(() => { clearInterval(t) }, ${SECONDS * 1000})\n`)
    await probeRuntime({ name: "node", runtime: "node", command: ["node", nodeId], cwd: dir, frame: "busyWork", entry: "SmokeThing", caps: ["heap", "gc", "lag", "cpu", "snapshot", "forcegc"], sampling: ["v8"], lag: true })
  }

  const python = ["python3", "python"].find((p) => works(p, "--version"))
  if (wanted("python") && requireRuntime("python", python)) {
    const dir = sourceDir()
    const script = `work-py-${Date.now()}.py`
    writeFileSync(join(dir, script), `import time\nclass SmokeThing:\n    pass\nkeep = []\ndef busy_work():\n    e = time.time() + 0.04\n    while time.time() < e:\n        pass\n    keep.extend(SmokeThing() for _ in range(50))\nend = time.time() + ${SECONDS}\nwhile time.time() < end:\n    busy_work()\n    time.sleep(0.01)\n`)
    await probeRuntime({ name: "python", runtime: "python", command: [python, script], cwd: dir, frame: "busy_work", entry: "SmokeThing", caps: ["gc", "lag", "cpu", "snapshot", "forcegc"], missing: ["heap"], sampling: ["stack"], lag: true })
  }

  if (wanted("bun") && requireRuntime("bun", works("bun", "--version"))) {
    const dir = sourceDir()
    const script = `work-bun-${Date.now()}.js`
    writeFileSync(join(dir, script), `class SmokeThing { constructor(i) { this.v = "x".repeat(64) + i } }\nconst keep = []\nfunction busyWork() { const e = Date.now() + 40; while (Date.now() < e); for (let i = 0; i < 100; i++) keep.push(new SmokeThing(i)) }\nconst t = setInterval(busyWork, 50)\nsetTimeout(() => { clearInterval(t) }, ${SECONDS * 1000})\n`)
    await probeRuntime({ name: "bun", runtime: "bun", command: ["bun", script], cwd: dir, frame: "busyWork", entry: "SmokeThing", caps: ["heap", "lag", "cpu", "snapshot", "forcegc"], missing: ["gc"], sampling: ["jsc"], lag: true, gauges: true })
  }

  if (wanted("php") && requireRuntime("php", works("php", "--version"))) {
    const excimer = (spawnSync("php", ["-m"], { encoding: "utf8", shell: IS_WINDOWS }).stdout ?? "").toLowerCase().includes("excimer")
    if (!excimer && required.includes("php-excimer")) check("Excimer is here to test", false)
    const dir = sourceDir()
    writeFileSync(join(dir, "timed.php"), `<?php echo isset(gc_status()['collector_time']) ? 'yes' : 'no';`)
    const timed = spawnSync("php", ["timed.php"], { cwd: dir, encoding: "utf8", shell: IS_WINDOWS }).stdout === "yes"
    const script = `work-php-${Date.now()}.php`
    const seconds = excimer ? SECONDS : 3
    writeFileSync(join(dir, script), `<?php\nclass SmokeThing { public $other; }\nfunction busy_work() { $e = microtime(true) + 0.04; while (microtime(true) < $e) { } for ($i = 0; $i < 20000; $i++) { $a = new SmokeThing; $b = new SmokeThing; $a->other = $b; $b->other = $a; } }\n$end = microtime(true) + ${seconds};\nwhile (microtime(true) < $end) { busy_work(); }\n`)
    if (excimer) {
      await probeRuntime({ name: "php", runtime: "php", command: ["php", script], cwd: dir, frame: "busy_work", entry: "", caps: ["heap", "cpu", "forcegc", ...(timed ? ["gc"] : [])], missing: ["lag", "snapshot"], sampling: ["excimer-cpu", "excimer-wall"], lag: false, gauges: true })
    } else {
      await probeRuntime({ name: "php-without-excimer", runtime: "php", command: ["php", script], cwd: dir, frame: "busy_work", entry: "", caps: [], missing: ["heap", "gc", "cpu", "forcegc", "lag", "snapshot"], lag: false, gauges: true })
    }
  }

  if (wanted("go") && requireRuntime("go", works("go", "version"))) {
    // Built against the copy installed with the app, as a compiled program, run directly.
    const dir = sourceDir()
    const binary = `work-go-${Date.now()}${IS_WINDOWS ? ".exe" : ""}`
    const sdk = join(dataDir(), "agents", "go").replaceAll("\\", "/")
    writeFileSync(join(dir, "go.mod"), `module smoke\n\ngo 1.21\n\nrequire github.com/Noah-Wilderom/peak/sdk/go v0.0.0\n\nreplace github.com/Noah-Wilderom/peak/sdk/go => "${sdk}"\n`)
    writeFileSync(join(dir, "main.go"), `package main\n\nimport (\n\t"runtime"\n\t"time"\n\n\t_ "github.com/Noah-Wilderom/peak/sdk/go/auto"\n)\n\ntype smokeThing struct{ data [256]byte }\n\nvar keep []*smokeThing\n\n//go:noinline\nfunc smokeAlloc() { for i := 0; i < 2000; i++ { keep = append(keep, new(smokeThing)) } }\n\n//go:noinline\nfunc busyWork() int { x := 0; e := time.Now().Add(40 * time.Millisecond); for time.Now().Before(e) { x++ }; return x }\n\nfunc main() {\n\truntime.MemProfileRate = 4096\n\tend := time.Now().Add(${SECONDS} * time.Second)\n\tfor time.Now().Before(end) { busyWork(); smokeAlloc(); time.Sleep(5 * time.Millisecond) }\n}\n`)
    const built = spawnSync("go", ["build", "-o", binary, "."], { cwd: dir, encoding: "utf8", shell: IS_WINDOWS })
    check("go: a program builds against the installed SDK", built.status === 0, built.stderr?.trim())
    if (built.status === 0) {
      await probeRuntime({ name: "go", runtime: "go", command: [join(dir, binary)], cwd: dir, frame: "main.busyWork", entry: "smokeAlloc", caps: ["heap", "gc", "lag", "cpu", "snapshot", "forcegc"], sampling: ["pprof"], lag: true, gauges: true })
      // Without the import there's nothing Peak can do, and it says so rather than pretending.
      writeFileSync(join(dir, "main.go"), `package main\n\nimport "time"\n\nfunc main() { time.Sleep(6 * time.Second) }\n`)
      const plain = `work-plain-${Date.now()}${IS_WINDOWS ? ".exe" : ""}`
      spawnSync("go", ["build", "-o", plain, "."], { cwd: dir, encoding: "utf8", shell: IS_WINDOWS })
      const running = cli(["run", "--", join(dir, plain)], { cwd: dir })
      const listed = await waitFor("the plain Go run", async () => (asJson((await cli(["ps", "--json"]).done).out) ?? []).find((r) => r.command.includes(plain)) ?? null, 15_000).catch(() => null)
      const refused = listed ? await cli(["profile", listed.id, "--ms", "500"]).done : { code: -1, err: "never listed" }
      check("go: a program without the import has no agent, and that's what's reported", listed && !listed.agent && !listed.profiling && refused.code === 1 && /no profiling agent/.test(refused.err), refused.err.trim())
      await running.done
    }
  }
  const setup = await cli(["agents"]).done
  check("explains how to profile each runtime", setup.code === 0 && ["Go", "Bun", "PHP", "Python", "Node.js"].every((r) => setup.out.includes(r)), setup.out.split("\n")[0])
}
