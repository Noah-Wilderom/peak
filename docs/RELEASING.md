# Releasing Peak

## How it fits together

- **Version:** one number in `package.json`, `tauri.conf.json` and the three crates. `node scripts/release/version.mjs set X.Y.Z` writes them all, `check [vX.Y.Z]` fails if they disagree. Tags are `vX.Y.Z`.
- **Build:** `.github/workflows/release.yml` builds each platform natively, signs the updater artifacts, checks the signatures with a separate implementation (`scripts/release/verify-signature.mjs`), then installs and smoke tests the result (`scripts/e2e/smoke/smoke.mjs`).
- **Publish:** a tag also makes a **draft** GitHub release, with every artifact, `SHA256SUMS`, `install.sh` and `latest.json`.
- **Update channel:** apps read `https://github.com/Noah-Wilderom/peak/releases/latest/download/latest.json`. GitHub's `latest` skips drafts and pre-releases, so **building and drafting can't reach users. Publishing the draft is the one act that advances the channel.**
- **Windows:** the installer ends the running app, so it downloads and verifies first, and installs only when the user restarts.
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
| Package builds and signs | CI | **Not yet** | **Not yet** | **Not yet** |
| Install, GUI, separate CLI, real samples (`smoke.mjs`) | CI | **Not yet** | **Not yet** | **Not yet** |
| Two-version signed update and failure cases (`update-proof.mjs`) | CI | **Failure cases only; upgrade failed** | CI | CI |
| Update through real buttons (`update-ui.mjs`) | Local | **Not yet** | Not possible: no WebDriver for macOS webviews | Not possible |
| Native tests (`tests/platform.rs`, `native.rs`) | Local, without `native.rs` | **Failed on one test** | CI | **Not yet** |
| Rust type-checks for this OS | Yes | Yes | Yes | Yes |
| Remote targets from this OS | Yes, earlier live suites | **Not run** | **Not run** | **Not run** |
| OS code signing and notarization | Not applicable | **None configured** | **Ad-hoc only** | **Ad-hoc only** |

"CI" means a native GitHub runner on `187f415`, and a later commit needs them again.

Evidence so far: `docs/evidence/release/`, with CI summaries in `ci-187f415/`. Remote targets on Windows and macOS can't run in the current workflows, because their CI runners have no Linux Docker daemon for a collector to reach. They need a real machine.

## Secrets

Set these on the repository, for the tag's workflow:

| Secret | Required | What it is |
|---|---|---|
| `TAURI_SIGNING_PRIVATE_KEY` | **Yes** | Contents of the updater private key |
| `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` | **Yes** | Its password |
| `APPLE_CERTIFICATE`, `APPLE_CERTIFICATE_PASSWORD`, `APPLE_SIGNING_IDENTITY` | For macOS trust | Base64 `.p12` of a **Developer ID Application** certificate, its password, its identity name |
| `APPLE_ID`, `APPLE_PASSWORD`, `APPLE_TEAM_ID` | For macOS trust | Apple account, app-specific password, team, for notarization |

The updater key signs what installed copies accept, so **lose it and existing installs can't be updated; leak it and someone can sign updates for them.** Keep a backup somewhere other than this server.

### What's different without the optional ones

| Without | Effect |
|---|---|
| Apple Developer ID and notarization | The app is ad-hoc signed. It runs on Apple Silicon, but a copy downloaded through a browser is blocked by Gatekeeper until the user allows it in System Settings > Privacy & Security, or runs `xattr -dr com.apple.quarantine /Applications/peak.app`. Updates work once it's installed. Needs a paid Apple Developer account; only its Account Holder can create the certificate |
| A Windows code-signing certificate | The installer runs, but SmartScreen warns on download, and Windows 11's Smart App Control can block it outright. No certificate is wired in yet. With one, set `bundle.windows.certificateThumbprint` and import the `.pfx` in the workflow, or use `signCommand` for a cloud-held key |

## Cutting a release

1. Merge everything. `node scripts/release/version.mjs set X.Y.Z`, add `docs/release-notes/vX.Y.Z.md`, commit.
2. Push `release-validation/X.Y.Z` first and wait for **Update proof** and **Tests**.
3. Tag `vX.Y.Z` and push it. **Release** builds everything and makes the draft.
4. Check the draft's assets against `SHA256SUMS`.
5. Publish: `gh release edit vX.Y.Z --draft=false --latest`. Installed copies see it within 6 hours, or on next start.

To roll back, publish a newer version with the fix. Unpublishing stops new updates, but copies that already updated stay put, and the updater won't move to a lower version.

## The repository is private

**This blocks real delivery.** Anonymous requests can't read release assets of a private repository, and installed copies are anonymous: the feed and `install.sh` get 404s, so updates would fail for everyone and only people with repository access could download. Embedding a token in the app isn't an option. The choices:

1. Make this repository public.
2. Publish releases to a separate public repository (say `Noah-Wilderom/peak-releases`), which keeps the source private. It needs `plugins.updater.endpoints`, `PEAK_RELEASE_REPO`, the README links and the workflow's `gh release create --repo` to change, with a token that can write there.

The endpoint is compiled in, so this has to be settled before the first release.
