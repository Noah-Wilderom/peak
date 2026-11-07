// Presses buttons in an installed production app from outside it, as a person would. A release has
// no debug port or WebDriver, and a release already published can't be given one, so this goes
// through what each OS offers: UI Automation, the accessibility API, or on a bare X server,
// reading the screen.
import { spawnSync } from "node:child_process"
import { join, mkdtempSync, tmpdir } from "./lib.mjs"
import { IS_MAC, IS_WINDOWS, log } from "./lib.mjs"

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

/** The screen as words, in screen coordinates. A capture is enlarged, as small text reads badly. */
function readScreen() {
  const dir = mkdtempSync(join(tmpdir(), "peak-ocr-"))
  const shot = join(dir, "screen.png")
  const SCALE = 3
  let factor
  if (IS_MAC) {
    run("screencapture", ["-x", shot])
    const pixels = Number(run("sips", ["-g", "pixelWidth", shot]).stdout.match(/pixelWidth: (\d+)/)?.[1])
    const points = Number(run("osascript", ["-e", 'tell application "Finder" to get item 3 of (bounds of window of desktop)']).stdout.trim())
    run("sips", ["--resampleWidth", String(pixels * SCALE), shot])
    factor = (points || pixels) / (pixels * SCALE)
  } else {
    run("import", ["-window", "root", "-resize", `${SCALE * 100}%`, shot])
    factor = 1 / SCALE
  }
  const clean = (w) => w.toLowerCase().replace(/[.,:]/g, "")
  const variants = [shot]
  // Light text on a dark button reads better one way, the rest of the page the other.
  if (!IS_MAC) {
    const negated = join(dir, "negated.png")
    run("convert", [shot, "-negate", negated])
    variants.push(negated)
  }
  return variants.map((image) =>
    run("tesseract", [image, "stdout", "--psm", "11", "tsv"]).stdout.split("\n").slice(1).map((l) => l.split("\t")).filter((c) => c[11]?.trim()).map((c) => ({
      word: c[11].trim(),
      plain: clean(c[11].trim()),
      line: `${c[2]}/${c[3]}/${c[4]}`,
      x: Number(c[6]) * factor,
      y: Number(c[7]) * factor,
      w: Number(c[8]) * factor,
      h: Number(c[9]) * factor,
    })),
  )
}

/** Every place the words of `name` are on screen, top to bottom. */
function locateAll(name) {
  const wanted = name.toLowerCase().replace(/[.]/g, "").split(/\s+/)
  for (const words of readScreen()) {
    const hits = []
    for (let i = 0; i + wanted.length <= words.length; i++) {
      if (wanted.every((w, j) => words[i + j].plain === w)) {
        const last = words[i + wanted.length - 1]
        hits.push({ x: Math.round((words[i].x + last.x + last.w) / 2), y: Math.round(words[i].y + words[i].h / 2) })
      }
    }
    if (hits.length) return hits.sort((a, b) => a.y - b.y)
  }
  return []
}

function clickAt({ x, y }) {
  if (IS_MAC) run("cliclick", [`c:${x},${y}`])
  else run("xdotool", ["mousemove", String(x), String(y), "click", "1"])
}

function bySight(name, press) {
  const [at] = locateAll(name)
  if (at && press) clickAt(at)
  return !!at
}

/** Press the nth control with these words, counting down the screen. */
export function pressNth(name, n) {
  const at = locateAll(name)[n]
  if (at) clickAt(at)
  return !!at
}

/**
 * A WKWebView can expose nothing to the accessibility API on a runner, with no error to say so. If
 * nothing at all comes through from the window, macOS is read by sight, as X is.
 */
let macHasTree = null
function macTree() {
  if (macHasTree === null) {
    const seen = contentsMac()
    macHasTree = seen.some((i) => /peak\.|History|Settings|Capture/.test(i.name))
    log(`accessibility tree on macOS: ${macHasTree ? "usable" : "not usable"}, ${seen.length} items: ${seen.slice(0, 25).map((i) => i.name).join(" | ")}`)
  }
  return macHasTree
}
function macAny(name, press) {
  return macTree() ? mac(name, press) : bySight(name, press)
}

const driver = IS_WINDOWS ? windows : IS_MAC ? macAny : bySight

/** Whether `name` is on screen. */
export const present = (name) => driver(name, false)

/** Press the control called `name`, if it's there. */
export const press = (name) => driver(name, true)

/** Whether controls' states can be read here, rather than only their words. */
export const readsState = () => IS_WINDOWS || (IS_MAC && macTree())

/** What's readable by sight, as lines and single words. No enabled state. */
function contentsBySight() {
  const items = []
  for (const words of readScreen()) {
    const lines = new Map()
    for (const w of words) lines.set(w.line, [...(lines.get(w.line) ?? []), w.word])
    for (const line of lines.values()) items.push({ name: line.join(" ") })
    for (const w of words) items.push({ name: w.word.replace(/[.,:]$/, "") })
  }
  return items
}

/** What's in the window, as the accessibility tree has it: { name, enabled }. */
export function contents() {
  if (IS_MAC) return macTree() ? contentsMac() : contentsBySight()
  if (!IS_WINDOWS) return contentsBySight()
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
        set on to "true"
        try
          set on to (enabled of e) as text
        end try
        set out to out & label & (ASCII character 31) & on & linefeed
      end if
    end repeat
    return out
  end tell
end tell`
  const r = run("osascript", ["-"], script)
  if (r.status !== 0) log(`accessibility: ${r.stderr.trim()}`)
  return (r.stdout ?? "").split("\n").filter(Boolean).map((l) => l.split(SEP)).map(([name, on]) => ({ name, enabled: on === "true" }))
}
