#!/usr/bin/env node
// collect.mjs must never ship the wrong version's file under this version's name. That's what
// once made a Windows update fail: a 9.0.0 installer copied as 9.0.1. Exits non-zero on any miss.
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

const version = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url))).version
const OLD = "0.0.1"
const sig = (v) => Buffer.from(`untrusted comment: test\nRUQ\ntrusted comment: timestamp:1\tfile:f\tversion:${v}\nZZ\n`).toString("base64")
let failed = 0

function scenario(name, platform, dir, files, expect) {
  const root = mkdtempSync(join(tmpdir(), "peak-collect-"))
  mkdirSync(join(root, dir))
  for (const [file, contents, signedFor] of files) {
    writeFileSync(join(root, dir, file), contents)
    if (signedFor) writeFileSync(join(root, dir, `${file}.sig`), sig(signedFor))
  }
  const out = join(root, "out")
  const r = spawnSync(process.execPath, [new URL("collect.mjs", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"), root, out, platform], { encoding: "utf8" })
  let ok
  if (expect.refuses) {
    ok = r.status !== 0 && r.stderr.includes(expect.refuses)
  } else {
    const copied = r.status === 0 ? readFileSync(join(out, expect.file), "utf8") : null
    ok = copied === expect.contents && readdirSync(out).includes(`${expect.file}.sig`)
  }
  console.log(`${ok ? "ok  " : "FAIL"} ${name}`)
  if (!ok) {
    failed++
    console.log(r.stdout, r.stderr)
  }
  rmSync(root, { recursive: true, force: true })
}

const setup = `peak_${version}_x64-setup.exe`
const oldSetup = `peak_${OLD}_x64-setup.exe`
scenario("takes this version when an older one sorts first", "windows", "nsis", [[oldSetup, "old", OLD], [setup, "new", version]], { file: setup, contents: "new" })
scenario("refuses when only an older version is there", "windows", "nsis", [[oldSetup, "old", OLD]], { refuses: `for ${version}` })
scenario("refuses a file signed for another version", "windows", "nsis", [[setup, "new", OLD]], { refuses: `isn't signed for ${version}` })
scenario("refuses a missing signature", "windows", "nsis", [[setup, "new", null]], { refuses: "no signature" })
scenario(
  "refuses a Linux set missing its .deb",
  "linux",
  "appimage",
  [[`peak_${OLD}_amd64.AppImage`, "old", OLD], [`peak_${version}_amd64.AppImage`, "new", version]],
  { refuses: "deb" }, // no deb folder in this fixture: the other half of the set has to exist too
)
console.log(failed ? `FAILED: ${failed}` : "ALL OK")
process.exit(failed ? 1 : 0)
