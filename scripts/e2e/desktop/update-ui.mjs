#!/usr/bin/env node
// The update flow as a person sees it, through the real window and its real buttons, on real
// packaged builds. Run under dbus and xvfb-run, with tauri-driver at $PEAK_TAURI_DRIVER.
//   PEAK_SMOKE_PLATFORM=linux update-ui.mjs <output dir>
import { spawn } from "node:child_process"
import { createHash } from "node:crypto"
import { createServer } from "node:http"
import { IS_WINDOWS, PLATFORM, closeApps, dataDir, install, join, launch, liveApps, log, mkdirSync, mkdtempSync, paths, pidAlive, readFileSync, sleep, tmpdir, waitFor, writeFileSync } from "../smoke/lib.mjs"
import { buildPair } from "../smoke/build-pair.mjs"
import { DatabaseSync } from "node:sqlite"

const out = process.argv[2]
mkdirSync(out, { recursive: true })
const [BASE, NEXT, PORT] = ["9.0.0", "9.0.1", 18766]
const HELD = IS_WINDOWS ? "ping -n 300 127.0.0.1" : "sleep 300"
const HELD_SEEN = new RegExp(HELD.replace(/\./g, "\\."))
const work = mkdtempSync(join(tmpdir(), "peak-ui-"))
const { baseDir, artifactName, artifactBytes, goodSig, key } = buildPair({ work, BASE, NEXT, PORT, autoUpdate: false })
const problems = []
const DRIVER = "http://127.0.0.1:4444"
const CDP_PORT = 9223
let session = null
let cdp = null
let cdpId = 0

async function wd(method, path, body) {
  const url = path.startsWith("/session") || path === "/status" ? `${DRIVER}${path}` : `${DRIVER}/session/${session}${path}`
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}

/** On Windows the window is driven through WebView2's own debugging protocol. */
function cdpCall(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++cdpId
    const onMessage = (e) => {
      const m = JSON.parse(e.data)
      if (m.id !== id) return
      cdp.removeEventListener("message", onMessage)
      if (m.error) reject(new Error(m.error.message))
      else resolve(m.result)
    }
    cdp.addEventListener("message", onMessage)
    cdp.send(JSON.stringify({ id, method, params }))
    setTimeout(() => reject(new Error(`${method} got no answer`)), 20_000)
  })
}
async function evaluate(script, args) {
  const r = await cdpCall("Runtime.evaluate", { expression: `(function () { ${script} }).apply(null, ${JSON.stringify(args)})`, returnByValue: true })
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text)
  return r.result.value
}
const js = (script, args = []) => (IS_WINDOWS ? evaluate(script, args) : wd("POST", "/execute/sync", { script, args }))
const text = () => js("return document.body.innerText")
async function see(pattern, ms = 15000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (pattern.test(await text())) return
    await sleep(150)
  }
  throw new Error(`never saw ${pattern}\n${(await text()).slice(0, 600)}`)
}
const CLICK = `const re = new RegExp(arguments[0]); const el = [...document.querySelectorAll('button,[role=tab],[role=radio],a')].find((e) => re.test((e.getAttribute('aria-label') || e.innerText || '').trim())); if (!el) return false; el.click(); return true`
async function click(pattern, ms = 10000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (await js(CLICK, [pattern])) return
    await sleep(150)
  }
  throw new Error(`nothing to click for /${pattern}/`)
}
const shot = async (name) => {
  const b64 = IS_WINDOWS ? (await cdpCall("Page.captureScreenshot")).data : await wd("GET", "/screenshot")
  writeFileSync(join(out, `${name}.png`), Buffer.from(b64, "base64"))
}
async function open() {
  if (IS_WINDOWS) {
    launch({ WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: `--remote-debugging-port=${CDP_PORT}` })
    const target = await waitFor("the window's debugging port", async () => {
      const pages = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.json()).catch(() => [])
      return pages.find((p) => p.type === "page")
    }, 60_000)
    cdp = new WebSocket(target.webSocketDebuggerUrl)
    await new Promise((res, rej) => {
      cdp.addEventListener("open", res, { once: true })
      cdp.addEventListener("error", rej, { once: true })
    })
  } else {
    const v = await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: paths().gui } } } })
    session = v.sessionId
  }
  await see(/peak\./, 30000)
}
/** Stop driving, and close whichever app is open. */
async function endSession() {
  if (IS_WINDOWS) cdp?.close()
  else await wd("DELETE", "").catch(() => {})
  session = null
  cdp = null
  closeApps()
  await sleep(2500)
}
async function step(name, fn) {
  try {
    const note = await fn()
    log("ok  ", name, note ?? "")
  } catch (e) {
    problems.push(`${name}: ${e.message}`)
    log("FAIL", name, e.message)
    await shot(`fail-${name.replace(/\W+/g, "-")}`).catch(() => {})
  }
}
const set = (pattern) => js(CLICK, [pattern])

