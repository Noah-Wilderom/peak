// Presses buttons in an installed production app from outside it, as a person would. A release has
// no debug port, and one already published can't be given one, so this goes through what each OS
// offers: WebDriver on Linux, UI Automation on Windows, and on macOS the accessibility API, or if
// that shows nothing of the window, reading the screen and clicking on it.
import { spawn, spawnSync } from "node:child_process"
import { IS_MAC, IS_WINDOWS, closeApps, join, launch, log, mkdtempSync, paths, sleep, tmpdir, waitFor } from "./lib.mjs"

const run = (bin, args, input) => spawnSync(bin, args, { encoding: "utf8", input, timeout: 120_000 })

function windows(name, press) {
  const script = `
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$windows = $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
$named = New-Object Windows.Automation.PropertyCondition($A::NameProperty, '${name.replaceAll("'", "''")}')
foreach ($w in $windows) {
  if ($w.Current.Name -notlike '*peak*') { continue }
  $all = $w.FindAll([Windows.Automation.TreeScope]::Descendants, $named)
  foreach ($e in $all) {
    $pattern = $null
    if ($e.TryGetCurrentPattern([Windows.Automation.InvokePattern]::Pattern, [ref]$pattern)) {
      ${press ? "$pattern.Invoke(); exit 0" : "exit 0"}
    }
    # Segmented controls and tabs are selected rather than invoked.
    if ($e.TryGetCurrentPattern([Windows.Automation.SelectionItemPattern]::Pattern, [ref]$pattern)) {
      ${press ? "$pattern.Select(); exit 0" : "exit 0"}
    }
    ${press ? "" : "exit 0"}
  }
}
exit 3`
  const r = run("powershell", ["-NoProfile", "-Command", script])
  if (r.status !== 0 && r.status !== 3) log(`ui automation: ${r.stderr.trim()}`)
  return r.status === 0
}

function mac(name, press) {
  const script = `
on run argv
  set wanted to item 1 of argv
  tell application "System Events"
    tell process "peak"
      set frontmost to true
      repeat with e in (entire contents of window 1)
        set label to ""
        try
          set label to (title of e) as text
        end try
        if label is not wanted then
          try
            set label to (description of e) as text
          end try
        end if
        if label is not wanted then
          try
            set label to (value of e) as text
          end try
        end if
        if label is wanted then
          ${press ? 'perform action "AXPress" of e' : ""}
          return "found"
        end if
      end repeat
    end tell
  end tell
  return "missing"
end run`
  const r = run("osascript", ["-", name], script)
  if (r.status !== 0) log(`accessibility: ${r.stderr.trim()}`)
  return r.stdout.trim() === "found"
}

const magick = () => (run("magick", ["-version"]).status === 0 ? "magick" : "convert")

/**
 * The screen as words, in screen coordinates. Small grey text reads best enlarged and thresholded.
 * Light text on a dark button doesn't read at all that way, so each dark button is found as a shape
 * and read by itself.
 */
