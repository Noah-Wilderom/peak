// Drives the real Peak window over WebDriver: real backend, real SQLite, real agents,
// real SSH to a local sshd, a real (isolated) Docker daemon and k3s cluster, and a real
// notification daemon. Exits non-zero on any failure.
import { spawn, spawnSync } from "node:child_process"
import { chmodSync, existsSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs"

const DRIVER = "http://127.0.0.1:4444"
const OUT = process.env.OUT
const RECEIVED = `${OUT}/notifications-received.log`
if (existsSync(RECEIVED)) unlinkSync(RECEIVED)
let session = null
const problems = []

async function wd(method, path, body) {
  const url = path.startsWith("/session") || path === "/status" ? `${DRIVER}${path}` : `${DRIVER}/session/${session}${path}`
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const js = (script, args = []) => wd("POST", "/execute/sync", { script, args })

/** Wait until the page text matches. */
async function see(pattern, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const text = await js("return document.body.innerText")
    if (pattern.test(text)) return
    await sleep(150)
  }
  throw new Error(`never saw ${pattern}`)
}

/** Click a button-like element by its accessible text. */
const CLICK = `
  const [pattern, scope, nth] = arguments
  const re = new RegExp(pattern)
  const root = scope ? [...document.querySelectorAll('section,aside,main')].find((e) => (e.getAttribute('aria-label') || e.tagName).match(new RegExp(scope))) : document
  if (!root) return false
  const els = [...root.querySelectorAll('button,[role=tab],[role=radio],a')].filter((e) => re.test((e.getAttribute('aria-label') || e.innerText || '').trim()) && !e.disabled)
  const el = els[nth || 0]
  if (!el) return false
  el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, button: 0 }))
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, button: 0 }))
  el.focus()
  el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, button: 0 }))
  el.dispatchEvent(new MouseEvent('mouseup', { bubbles: true, button: 0 }))
  el.click()
  return true`

async function click(pattern, scope, nth, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js(CLICK, [pattern, scope ?? null, nth ?? 0])) return
    await sleep(150)
  }
  throw new Error(`nothing to click for /${pattern}/ in ${scope ?? "page"}`)
}

/** Type into an input the way React notices. */
const TYPE = `
  const [selector, value] = arguments
  const el = document.querySelector(selector)
  if (!el) return false
  const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
  return true`
async function type(selector, value) {
  if (!(await js(TYPE, [selector, value]))) throw new Error(`no input ${selector}`)
}

async function shot(name) {
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(await wd("GET", "/screenshot"), "base64"))
}

async function step(name, fn) {
  try {
    await fn()
    console.log("ok  ", name)
  } catch (e) {
    problems.push(`${name}: ${e.message}`)
    console.log("FAIL", name, e.message)
    await shot("fail-" + name.replace(/\W+/g, "-")).catch(() => {})
  }
}

async function open() {
  const v = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: "/opt/peak/peak" } } } })
  session = v.sessionId
  await see(/peak\./, 30000)
}
const close = async () => {
  await wd("DELETE", "").catch(() => {})
  session = null
  await sleep(1500)
}

/** What the notification daemon actually received, written by a hook inside dunst. */
function notifications() {
  if (!existsSync(RECEIVED)) return []
  return readFileSync(RECEIVED, "utf8").split("\n").filter(Boolean)
}

/** Start a real notification daemon that records each notification it accepts. */
async function startDunst() {
  writeFileSync("/tmp/peak-dunst-hook.sh", `#!/bin/sh\nprintf '%s | %s\\n' "$2" "$3" >> ${RECEIVED}\n`)
  chmodSync("/tmp/peak-dunst-hook.sh", 0o755)
  writeFileSync("/tmp/peak-dunstrc", '[record]\n  summary = "*"\n  script = /tmp/peak-dunst-hook.sh\n')
  const log = openSync(`${OUT}/dunst.log`, "w")
  spawn("dunst", ["-config", "/tmp/peak-dunstrc"], { stdio: ["ignore", log, log], detached: true }).unref()
  await sleep(2000)
}

