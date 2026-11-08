#!/usr/bin/env node
// What a person sees of each runtime's agent, in the installed production window: who's reporting,
// what's missing and why, recording and reading profiles with the real buttons, and the same run
// reopened from history after a restart. The checks read the window; the database shows the buttons
// did something. On Linux the window takes WebDriver, on Windows UI Automation, on macOS the
// accessibility API, as a release has no debug port.
//   PEAK_SMOKE_PLATFORM=... [PEAK_TAURI_DRIVER=...] agents-ui.mjs <artifacts dir> <output dir>
import { IS_MAC, IS_WINDOWS, PLATFORM, cli, install, join, liveApps, log, mkdirSync, shot as desktopShot, sleep, storedRunById, waitFor, writeFileSync } from "../smoke/lib.mjs"
import { closeApp, contents, openApp, press, pressInLine, readsState, scrollDown, scrollToTop, stopDriving, typeInto } from "../smoke/drive.mjs"
import { phpHasExcimer, programs } from "../smoke/probes.mjs"
import { newRecord } from "../smoke/record.mjs"

const [artifacts, out] = process.argv.slice(2)
mkdirSync(out, { recursive: true })
const proof = newRecord(log)
const { check } = proof

// ─── the window ─────────────────────────────────────────────────────────────
async function look() {
  const items = await contents()
  return { text: items.map((i) => i.name).join("\n"), items }
}
async function see(pattern, ms = 30_000) {
  // Reading a screen takes seconds a go, and what's wanted may be further down the page.
  const sight = !readsState()
  const end = Date.now() + (sight ? Math.max(ms, 90_000) : ms)
  let text = ""
  let scrolled = 0
  while (Date.now() < end) {
    // It wraps lines where the window does, and curls apostrophes.
    text = (await look()).text.replace(/\s+/g, " ").replaceAll("\u2019", "'")
    if (pattern.test(text)) return true
    await sleep(500)
    // From the top, then down a screen at a time: only once what's on screen hasn't got it.
    if (sight) {
      if (scrolled === 0) scrollToTop()
      else if (scrolled < 5) scrollDown()
      scrolled = scrolled < 5 ? scrolled + 1 : 0
    }
  }
  log(`never saw ${pattern} in:\n${text.slice(0, 1500)}`)
  return false
}
/** Press a control by its name's pattern, such as a tab whose name holds a count. */
async function pressMatching(pattern, ms = 30_000) {
  const sight = !readsState()
  const end = Date.now() + (sight ? Math.max(ms, 45_000) : ms)
  let scrolled = 0
  // Reading the screen, a control's words can share a line with its icon, so the pattern's own
  // words are what's looked for.
  const words = pattern.source.replace(/^\^|\$$/g, "").replace(/\\(.)/g, "$1")
  // Only plain words, and escaped punctuation: not \b, \s, \d.
  const literal = sight && !/[\\^$.*+?()[\]{}|]/.test(pattern.source.replace(/^\^|\$$/g, "").replace(/\\[^A-Za-z0-9]/g, ""))
  while (Date.now() < end) {
    if (literal && (await press(words))) return true
    // Reading the screen says what's there, not whether it's enabled. Elsewhere it has to be.
    const hit = (await look()).items.find((i) => pattern.test(i.name) && (i.enabled === true || (i.enabled === undefined && !readsState())))
    if (hit && (await press(hit.name))) return true
    await sleep(500)
    if (sight && scrolled < 5) {
      if (scrolled === 0) scrollToTop()
      else scrollDown()
      scrolled++
    }
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
  let pressed = await press(name)
  for (let i = 0; !pressed && i < 3; i++) {
    scrollDown()
    pressed = await press(name)
  }
  await sleep(2500)
  const after = storedRunById(run)
  const quiet = before?.cpuProfiles === after?.cpuProfiles && before?.snapshots === after?.snapshots && !/Recording|Capturing/.test((await look()).text)
  if (!pressed) {
    // Its words didn't read, so there's no evidence either way, and the proof can't pass on it.
    proof.unobserved(label, `"${name}" couldn't be found on screen, so whether it's disabled wasn't observed`)
    return
  }
  check(label, quiet, "semantic: the attribute can't be read here, so it was pressed, and nothing came of it")
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
// Reading the screen takes far longer than asking WebDriver or UI Automation.
const SECONDS = IS_MAC ? 420 : 70
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
    // Reading the screen takes seconds, so the 10 second recording leaves time to see it running.
    check(t(`Record ${IS_MAC ? 10 : 5}s can be pressed`), await pressMatching(IS_MAC ? /^Record 10s$/ : /^Record 5s$/))
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
    if (name === "go") {
      // Only the label read counts: "N functions" beneath it, or no "types", isn't the label.
      // In a narrow card the label wraps, "Objects," over "estimated", and the screen reads the
      // cards' rows across, so a few words can come between the two.
      const label = await see(/Objects\W+(?:\S+\s+){0,4}?estimated/, 8000)
      const text = (await look()).text
      check(t("Go's objects are labelled estimated, by allocating function, not types"), label && /\b\d+ functions\b/.test(text) && !/\d+ types/.test(text), label ? "label read" : /\b\d+ functions\b/.test(text) ? "only the count was read, not the label" : "neither read")
    }
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
  const program = programs.bun(IS_MAC ? 150 : 20)
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
    }, (IS_MAC ? 150 : 20) * 1000 + 90_000).catch(() => null)
    check("capture: ended on its own, with its own exit code", stored?.exit_code === 0, stored?.exit_code)
  } else {
    // Its later checks are still required, and fail rather than vanish from the record.
    check("capture: the window names the runtime", false, "the captured run never connected")
    check("capture: ended on its own, with its own exit code", false, "the captured run never connected")
  }
  // Reopened like any other: with no such run, that fails too.
  kept.push({ name: "capture-bun", label: "Bun", marker, cpu: false, snapshot: false })
}