function readScreen() {
  const dir = mkdtempSync(join(tmpdir(), "peak-ocr-"))
  const shot = join(dir, "screen.png")
  const page = join(dir, "page.png")
  run("screencapture", ["-x", shot])
  const pixels = Number(run("sips", ["-g", "pixelWidth", shot]).stdout.match(/pixelWidth: (\d+)/)?.[1])
  const points = Number(run("osascript", ["-e", 'tell application "Finder" to get item 3 of (bounds of window of desktop)']).stdout.trim())
  const toPoints = (points || pixels) / pixels
  const tool = magick()
  const clean = (w) => w.toLowerCase().replace(/[.,:]/g, "")
  const ENLARGE = 2
  // A capture has an alpha channel, which ImageMagick 7 keeps through all this, leaving tesseract nothing.
  run(tool, [shot, "-alpha", "off", "-colorspace", "Gray", "-resize", `${ENLARGE * 100}%`, "-threshold", "75%", page])
  const words = run("tesseract", [page, "stdout", "--psm", "11", "tsv"]).stdout.split("\n").slice(1).map((l) => l.split("\t")).filter((c) => c[11]?.trim()).map((c) => ({
    word: c[11].trim(),
    plain: clean(c[11].trim()),
    line: `${c[2]}/${c[3]}/${c[4]}`,
    x: (Number(c[6]) / ENLARGE) * toPoints,
    y: (Number(c[7]) / ENLARGE) * toPoints,
    w: (Number(c[8]) / ENLARGE) * toPoints,
    h: (Number(c[9]) / ENLARGE) * toPoints,
  }))
  const shapes = run(tool, [shot, "-alpha", "off", "-colorspace", "Gray", "-negate", "-threshold", "35%", "-define", "connected-components:verbose=true", "-define", "connected-components:area-threshold=400", "-connected-components", "8", "null:"])
  const found = `${shapes.stdout}${shapes.stderr}`.matchAll(/(\d+)x(\d+)\+(\d+)\+(\d+) [\d.,]+ \d+ \w+\((?:255|100%)/g)
  let n = 0
  for (const [, width, height, left, top] of found) {
    const [w, h, x, y] = [width, height, left, top].map(Number)
    // Button-shaped, in either a 1x or a 2x capture.
    if (w < 40 * (pixels / (points || pixels)) || h < 18 || h > 90) continue
    const crop = join(dir, `shape-${n++}.png`)
    run(tool, [shot, "-alpha", "off", "-crop", `${w}x${h}+${x}+${y}`, "+repage", "-colorspace", "Gray", "-negate", "-resize", "300%", crop])
    const text = run("tesseract", [crop, "stdout", "--psm", "7"]).stdout.trim().replace(/^\W+\s*/, "")
    // An icon inside a button reads as stray symbols.
    for (const word of text.split(/\s+/).map((w) => w.replace(/^[^\p{L}\p{N}]+|[^\p{L}\p{N}.]+$/gu, "")).filter(Boolean)) {
      words.push({ word, plain: clean(word), line: `shape-${n}`, x: x * toPoints, y: y * toPoints, w: w * toPoints, h: h * toPoints })
    }
  }
  return words
}

/** Every place the words of `name` are on screen, top to bottom. */
/** One character off, as reading a screen often is: "Coltect garbage", "Record Ss". */
function nearly(a, b) {
  if (a === b) return true
  if (Math.min(a.length, b.length) < 2 || Math.abs(a.length - b.length) > 1) return false
  let [i, j] = [0, 0]
  while (i < a.length && j < b.length && a[i] === b[j]) (i++, j++)
  if (a.length === b.length) return a.slice(i + 1) === b.slice(j + 1)
  return a.length > b.length ? a.slice(i + 1) === b.slice(j) : a.slice(i) === b.slice(j + 1)
}

function locateAll(name) {
  const wanted = name.toLowerCase().replace(/[.]/g, "").split(/\s+/)
  const words = readScreen()
  // A control's own words are a line by themselves. "CPU" the tab, not "CPU profiles" the label.
  const sizes = new Map()
  for (const w of words) sizes.set(w.line, (sizes.get(w.line) ?? 0) + 1)
  const hits = []
  for (let i = 0; i + wanted.length <= words.length; i++) {
    if (wanted.every((w, j) => nearly(words[i + j].plain, w))) {
      const last = words[i + wanted.length - 1]
      const exact = wanted.every((w, j) => words[i + j].plain === w)
      hits.push({ rank: (exact ? 4 : 0) + (sizes.get(words[i].line) === wanted.length ? 2 : wanted.length > 1 && sizes.get(words[i].line) === wanted.length + 1 ? 1 : 0), x: Math.round((words[i].x + last.x + last.w) / 2), y: Math.round(words[i].y + words[i].h / 2) })
    }
  }
  return hits.sort((a, b) => b.rank - a.rank || a.y - b.y)
}

function clickAt({ x, y }) {
  run("cliclick", [`c:${x},${y}`])
}

function bySight(name, press) {
  const [at] = locateAll(name)
  if (at && press) clickAt(at)
  return !!at
}

/** Scroll the main pane, where only the screen can be read and what's below it can't be. */
export function scrollDown() {
  if (!IS_MAC || macTree()) return
  const [area] = locateAll("Profiler")
  if (area) clickAt({ x: area.x + 400, y: area.y + 90 })
  run("cliclick", ["kp:page-down"])
}

/** Back to the top of the main pane. */
export function scrollToTop() {
  if (!IS_MAC || macTree()) return
  const [area] = locateAll("Profiler")
  if (area) clickAt({ x: area.x + 400, y: area.y + 90 })
  for (let i = 0; i < 4; i++) run("cliclick", ["kp:page-up"])
}

/**
 * A WKWebView can expose nothing to the accessibility API on a runner, with no error to say so. If
 * nothing at all comes through from the window, macOS is read by sight, as X is.
 */
let macHasTree = null
function macTree() {
  if (macHasTree === null) {
    // WebKit builds its tree for a client that says it's assistive. Harmless if refused.
    run("osascript", ["-e", 'tell application "System Events" to tell process "peak" to set value of attribute "AXEnhancedUserInterface" to true'])
    const seen = contentsMac()
    macHasTree = seen.some((i) => /peak\.|History|Settings|Capture/.test(i.name))
    log(`accessibility tree on macOS: ${macHasTree ? "usable" : "not usable"}, ${seen.length} items: ${seen.slice(0, 25).map((i) => i.name).join(" | ")}`)
  }
  return macHasTree
}
function macAny(name, press) {
  return macTree() ? mac(name, press) : bySight(name, press)
}

// ─── Linux: WebDriver ───────────────────────────────────────────────────────
const DRIVER = "http://127.0.0.1:4444"
let session = null
let driverProcess = null
async function wd(method, path, body) {
  const url = path === "/session" || path === "/status" ? `${DRIVER}${path}` : `${DRIVER}/session/${session}${path}`
  const res = await fetch(url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) })
  const json = await res.json()
  if (json.value?.error) throw new Error(`${json.value.error}: ${json.value.message}`)
  return json.value
}
const CONTROLS = "[...document.querySelectorAll('button,[role=tab],[role=radio],a')]"
const LABEL = "(e.getAttribute('aria-label') || e.innerText || '').replace(/\\s+/g, ' ').trim()"
const script = (text, ...args) => wd("POST", "/execute/sync", { script: text, args })