let mode = "off"
let hits = 0
const server = createServer((req, res) => {
  if (req.url === "/latest.json") {
    const version = mode === "current" ? BASE : NEXT
    const body = { version, notes: "A proof release.", pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), platforms: { [key]: { signature: goodSig, url: `http://127.0.0.1:${PORT}/${artifactName}` } } }
    return void res.writeHead(200, { "content-type": "application/json" }).end(JSON.stringify(body))
  }
  hits++
  const bytes = mode === "tampered" ? Buffer.concat([artifactBytes.subarray(0, 4096), Buffer.from("tampered"), artifactBytes.subarray(4104)]) : artifactBytes
  res.writeHead(200, { "content-length": bytes.length })
  // Slowly enough to see progress.
  const chunks = 20
  let i = 0
  const t = setInterval(() => {
    if (i === chunks) {
      clearInterval(t)
      return void res.end()
    }
    res.write(bytes.subarray(Math.floor((i * bytes.length) / chunks), Math.floor(((i + 1) * bytes.length) / chunks)))
    i++
  }, 100)
})
const serve = () => new Promise((r) => server.listen(PORT, "127.0.0.1", r))
const hash = () => createHash("sha256").update(readFileSync(paths().gui)).digest("hex")

const driver = IS_WINDOWS ? null : spawn(process.env.PEAK_TAURI_DRIVER, ["--native-driver", "/usr/bin/WebKitWebDriver"], { stdio: "inherit" })
for (let i = 0; driver && i < 100; i++) {
  try {
    await wd("GET", "/status")
    break
  } catch {
    await sleep(100)
  }
}

