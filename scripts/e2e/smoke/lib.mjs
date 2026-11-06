// What the packaged-app checks share: installing each platform's artifact the way its
// documented steps do, launching it on its own, and running its CLI from another process.
import { execFileSync, spawn, spawnSync } from "node:child_process"
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { DatabaseSync } from "node:sqlite"
import { join } from "node:path"

export const PLATFORM = process.env.PEAK_SMOKE_PLATFORM
if (!PLATFORM) throw new Error("set PEAK_SMOKE_PLATFORM")
export const IS_WINDOWS = PLATFORM === "windows"
export const IS_MAC = PLATFORM.startsWith("darwin")
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
export const log = (...a) => console.log(...a)

export const dataDir = () => {
  if (IS_WINDOWS) return join(process.env.LOCALAPPDATA, "peak")
  if (IS_MAC) return join(homedir(), "Library/Application Support/peak")
  return join(process.env.XDG_DATA_HOME || join(homedir(), ".local/share"), "peak")
}

/** Where each format installs, and its GUI and CLI. */
export function paths() {
  if (IS_WINDOWS) {
    const dir = join(process.env.LOCALAPPDATA, "peak")
    return { gui: join(dir, "peak.exe"), cli: join(dir, "peak-cli.exe") }
  }
  if (IS_MAC) {
    const exe = join(homedir(), "Applications/peak.app/Contents/MacOS/peak")
    return { gui: exe, cli: exe }
  }
  const exe = join(homedir(), ".local/bin/peak")
  return { gui: exe, cli: exe }
}

const artifact = (dir, re) => {
  const f = readdirSync(dir).find((n) => re.test(n) && !n.endsWith(".sig"))
  if (!f) throw new Error(`no ${re} in ${dir}`)
  return join(dir, f)
}

/** Install from the release artifacts in `dir`, replacing any earlier copy. */
export function install(dir) {
  if (IS_WINDOWS) {
    const r = spawnSync(artifact(dir, /-setup\.exe$/), ["/S"], { stdio: "inherit" })
    if (r.status !== 0) throw new Error(`installer exited ${r.status}`)
  } else if (IS_MAC) {
    const mount = mkdtempSync(join(tmpdir(), "peak-dmg-"))
    execFileSync("hdiutil", ["attach", artifact(dir, /\.dmg$/), "-nobrowse", "-mountpoint", mount], { stdio: "inherit" })
    mkdirSync(join(homedir(), "Applications"), { recursive: true })
    execFileSync("rm", ["-rf", join(homedir(), "Applications/peak.app")])
    execFileSync("cp", ["-R", join(mount, "peak.app"), join(homedir(), "Applications/peak.app")])
    execFileSync("hdiutil", ["detach", mount], { stdio: "inherit" })
  } else {
    execFileSync("sh", ["scripts/install-release.sh", "--file", artifact(dir, /\.AppImage$/)], { stdio: "inherit" })
  }
}