async function linuxContents() {
  const text = await script("return document.body ? document.body.innerText : ''")
  const controls = await script(`return ${CONTROLS}.map((e) => ({ name: ${LABEL}, enabled: !e.disabled }))`)
  return [...text.split("\n").filter(Boolean).map((name) => ({ name })), ...controls]
}
async function linuxPress(name) {
  const el = await script(`const name = arguments[0]; return ${CONTROLS}.find((e) => ${LABEL} === name)`, name)
  if (!el) return false
  try {
    await wd("POST", `/element/${Object.values(el)[0]}/click`, {})
    return true
  } catch (e) {
    // A notification can be over it for a few seconds, and that's for the caller to wait out.
    if (/intercepted|not interactable|stale/.test(e.message)) return false
    throw e
  }
}

const LINUX = !IS_WINDOWS && !IS_MAC

/** Whether `name` is on screen. */
export async function present(name) {
  if (LINUX) return (await linuxContents()).some((i) => i.name === name || i.name.includes(name))
  return IS_WINDOWS ? windows(name, false) : macAny(name, false)
}

/** Press the control called `name`, if it's there. */
export async function press(name) {
  if (LINUX) return linuxPress(name)
  return IS_WINDOWS ? windows(name, true) : macAny(name, true)
}

/** Whether controls' states can be read here, rather than only their words. */
export const readsState = () => LINUX || IS_WINDOWS || macTree()

/** What the window holds, as { name, enabled }. */
export async function contents() {
  if (LINUX) return linuxContents()
  return contentsNative()
}

/** Put text in the command field, where it's a known field to the platform. */
export async function typeInto(field, text) {
  if (LINUX) {
    const el = await script("return document.querySelector('form input')")
    await wd("POST", `/element/${Object.values(el)[0]}/value`, { text })
    return true
  }
  if (IS_MAC) {
    // Where the field has a placeholder to find by, otherwise it's focused on arrival.
    const hint = field === "Search" ? "Search" : null
    if (hint && !bySight(hint, true)) return false
    return run("cliclick", [`t:${text}`]).status === 0
  }
  const ps = `
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$edit = New-Object Windows.Automation.PropertyCondition($A::ControlTypeProperty, [Windows.Automation.ControlType]::Edit)
foreach ($w in $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)) {
  if ($w.Current.Name -notlike '*peak*') { continue }
  foreach ($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants, $edit)) {
    if ($e.Current.Name -like '*${field}*') {
      $e.GetCurrentPattern([Windows.Automation.ValuePattern]::Pattern).SetValue($env:PEAK_TYPED); exit 0
    }
  }
}
exit 3`
  return spawnSync("powershell", ["-NoProfile", "-Command", ps], { env: { ...process.env, PEAK_TYPED: text } }).status === 0
}

