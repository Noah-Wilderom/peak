#!/usr/bin/env node
// Checks an updater artifact against its .sig with nothing from Tauri, so a bad signing setup
// can't pass by accident.  verify-signature.mjs <file> <file.sig> <base64 public key>
// The format is minisign: Ed25519 over the file's BLAKE2b-512, then over signature + comment.
import { createHash, createPublicKey, verify } from "node:crypto"
import { readFileSync } from "node:fs"

const ED25519_SPKI = Buffer.from("302a300506032b6570032100", "hex")
const decode = (b64) => Buffer.from(b64.trim(), "base64").toString("utf8").trim().split("\n")

export function check(fileBytes, sigB64, pubB64) {
  const pub = Buffer.from(decode(pubB64).at(-1), "base64")
  const keyId = pub.subarray(2, 10)
  const key = createPublicKey({ key: Buffer.concat([ED25519_SPKI, pub.subarray(10)]), format: "der", type: "spki" })
  const lines = decode(sigB64)
  const sig = Buffer.from(lines[1], "base64")
  if (sig.subarray(0, 2).toString() !== "ED") throw new Error("not a prehashed minisign signature")
  if (!sig.subarray(2, 10).equals(keyId)) throw new Error("signed by a different key")
  const digest = createHash("blake2b512").update(fileBytes).digest()
  if (!verify(null, digest, key, sig.subarray(10))) throw new Error("the signature doesn't match this file")
  const trusted = lines[2].replace(/^trusted comment: /, "")
  const global = Buffer.from(lines[3], "base64")
  if (!verify(null, Buffer.concat([sig.subarray(10), Buffer.from(trusted)]), key, global)) throw new Error("the signed comment was altered")
  return trusted
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const [file, sig, pub] = process.argv.slice(2)
  try {
    console.log(`signature ok: ${check(readFileSync(file), readFileSync(sig, "utf8"), pub)}`)
  } catch (e) {
    console.error(`signature BAD for ${file}: ${e.message}`)
    process.exit(1)
  }
}
