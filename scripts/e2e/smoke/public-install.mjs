#!/usr/bin/env node
// Fetches a platform's release files from the public URLs, anonymously, for smoke.mjs to install.
//   PEAK_SMOKE_PLATFORM=... public-install.mjs vX.Y.Z <dir>
import { createHash } from "node:crypto"
import { mkdirSync, writeFileSync } from "node:fs"
import { join } from "node:path"

const [tag, dir] = process.argv.slice(2)
const version = tag.replace(/^v/, "")
const base = `https://github.com/Noah-Wilderom/peak/releases/download/${tag}`
const NAMES = {
  linux: [`peak_${version}_amd64.AppImage`],
  windows: [`peak_${version}_x64-setup.exe`],
  "darwin-aarch64": [`peak_${version}_aarch64.dmg`],
  "darwin-x86_64": [`peak_${version}_x64.dmg`],
}[process.env.PEAK_SMOKE_PLATFORM]
const get = async (name) => {
  const r = await fetch(`${base}/${name}`, { redirect: "follow" })
  if (!r.ok) throw new Error(`${r.status} for ${name}`)
  return Buffer.from(await r.arrayBuffer())
}
mkdirSync(dir, { recursive: true })
const sums = new Map((await get("SHA256SUMS")).toString().trim().split("\n").map((l) => l.split(/\s+/).reverse()))
for (const name of NAMES) {
  const bytes = await get(name)
  const hash = createHash("sha256").update(bytes).digest("hex")
  if (sums.get(name) !== hash) throw new Error(`${name} doesn't match SHA256SUMS`)
  writeFileSync(join(dir, name), bytes)
  console.log(`${name}: ${bytes.length} bytes, sha256 ${hash}`)
}
