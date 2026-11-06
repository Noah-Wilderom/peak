// The real app opened on its own, then the real CLI started from other processes, with
// ordinary environments and no discovery override. Checks the terminal side (output, exit
// code, what peak says) and the app side (the run appears in the already open window).
// Run through run.sh: PEAK_E2E_SCRIPT=cli-discovery.mjs NO_DIND=1 NO_K3S=1 run.sh ...
import { spawn } from "node:child_process"
import { chmodSync, copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { createServer } from "node:net"

const DRIVER = "http://127.0.0.1:4444"
const OUT = process.env.OUT
const ONLY = process.env.PEAK_E2E_ONLY ? new RegExp(process.env.PEAK_E2E_ONLY) : null
const HOME = "/home/tester"
const DATA = `${HOME}/.local/share/peak`
const APP = "/opt/peak/peak"
const ALT = "/opt/peak/alt-cli"
let session = null
const problems = []
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function wd(method, path, body) {
  const url = path.startsWith("/session") || path === "/status" ? `${DRIVER}${path}` : `${DRIVER}/session/${session}${path}`
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
const js = (script, args = []) => wd("POST", "/execute/sync", { script, args })
const pageText = () => js("return document.body.innerText")
async function see(pattern, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pattern.test(await pageText())) return
    await sleep(150)
  }
  throw new Error(`the app never showed ${pattern}`)
}
async function open() {
  const v = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: APP } } } })
  session = v.sessionId
  await see(/peak\./, 30000)
  await sleep(500)
}
async function close() {
  await wd("DELETE", "").catch(() => {})
  session = null
  await sleep(1500)
}
const shot = async (name) => {
  const b64 = await wd("GET", "/screenshot")
  writeFileSync(`${OUT}/${name}.png`, Buffer.from(b64, "base64"))
}

/** A shell's view of things: its own env, nothing inherited from the display or the driver. */
const shell = (extra = {}) => ({ HOME, USER: "tester", PATH: `${HOME}/.local/bin:/opt/peak:/usr/local/bin:/usr/bin:/bin`, LANG: "C.UTF-8", ...extra })