const selectValue = (selector, value) =>
  js(
    `const [sel, v] = arguments; const s = document.querySelector(sel); if (!s) return false;
     const o = v ? [...s.options].find((x) => x.value === v) : [...s.options].find((x) => x.value); if (!o) return false;
     Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value').set.call(s, o.value);
     s.dispatchEvent(new Event('change', { bubbles: true })); return true`,
    [selector, value ?? null],
  )

const chooseTarget = async (label) => {
  await click("^Capture$", "ASIDE")
  await see(/Capture a process/)
  await sleep(300)
  const v = await js("return [...document.querySelector('select[aria-label=\"Where\"]').options].find((o) => o.text.includes(arguments[0])).value", [label])
  await selectValue('select[aria-label="Where"]', v)
  await see(/Attaching only observes/)
}

/** A real mouse gesture on the memory chart, through WebDriver. */
async function mouseOnChart(fromX, toX) {
  const rect = await js("const s = [...document.querySelectorAll('main section')].find((x) => x.textContent.startsWith('Memory.')).querySelector('.recharts-wrapper').getBoundingClientRect(); return { x: s.x, y: s.y, w: s.width, h: s.height }")
  const at = (f) => ({ x: Math.round(rect.x + rect.w * f), y: Math.round(rect.y + rect.h * 0.5) })
  const steps = [
    { type: "pointerMove", duration: 0, ...at(fromX), origin: "viewport" },
    { type: "pause", duration: 400 },
    { type: "pointerDown", button: 0 },
    { type: "pause", duration: 150 },
  ]
  if (toX !== fromX) steps.push({ type: "pointerMove", duration: 200, ...at(toX), origin: "viewport" }, { type: "pause", duration: 150 })
  steps.push({ type: "pointerUp", button: 0 })
  await wd("POST", "/actions", { actions: [{ type: "pointer", id: "mouse", parameters: { pointerType: "mouse" }, actions: steps }] })
  await wd("DELETE", "/actions").catch(() => {})
}

const capture = async (command, cwd = "/tmp") => {
  await click("^Capture$", "ASIDE")
  await see(/Capture a process/)
  await type('input[placeholder="bun run build"]', command)
  await type('input.font-mono:not([placeholder])', cwd)
  await sleep(100)
  await click("^Run and capture")
}

const driver = spawn("/opt/peak/tauri-driver", ["--native-driver", "/usr/bin/WebKitWebDriver"], { stdio: "inherit" })
for (let i = 0; i < 100; i++) {
  try {
    await wd("GET", "/status")
    break
  } catch {
    await sleep(100)
  }
}

