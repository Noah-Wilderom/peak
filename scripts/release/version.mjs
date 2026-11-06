#!/usr/bin/env node
// One version across every manifest.
//   version.mjs check [vX.Y.Z]   fails unless all agree (and match the tag, if given)
//   version.mjs set X.Y.Z        writes it everywhere
import { readFileSync, writeFileSync } from "node:fs"

const ROOT = new URL("../../", import.meta.url)
const read = (p) => readFileSync(new URL(p, ROOT), "utf8")
const write = (p, s) => writeFileSync(new URL(p, ROOT), s)

const CARGO = ["src-tauri/Cargo.toml", "src-tauri/peak-core/Cargo.toml", "src-tauri/peak-collector/Cargo.toml"]
const LOCKED = ["peak", "peak-core", "peak-collector"]
const JSONS = ["package.json", "src-tauri/tauri.conf.json"]
const cargoVersion = /^version = "([^"]+)"/m
const lockEntry = (name) => new RegExp(`(name = "${name}"\\nversion = ")([^"]+)(")`)

function versions() {
  const found = {}
  for (const p of JSONS) found[p] = JSON.parse(read(p)).version
  for (const p of CARGO) found[p] = cargoVersion.exec(read(p))[1]
  const lock = read("src-tauri/Cargo.lock")
  for (const n of LOCKED) found[`Cargo.lock:${n}`] = lockEntry(n).exec(lock)[2]
  return found
}

const [cmd, arg] = process.argv.slice(2)
if (cmd === "check") {
  const found = versions()
  const all = new Set(Object.values(found))
  const want = arg?.replace(/^v/, "")
  if (all.size !== 1 || (want && !all.has(want))) {
    console.error(`versions disagree${want ? ` with ${want}` : ""}:`, found)
    process.exit(1)
  }
  console.log([...all][0])
} else if (cmd === "set" && /^\d+\.\d+\.\d+$/.test(arg ?? "")) {
  for (const p of JSONS) write(p, read(p).replace(/("version":\s*")[^"]+(")/, `$1${arg}$2`))
  for (const p of CARGO) write(p, read(p).replace(cargoVersion, `version = "${arg}"`))
  let lock = read("src-tauri/Cargo.lock")
  for (const n of LOCKED) lock = lock.replace(lockEntry(n), `$1${arg}$3`)
  write("src-tauri/Cargo.lock", lock)
  console.log(arg)
} else {
  console.error("usage: version.mjs check [vX.Y.Z] | set X.Y.Z")
  process.exit(2)
}