/** Start the CLI as a separate process. `done` resolves with what a terminal would have seen. */
function cli(argv, { env = shell(), cwd = "/tmp" } = {}) {
  const c = spawn(argv[0], argv.slice(1), { env, cwd, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  c.stdout.on("data", (d) => (out += d))
  c.stderr.on("data", (d) => (err += d))
  const done = new Promise((res) => {
    const t0 = Date.now()
    c.on("error", (e) => res({ code: 127, out, err: err + e.message, ms: Date.now() - t0 }))
    c.on("close", (code, signal) => res({ code, signal, out, err, ms: Date.now() - t0 }))
  })
  return { pid: c.pid, done }
}

const unique = (() => {
  let n = 0
  return (tag) => `cli-${tag}-${++n}-${Date.now() % 100000}`
})()

/** The ordinary case: run it, watch it appear while running, check output and exit in both places. */
async function monitored(argv0, tag, opts = {}) {
  const id = unique(tag)
  const c = cli([...argv0, "run", "--", "sh", "-c", `echo ${id}-out; echo ${id}-err >&2; sleep 3; exit 7`], opts)
  await see(new RegExp(id), 2500)
  await js(`const e=[...document.querySelectorAll('aside button, aside [role=button], aside a, aside li, aside div')].find((x)=>x.textContent.includes(arguments[0])&&x.children.length<8); e&&e.click()`, [id])
  await see(/Running/)
  const r = await c.done
  if (r.code !== 7) throw new Error(`exit ${r.code}, wanted 7. stderr: ${r.err}`)
  if (!r.out.includes(`${id}-out`)) throw new Error(`stdout: ${r.out}`)
  if (!r.err.includes(`${id}-err`)) throw new Error(`stderr: ${r.err}`)
  if (/isn't running|without monitoring/.test(r.err)) throw new Error(`said: ${r.err}`)
  await see(/Failed · exit 7/, 6000)
  await js(`[...document.querySelectorAll('[role=tab]')].find((t)=>t.innerText.startsWith('Output')).click()`)
  await see(new RegExp(`${id}-out`), 4000)
  await see(new RegExp(`${id}-err`), 4000)
  await js(`[...document.querySelectorAll('[role=tab]')].find((t)=>t.innerText.startsWith('Overview')).click()`)
  return `exit ${r.code}, ${r.ms}ms, running then failed in the open app, output in both`
}

/** Not monitored, for the stated reason, with the command itself unaffected. */
async function unmonitored(argv0, said, opts = {}, askApp = true) {
  const id = unique("off")
  const r = await cli([...argv0, "run", "--", "sh", "-c", `echo ${id}; exit 3`], opts).done
  const first = r.err.split("\n")[0]
  if (r.code !== 3 || !r.out.includes(id)) throw new Error(`command disturbed: exit ${r.code}, out ${r.out}`)
  if (!said.test(r.err)) throw new Error(`wrong reason: "${first}" (wanted ${said})`)
  if (askApp && session && (await pageText()).includes(id)) throw new Error("appeared in the app anyway")
  return `exit ${r.code}, ${r.ms}ms, said: ${first}`
}

const NO_APP = /app isn't running/
async function step(name, fn) {
  if (ONLY && !ONLY.test(name)) return
  try {
    const note = await fn()
    console.log("ok  ", name, note ? `\n       ${note}` : "")
  } catch (e) {
    problems.push(`${name}: ${e.message}`)
    console.log("FAIL", name, `\n       ${e.message.split("\n")[0]}`)
    if (session) await shot("fail-" + name.replace(/\W+/g, "-")).catch(() => {})
  }
}

/** Another app, started from a plain command the way a second launch would be. */
async function secondApp() {
  const a = spawn(APP, [], { env: { ...shell(), DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY ?? "", DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? "", WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1" }, stdio: "ignore" })
  await sleep(4000)
  return a
}
/** The newest app, by its own record: an AppImage has a second process of the same name. */
const appPid = async () => {
  const dir = `${DATA}/instances`
  const records = readdirSync(dir).filter((f) => f.endsWith(".json")).map((f) => JSON.parse(readFileSync(`${dir}/${f}`, "utf8")))
  return String(records.sort((a, b) => b.startedAt - a.startedAt)[0].pid)
}

const driver = spawn("/opt/peak/tauri-driver", ["--native-driver", "/usr/bin/WebKitWebDriver"], { stdio: "inherit" })
for (let i = 0; i < 100; i++) {
  try { await wd("GET", "/status"); break } catch { await sleep(100) }
}

try {
  await step("no app has ever run: says so, command unaffected", () => unmonitored(["peak"], NO_APP))

  await open()
  await step("app open, `peak` on PATH, cwd /tmp", () => monitored(["peak"], "path"))
  await step("different working directory, relative binary path", async () => {
    mkdirSync("/tmp/wd/deep/er", { recursive: true })
    return monitored(["../../../../opt/peak/peak"], "rel", { cwd: "/tmp/wd/deep/er" })
  })
  await step("installed copy in ~/.local/bin (task peak:install's result)", async () => {
    mkdirSync(`${HOME}/.local/bin`, { recursive: true })
    copyFileSync(APP, `${HOME}/.local/bin/peak`)
    chmodSync(`${HOME}/.local/bin/peak`, 0o755)
    return monitored([`${HOME}/.local/bin/peak`], "installed", { cwd: HOME })
  })
  await step("the other build's CLI against this app (dev <-> release)", () => {
    if (!existsSync(ALT)) throw new Error("no alternate CLI mounted")
    return monitored([ALT], "altcli", { cwd: "/var/tmp" })
  })
  await step("shell with a different XDG_DATA_HOME (snap, IDE and sudo terminals do this)", () => {
    const d = mkdtempSync("/tmp/xdg-")
    return monitored(["peak"], "xdg", { env: shell({ XDG_DATA_HOME: d }) })
  })
  await step("shell with an empty XDG_DATA_HOME, and no USER", () => {
    const env = shell({ XDG_DATA_HOME: "" })
    delete env.USER
    return monitored(["peak"], "xdgempty", { env })
  })
  await step("shell with HOME unset", () => {
    const env = shell()
    delete env.HOME
    return monitored(["peak"], "nohome", { env })
  })
  await step("record removed while the app stays open", async () => {
    rmSync(`${DATA}/control.json`, { force: true })
    rmSync(`${DATA}/instances`, { recursive: true, force: true })
    rmSync(`${HOME}/.local/state/peak`, { recursive: true, force: true })
    await sleep(12000) // the app has a moment to notice
    return monitored(["peak"], "removed")
  })
  await step("a second app opens, then closes: the first stays reachable", async () => {
    const a = await secondApp()
    a.kill("SIGTERM")
    await sleep(1000)
    return monitored(["peak"], "second-closed")
  })
  await step("two apps open: the run goes to exactly one, and peak says which", async () => {
    const a = await secondApp()
    const id = unique("two")
    const r = await cli(["peak", "run", "--", "echo", id]).done
    const here = (await pageText()).includes(id)
    a.kill("SIGTERM")
    await sleep(1000)
    if (r.code !== 0 || /isn't running/.test(r.err)) throw new Error(`exit ${r.code}: ${r.err}`)
    if (!/2 Peak apps/.test(r.err)) throw new Error(`didn't say which: "${r.err.trim()}"`)
    return `shown in driven app: ${here}; said: ${r.err.split("\n")[0]}`
  })
  await step("app frozen (SIGSTOP): reported as not answering, not as absent", async () => {
    const pid = await appPid()
    process.kill(+pid, "SIGSTOP")
    try {
      // A frozen window can't be asked anything until it's thawed.
      return await unmonitored(["peak"], /open.*(isn't answering)/, {}, false)
    } finally {
      process.kill(+pid, "SIGCONT")
      await sleep(1000)
    }
  })
  await step("thawed: the same app takes commands again", () => monitored(["peak"], "thawed"))
  await step("another user can't use this user's app", async () => {
    // Their own environment first, then this user's dir pointed at explicitly.
    const own = await cli(["sudo", "-n", "-u", "other", "-H", "/opt/peak/peak", "run", "--", "sh", "-c", "exit 3"]).done
    if (own.code !== 3 || !NO_APP.test(own.err)) throw new Error(`own env: exit ${own.code}: ${own.err}`)
    const pointed = await cli(["sudo", "-n", "-u", "other", `XDG_DATA_HOME=${HOME}/.local/share`, "HOME=/home/other", "/opt/peak/peak", "run", "--", "sh", "-c", "exit 3"]).done
    if (pointed.code !== 3) throw new Error(`pointed: exit ${pointed.code}: ${pointed.err}`)
    if (/ other /.test(await pageText())) throw new Error("appeared in the app")
    return `own: ${own.err.split("\n")[0]} | pointed at this user's dir: ${pointed.err.split("\n")[0]}`
  })
  await shot("c01-monitored-runs")

  await step("app closed normally: truly no app", async () => {
    await close()
    return unmonitored(["peak"], NO_APP)
  })
  await step("reopened: found again, in a different working directory", async () => {
    await open()
    return monitored(["peak"], "reopen", { cwd: "/usr" })
  })
  await step("app killed: stale record is recognised and never handed the secret", async () => {
    const records = () => [`${DATA}/control.json`, ...["instances"].flatMap((d) => (existsSync(`${DATA}/${d}`) ? readdirSync(`${DATA}/${d}`).map((f) => `${DATA}/${d}/${f}`) : []))].filter(existsSync)
    const before = records().map((f) => JSON.parse(readFileSync(f, "utf8")))
    const addr = before[0].addr
    const secret = before[0].secret
    process.kill(+(await appPid()), "SIGKILL")
    await wd("DELETE", "").catch(() => {})
    session = null
    await sleep(1500)
    const plain = await unmonitored(["peak"], NO_APP)
    // Something else now holds the dead app's port.
    let got = ""
    const srv = createServer((s) => s.on("data", (d) => (got += d)))
    await new Promise((res, rej) => { srv.once("error", rej); srv.listen(+addr.split(":")[1], "127.0.0.1", res) })
    try {
      const r = await unmonitored(["peak"], NO_APP)
      if (got.includes(secret)) throw new Error("the dead app's secret went to whatever holds its port now")
      return `${plain} | port reused: ${r}`
    } finally {
      srv.close()
    }
  })
  await step("restarted after the crash: found again", async () => {
    await open()
    return monitored(["peak"], "after-crash")
  })
  await step("corrupt record beside a healthy app", async () => {
    mkdirSync(`${DATA}/instances`, { recursive: true })
    writeFileSync(`${DATA}/instances/garbage.json`, "{ not json")
    writeFileSync(`${DATA}/control.json`, "{ not json")
    return monitored(["peak"], "corrupt")
  })
  await close()
  await step("only a corrupt record: reported as that, not as no app", async () => {
    rmSync(`${DATA}/instances`, { recursive: true, force: true })
    writeFileSync(`${DATA}/control.json`, "{ not json")
    return unmonitored(["peak"], /couldn't read|can't read/)
  })
} catch (e) {
  problems.push(String(e))
} finally {
  driver.kill()
}
console.log(problems.length ? `PROBLEMS: ${problems.length}\n` + problems.join("\n") : "ALL OK")
process.exit(problems.length ? 1 : 0)