/** Start the installed app. On Linux WebDriver starts it, which is what lets it be driven. */
export async function openApp() {
  if (!LINUX) return void launch()
  if (!driverProcess) {
    driverProcess = spawn(process.env.PEAK_TAURI_DRIVER || join(process.env.HOME, ".cargo/bin/tauri-driver"), ["--native-driver", "/usr/bin/WebKitWebDriver"], {
      stdio: "inherit",
      env: { ...process.env, WEBKIT_DISABLE_COMPOSITING_MODE: "1", WEBKIT_DISABLE_DMABUF_RENDERER: "1" },
    })
    await waitFor("the driver", () => wd("GET", "/status").catch(() => null), 15_000)
  }
  session = (await wd("POST", "/session", { capabilities: { alwaysMatch: { browserName: "wry", "tauri:options": { application: paths().gui } } } })).sessionId
}

/** Close the app, and stop driving it. */
export async function closeApp() {
  if (LINUX && session) await wd("DELETE", "").catch(() => {})
  session = null
  closeApps()
  await sleep(2500)
}

/** Finished with driving at all, so that this process can end. */
export function stopDriving() {
  driverProcess?.kill()
  driverProcess = null
}

/** What's readable by sight, as lines and single words. No enabled state. */
function contentsBySight() {
  const items = []
  const words = readScreen()
  const lines = new Map()
  for (const w of words) lines.set(w.line, [...(lines.get(w.line) ?? []), w.word])
  for (const line of lines.values()) items.push({ name: line.join(" ") })
  for (const w of words) items.push({ name: w.word.replace(/[.,:]$/, "") })
  return items
}

/** What's in the window, as the accessibility tree has it: { name, enabled }. */
function contentsNative() {
  if (IS_MAC) return macTree() ? contentsMac() : contentsBySight()
  const SEP = "\u001f"
  {
    const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName UIAutomationClient,UIAutomationTypes
$A = [Windows.Automation.AutomationElement]
$windows = $A::RootElement.FindAll([Windows.Automation.TreeScope]::Children, [Windows.Automation.Condition]::TrueCondition)
foreach ($w in $windows) {
  if ($w.Current.Name -notlike '*peak*') { continue }
  foreach ($e in $w.FindAll([Windows.Automation.TreeScope]::Descendants, [Windows.Automation.Condition]::TrueCondition)) {
    if ($e.Current.Name) { $e.Current.Name.Replace("\`n", ' ') + [char]0x1f + $e.Current.IsEnabled }
  }
}`
    const r = run("powershell", ["-NoProfile", "-Command", script])
    if (r.status !== 0) log(`ui automation: ${r.stderr.trim()}`)
    return (r.stdout ?? "").split(/\r?\n/).filter(Boolean).map((l) => l.split(SEP)).map(([name, on]) => ({ name, enabled: on === "True" }))
  }
}

function contentsMac() {
  const SEP = "\u001f"
  const script = `
tell application "System Events"
  tell process "peak"
    set out to ""
    repeat with e in (entire contents of window 1)
      set label to ""
      try
        set label to (title of e) as text
      end try
      if label is "" or label is "missing value" then
        try
          set label to (description of e) as text
        end try
      end if
      if label is "" or label is "missing value" then
        try
          set label to (value of e) as text
        end try
      end if
      if label is not "" and label is not "missing value" then
        set isEnabled to "true"
        try
          set isEnabled to (enabled of e) as text
        end try
        set out to out & label & (ASCII character 31) & isEnabled & linefeed
      end if
    end repeat
    return out
  end tell
end tell`
  const r = run("osascript", ["-"], script)
  if (r.status !== 0) log(`accessibility: ${r.stderr.trim()}`)
  return (r.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split(SEP)).map(([name, on]) => ({ name, enabled: on === "true" }))
}
