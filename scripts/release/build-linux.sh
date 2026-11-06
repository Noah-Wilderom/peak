#!/bin/sh
# Builds Linux release artifacts into <out dir>. Same steps here and in CI.
#   TAURI_SIGNING_PRIVATE_KEY=... TAURI_SIGNING_PRIVATE_KEY_PASSWORD=... build-linux.sh <out dir> [tauri --config json]
set -eu
OUT=$1
OVERLAY=${2:-}
[ -n "${TAURI_SIGNING_PRIVATE_KEY:-}" ] || { echo "TAURI_SIGNING_PRIVATE_KEY isn't set: updater artifacts can't be signed" >&2; exit 2; }
node scripts/release/version.mjs check
bun install --frozen-lockfile
export APPIMAGE_EXTRACT_AND_RUN=1 PEAK_REQUIRE_COLLECTOR=1
if [ -n "$OVERLAY" ]; then
  bun run tauri build --bundles appimage,deb --config "$OVERLAY"
else
  bun run tauri build --bundles appimage,deb
fi
node scripts/release/collect.mjs src-tauri/target/release/bundle "$OUT" linux