/** Start the installed app, independently of this process. */
export function launch(env = {}) {
  const { gui } = paths()
  // The display has to outlive this app, because an update relaunches it: run this script under xvfb-run.
  if (PLATFORM === "linux" && !process.env.DISPLAY) throw new Error("no display: run under xvfb-run")
  const app = spawn(gui, [], { detached: true, stdio: "ignore", env: { ...process.env, WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1", ...env } })
  app.unref()
  return app
}

export const instances = () => {
  const d = join(dataDir(), "instances")
  if (!existsSync(d)) return []
  return readdirSync(d).filter((f) => f.endsWith(".json")).flatMap((f) => {
    try {
      return [JSON.parse(readFileSync(join(d, f), "utf8"))]
    } catch {
      return []
    }
  })
}

export const pidAlive = (pid) => {
  if (IS_WINDOWS) return spawnSync("tasklist", ["/FI", `PID eq ${pid}`, "/NH"], { encoding: "utf8" }).stdout.includes(String(pid))
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export const liveApps = () => instances().filter((i) => pidAlive(i.pid))

export async function waitFor(what, ok, ms = 60_000) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    const v = await ok()
    if (v) return v
    await sleep(500)
  }
  throw new Error(`timed out waiting for ${what}`)
}

export function closeApps() {
  for (const i of liveApps()) {
    if (IS_WINDOWS) spawnSync("taskkill", ["/PID", String(i.pid), "/T", "/F"])
    else {
      try {
        process.kill(i.pid, "SIGTERM")
      } catch {}
    }
  }
}

/** The CLI, from another process and directory. Resolves with what a terminal would show. */
export function cli(args, { cwd = tmpdir() } = {}) {
  const c = spawn(paths().cli, args, { cwd, stdio: ["ignore", "pipe", "pipe"] })
  let out = ""
  let err = ""
  c.stdout.on("data", (d) => (out += d))
  c.stderr.on("data", (d) => (err += d))
  const done = new Promise((res) => {
    c.on("error", (e) => res({ code: -1, out, err: err + e.message }))
    c.on("close", (code) => res({ code, out, err }))
  })
  return { child: c, done }
}

/** A workload with some real memory and CPU, a line on each stream and a known exit. */
export function workload(id, seconds, code) {
  const f = join(mkdtempSync(join(tmpdir(), "peak-work-")), "work.cjs")
  writeFileSync(f, `console.log("${id}-out"); console.error("${id}-err");
    const keep = []; const end = Date.now() + ${seconds * 1000};
    const t = setInterval(() => { keep.push(Buffer.alloc(4e6, 1)); let x = 0; for (let i = 0; i < 2e7; i++) x += i;
      if (Date.now() > end) { clearInterval(t); process.exit(${code}) } }, 200)\n`)
  return ["node", f]
}

/** What the app recorded for a run, straight from its database. */
export function storedRun(id) {
  const db = new DatabaseSync(join(dataDir(), "peak.db"), { readOnly: true })
  try {
    const log = db.prepare("SELECT run_id, text FROM logs WHERE text LIKE ? LIMIT 1").get(`%${id}%`)
    if (!log) return null
    const run = db.prepare("SELECT * FROM runs WHERE id = ?").get(log.run_id)
    const s = db.prepare("SELECT COUNT(*) n FROM samples WHERE run_id = ?").get(log.run_id)
    return { ...run, samples: s.n, maxRss: run.peak_rss }
  } finally {
    db.close()
  }
}

/** Every sample of a run, as the app stored them. */
export function storedSamples(id) {
  const db = new DatabaseSync(join(dataDir(), "peak.db"), { readOnly: true })
  try {
    const log = db.prepare("SELECT run_id FROM logs WHERE text LIKE ? LIMIT 1").get(`%${id}%`)
    if (!log) return []
    return db.prepare("SELECT data FROM samples WHERE run_id = ?").all(log.run_id).map((r) => JSON.parse(r.data))
  } finally {
    db.close()
  }
}

/** What the app's proof mode recorded going wrong. */
export function proofFailures() {
  const db = new DatabaseSync(join(dataDir(), "peak.db"), { readOnly: true })
  try {
    const rows = db.prepare("SELECT text FROM logs WHERE text LIKE 'update-proof-failure %'").all()
    return [...new Set(rows.map((r) => Buffer.from(r.text.split(" ").at(-1), "base64").toString()))]
  } finally {
    db.close()
  }
}

export function shot(out, name) {
  mkdirSync(out, { recursive: true })
  const file = join(out, `${name}.png`)
  if (IS_MAC) spawnSync("screencapture", ["-x", file])
  else if (IS_WINDOWS) {
    spawnSync("powershell", ["-NoProfile", "-Command", `Add-Type -AssemblyName System.Windows.Forms,System.Drawing; $b=[System.Windows.Forms.Screen]::PrimaryScreen.Bounds; $i=New-Object System.Drawing.Bitmap $b.Width,$b.Height; $g=[System.Drawing.Graphics]::FromImage($i); $g.CopyFromScreen($b.Location,[System.Drawing.Point]::Empty,$b.Size); $i.Save('${file}')`])
  }
}

export { cpSync, existsSync, join, mkdirSync, mkdtempSync, readFileSync, readdirSync, tmpdir, writeFileSync }