try {
  await open()
  const pyFile = "/tmp/busy.py"
  writeFileSync(pyFile, "import time\ndef busy_work():\n  e=time.time()+0.2\n  while time.time()<e: pass\nwhile True:\n  busy_work()\n  time.sleep(0.05)\n")

  await step("starts with an empty real backend", async () => {
    await see(/Capture a process/)
    await shot("d01-empty")
  })
  await step("no notification service: peak says what it knows and keeps working", async () => {
    await click("^Capture$", "ASIDE").catch(() => {})
    await click("^Settings$", "ASIDE")
    await see(/can't see whether it appears/)
    await click("^Send test$")
    await see(/Test notification handed over/)
    await shot("d01b-no-notification-service")
    await click("Close")
  })
  await step("captures a real command with output", async () => {
    await capture("echo hello-from-real-process; echo oops >&2; sleep 40")
    await see(/hello-from-real|echo hello-from-real/)
    await see(/\d+(\.\d+)? (KiB|MiB)/)
    await click("Output")
    await see(/hello-from-real-process/)
    await see(/oops/)
    await sleep(800)
    await shot("d02-output")
  })
  await step("timeline marks stderr and jumps to output", async () => {
    await click("Overview")
    await sleep(1500)
    const has = await js("return !!document.querySelector('[aria-label^=\"stderr at\"]')")
    if (!has) throw new Error("no stderr marker")
    await click("^stderr at")
    await see(/Output at T\+/)
    await shot("d03-jump")
  })
  await step("a real chart drag zooms; a real chart click opens the output", async () => {
    await click("Overview")
    // Enough history that a drag covers several samples in the shortest range.
    await sleep(9000)
    await click("^30s$")
    await sleep(500)
    await mouseOnChart(0.45, 0.95)
    await sleep(400)
    const zoomed = await js("return [...document.querySelectorAll('main button')].some((b) => /\\u2013/.test(b.innerText))")
    const output = await js("return document.querySelector('[role=tab][data-state=active]').innerText.startsWith('Output')")
    if (!zoomed || output) throw new Error(`drag: zoomed=${zoomed} output=${output}`)
    await js("[...document.querySelectorAll('main button')].find((b) => /\\u2013/.test(b.innerText)).click()")
    // The longest range redraws about once a second, so hover lands before the press
    // even under software rendering.
    await click("^1h$")
    await sleep(1200)
    await mouseOnChart(0.5, 0.5)
    await see(/Output at T\+|No output within 5s/)
    await shot("d03b-chart-click")
  })
  await step("stop a local run: exits cleanly", async () => {
    await click("^Stop$")
    await see(/Stopped|Exited/)
  })
  await step("python agent: lag and CPU profile from the real runtime", async () => {
    await capture(`python3 ${pyFile}`)
    await see(/python3/)
    await sleep(3000)
    await click("Resources")
    await see(/Runtime lag/)
    await see(/Threads and handles/)
    await sleep(1500)
    await shot("d04-resources")
    await click("Profiler")
    await click("^CPU$")
    await click("^Record 5s")
    await see(/Recording/)
    await sleep(1500)
    await shot("d05-recording")
    await see(/lock waits are included/, 12000)
    await sleep(1000)
    await shot("d06-cpu-profile")
    await click("^Heap$")
    await click("Take snapshot")
    await see(/Heap by type/, 30000)
    await sleep(600)
    await shot("d07-heap")
  })
  await step("a real notification daemon receives alerts, once per crossing", async () => {
    await startDunst()
    await click("^Settings$", "ASIDE")
    await see(/Storage\./)
    await sleep(500)
    await click("^Send test$")
    for (let i = 0; i < 30 && !notifications().some((n) => n.includes("Notifications are working")); i++) await sleep(200)
    if (!notifications().some((n) => n.includes("Notifications are working"))) throw new Error("the daemon never got the test notification")
    await click("Close")
  })
  await step("alerts from saved settings fire a toast and a marker", async () => {
    await click("^Settings$", "ASIDE")
    await see(/Storage\./)
    await sleep(500)
    await shot("d08-settings")
    await type('input[aria-label="Memory threshold in MiB"]', "1")
    await type('input[aria-label="Retention days"]', "14")
    await sleep(100)
    await click("^Save settings$")
    await see(/Alert:/)
    await shot("d09-alert")
    await click("Close")
    await sleep(800)
    const m = await js("return !!document.querySelector('[aria-label^=\"Alert at\"]')")
    if (!m) throw new Error("no alert marker on the timeline")
    await shot("d10-alert-marker")
    const got = () => notifications().filter((n) => n.startsWith("Peak alert") && n.includes("busy.py") && n.includes("Memory reached"))
    for (let i = 0; i < 30 && got().length === 0; i++) await sleep(200)
    if (got().length !== 1) throw new Error("expected one notification, got " + JSON.stringify(got()))
    await sleep(3000)
    if (got().length !== 1) throw new Error("repeated while still over the limit: " + JSON.stringify(got()))
  })
  await step("sustained CPU alert honours its duration; notifications can be turned off", async () => {
    await click("^Settings$", "ASIDE")
    await see(/Storage\./)
    await sleep(400)
    // Off first: this alert must show in the app and not reach the daemon.
    await click("Desktop notifications off")
    await type('input[aria-label="CPU threshold in percent"]', "20")
    await type('input[aria-label="CPU duration in seconds"]', "2")
    await sleep(100)
    const before = notifications().length
    await click("^Save settings$")
    await see(/CPU above 20/, 15000)
    await sleep(1500)
    if (notifications().length !== before) throw new Error("notified with notifications turned off")
    await shot("d10b-cpu-alert-no-notification")
    await click("Desktop notifications on")
    await type('input[aria-label="CPU duration in seconds"]', "0")
    await sleep(100)
    await click("^Save settings$")
    await sleep(800)
    await click("Close")
  })
  await step("machine strip shows real host data", async () => {
    await click("This machine")
    await see(/This machine\./)
    await sleep(800)
    await shot("d11-machine")
  })
  await step("stopping, then report and history", async () => {
    await click("python3", "ASIDE")
    await click("^Stop$")
    await see(/Stopped|Exited/)
    await click("Report")
    await see(/Verdict/)
    await see(/Top allocators/)
    await click("^Copy Markdown$")
    await see(/Copied|Couldn't copy the report/)
    const copied = await js("return document.body.innerText.includes('Copied')")
    console.log(copied ? "     clipboard: write accepted" : "     clipboard: refused by this webview, and reported")
    await shot("d12-report")
    await click("^History$", "ASIDE")
    await see(/History\./)
    await see(/python3/)
    await see(/echo hello-from-real/)
    await shot("d13-history")
  })
  await step("compare two real stored runs without adding them to the session", async () => {
    const before = await js("return document.querySelectorAll('aside li').length")
    await js("const b = document.querySelectorAll('main input[type=checkbox]'); b[0].click(); b[1].click()")
    await sleep(200)
    await click("^Compare$")
    await see(/Differences\./)
    await see(/Peak memory/)
    await sleep(800)
    await shot("d13b-compare")
    const after = await js("return document.querySelectorAll('aside li').length")
    if (after !== before) throw new Error("comparison changed the session")
  })
  await step("resources: real ports, children and lag", async () => {
    await capture("python3 -m http.server 18765 & sleep 40")
    await see(/python3 -m http.server/)
    await sleep(2500)
    await click("Resources")
    await see(/Listening ports/)
    await see(/18765/, 15000)
    await see(/Memory by process/)
    await sleep(800)
    await shot("d13c-ports-children")
    await click("^Stop$")
    await see(/Stopped|Exited/)
  })
  await step("node agent: lag, and a CPU profile that says how it sampled", async () => {
    await capture("node --no-use-osr -e 'function busyWork(){const e=Date.now()+100;while(Date.now()<e);} setInterval(busyWork,120)'")
    await see(/busyWork/)
    await sleep(2500)
    await click("Profiler")
    await click("^CPU$")
    await click("^Record 5s")
    await see(/Sampled by V8/, 12000)
    await sleep(800)
    await shot("d13d-node-profile")
    await click("^Stop$")
    await see(/Stopped|Exited/)
  })

  await step("real SSH target: connect, attach, launch, detach", async () => {
    await click("^Targets$", "ASIDE")
    await see(/Targets\./)
    await type('input[placeholder="me@build-box"]', "e2e-target")
    await sleep(100)
    await click("^Add and connect$")
    await see(/Connected/, 45000)
    await see(/Host memory/)
    await shot("d14-ssh-target")
    await click("^Capture$", "ASIDE")
    await see(/Capture a process/)
    await sleep(300)
    await selectValue('select[aria-label="Where"]')
    await see(/Runs on e2e-target/)
    await type('input[placeholder="bun run build"]', "echo remote-output; sleep 30")
    await sleep(100)
    await click("^Run and capture")
    await see(/on e2e-target/)
    await click("Output")
    await see(/remote-output/, 20000)
    await shot("d15-remote-output")
    await click("Stats")
    await see(/Target\./)
    await see(/This machine's clock vs the target's/)
    await shot("d16-remote-stats")
  })
  await step("attach an existing remote process: only observed, no plain Stop", async () => {
    const started = spawnSync("ssh", ["e2e-target", "nohup sleep 300 >/dev/null 2>&1 & echo $!"], { encoding: "utf8" })
    const pid = started.stdout.trim()
    if (!pid) throw new Error("couldn't start a remote process: " + started.stderr)
    await click("^Capture$", "ASIDE")
    await see(/Capture a process/)
    await sleep(300)
    await selectValue('select[aria-label="Where"]')
    await see(/Attaching only observes/)
    await see(/sleep 300/, 20000)
    await js(`[...document.querySelectorAll('main li button')].find((b) => /sleep 300/.test(b.innerText)).click()`)
    await see(/Detach/)
    await sleep(2500)
    const stop = await js("return [...document.querySelectorAll('main button')].some((b) => b.innerText.trim() === 'Stop')")
    if (stop) throw new Error("an attached service offers Stop")
    await click("Output")
    await see(/aren't captured here/)
    await shot("d17-remote-attached")
  })
  await step("disconnect: attached stays running, launched ends with the session", async () => {
    await click("^Targets$", "ASIDE")
    await click("^Disconnect$")
    await see(/Disconnected/)
    await click("sleep 300", "ASIDE")
    await see(/It may still be running/)
    await shot("d18-remote-disconnected")
    const alive = spawnSync("ssh", ["e2e-target", "pgrep -f 'sleep 300' | wc -l"], { encoding: "utf8" }).stdout.trim()
    if (alive === "0") throw new Error("disconnecting killed an attached process")
  })
  await step("reconnect: same run, verified, and the gap shows", async () => {
    await sleep(2000)
    await click("^Targets$", "ASIDE")
    await click("^Connect$")
    await see(/Connected/, 45000)
    await click("sleep 300", "ASIDE")
    await click("Overview")
    // SVG labels aren't in innerText on WebKit.
    const end = Date.now() + 15000
    while (!(await js("return !!document.querySelector('.recharts-reference-area') && document.body.textContent.includes('No data')"))) {
      if (Date.now() > end) throw new Error("no gap on the chart")
      await sleep(200)
    }
    await sleep(1000)
    await shot("d19-gap")
    await click("Detach", "MAIN")
    await see(/Monitoring stopped/)
    const alive = spawnSync("ssh", ["e2e-target", "pgrep -f 'sleep 300' | wc -l"], { encoding: "utf8" }).stdout.trim()
    if (alive === "0") throw new Error("detaching killed the process")
    await click("^Targets$", "ASIDE")
    await click("^Disconnect$")
  })
  await step("real Docker daemon through the UI: totals, logs, collector, attach", async () => {
    const run = spawnSync("docker", ["run", "-d", "--name", "e2e-web", "--memory", "128m", "alpine:3.20", "sh", "-c", "echo docker-log-line; while true; do sleep 1; done"], { encoding: "utf8" })
    if (run.status !== 0) throw new Error("docker run: " + run.stderr)
    await click("^Targets$", "ASIDE")
    await click("^Docker$")
    await see(/e2e-web/, 30000)
    await click("^e2e-web")
    await see(/The whole container, not one process tree/)
    await see(/limit 128 MiB/, 20000)
    await see(/docker-log-line/, 15000)
    await see(/These PIDs differ/)
    await shot("d20-docker-browser")
    await click("^Monitor in detail$")
    await see(/Connected/, 60000)
    await see(/128 MiB/)
    await shot("d20b-docker-target")
    await chooseTarget("e2e-web")
    await see(/while true/, 20000)
    await js("[...document.querySelectorAll('main li button')].find((b) => /while true/.test(b.innerText)).click()")
    await see(/on e2e-web/)
    await sleep(2500)
    await shot("d20c-docker-attached")
    await click("Detach", "MAIN")
    await see(/Monitoring stopped/)
    const alive = spawnSync("docker", ["inspect", "-f", "{{.State.Running}}", "e2e-web"], { encoding: "utf8" }).stdout.trim()
    if (alive !== "true") throw new Error("detaching stopped the container")
    await click("^Targets$", "ASIDE")
    await click("^Disconnect$")
    await see(/Disconnected/)
    await click("^Remove$", "Target e2e-web")
  })
  await step("real Kubernetes through the UI: pods, logs, RBAC answer, collector, attach", async () => {
    const yaml = "apiVersion: v1\nkind: Pod\nmetadata: { name: e2e-pod, namespace: default }\nspec:\n  terminationGracePeriodSeconds: 1\n  containers:\n  - name: app\n    image: alpine:3.20\n    command: ['sh','-c','echo kube-log-line; while true; do sleep 1; done']\n    resources: { limits: { memory: '64Mi' } }\n"
    const applied = spawnSync("kubectl", ["apply", "-f", "-"], { input: yaml, encoding: "utf8" })
    if (applied.status !== 0) throw new Error("kubectl apply: " + applied.stderr)
    let phase = ""
    for (let i = 0; i < 150 && phase !== "Running"; i++) {
      phase = spawnSync("kubectl", ["get", "pod", "e2e-pod", "-o", "jsonpath={.status.phase}"], { encoding: "utf8" }).stdout
      await sleep(1000)
    }
    if (phase !== "Running") throw new Error("pod stayed " + phase + ": " + spawnSync("kubectl", ["describe", "pod", "e2e-pod"], { encoding: "utf8" }).stdout.slice(-500))
    await click("^Targets$", "ASIDE")
    await click("^Kubernetes$")
    await see(/e2e-pod \/ app/, 30000)
    await click("^e2e-pod / app")
    await see(/kube-log-line/, 20000)
    await see(/no metrics API available|No measurement for this container yet|CPU \d+m/, 20000)
    await shot("d21-kube-browser")
    await js("[...document.querySelectorAll('main input[type=checkbox]')].at(-1).click()")
    await sleep(200)
    await click("^Monitor in detail$")
    await see(/Connected/, 60000)
    await see(/64 MiB/)
    await shot("d21b-kube-target")
    await chooseTarget("e2e-pod")
    await see(/while true/, 20000)
    await js("[...document.querySelectorAll('main li button')].find((b) => /while true/.test(b.innerText)).click()")
    await see(/on default\/e2e-pod\/app/)
    await sleep(2500)
    await shot("d21c-kube-attached")
    await click("Detach", "MAIN")
    await see(/Monitoring stopped/)
    await click("^Targets$", "ASIDE")
    await click("^Disconnect$", "Target default/e2e-pod/app")
  })
  await close()

  await open()
  await step("after a restart: history and settings survive", async () => {
    await click("^Settings$", "ASIDE")
    await see(/Storage\./)
    await sleep(500)
    const v = await js("return document.querySelector('input[aria-label=\"Memory threshold in MiB\"]').value")
    const d = await js("return document.querySelector('input[aria-label=\"Retention days\"]').value")
    if (v !== "1" || d !== "14") throw new Error(`settings lost: ${v} ${d}`)
    await click("^History$", "ASIDE")
    await see(/python3/)
    await see(/Interrupted|Stopped/)
    await shot("d22-history-after-restart")
    await click("^Open python3 /tmp/busy", "MAIN")
    await see(/From history/)
    await click("Profiler")
    await click("^CPU$")
    await see(/CPU profile\./)
    await shot("d23-reopened-profile")
  })
  await step("targets are remembered, and don't reconnect by themselves", async () => {
    await click("^Targets$", "ASIDE")
    await see(/e2e-target/)
    await see(/Disconnected/)
  })
  await step("storage maintenance removes history, leaves a running workload recording", async () => {
    await capture("echo still-here; sleep 60")
    await see(/still-here|sleep 60/)
    await sleep(1500)
    await click("^Settings$", "ASIDE")
    await see(/Storage\./)
    await sleep(500)
    await shot("d24-storage-before")
    await click("^Delete all stopped runs$")
    await click("^Delete all$")
    await see(/Removed \d+ runs?/)
    await see(/\(0 stopped\)/)
    await click("Compact database")
    await see(/Database compacted/)
    await shot("d25-storage-after")
    await click("Close")
    const samples = () => js("return document.body.innerText.includes('Running')")
    if (!(await samples())) throw new Error("the running workload was disturbed")
    await click("Report")
    await see(/Running|Still running/)
    await click("^Stop$")
    await see(/Stopped|Exited/)
  })
  await close()
} catch (e) {
  problems.push(String(e))
} finally {
  driver.kill()
}
console.log(problems.length ? "PROBLEMS:\n" + problems.join("\n") : "ALL OK")
process.exit(problems.length ? 1 : 0)
