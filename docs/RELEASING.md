# Releasing Peak

## How it fits together

- **Version:** one number in `package.json`, `tauri.conf.json` and the three crates. `node scripts/release/version.mjs set X.Y.Z` writes them all, `check [vX.Y.Z]` fails if they disagree. Tags are `vX.Y.Z`.
- **Build:** `.github/workflows/release.yml` builds each platform natively, signs the updater artifacts, checks the signatures with a separate implementation (`scripts/release/verify-signature.mjs`), then installs and smoke tests the result (`scripts/e2e/smoke/smoke.mjs`).
- **Publish:** a tag also makes a **draft** GitHub release, with every artifact, `SHA256SUMS`, `install.sh` and `latest.json`.
- **Update channel:** apps read `https://github.com/Noah-Wilderom/peak/releases/latest/download/latest.json`. GitHub's `latest` skips drafts and pre-releases, so **building and drafting can't reach users. Publishing the draft is the one act that advances the channel.**
- **Windows:** the installer ends the running app, so it downloads and verifies first, and installs only when the user restarts.
- **After publishing:** `.github/workflows/public-delivery.yml` checks the release from the outside.
- **Proof:** `.github/workflows/update-proof.yml` upgrades between two real builds on each OS with a throwaway key and a localhost feed, so it needs no secrets and can't touch the channel. It runs on `release-validation/**` branches.

## Artifacts

| Platform | Artifact | Updater signature | Feed key |
|---|---|---|---|
| Linux x86_64 | `peak_V_amd64.AppImage` | `.sig` | `linux-x86_64-appimage` |
| Linux x86_64 | `peak_V_amd64.deb` | none: not an update path | none |
| Windows x64 | `peak_V_x64-setup.exe` | `.sig` | `windows-x86_64-nsis` |
| macOS arm64 | `peak_V_aarch64.dmg` | none | none |
| macOS arm64 | `peak_V_aarch64.app.tar.gz` | `.sig` | `darwin-aarch64-app` |
| macOS x64 | `peak_V_x64.dmg` | none | none |
| macOS x64 | `peak_V_x64.app.tar.gz` | `.sig` | `darwin-x86_64-app` |

The feed uses installer-specific keys only, so a `.deb` install can never be handed an AppImage. `scripts/release/manifest.mjs` refuses a feed missing any platform, because a partial release would strand some users.

Each platform also records `BUILD-INFO-<platform>.json`: version, commit, compiler, runner, workflow run. `peak version` prints the version, format and commit. Builds are repeatable from a tag; they haven't been shown to be byte-for-byte reproducible.

## What's been run, and where

Updated as evidence comes in. "Type-checked" means compiled for that OS from Linux with C steps stubbed: nothing was linked or run.

| Check | Linux x86_64 | Windows x64 | macOS arm64 | macOS x64 |
|---|---|---|---|---|
| Package builds and signs | CI | CI | CI | CI |
| Install, GUI, separate CLI, real samples (`smoke.mjs`) | CI | CI | CI | CI |
| Updater signature checked independently | CI | CI | CI | CI |
| Runtime agents report from inside the program (`smoke.mjs`), for 0.1.0: Node, Python | CI | CI | CI | CI |
| Go, Bun, PHP agents through the installed app and CLI (`probes.mjs`), candidate `b72de3f` | CI | CI, PHP without Excimer | CI | CI |
| The agents in the installed window (`agents-ui.mjs`), candidate `b72de3f` | **Failing:** harness, 5 checks, fix not yet run | CI | **Failing:** can't read the window, fix not yet run | **Failing:** can't read the window, fix not yet run |
| Pressing the published `v0.1.0`'s own buttons (`release-upgrade.mjs --rehearse`), `b72de3f` | CI | CI | **Failing:** can't read the window, fix not yet run | **Failing:** can't read the window, fix not yet run |
| The previous release's own update to this one (`release-upgrade.mjs`) | After publication | After publication | After publication | After publication |
| Two-version signed update (`update-proof.mjs`) | CI | CI | CI | CI |
| Failure cases in that proof | CI | CI | CI | CI |
| Update through real buttons (`update-ui.mjs`) | CI | CI | Not possible: no WebDriver for macOS webviews, so screenshots and timed presses only | Not possible |
| Native tests (`tests/platform.rs`, `native.rs`) | Linux tests in **Tests** | CI | CI | CI |
| `install.sh` download route | Local, on real CI artifacts | Not applicable | Not applicable | Not applicable |
| Install from public URLs (`public-delivery.yml`) | CI, published `v0.1.0`, plus clean Ubuntu 22.04 and 24.04 containers | CI, published `v0.1.0` | CI, published `v0.1.0` | CI, published `v0.1.0` |
| Update through the real GitHub feed (`public-update-proof.mjs`) | CI, published `v0.1.0` | CI, published `v0.1.0` | CI, published `v0.1.0` | CI, published `v0.1.0` |
| Remote targets from this OS | Yes, earlier live suites | **Not run: needs a real machine** | **Not run: needs a real machine** | **Not run: needs a real machine** |
| OS code signing and notarization | Not applicable | None, by decision | Ad-hoc only, by decision | Ad-hoc only, by decision |