const openSettings = async () => {
  await click("^Settings$")
  await see(/About and updates/)
}
try {
  install(baseDir)
  const before = hash()
  await open()
  await step("offline, a check says so in Settings and nothing interrupts", async () => {
    await openSettings()
    await see(new RegExp(`Peak ${BASE.replace(/\./g, "\\.")}`))
    await click("^Check for updates$")
    await see(/Couldn't check for updates/)
    if (await js("return !!document.querySelector('[aria-label=\"Peak update\"]')")) throw new Error("a popup for a failed check")
    await shot("u1-offline")
  })
  await serve()
  await step("no newer release: says it's the latest", async () => {
    mode = "current"
    await click("^Check for updates$")
    await see(/This is the latest version/)
    await shot("u2-current")
  })
  await step("a tampered download is refused, with the reason, and the app carries on", async () => {
    mode = "tampered"
    await click("^Check for updates$")
    await see(/Peak 9\.0\.1 is available/)
    await click("Download and install")
    await see(/couldn't be installed/, 30000)
    await see(/failed its signature check, so nothing was installed/)
    await see(/unchanged and keeps working/)
    await shot("u3-tampered")
    if (hash() !== before) throw new Error("the install changed")
    if (!liveApps().length) throw new Error("the app went away")
  })
  await endSession()

  await step("a new release is found by itself and nothing downloads until asked", async () => {
    mode = "good"
    hits = 0
    await open()
    await see(/Peak 9\.0\.1 is available/, 30000)
    await see(/A proof release/)
    await shot("u4-discovered")
    await sleep(3000)
    if (hits) throw new Error(`downloaded without asking: ${hits}`)
    await click("^Later$")
    await sleep(500)
    if (/Peak 9\.0\.1 is available/.test(await text())) throw new Error("Later didn't hide it")
  })
  await step("settings saved before the update", async () => {
    await openSettings()
    await set("^Alerts off$")
    await sleep(200)
    await click("^Save settings$")
    await see(/Settings saved/)
    await click("Close")
  })
  await step("a command captured in the app, to see a restart treat it fairly", async () => {
    await click("^Capture$")
    await see(/Capture a process/)
    await js(`const s = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set; const i = document.querySelector('input[placeholder="bun run build"]'); s.call(i, arguments[0]); i.dispatchEvent(new Event('input', { bubbles: true }))`, [HELD])
    await sleep(100)
    await click("^Run and capture")
    await see(HELD_SEEN)
    await sleep(1500)
  })
  const oldPid = liveApps()[0]?.pid
  await step("download shows progress, verifies, installs, and then waits", async () => {
    await openSettings()
    await click("^Check for updates$")
    await click("Download and install")
    await see(/Downloading Peak 9\.0\.1/, 8000)
    await shot("u5-downloading")
    // Windows waits to install until the restart, because its installer ends the app.
    await see(IS_WINDOWS ? /Peak 9\.0\.1 is downloaded and verified/ : /Peak 9\.0\.1 is installed/, 60000)
    await see(/Nothing restarts until you say so/)
    await shot("u6-installed")
    await sleep(4000)
    if (!pidAlive(oldPid)) throw new Error("restarted without being asked")
    if (!IS_WINDOWS && hash() === before) throw new Error("the file on disk wasn't replaced")
    if (IS_WINDOWS && hash() !== before) throw new Error("installed before being asked")
  })
  await step("a restart names what it would stop, and can be declined", async () => {
    await click("Restart now")
    await see(/Restarting stops this command/)
    await see(HELD_SEEN)
    await shot("u7-confirm")
    await click("^Not now$")
    await sleep(1000)
    if (!pidAlive(oldPid)) throw new Error("declined, but it restarted")
  })
  await step("restart: the old app exits and the new version comes up", async () => {
    await click("Restart now")
    // The window can be gone before WebDriver answers this click. What counts comes next.
    await click("^Stop and restart$").catch(() => {})
    const fresh = await waitFor("the new app", () => liveApps().find((i) => i.pid !== oldPid), 60_000)
    await waitFor("the old app to go", () => !pidAlive(oldPid), 20_000)
    await sleep(3000)
    await endSession()
    return `${oldPid} -> ${fresh.pid}`
  })
  await step("reopened: new version, with history and settings", async () => {
    mode = "current"
    await open()
    await openSettings()
    await see(new RegExp(`Peak ${NEXT.replace(/\./g, "\\.")}`))
    await see(/Alerts/)
    const kept = await js(`const r = [...document.querySelectorAll('[role=radio]')].find((e) => e.getAttribute('aria-label') === 'Alerts off'); return r && r.getAttribute('aria-checked')`)
    if (kept !== "true") throw new Error(`settings lost: ${kept}`)
    await shot("u8-after")
    await click("Close")
    await click("^History$")
    await see(HELD_SEEN)
    await shot("u9-history")
    const db = new DatabaseSync(join(dataDir(), "peak.db"), { readOnly: true })
    const n = db.prepare("SELECT COUNT(*) n FROM runs WHERE command = ?").get(HELD).n
    db.close()
    if (n !== 1) throw new Error(`runs: ${n}`)
  })
} catch (e) {
  problems.push(String(e))
} finally {
  await endSession()
  driver?.kill()
  server.closeAllConnections?.()
  server.close()
}
log(problems.length ? `PROBLEMS: ${problems.length}\n${problems.join("\n")}` : `ALL OK (${PLATFORM})`)
process.exit(problems.length ? 1 : 0)
