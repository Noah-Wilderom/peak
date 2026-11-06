// Two real builds of this checkout, a version apart, signed with a throwaway key made here and
// pointed at a localhost feed. Never uses the release key or the release channel.
import { execFileSync, execSync } from "node:child_process"
import { IS_WINDOWS, PLATFORM, join, readFileSync, readdirSync, writeFileSync } from "./lib.mjs"

const bun = IS_WINDOWS ? "bun.exe" : "bun"
const sh = (c, env = {}) => execSync(c, { stdio: "inherit", shell: IS_WINDOWS ? "bash" : "/bin/sh", env: { ...process.env, ...env } })

export function buildPair({ work, BASE, NEXT, PORT, autoUpdate, windowArgs }) {
  const target = process.env.PEAK_PROOF_TARGET
  const keyFile = join(work, "throwaway.key")
  const password = "proof-only"
  const generate = (file) => execFileSync(bun, ["x", "tauri", "signer", "generate", "--ci", "-w", file, "-p", password], { stdio: "ignore" })
  generate(keyFile)
  const overlayFile = join(work, "overlay.json")
  // Arrays replace rather than merge in a config overlay, so the whole window goes in.
  const conf = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8"))
  const app = windowArgs ? { app: { windows: conf.app.windows.map((w) => ({ ...w, additionalBrowserArgs: windowArgs })) } } : {}
  writeFileSync(overlayFile, JSON.stringify({
    ...app,
    plugins: { updater: { pubkey: readFileSync(`${keyFile}.pub`, "utf8").trim(), endpoints: [`http://127.0.0.1:${PORT}/latest.json`], dangerousInsecureTransportProtocol: true } },
  }))
  const original = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).version
  const build = (version) => {
    sh(`node scripts/release/version.mjs set ${version}`)
    sh(`bun run tauri build ${target ? `--target ${target}` : ""} --config "${overlayFile.replace(/\\/g, "/")}"`, {
      TAURI_SIGNING_PRIVATE_KEY: readFileSync(keyFile, "utf8"),
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: password,
      PEAK_REQUIRE_COLLECTOR: "1",
      APPIMAGE_EXTRACT_AND_RUN: "1",
      ...(autoUpdate ? { VITE_PEAK_E2E_AUTOUPDATE: "1" } : {}),
    })
    const bundle = target ? `src-tauri/target/${target}/release/bundle` : "src-tauri/target/release/bundle"
    const dest = join(work, version)
    sh(`node scripts/release/collect.mjs "${bundle}" "${dest.replace(/\\/g, "/")}" ${PLATFORM}`)
    return dest
  }
  const baseDir = build(BASE)
  const nextDir = build(NEXT)
  sh(`node scripts/release/version.mjs set ${original}`)

  const artifactName = readdirSync(nextDir).find((f) => /\.(AppImage|app\.tar\.gz)$|-setup\.exe$/.test(f))
  const artifactBytes = readFileSync(join(nextDir, artifactName))
  const goodSig = readFileSync(join(nextDir, `${artifactName}.sig`), "utf8").trim()
  const key = { linux: "linux-x86_64-appimage", windows: "windows-x86_64-nsis", "darwin-aarch64": "darwin-aarch64-app", "darwin-x86_64": "darwin-x86_64-app" }[PLATFORM]

  // A signature that's valid, but from a key the app doesn't trust.
  const otherKey = join(work, "other.key")
  generate(otherKey)
  const otherCopy = join(work, artifactName)
  writeFileSync(otherCopy, artifactBytes)
  execFileSync(bun, ["x", "tauri", "signer", "sign", "-f", otherKey, "-p", password, otherCopy], { stdio: "ignore" })
  const wrongKeySig = readFileSync(`${otherCopy}.sig`, "utf8").trim()
  return { baseDir, nextDir, artifactName, artifactBytes, goodSig, wrongKeySig, key }
}