"CI" means a native GitHub runner, on `f17d80d` unless it says otherwise, and on the tag's rebuild where the release is concerned. Any later commit changing the app, scripts or workflows needs them again.

Evidence so far: `docs/evidence/release/`, with CI summaries in `ci-187f415/`, `ci-03f6ccf/`, `ci-676efdc/`, `ci-ea3ebc1/`, `ci-110e1c4/`, `ci-64a4d5d/`, `ci-f17d80d/`, `ci-tag-v0.1.0/`, `ci-public-v0.1.0/` and `ci-public-rerun-v0.1.0/`. Remote targets on Windows and macOS can't run in the current workflows, because their CI runners have no Linux machine for a collector to run on.

## Secrets

Set these on the repository, for the tag's workflow:

| Secret | Required | What it is |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | **Yes** | Contents of the updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **Yes** | Its password |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | Not used for this release | Base64 `.p12` of a **Developer ID Application** certificate, its password, its identity name |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | Not used for this release | Apple account, app-specific password, team, for notarization |

The updater key signs what installed copies accept, so **lose it and existing installs can't be updated; leak it and someone can sign updates for them.** Keep a backup somewhere other than this server.

### OS warnings: the user's decision for this release

The first release ships **without** Apple or Windows code signing, with the warnings documented in the README. No certificate or Apple account is involved, and nothing is notarized. Updater signatures are separate and always required.

| Platform | What users see | How to get past it |
|---|---|---|
| macOS | The app is ad-hoc signed. A copy downloaded through a browser is blocked by Gatekeeper | Open it once, then System Settings > Privacy & Security > Open Anyway, or `xattr -dr com.apple.quarantine /Applications/peak.app` |
| Windows | SmartScreen warns on download. Windows 11's Smart App Control can block it, and only turning that feature off gets past it | "More info" > "Run anyway" |

Updates installed by the app work once it's installed. If this changes later: a macOS **Developer ID** certificate needs a paid Apple account, set through the optional `APPLE_*` secrets above; a Windows certificate needs `bundle.windows.certificateThumbprint` or `signCommand`, which isn't wired in yet.

## Linux runtime needs

The AppImage bundles WebKit and GTK, but expects these from the host, as any desktop has: `libEGL`, `libGL`, `libX11`, `libX11-xcb`, `libdrm`, `libexpat`, `libfontconfig`, `libfreetype`, `libfribidi`, `libgbm`, `libharfbuzz`, `libwayland-client`, `libxcb`, plus `libfuse2` to mount. Without them it doesn't start, CLI included. CI's build jobs install dev packages that hide this, so only **Public delivery** tests it, with no `-dev` packages.

## Cutting a release

1. Merge everything. `node scripts/release/version.mjs set X.Y.Z`, add `docs/release-notes/vX.Y.Z.md`, commit.
2. Push `release-validation/X.Y.Z` first and wait for **Update proof** and **Tests**.
3. Tag `vX.Y.Z` and `sdk/go/vX.Y.Z` on the same commit and push them, so that `go get` finds the Go SDK. **Release** builds everything and makes the draft.
4. Check the draft's assets against `SHA256SUMS`.
5. Publish: `gh release edit vX.Y.Z --draft=false --latest`. Installed copies see it within 6 hours, or on next start.
6. Straight after: `node scripts/release/verify-published.mjs vX.Y.Z`. It uses anonymous requests only, and checks the feed, every download, checksums and signatures.
7. **Public delivery** runs by itself on publishing, or by hand with `gh workflow run public-delivery.yml -f tag=vX.Y.Z`. On every OS it installs from the public URLs and smoke tests, then updates a 0.0.9 copy to the release through the real feed. It needs no secrets and publishes nothing.

To roll back, publish a newer version with the fix. Unpublishing stops new updates, but copies that already updated stay put, and the updater won't move to a lower version.

## Where releases live

`Noah-Wilderom/peak`, which is public. The updater and `install.sh` read its release assets anonymously, with no token. The first release is `v0.1.0`, published 2026-11-07.
