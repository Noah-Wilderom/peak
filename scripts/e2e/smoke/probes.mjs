// Real programs of every runtime through the installed app and a separate CLI process.
import { spawnSync } from "node:child_process"
import { IS_WINDOWS, PLATFORM, cli, dataDir, join, log, mkdirSync, mkdtempSync, shot, sleep, storedRunById, storedSamples, tmpdir, waitFor, writeFileSync } from "./lib.mjs"

const works = (bin, ...args) => spawnSync(bin, args, { encoding: "utf8", shell: IS_WINDOWS }).status === 0
const sourceDir = () => mkdtempSync(join(tmpdir(), "peak runtime "))
export const python = () => ["python3", "python"].find((p) => works(p, "--version"))
export const phpHasExcimer = () => (spawnSync("php", ["-m"], { encoding: "utf8", shell: IS_WINDOWS }).stdout ?? "").toLowerCase().includes("excimer")

const JS = (seconds) => `class SmokeThing { constructor(i) { this.v = "x".repeat(64) + i } }\nconst keep = []\nfunction busyWork() { const e = Date.now() + 40; while (Date.now() < e); for (let i = 0; i < 100; i++) keep.push(new SmokeThing(i)) }\nconst t = setInterval(busyWork, 50)\nsetTimeout(() => { clearInterval(t) }, ${seconds * 1000})\n`
const PHP = (seconds) => `<?php\nclass SmokeThing { public $other; }\nfunction busy_work() { $e = microtime(true) + 0.04; while (microtime(true) < $e) { } for ($i = 0; $i < 20000; $i++) { $a = new SmokeThing; $b = new SmokeThing; $a->other = $b; $b->other = $a; } }\n$end = microtime(true) + ${seconds};\nwhile (microtime(true) < $end) { busy_work(); }\n`
const stamp = () => `${Date.now()}`

/** A real program of each runtime, in a directory with a space in its name. */
export const programs = {
  node(seconds) {
    const cwd = sourceDir()
    const script = `work-node-${stamp()}.js`
    writeFileSync(join(cwd, script), JS(seconds))
    // V8 can't see code it optimized on-stack before a profile started, and this loop gets hot early.
    return { command: ["node", "--no-use-osr", script], cwd }
  },
  bun(seconds) {
    const cwd = sourceDir()
    const script = `work-bun-${stamp()}.js`
    writeFileSync(join(cwd, script), JS(seconds))
    return { command: ["bun", script], cwd }
  },
  python(seconds) {
    const cwd = sourceDir()
    const script = `work-py-${stamp()}.py`
    writeFileSync(join(cwd, script), `import time\nclass SmokeThing:\n    pass\nkeep = []\ndef busy_work():\n    e = time.time() + 0.04\n    while time.time() < e:\n        pass\n    keep.extend(SmokeThing() for _ in range(50))\nend = time.time() + ${seconds}\nwhile time.time() < end:\n    busy_work()\n    time.sleep(0.01)\n`)
    return { command: [python(), script], cwd }
  },
  php(seconds) {
    const cwd = sourceDir()
    const script = `work-php-${stamp()}.php`
    writeFileSync(join(cwd, script), PHP(seconds))
    return { command: ["php", script], cwd }
  },
  /** PHP with no extensions loaded: its own ini files are out of the way, whatever's installed. */
  phpAlone(seconds) {
    const cwd = sourceDir()
    const script = `work-php-alone-${stamp()}.php`
    writeFileSync(join(cwd, script), PHP(seconds))
    mkdirSync(join(cwd, "ini"))
    mkdirSync(join(cwd, "scan"))
    writeFileSync(join(cwd, "ini", "php.ini"), "")
    return { command: ["php", script], cwd, env: { PHPRC: join(cwd, "ini"), PHP_INI_SCAN_DIR: join(cwd, "scan") } }
  },
  /** A compiled program, built against the copy installed with the app, and run directly. */
  go(seconds) {
    const cwd = sourceDir()
    const binary = `work-go-${stamp()}${IS_WINDOWS ? ".exe" : ""}`
    const sdk = join(dataDir(), "agents", "go").replaceAll("\\", "/")
    writeFileSync(join(cwd, "go.mod"), `module smoke\n\ngo 1.21\n\nrequire github.com/Noah-Wilderom/peak/sdk/go v0.0.0\n\nreplace github.com/Noah-Wilderom/peak/sdk/go => "${sdk}"\n`)
    writeFileSync(join(cwd, "main.go"), `package main\n\nimport (\n\t"runtime"\n\t"time"\n\n\t_ "github.com/Noah-Wilderom/peak/sdk/go/auto"\n)\n\ntype smokeThing struct{ data [256]byte }\n\nvar keep []*smokeThing\n\n//go:noinline\nfunc smokeAlloc() { for i := 0; i < 2000; i++ { keep = append(keep, new(smokeThing)) } }\n\n//go:noinline\nfunc busyWork() int { x := 0; e := time.Now().Add(40 * time.Millisecond); for time.Now().Before(e) { x++ }; return x }\n\nfunc main() {\n\truntime.MemProfileRate = 4096\n\tend := time.Now().Add(${seconds} * time.Second)\n\tfor time.Now().Before(end) { busyWork(); smokeAlloc(); time.Sleep(5 * time.Millisecond) }\n}\n`)
    const built = spawnSync("go", ["build", "-o", binary, "."], { cwd, encoding: "utf8", shell: IS_WINDOWS })
    return { command: [join(cwd, binary)], cwd, ok: built.status === 0, why: built.stderr?.trim() }
  },
  /** The same, without Peak's import. */
  goPlain(seconds) {
    const cwd = sourceDir()
    const binary = `work-plain-${stamp()}${IS_WINDOWS ? ".exe" : ""}`
    writeFileSync(join(cwd, "go.mod"), "module plain\n\ngo 1.21\n")
    writeFileSync(join(cwd, "main.go"), `package main\n\nimport "time"\n\nfunc main() { time.Sleep(${seconds} * time.Second) }\n`)
    spawnSync("go", ["build", "-o", binary, "."], { cwd, encoding: "utf8", shell: IS_WINDOWS })
    return { command: [join(cwd, binary)], cwd }
  },
}

