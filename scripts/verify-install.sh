#!/bin/bash
# Walks the README's build and install steps from a fresh copy of the working tree, with `peak`
# absent from PATH and only temporary directories as destinations.
#
#   scripts/verify-install.sh <work dir> <log file>
#
# It fails if a step's outcome differs from what the docs say. Shell profiles and the real
# ~/.local/bin are checksummed before and after. PEAK_SYSLIBS_ENV may name a script providing
# webkit dev libraries where they aren't installed.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$1; LOG=$2
exec > >(tee "$LOG") 2>&1
FAILED=0
ok() { echo "  ok: $1"; }
bad() { echo "  FAIL: $1"; FAILED=1; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }
guarded() { sha256sum "$REAL_HOME"/.profile "$REAL_HOME"/.bashrc "$REAL_HOME"/.bash_profile "$REAL_HOME"/.zshrc "$REAL_HOME/.local/bin/peak" 2>/dev/null; }

echo "started $(date -u +%FT%TZ)"
[ -n "${PEAK_SYSLIBS_ENV:-}" ] && . "$PEAK_SYSLIBS_ENV"
unset PEAK_COLLECTORS PEAK_INSTALL_DIR
REAL_HOME=$HOME
BEFORE=$(guarded)
mkdir -p "$WORK"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -x -C "$WORK"
cd "$WORK"
TMP=$WORK/.tmp; mkdir -p "$TMP"
export XDG_DATA_HOME=$TMP/data
BIN=src-tauri/target/release/peak

echo; echo "=== preconditions"
check "peak is not on PATH" '! command -v peak >/dev/null'
check "no node_modules, no build" '[ ! -e node_modules ] && [ ! -e src-tauri/target ]'

echo; echo "=== \$ task peak:build"
START=$(date +%s)
task peak:build > build.log 2>&1; CODE=$?
sed 's/\x1b\[[0-9;]*m//g' build.log | grep -E "Built application|Finished|Built src-tauri|Open the app|Use the CLI|Install 'peak'|^error" | sed "s#$WORK/##"
echo "exit=$CODE, took $(( $(date +%s) - START ))s"
check "the build succeeds" '[ $CODE -eq 0 ]'
check "it doesn't put peak on PATH, and says so" '! command -v peak >/dev/null && grep -q "It isn.t on your PATH" build.log'
check "the documented path works: peak run" '[ "$(./$BIN run -- echo from-build 2>/dev/null)" = from-build ]'
check "the documented path works: peak collector" './$BIN collector >/dev/null'

echo; echo "=== \$ PEAK_INSTALL_DIR=<temp>/bin task peak:install   (not on PATH)"
DEST=$TMP/bin
PEAK_INSTALL_DIR=$DEST task peak:install > install.log 2>&1; CODE=$?
sed 's/\x1b\[[0-9;]*m//g' install.log | tail -5 | sed "s#$WORK#<work>#g"
check "it installs" '[ $CODE -eq 0 ] && [ -x "$DEST/peak" ]'
check "it says the directory isn't on PATH, and how to fix that" 'grep -q "on your PATH, so bare" install.log && grep -q "export PATH=\"$DEST:" install.log'
check "peak still isn't a command: nothing was claimed or changed" '! command -v peak >/dev/null'
check "the direct path it prints works" '[ "$("$DEST/peak" run -- echo direct 2>/dev/null)" = direct ]'

echo; echo "=== with the line it suggested applied, in a new shell"
export_line=$(grep 'export PATH=' install.log | sed 's/^ *//')
export_output=$(bash -c "$export_line; command -v peak; peak run -- echo on-path 2>/dev/null; peak collector | cut -d: -f1")
echo "$export_output" | sed "s#$WORK#<work>#g"
check "bare peak resolves and runs" '[ "$(echo "$export_output" | head -1)" = "$DEST/peak" ] && echo "$export_output" | grep -q on-path && echo "$export_output" | grep -q x86_64'

echo; echo "=== \$ scripts/install-peak.sh, reinstalling with the directory on PATH"
OUT=$(PATH=$DEST:$PATH PEAK_INSTALL_DIR=$DEST sh scripts/install-peak.sh); echo "$OUT" | sed "s#$WORK#<work>#g"
check "no PATH warning when it's already there" '! echo "$OUT" | grep -q "isn.t on your PATH" && echo "$OUT" | grep -q "Run .peak."'

echo; echo "=== another peak earlier on PATH"
mkdir -p "$TMP/other"; printf '#!/bin/sh\n' > "$TMP/other/peak"; chmod +x "$TMP/other/peak"
OUT=$(PATH=$TMP/other:$DEST:$PATH PEAK_INSTALL_DIR=$DEST sh scripts/install-peak.sh); echo "$OUT" | sed "s#$WORK#<work>#g"
check "it warns which one wins" 'echo "$OUT" | grep -q "currently runs $TMP/other/peak"'

echo; echo "=== default destination, HOME pointing at a temp directory"
FAKE=$TMP/home; mkdir -p "$FAKE"; echo '# untouched' > "$FAKE/.profile"; P=$(sha256sum "$FAKE/.profile")
OUT=$(HOME=$FAKE sh scripts/install-peak.sh); echo "$OUT" | sed "s#$WORK#<work>#g"
check "it goes to ~/.local/bin/peak" '[ -x "$FAKE/.local/bin/peak" ]'
check "the profile isn't edited" '[ "$(sha256sum "$FAKE/.profile")" = "$P" ]'
check "no file is left beside it" '[ "$(ls -A "$FAKE/.local/bin" | wc -l)" = 1 ]'

echo; echo "=== nothing built yet"
mkdir -p "$TMP/empty/scripts"; cp scripts/install-peak.sh "$TMP/empty/scripts/"
OUT=$(PEAK_INSTALL_DIR=$TMP/nowhere sh "$TMP/empty/scripts/install-peak.sh" 2>&1); CODE=$?; echo "$OUT" | sed "s#$WORK#<work>#g"
check "it refuses, and says what to run" '[ $CODE -ne 0 ] && echo "$OUT" | grep -q "task peak:build" && [ ! -e "$TMP/nowhere" ]'

echo; echo "=== the real home"
check "shell profiles and ~/.local/bin/peak are unchanged" '[ "$BEFORE" = "$(guarded)" ]'
echo "installed binary, for a window test: $DEST/peak"
echo "ended $(date -u +%FT%TZ)"
[ $FAILED -eq 0 ] && echo "ALL STEPS AS DOCUMENTED" || echo "SOME STEPS FAILED"
exit $FAILED
