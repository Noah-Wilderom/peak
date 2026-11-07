#!/usr/bin/env node
// Checks a release the way the outside world sees it: anonymous requests only, using nothing
// but what's published and the public key in this checkout.
//   verify-published.mjs vX.Y.Z [base url of "latest" assets]
// Run straight after publishing. Exits non-zero on any miss.
import { createHash } from "node:crypto"
import { readFileSync } from "node:fs"
import { check as checkSignature } from "./verify-signature.mjs"

const [tag, base = "https://github.com/Noah-Wilderom/peak/releases/latest/download"] = process.argv.slice(2)
if (!tag) {
  console.error("usage: verify-published.mjs vX.Y.Z [base url]")
  process.exit(2)
}
const version = tag.replace(/^v/, "")
const pub = JSON.parse(readFileSync(new URL("../../src-tauri/tauri.conf.json", import.meta.url))).plugins.updater.pubkey
const REQUIRED = ["linux-x86_64-appimage", "windows-x86_64-nsis", "darwin-aarch64-app", "darwin-x86_64-app"]
let failed = 0
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "ok  " : "FAIL"} ${name} ${detail}`)
  if (!ok) failed++
}
const get = async (url) => {
  const r = await fetch(url, { redirect: "follow" })
  if (!r.ok) throw new Error(`${r.status} for ${url}`)
  return Buffer.from(await r.arrayBuffer())
}
const sha = (b) => createHash("sha256").update(b).digest("hex")

try {
  const feed = JSON.parse((await get(`${base}/latest.json`)).toString())
  check("the feed announces this version", feed.version === version, feed.version)
  check("it has release notes and a date", !!feed.notes && !Number.isNaN(Date.parse(feed.pub_date)))
  const keys = Object.keys(feed.platforms)
  check("it has every platform, and no bare key a .deb could match", REQUIRED.every((k) => keys.includes(k)) && keys.length === REQUIRED.length, keys.join(" "))

  const sums = new Map((await get(`${base}/SHA256SUMS`)).toString().trim().split("\n").map((l) => { const [h, n] = l.split(/\s+/); return [n, h] }))
  for (const key of REQUIRED) {
    const entry = feed.platforms[key]
    const name = entry.url.split("/").pop()
    const bytes = await get(entry.url)
    check(`${key}: downloads anonymously`, bytes.length > 1_000_000, `${name}, ${bytes.length} bytes`)
    check(`${key}: matches SHA256SUMS`, sums.get(name) === sha(bytes))
    const signed = checkSignature(bytes, entry.signature, pub)
    check(`${key}: signed by the updater key, for this version`, signed.includes(`version:${version}`), signed.replace(/\s+/g, " "))
    check(`${key}: the published .sig is the same signature`, (await get(`${entry.url}.sig`)).toString().trim() === entry.signature)
  }
  for (const name of [`peak_${version}_amd64.deb`, `peak_${version}_aarch64.dmg`, `peak_${version}_x64.dmg`, "install.sh"]) {
    const bytes = await get(`${base}/${name}`)
    check(`${name}: downloads anonymously and matches SHA256SUMS`, sums.get(name) === sha(bytes), `${bytes.length} bytes`)
  }
  check("latest.json matches SHA256SUMS", sums.get("latest.json") === sha(await get(`${base}/latest.json`)))
} catch (e) {
  check("the release is readable", false, e.message)
}
console.log(failed ? `FAILED: ${failed}` : "ALL OK")
process.exit(failed ? 1 : 0)
