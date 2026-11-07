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

/** Where the words of `name` are on an X screen, by reading a screenshot of it. */
function locate(name) {
  const dir = mkdtempSync(join(tmpdir(), "peak-ocr-"))
  const shot = join(dir, "screen.png")
  const SCALE = 3
  run("import", ["-window", "root", "-resize", `${SCALE * 100}%`, shot])
  const wanted = name.toLowerCase().replace(/[.]/g, "").split(/\s+/)
  // Light text on a dark button reads better one way, the rest of the page the other.
  for (const variant of [[], ["-negate"]]) {
    const image = variant.length ? join(dir, "negated.png") : shot
    if (variant.length) run("convert", [shot, ...variant, image])
    const words = run("tesseract", [image, "stdout", "--psm", "11", "tsv"]).stdout.split("\n").slice(1).map((l) => l.split("\t")).filter((c) => c[11]?.trim())
    for (let i = 0; i + wanted.length <= words.length; i++) {
      if (wanted.every((w, j) => words[i + j][11].toLowerCase().replace(/[.,:]/g, "") === w)) {
        const left = Number(words[i][6])
        const last = words[i + wanted.length - 1]
        const right = Number(last[6]) + Number(last[8])
        return { x: Math.round((left + right) / 2 / SCALE), y: Math.round((Number(words[i][7]) + Number(words[i][9]) / 2) / SCALE) }
      }
    }
  }
  return null
}

function x11(name, press) {
  const at = locate(name)
  if (at && press) run("xdotool", ["mousemove", String(at.x), String(at.y), "click", "1"])
  return !!at
}

const driver = IS_WINDOWS ? windows : IS_MAC ? mac : x11

/** Whether `name` is on screen. */
export const present = (name) => driver(name, false)

/** Press the control called `name`, if it's there. */
export const press = (name) => driver(name, true)