/** `PEAK_SMOKE_REQUIRE` lists the runtimes that have to be here: a missing one fails rather than being skipped. */
export async function runProbes({ check, record, out, only }) {
  const wanted = (name) => !only || only.includes(name)
  const versionNumber = (await cli(["--version"]).done).out.match(/\d+\.\d+\.\d+/)?.[0]
  const required = (process.env.PEAK_SMOKE_REQUIRE ?? "").split(",").filter(Boolean)
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
  async function probeRuntime({ name, runtime, command, cwd, frame, caps, missing = [], sampling, lag, entry, gauges = false, env }) {
    const label = (what) => `${name}: ${what}`
    const id = command.find((part) => part.includes("work-"))
    const running = cli(["run", "--", ...command], { cwd, env })
    const found = await waitFor(`the ${name} run's agent`, async () => {
      const runs = asJson((await cli(["ps", "--json"]).done).out) ?? []
      return runs.find((r) => r.command.includes(id) && r.profiling) ?? null
    }, 90_000).catch((e) => (check(label("agent connected"), false, e.message), null))
    if (!found) {
      const ended = await running.done
      log(`${name} ended with exit ${ended.code}.\nstdout: ${ended.out.slice(0, 2000)}\nstderr: ${ended.err.slice(0, 2000)}`)
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
      check(label("CPU profile holds the program's own function, in milliseconds"), frames.some((f) => f.name.includes(frame)) && sampled > 100 && sampled < 20_000 && profile.durationMs >= 1900, `${profile?.sampling}, ${Math.round(sampled)} ms sampled in ${Math.round(profile?.durationMs)} ms, top: ${frames.sort((a, b) => (b.self ?? 0) - (a.self ?? 0)).slice(0, 6).map((f) => `${f.name} ${Math.round(f.self)}`).join(", ")}: ${cpu.err.trim()}`)
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
  if (wanted("node") && requireRuntime("node", works("node", "--version"))) {
    await probeRuntime({ ...programs.node(SECONDS), name: "node", runtime: "node", frame: "busyWork", entry: "SmokeThing", caps: ["heap", "gc", "lag", "cpu", "snapshot", "forcegc"], sampling: ["v8"], lag: true })
    // Opting in to profiling leaves a user's own options in effect.
    const dir = sourceDir()
    writeFileSync(join(dir, "own.cjs"), "globalThis.ownPreload = true\n")
    const own = await cli(["run", "--", "node", "-e", "console.log('own=' + globalThis.ownPreload + ' agent=' + globalThis.__peakAgent)"], { cwd: dir, env: { NODE_OPTIONS: `--require "${join(dir, "own.cjs").replaceAll("\\", "/")}"` } }).done
    check("node: a user's own NODE_OPTIONS still apply", own.out.includes("own=true agent=true"), own.out.trim())
  }

  if (wanted("python") && requireRuntime("python", python())) {
    await probeRuntime({ ...programs.python(SECONDS), name: "python", runtime: "python", frame: "busy_work", entry: "SmokeThing", caps: ["gc", "lag", "cpu", "snapshot", "forcegc"], missing: ["heap"], sampling: ["stack"], lag: true })
    const dir = sourceDir()
    writeFileSync(join(dir, "ownmodule.py"), "VALUE = 'found'\n")
    const own = await cli(["run", "--", python(), "-c", "import ownmodule, socket, gc; print('own=' + ownmodule.VALUE + ' agent=' + str(any(c.__name__ == 'on_gc' for c in gc.callbacks)))"], { env: { PYTHONPATH: dir } }).done
    check("python: a user's own PYTHONPATH still applies", own.out.includes("own=found agent=True"), `${own.out.trim()} ${own.err.trim()}`)
  }

  if (wanted("bun") && requireRuntime("bun", works("bun", "--version"))) {
    const ownOptions = await cli(["run", "--", "bun", "-e", "console.log('smol=' + process.execArgv.length + ' agent=' + globalThis.__peakAgent)"], { env: { BUN_OPTIONS: "--smol" } }).done
    check("bun: a user's own BUN_OPTIONS don't lose the agent", ownOptions.code === 0 && ownOptions.out.includes("agent=true"), `${ownOptions.out.trim()} ${ownOptions.err.trim()}`)
    await probeRuntime({ ...programs.bun(SECONDS), name: "bun", runtime: "bun", frame: "busyWork", entry: "SmokeThing", caps: ["heap", "lag", "cpu", "snapshot", "forcegc"], missing: ["gc"], sampling: ["jsc"], lag: true, gauges: true })
  }

  if (wanted("php") && requireRuntime("php", works("php", "--version"))) {
    const excimer = phpHasExcimer()
    if (!excimer && required.includes("php-excimer")) check("Excimer is here to test", false)
    if (excimer) {
      const dir = sourceDir()
      writeFileSync(join(dir, "timed.php"), `<?php echo isset(gc_status()['collector_time']) ? 'yes' : 'no';`)
      const timed = spawnSync("php", ["timed.php"], { cwd: dir, encoding: "utf8", shell: IS_WINDOWS }).stdout === "yes"
      await probeRuntime({ ...programs.php(SECONDS), name: "php", runtime: "php", frame: "busy_work", entry: "", caps: ["heap", "cpu", "forcegc", ...(timed ? ["gc"] : [])], missing: ["lag", "snapshot"], sampling: ["excimer-cpu", "excimer-wall"], lag: false, gauges: true })
    }
    // The same PHP with nothing extra loaded, which is all there is on Windows.
    await probeRuntime({ ...programs.phpAlone(8), name: "php-alone", runtime: "php", frame: "busy_work", entry: "", caps: [], missing: ["heap", "gc", "cpu", "forcegc", "lag", "snapshot"], lag: false, gauges: true })
    const dir = sourceDir()
    writeFileSync(join(dir, "own.php"), `<?php define("USER_PREPEND", true);`)
    mkdirSync(join(dir, "scan"))
    writeFileSync(join(dir, "scan", "user.ini"), `auto_prepend_file="${join(dir, "own.php").replaceAll("\\", "/")}"\n`)
    writeFileSync(join(dir, "own-run.php"), `<?php echo "own=" . (defined("USER_PREPEND") ? "yes" : "no") . " agent=" . (class_exists("PeakAgent\\\\Agent", false) ? "yes" : "no"); exit(4);`)
    const own = await cli(["run", "--", "php", "own-run.php"], { cwd: dir, env: { PHP_INI_SCAN_DIR: join(dir, "scan") } }).done
    check("php: a user's own auto_prepend_file still runs, and the exit code is the program's", own.code === 4 && own.out.includes("own=yes agent=yes"), `exit ${own.code}: ${own.out.trim()} ${own.err.trim()}`)
  }

  if (wanted("go") && requireRuntime("go", works("go", "version"))) {
    const built = programs.go(SECONDS)
    check("go: a program builds against the installed SDK", built.ok, built.why)
    if (built.ok) {
      await probeRuntime({ ...built, name: "go", runtime: "go", frame: "main.busyWork", entry: "smokeAlloc", caps: ["heap", "gc", "lag", "cpu", "snapshot", "forcegc"], sampling: ["pprof"], lag: true, gauges: true })
      // Without the import there's nothing Peak can do, and it says so rather than pretending.
      const plain = programs.goPlain(6)
      const running = cli(["run", "--", ...plain.command], { cwd: plain.cwd })
      const name = plain.command[0]
      const listed = await waitFor("the plain Go run", async () => (asJson((await cli(["ps", "--json"]).done).out) ?? []).find((r) => r.command.includes(name)) ?? null, 15_000).catch(() => null)
      const refused = listed ? await cli(["profile", listed.id, "--ms", "500"]).done : { code: -1, err: "never listed" }
      check("go: a program without the import has no agent, and that's what's reported", listed && !listed.agent && !listed.profiling && refused.code === 1 && /no profiling agent/.test(refused.err), refused.err.trim())
      await running.done
    }
  }
  const setup = await cli(["agents"]).done
  check("explains how to profile each runtime", setup.code === 0 && ["Go", "Bun", "PHP", "Python", "Node.js"].every((r) => setup.out.includes(r)), setup.out.split("\n")[0])
}