// A result from the terminal, on a run that isn't the one on screen, leaves the window where it is.
{
  const shown = programs.node(IS_MAC ? 200 : 30)
  const other = programs.python(IS_MAC ? 200 : 30)
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
  // Pressing isn't enough: the page has to be there, with its search box.
  let opened = false
  for (let i = 0; i < 3 && !opened; i++) {
    await pressMatching(/^History$/)
    opened = await see(/Search by command|History\. Every run/, 20_000)
  }
  check(t("History opens"), opened)
  const leaf = run.marker.split(/[\\/]/).at(-1)
  if (readsState()) {
    check(t("the run is listed and opens"), await pressMatching(new RegExp(`^Open .*${leaf.replaceAll(".", "\\.")}`)))
  } else {
    // A row can't be told by its hidden label here, or reached if it's off-screen. Searching leaves
    // only this one, wherever it was.
    // Entering the search proves only that: finding the run is the next check, by opening it.
    check(t("the search is entered"), await typeInto("Search", leaf))
    await sleep(1500)
    check(t("the run is listed and opens"), await pressMatching(/^Open$/))
  }
  await sleep(1000)
  // A tab's name shares its line with the other tabs, and with its count.
  check(t("the Profiler tab opens"), readsState() ? await pressMatching(/^Profiler\b/) : await pressInLine("Profiler"))
  check(t("the agent's identity is still there"), await see(new RegExp(`${run.label}\\s+${number}`)))
  check(t("as what it reported, not as live"), await see(/Agent has disconnected/, 5000))
  if (run.cpu) {
    await pressMatching(/^CPU$/, 5000)
    // A profile listed, or the one selected: which of the two is on screen depends on the scroll.
    check(t("the CPU profile is there"), await see(/Profile\s+1|CPU profile\.(?:\s+\S+){0,6}?\s+\d[\d.]*\s*m?s\s+recorded/, 15_000))
  }
  await shot(`${run.name}-reopened`)
}
await closeApp()
const counts = proof.counts()
writeFileSync(join(out, `agents-ui-${PLATFORM}.json`), JSON.stringify({ counts, checks: proof.entries }, null, 2))
stopDriving()
log(`pass ${counts.pass}, fail ${counts.fail}, not observed ${counts.unobserved}, of ${counts.total}`)
log(proof.passed() ? "AGENTS UI OK" : "AGENTS UI FAILED")
process.exit(proof.passed() ? 0 : 1)
