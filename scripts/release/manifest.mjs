#!/usr/bin/env node
// Writes SHA256SUMS and the updater feed for a directory holding every platform's artifacts.
//   manifest.mjs <dir> <vX.Y.Z> <notes file> [base url]
// Every platform must be present: the updater rejects a feed with a bad entry, and a partial
// release would leave some users behind while it looked complete.
import { createHash } from "node:crypto"
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [dir, tag, notesFile, base = `https://github.com/Noah-Wilderom/peak/releases/download/${tag}`] = process.argv.slice(2)
const version = tag.replace(/^v/, "")
const required = (process.env.PEAK_FEED_PLATFORMS ?? "linux-x86_64-appimage,windows-x86_64-nsis,darwin-aarch64-app,darwin-x86_64-app").split(",")
const FILES = {
  "linux-x86_64-appimage": `peak_${version}_amd64.AppImage`,
  "windows-x86_64-nsis": `peak_${version}_x64-setup.exe`,
  "darwin-aarch64-app": `peak_${version}_aarch64.app.tar.gz`,
  "darwin-x86_64-app": `peak_${version}_x64.app.tar.gz`,
}

const platforms = {}
for (const key of required) {
  const name = FILES[key]
  if (!name) throw new Error(`unknown platform ${key}`)
  const file = join(dir, name)
  if (!existsSync(file) || !existsSync(`${file}.sig`)) throw new Error(`${key}: missing ${name} or its signature`)
  platforms[key] = { signature: readFileSync(`${file}.sig`, "utf8").trim(), url: `${base}/${name}` }
}
const notes = readFileSync(notesFile, "utf8").trim()
if (!notes) throw new Error("release notes are empty")
writeFileSync(join(dir, "latest.json"), JSON.stringify({ version, notes, pub_date: new Date().toISOString().replace(/\.\d+Z$/, "Z"), platforms }, null, 2) + "\n")
const lines = readdirSync(dir).filter((f) => f !== "SHA256SUMS").sort().map((f) => `${createHash("sha256").update(readFileSync(join(dir, f))).digest("hex")}  ${f}`)
writeFileSync(join(dir, "SHA256SUMS"), lines.join("\n") + "\n")
console.log(lines.join("\n"))
