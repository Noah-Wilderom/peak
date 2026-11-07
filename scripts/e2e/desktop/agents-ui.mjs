#!/usr/bin/env node
// What a person sees of each runtime's agent, in the installed production window: who's reporting,
// what's missing and why, recording and reading profiles with the real buttons, and the same run
// reopened from history after a restart. The checks read the window; the database shows the buttons
// did something. On Linux the window takes WebDriver, on Windows UI Automation, on macOS the
// accessibility API, as a release has no debug port.
//   PEAK_SMOKE_PLATFORM=... [PEAK_TAURI_DRIVER=...] agents-ui.mjs <artifacts dir> <output dir>
import { spawn, spawnSync } from "node:child_process"
import { IS_MAC, IS_WINDOWS, PLATFORM, cli, closeApps, install, join, launch, liveApps, log, mkdirSync, paths, shot as desktopShot, sleep, storedRunById, waitFor, writeFileSync } from "../smoke/lib.mjs"
import { contents, press as nativePress, pressNth, readsState } from "../smoke/drive.mjs"
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
const LINUX = !IS_WINDOWS && !IS_MAC
const DRIVER = "http://127.0.0.1:4444"
let session = null
async function wd(method, path, body) {
  const url = path === "/session" || path === "/status" ? `${DRIVER}${path}` : `${DRIVER}/session/${session}${path}`
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
const LIST = "return [...document.querySelectorAll('button,[role=tab],[role=radio],a')].map((e) => ({ name: (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim(), enabled: !e.disabled }))"
const FIND = "const name = arguments[0]; return [...document.querySelectorAll('button,[role=tab],[role=radio],a')].find((e) => (e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim() === name)"

/** Everything readable in the window, and its controls. */
async function look() {
  if (LINUX) {
    const text = await wd("POST", "/execute/sync", { script: "return document.body ? document.body.innerText : ''", args: [] })
    return { text, items: await wd("POST", "/execute/sync", { script: LIST, args: [] }) }
  }
  const items = contents()
  return { text: items.map((i) => i.name).join("\n"), items }
}
async function see(pattern, ms = 30_000) {
  const end = Date.now() + ms
  let text = ""
  while (Date.now() < end) {
    text = (await look()).text
    if (pattern.test(text)) return true
    await sleep(500)
  }
  log(`never saw ${pattern} in:\n${text.slice(0, 1500)}`)
  return false
}
async function press(name) {
  if (!LINUX) return nativePress(name)
  const el = await wd("POST", "/execute/sync", { script: FIND, args: [name] })
  if (!el) return false
  await wd("POST", `/element/${Object.values(el)[0]}/click`, {})
  return true
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
/** Disabled, as far as this platform can read it. Where only words can be read, says so in the record. */
async function checkDisabled(label, name) {
  if (!LINUX && !readsState()) {
    record[label] = { ok: true, detail: "not readable here: only the screen's words are, so only the reason beside it is checked" }
    return
  }
  check(label, (await look()).items.find((i) => i.name === name)?.enabled === false)
}
/** Enter a command on the Capture page, which is focused on arrival. */
async function typeCommand(text) {
  if (LINUX) {
    const el = await wd("POST", "/execute/sync", { script: "return document.querySelector('form input')", args: [] })
    await wd("POST", `/element/${Object.values(el)[0]}/value`, { text })
    return true
  }
  if (IS_MAC) return spawnSync("cliclick", [`t:${text}`]).status === 0
  const script = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$edit = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
foreach ($w in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
  if ($w.Current.Name -notlike '*peak*') { continue }
  foreach ($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants, $edit)) {
    if ($e.Current.Name -like '*Command*') {
      $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($env:PEAK_TYPED); exit 0
    }
  }
}
exit 3`
  return spawnSync("powershell", ["-NoProfile", "-Command", script], { env: { ...process.env, PEAK_TYPED: text } }).status === 0
}
const shot = async (name) => {
  const file = `${PLATFORM}-${name}`
  if (LINUX) writeFileSync(join(out, `${file}.png`), Buffer.from(await wd("GET", "/screenshot"), "base64"))
  else desktopShot(out, file)
}
async function openWindow() {
  if (LINUX) {
    session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: paths().gui } } } })).sessionId
  } else {
    launch()
  }
  await waitFor("the app", () => liveApps()[0], 60_000)
  await sleep(4000)
}
async function closeWindow() {
  if (LINUX) await wd("DELETE", "").catch(() => {})
  session = null
  closeApps()
  await sleep(2500)
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

if (LINUX) {
  spawn(process.env.PEAK_TAURI_DRIVER, ["--native-driver", "/usr/bin/WebKitWebDriver"], { stdio: "inherit" })
  await waitFor("the driver", () => wd("GET", "/status").catch(() => null), 15_000)
}
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
    await checkDisabled(t("recording is disabled"), "Record 5s")
    await shot(`${name}-cpu-refused`)
  }
  await pressMatching(/^Heap$/, 5000)
  if (snapshot) {
    check(t("Take snapshot can be pressed"), await pressMatching(/^Take snapshot$/))
    check(t("the snapshot appears"), await see(/Snapshot\s+1/, 60_000))
    check(t("and shows what the program holds"), await see(snapshot, 10_000), String(snapshot))
    await shot(`${name}-heap`)
  } else {
    await checkDisabled(t("taking a snapshot is disabled"), "Take snapshot")
    await shot(`${name}-heap-refused`)
  }
  if (gc) check(t("Collect garbage can be pressed"), await pressMatching(/^Collect garbage$/))
  else await checkDisabled(t("collecting garbage is disabled"), "Collect garbage")

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

const WHY = { lag: /no event loop to delay/, list: /no built-in way to list/, excimer: /pecl install excimer/, bunGc: /doesn't publish individual garbage collections/, pyHeap: /no cheap total/ }
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
  check("capture: takes a command", await typeCommand(command))
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
await closeWindow()
await openWindow()
// Where only words can be read, a row is found by its place: newest first, under the no-agent run.
const newestFirst = [...kept].reverse()
for (const run of kept) {
  const t = (what) => `${run.name}, reopened: ${what}`
  check(t("History opens"), await pressMatching(/^History$/))
  await sleep(1000)
  const leaf = run.marker.split(/[\\/]/).at(-1)
  const byName = LINUX || readsState()
  const row = newestFirst.indexOf(run) + 1
  if (!byName && row > 4) {
    record[t("not checked here")] = { ok: true, detail: "further down the list than this screen shows, and only words can be read" }
    await pressMatching(/^Close$/, 2000)
    continue
  }
  check(t("the run is listed and opens"), byName ? await pressMatching(new RegExp(`^Open .*${leaf.replaceAll(".", "\\.")}`)) : pressNth("Open", row))
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
await closeWindow()
writeFileSync(join(out, `agents-ui-${PLATFORM}.json`), JSON.stringify(record, null, 2))
log(process.exitCode ? "AGENTS UI FAILED" : "AGENTS UI OK")
process.exit(process.exitCode ?? 0)
