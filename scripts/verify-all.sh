#!/bin/bash
# Every check for this repository, in one run, with a durable record:
#   docs/evidence/<UTC time>/verification.log    what ran, when, and what it said
#   $SHOTS/{browser,desktop}/                    screenshots (too large for the repo)
#
# Needs: bun, cargo + cargo-llvm-cov, rustup musl target, node 20/22 optional, python3,
# docker, sshd, kubectl, tauri-driver, Playwright. Paths come from PEAK_TOOLS:
#   $PEAK_TOOLS/env.sh                 optional environment (private webkit dev libraries)
#   $PEAK_TOOLS/collectors/x86_64/     where the static collector is placed
#   $PEAK_TOOLS/bin/kubectl, $PEAK_TOOLS/tauri-driver/bin/tauri-driver
#   $PEAK_TOOLS/e2e/                   a directory with Playwright installed
#   $PEAK_TOOLS/node/node-v*/bin/node  extra Node versions (optional)
set -u
TOOLS=${PEAK_TOOLS:?set PEAK_TOOLS}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
STAMP=$(date -u +%Y%m%dT%H%MZ)
OUT=$ROOT/docs/evidence/$STAMP
SHOTS=$TOOLS/evidence/$STAMP
mkdir -p "$OUT" "$SHOTS/browser" "$SHOTS/desktop"
LOG=$OUT/verification.log
exec > >(tee "$LOG") 2>&1
[ -f "$TOOLS/env.sh" ] && . "$TOOLS/env.sh"
export PATH=$TOOLS/bin:$PATH PEAK_COLLECTORS=$TOOLS/collectors
FAILED=()
# gate <name> <command...>: run, print the tail, record the outcome.
gate() {
  local name=$1; shift
  echo; echo "=== $name  started $(date -u +%H:%M:%S)  \$ $*"
  local t; t=$(mktemp)
  "$@" >"$t" 2>&1; local code=$?
  grep -vE '^\s+(Compiling|Downloaded|Downloading)|dbind-WARNING|libEGL|^$' "$t" | tail -"${TAIL:-25}"
  rm -f "$t"
  echo "--- $name  exit=$code  ended $(date -u +%H:%M:%S)"
  [ $code -eq 0 ] || FAILED+=("$name")
}
cd "$ROOT"
echo "commit base: $(git rev-parse --short HEAD), uncommitted files: $(git status --short | wc -l)"
echo "disk: $(df -h / | tail -1)"

gate typecheck bun run typecheck
TAIL=120 gate frontend-coverage bun run test:coverage
gate frontend-build bun run build
gate agents bun run test:agents
for n in "$TOOLS"/node/node-v*/bin/node; do
  [ -x "$n" ] && gate "agents-node-$("$n" --version)" "$n" --test --test-reporter=spec src-tauri/agents/tests/*.test.mjs
done

cd "$ROOT/src-tauri"
gate backend-fmt cargo fmt --all --check
gate backend-clippy cargo clippy --workspace --all-targets -- -D warnings
# Without the desktop's libraries: the collector must not need them.
gate collector-builds-alone env -u RUSTFLAGS -u PKG_CONFIG_PATH -u LD_LIBRARY_PATH cargo build -p peak-collector
gate collector-static env -u RUSTFLAGS cargo build -p peak-collector --release --target x86_64-unknown-linux-musl
mkdir -p "$TOOLS/collectors/x86_64"
cp target/x86_64-unknown-linux-musl/release/peak-collector "$TOOLS/collectors/x86_64/"
TAIL=60 gate backend-coverage cargo llvm-cov --workspace --ignore-filename-regex '(lib|main|live_\w+)\.rs$' --fail-under-lines 99

TAIL=5 gate live-ssh cargo test --test live_ssh -- --ignored --test-threads=1
TAIL=5 gate live-docker cargo test --test live_docker -- --ignored --test-threads=1
TAIL=8 gate live-kubernetes cargo test --test live_kube -- --ignored --test-threads=1

cd "$ROOT"
echo; echo "=== browser-mock  (real Chromium, simulated data)"
bun run dev --port 1420 --strictPort >/dev/null 2>&1 &
sleep 4
cp scripts/e2e/mock-e2e.mjs "$TOOLS/e2e/"
TAIL=30 gate browser-mock bash -c "cd '$TOOLS/e2e' && PLAYWRIGHT_BROWSERS_PATH='$TOOLS/e2e/browsers' SHOTS='$SHOTS/browser' node mock-e2e.mjs"
PID=$(ss -ltnp 2>/dev/null | grep ':1420 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2)
[ -n "$PID" ] && kill "$PID"

gate desktop-binary bash -c "bun run build && cd src-tauri && cargo build --features tauri/custom-protocol"
TAIL=60 gate desktop-real scripts/e2e/desktop/run.sh src-tauri/target/debug/peak "$TOOLS/tauri-driver/bin/tauri-driver" "$TOOLS/collectors" "$TOOLS/bin/kubectl" "$SHOTS/desktop"
[ -f "$SHOTS/desktop/notifications-received.log" ] && cp "$SHOTS/desktop/notifications-received.log" "$OUT/"

echo; echo "leftover disposable containers: $(docker ps -a --filter name=peak-live --format '{{.Names}}' | wc -l)"
echo "screenshots: $SHOTS"
if [ ${#FAILED[@]} -eq 0 ]; then echo "ALL CHECKS PASSED"; else echo "FAILED: ${FAILED[*]}"; exit 1; fi
