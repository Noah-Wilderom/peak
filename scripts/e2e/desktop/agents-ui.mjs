#!/usr/bin/env node
// What a person sees of each runtime's agent, in the installed production window: who's reporting,
// what's missing and why, recording and reading profiles with the real buttons, and the same run
// reopened from history after a restart. The checks read the window; the database shows the buttons
// did something. On Linux the window takes WebDriver, on Windows UI Automation, on macOS the
// accessibility API, as a release has no debug port.
//   PEAK_SMOKE_PLATFORM=... [PEAK_TAURI_DRIVER=...] agents-ui.mjs <artifacts dir> <output dir>
import { IS_WINDOWS, PLATFORM, cli, install, join, liveApps, log, mkdirSync, shot as desktopShot, sleep, storedRunById, waitFor, writeFileSync } from "../smoke/lib.mjs"
import { closeApp, contents, openApp, press, readsState, scrollDown, stopDriving, typeInto } from "../smoke/drive.mjs"
import { phpHasExcimer, programs } from "../smoke/probes.mjs"

const [artifacts, out] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const record = {}
const check = (name, ok, detail) => {
  record[name] = { ok: !!ok, detail }
  log(ok ? "ok  " : "FAIL", name, detail ?? "")
  if (!ok) process.exitCode = 1
}

// ─── the window ─────────────────────────────────────────────────────────────
async function look() {
  const items = await contents()
  return { text: items.map((i) => i.name).join("\n"), items }
}
async function see(pattern, ms = 30_000) {
  const end = Date.now() + ms
  let text = ""
  let scrolled = 0
  while (Date.now() < end) {
    // Reading a screen wraps lines where the window does, and curls apostrophes.
    text = (await look()).text.replace(/\s+/g, " ").replaceAll("\u2019", "'")
    if (pattern.test(text)) return true
    await sleep(500)
    // Reading the screen, what's further down the page takes scrolling to. A few times, and only
    // once it isn't simply taking a moment.
    if (!readsState() && scrolled < 4 && Date.now() > end - ms * 0.5) {
      scrollDown()
      scrolled++
    }
  }
  log(`never saw ${pattern} in:\n${text.slice(0, 1500)}`)
  return false
}
/** Press a control by its name's pattern, such as a tab whose name holds a count. */
async function pressMatching(pattern, ms = 30_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const hit = (await look()).items.find((i) => pattern.test(i.name) && i.enabled)
    if (hit && (await press(hit.name))) return true
    await sleep(500)
  }
  return false
}
/**
 * That a control is disabled. Where the platform can't read the attribute, that's not assumed: it's
 * pressed, and nothing may come of it. The record says which of the two this was.
 */
async function checkDisabled(label, name, run) {
  if (readsState()) {
    return check(label, (await look()).items.find((i) => i.name === name && i.enabled !== undefined)?.enabled === false)
  }
  const before = storedRunById(run)
  const pressed = await press(name)
  await sleep(2500)
  const after = storedRunById(run)
  const quiet = before?.cpuProfiles === after?.cpuProfiles && before?.snapshots === after?.snapshots && !/Recording|Capturing/.test((await look()).text)
  if (!pressed) {
    // Greyed out, its words may not read. That's not evidence either way, so it's recorded as neither.
    record[label] = { ok: true, unobserved: true, detail: `"${name}" couldn't be found on screen, so whether it's disabled wasn't observed` }
    log("NOT OBSERVED", label)
    return
  }
  check(label, quiet, "attribute not readable here: pressed instead, and nothing came of it")
}
const shot = (name) => desktopShot(out, `${PLATFORM}-${name}`)
async function openWindow() {
  await openApp()
  await waitFor("the app", () => liveApps()[0], 60_000)
  await sleep(4000)
}

const asJson = (t) => {
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}
const version = (await (async () => {
  install(artifacts)
  return (await cli(["--version"]).done).out.match(/\d+\.\d+\.\d+/)?.[0]
})())

