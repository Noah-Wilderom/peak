#!/usr/bin/env node
// Gathers what `tauri build` left for one platform into a directory, under stable names, with
// a BUILD-INFO record. Fails if an expected artifact or signature is missing.
//   collect.mjs <bundle dir> <out dir> <linux|darwin-aarch64|darwin-x86_64|windows>
import { execSync } from "node:child_process"
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [bundle, out, platform] = process.argv.slice(2)
const version = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url))).version
mkdirSync(out, { recursive: true })

// A bundle folder keeps earlier versions, and which comes first depends on the filesystem. So a
// file naming a version must name this one. Only the macOS update archive names none.
const find = (dir, re) => {
  const d = join(bundle, dir)
  const hits = existsSync(d) ? readdirSync(d).filter((f) => re.test(f) && !f.endsWith(".sig")) : []
  const hit = hits.find((f) => f.includes(`_${version}_`)) ?? hits.find((f) => !/_\d+\.\d+\.\d+_/.test(f))
  if (!hit) throw new Error(`no ${re} for ${version} in ${d}: ${hits.join(", ") || "nothing"}`)
  return join(d, hit)
}
/** What's signed says which version it is, and that has to be this one. */
const checkSignedVersion = (sigFile) => {
  const text = Buffer.from(readFileSync(sigFile, "utf8").trim(), "base64").toString("utf8")
  if (!text.includes(`version:${version}`)) throw new Error(`${sigFile} isn't signed for ${version}: ${text.split("\n")[2]}`)
}
const copy = (from, name, signed) => {
  copyFileSync(from, join(out, name))
  if (signed) {
    if (!existsSync(`${from}.sig`)) throw new Error(`no signature for ${from}`)
    checkSignedVersion(`${from}.sig`)
    copyFileSync(`${from}.sig`, join(out, `${name}.sig`))
  }
}

const artifacts = {
  linux: [["appimage", /\.AppImage$/, `peak_${version}_amd64.AppImage`, true], ["deb", /\.deb$/, `peak_${version}_amd64.deb`, false]],
  windows: [["nsis", /-setup\.exe$/, `peak_${version}_x64-setup.exe`, true]],
  "darwin-aarch64": [["macos", /\.app\.tar\.gz$/, `peak_${version}_aarch64.app.tar.gz`, true], ["dmg", /\.dmg$/, `peak_${version}_aarch64.dmg`, false]],
  "darwin-x86_64": [["macos", /\.app\.tar\.gz$/, `peak_${version}_x64.app.tar.gz`, true], ["dmg", /\.dmg$/, `peak_${version}_x64.dmg`, false]],
}[platform]
if (!artifacts) throw new Error(`unknown platform ${platform}`)
for (const [dir, re, name, signed] of artifacts) copy(find(dir, re), name, signed)

const run = (c) => { try { return execSync(c, { encoding: "utf8" }).trim() } catch { return "unknown" } }
writeFileSync(join(out, `BUILD-INFO-${platform}.json`), JSON.stringify({
  version, platform,
  commit: process.env.PEAK_BUILD_COMMIT ?? process.env.GITHUB_SHA ?? run("git rev-parse HEAD"),
  rustc: run("rustc --version"), node: process.version, runner: process.env.ImageOS ?? process.env.RUNNER_OS ?? "local",
  run: process.env.GITHUB_RUN_ID ?? null, artifacts: artifacts.map((a) => a[2]),
}, null, 2) + "\n")
console.log(artifacts.map((a) => a[2]).join("\n"))