await openWindow()
await shot("window")

// ─── each runtime, while it runs ────────────────────────────────────────────
const SECONDS = 70
const kept = []

async function runtimeInWindow({ name, label, versionShape, program, cpu, snapshot, gc, missing }) {
  const t = (what) => `${name}: ${what}`
  const started = cli(["run", "--", ...program.command], { cwd: program.cwd, env: program.env })
  const marker = program.command.find((p) => p.includes("work-"))
  const run = await waitFor(`${name}'s agent`, async () => (asJson((await cli(["ps", "--json"]).done).out) ?? []).find((r) => r.command.includes(marker) && r.profiling) ?? null, 90_000).catch(() => null)
  check(t("connected"), run)
  if (!run) return void (await started.done)
  await cli(["open", run.id]).done
  check(t("the window names the runtime and its version"), await see(new RegExp(`${label}\\s+${versionShape}`)))
  check(t("and the agent's version"), await see(new RegExp(`Peak agent\\s+${version.replaceAll(".", "\\.")}`), 5000))
  check(t("and that it's connected"), await see(/Connected/, 5000))
  for (const [what, reason] of missing) check(t(`says why there's no ${what}`), await see(reason, 5000), String(reason))
  if (IS_WINDOWS && name === "php-alone") check(t("doesn't suggest an extension Windows can't install"), !/pecl install/.test((await look()).text))
  await shot(`${name}-connected`)

  if (cpu) {
    await pressMatching(/^CPU$/, 5000)
    check(t("Record 5s can be pressed"), await pressMatching(/^Record 5s$/))
    check(t("shows it's recording"), await see(/Recording/, 4000))
    check(t("the profile appears, with its length"), await see(/Profile\s+1/, 40_000))
    check(t("explained by how it was measured"), await see(cpu, 5000), String(cpu))
    await shot(`${name}-cpu`)
  } else {
    await pressMatching(/^CPU$/, 5000)
    await checkDisabled(t("recording is disabled"), "Record 5s", run.id)
    check(t("the CPU view doesn't invite recording"), await see(/can't record them/, 8000))
    await shot(`${name}-cpu-refused`)
  }
  await pressMatching(/^Heap$/, 5000)
  if (snapshot) {
    check(t("Take snapshot can be pressed"), await pressMatching(/^Take snapshot$/))
    check(t("the snapshot appears"), await see(/Snapshot\s+1/, 60_000))
    check(t("and shows what the program holds"), await see(snapshot, 10_000), String(snapshot))
    if (name === "go") check(t("Go's objects are estimates from allocating functions, not types"), await see(/allocating\s+functions/, 8000))
    await shot(`${name}-heap`)
  } else {
    await checkDisabled(t("taking a snapshot is disabled"), "Take snapshot", run.id)
    check(t("the heap view doesn't invite a snapshot"), await see(/can't take them/, 8000))
    await shot(`${name}-heap-refused`)
  }
  if (gc) check(t("Collect garbage can be pressed"), await pressMatching(/^Collect garbage$/))
  else await checkDisabled(t("collecting garbage is disabled"), "Collect garbage", run.id)

  // A result from the terminal reaches the window that's already open.
  if (cpu) {
    const before = (await look()).text
    const fromCli = await cli(["profile", run.id, "--ms", "800", "--json"]).done
    await pressMatching(/^CPU$/, 5000)
    check(t("a profile from the terminal appears in the window"), fromCli.code === 0 && (await see(/Profile\s+2/, 15_000)), `${fromCli.err.trim()} ${before.length}`)
    await pressMatching(/^Heap$/, 5000)
  }

  const ended = await started.done
  check(t("the program's exit code is its own"), ended.code === 0, `exit ${ended.code}: ${ended.err.trim().split("\n")[0]}`)
  await sleep(1500)
  await cli(["open", run.id]).done
  check(t("after it ends, the window says the agent has gone"), await see(/Agent has disconnected/))
  await shot(`${name}-ended`)
  const stored = await waitFor(`${name} stored`, () => {
    const r = storedRunById(run.id)
    return r && r.exit_code !== null ? r : null
  }, 30_000).catch(() => null)
  check(t("the buttons' results are in history"), stored && stored.cpuProfiles >= (cpu ? 1 : 0) && stored.snapshots >= (snapshot ? 1 : 0), stored && `cpu ${stored.cpuProfiles}, snapshots ${stored.snapshots}`)
  kept.push({ name, label, marker, cpu: !!cpu, snapshot: !!snapshot })
}

const WHY = { lag: /no event loop to delay/, list: /no built-in way to list/, excimer: IS_WINDOWS ? /no Windows build/ : /pecl install excimer/, bunGc: /doesn't publish individual garbage collections/, pyHeap: /no cheap total/ }
const number = "\\d+\\.\\d+"

await runtimeInWindow({ name: "node", label: "Node\\.js", versionShape: number, program: programs.node(SECONDS), cpu: /Sampled by V8/, snapshot: /SmokeThing/, gc: true, missing: [] })
await runtimeInWindow({ name: "python", label: "Python", versionShape: number, program: programs.python(SECONDS), cpu: /Python stack sampled/, snapshot: /SmokeThing/, gc: true, missing: [["live heap", WHY.pyHeap]] })
await runtimeInWindow({ name: "bun", label: "Bun", versionShape: number, program: programs.bun(SECONDS), cpu: /Sampled by JavaScriptCore/, snapshot: /SmokeThing/, gc: true, missing: [["collections", WHY.bunGc]] })
const excimer = phpHasExcimer()
if (excimer) await runtimeInWindow({ name: "php", label: "PHP", versionShape: number, program: programs.php(SECONDS), cpu: /sampled by Excimer/, snapshot: null, gc: true, missing: [["delay", WHY.lag], ["snapshots", WHY.list]] })
else check("php with Excimer isn't claimed here", IS_WINDOWS, "no Excimer")
await runtimeInWindow({ name: "php-alone", label: "PHP", versionShape: number, program: programs.phpAlone(SECONDS), cpu: null, snapshot: null, gc: false, missing: [["live figures", WHY.excimer], ["delay", WHY.lag], ["snapshots", WHY.list]] })
const go = programs.go(SECONDS)
check("go: builds against the installed SDK", go.ok, go.why)
if (go.ok) await runtimeInWindow({ name: "go", label: "Go", versionShape: number, program: go, cpu: /all goroutines/, snapshot: /smokeAlloc/, gc: true, missing: [] })

// Started from the window's own Capture page, rather than a terminal.
{
  const program = programs.bun(20)
  const marker = program.command.at(-1)
  const command = `bun "${join(program.cwd, marker).replaceAll("\\", "/")}"`
  check("capture: the page opens", await pressMatching(/^Capture$/))
  await sleep(1000)
  check("capture: takes a command", await typeInto("Command", command))
  check("capture: starts it", await pressMatching(/^Run and capture/))
  const run = await waitFor("the captured run's agent", async () => (asJson((await cli(["ps", "--json"]).done).out) ?? []).find((r) => r.command.includes(marker) && r.profiling) ?? null, 30_000).catch(() => null)
  check("capture: the agent connected", run?.agent?.agentVersion === version, run?.agent?.agentVersion)
  if (run) {
    await cli(["open", run.id]).done
    check("capture: the window names the runtime", await see(/Bun\s+\d+\.\d+/))
    await shot("capture-bun")
    const stored = await waitFor("the captured run stored", () => {
      const r = storedRunById(run.id)
      return r && r.exit_code !== null ? r : null
    }, 60_000).catch(() => null)
    check("capture: ended on its own, with its own exit code", stored?.exit_code === 0, stored?.exit_code)
    kept.push({ name: "capture-bun", label: "Bun", marker, cpu: false, snapshot: false })
  }
}

// A result from the terminal, on a run that isn't the one on screen, leaves the window where it is.
{
  const shown = programs.node(30)
  const other = programs.python(30)
  const running = [cli(["run", "--", ...shown.command], { cwd: shown.cwd }), cli(["run", "--", ...other.command], { cwd: other.cwd })]
  const find = (program) => waitFor("a run's agent", async () => (asJson((await cli(["ps", "--json"]).done).out) ?? []).find((r) => r.command.includes(program.command.find((p) => p.includes("work-"))) && r.profiling) ?? null, 60_000).catch(() => null)
  const [a, b] = [await find(shown), await find(other)]
  check("selection: both runs connected", a && b)
  if (a && b) {
    await cli(["open", a.id]).done
    check("selection: the first run is on screen", await see(/Node\.js\s+\d/))
    const result = await cli(["profile", b.id, "--ms", "800", "--json"]).done
    check("selection: the other run was profiled from the terminal", result.code === 0, result.err.trim())
    await sleep(2500)
    const text = (await look()).text
    check("selection: the window stayed on the first run", /Node\.js\s+\d/.test(text) && !/Python\s+\d/.test(text))
    await shot("selection-kept")
    await cli(["open", b.id]).done
    // Its view has to have replaced the other one before its controls mean anything.
    await see(/Python\s+\d/)
    await pressMatching(/^CPU$/, 5000)
    check("selection: and the other run has the result", await see(/Profile\s+1/, 15_000))
    await shot("selection-other-run")
  }
  await Promise.all(running.map((r) => r.done))
}

// A runtime with no agent gets its setup, not empty charts.
const plain = programs.goPlain(25)
const plainRun = cli(["run", "--", ...plain.command], { cwd: plain.cwd })
const plainListed = await waitFor("the plain program", async () => (asJson((await cli(["ps", "--json"]).done).out) ?? []).find((r) => r.command.includes(plain.command[0])) ?? null, 15_000).catch(() => null)
if (plainListed) await cli(["open", plainListed.id]).done
check("no agent: the window says profiling isn't available", await see(/profiling aren't available/))
check("no agent: and that attaching only gives OS-level monitoring, or how to opt in", await see(/Attaching to a running process only gives OS-level monitoring|Peak has profiling agents for/, 5000))
await shot("no-agent")
await plainRun.done

// ─── reopened from history, after a restart ─────────────────────────────────
await closeApp()
await openWindow()
for (const run of kept) {
  const t = (what) => `${run.name}, reopened: ${what}`
  check(t("History opens"), await pressMatching(/^History$/))
  await sleep(1000)
  const leaf = run.marker.split(/[\\/]/).at(-1)
  if (readsState()) {
    check(t("the run is listed and opens"), await pressMatching(new RegExp(`^Open .*${leaf.replaceAll(".", "\\.")}`)))
  } else {
    // A row can't be told by its hidden label here, or reached if it's off-screen. Searching leaves
    // only this one, wherever it was.
    check(t("searching finds the run"), await typeInto("Search", leaf))
    await sleep(1500)
    check(t("the run is listed and opens"), await pressMatching(/^Open$/))
  }
  await sleep(1000)
  check(t("the Profiler tab opens"), await pressMatching(/^Profiler\b/))
  check(t("the agent's identity is still there"), await see(new RegExp(`${run.label}\\s+${number}`)))
  check(t("as what it reported, not as live"), await see(/Agent has disconnected/, 5000))
  if (run.cpu) {
    await pressMatching(/^CPU$/, 5000)
    check(t("the CPU profile is there"), await see(/Profile\s+1/, 15_000))
  }
  await shot(`${run.name}-reopened`)
}
await closeApp()
writeFileSync(join(out, `agents-ui-${PLATFORM}.json`), JSON.stringify(record, null, 2))
stopDriving()
log(process.exitCode ? "AGENTS UI FAILED" : "AGENTS UI OK")
process.exit(process.exitCode ?? 0)
