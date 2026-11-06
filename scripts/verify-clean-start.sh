#!/bin/bash
# The workflow people actually use, from nothing: an exported copy of the working tree, no
# node_modules, no target directory, no PEAK_COLLECTORS, and the musl target removed.
# It runs `task dev` and checks that the binary it built can supply a collector.
#
#   scripts/verify-clean-start.sh <work dir> <log file>
#
# PEAK_SYSLIBS_ENV may name a script providing webkit dev libraries where they aren't
# installed. That's unrelated to collectors, and it must not set PEAK_COLLECTORS.
set -u
ROOT=$(cd "$(dirname "$0")/.." && pwd)
WORK=$1; LOG=$2
exec > >(tee "$LOG") 2>&1
TARGET=x86_64-unknown-linux-musl
echo "started $(date -u +%FT%TZ)"
[ -n "${PEAK_SYSLIBS_ENV:-}" ] && . "$PEAK_SYSLIBS_ENV"
unset PEAK_COLLECTORS
mkdir -p "$WORK"
(cd "$ROOT" && git ls-files -co --exclude-standard -z | tar --null -T - -cf -) | tar -x -C "$WORK"
cd "$WORK"
echo "=== preconditions"
echo "PEAK_COLLECTORS=${PEAK_COLLECTORS-<unset>}"
echo "node_modules: $([ -e node_modules ] && echo present || echo absent)"
echo "target dir: $([ -e src-tauri/target ] && echo present || echo absent)"
echo "collector files in the copy: $(find . -name 'peak-collector' -type f | wc -l)"
rustup target remove $TARGET 2>&1 | tail -1
echo "rustup musl target installed: $(rustup target list --installed | grep -c $TARGET)"

echo; echo "=== \$ task dev   (stopped once the app has been launched)"
export XDG_DATA_HOME="$WORK/.xdg"
START=$(date +%s)
setsid xvfb-run -a task dev > dev.log 2>&1 &
PGID=$!
for _ in $(seq 1 120); do
  grep -q 'Running.*target/debug/peak' dev.log && break
  kill -0 $PGID 2>/dev/null || break
  sleep 5
done
echo "build + launch took $(( $(date +%s) - START ))s"
grep -E 'task: \[dev\]|Compiling peak|Finished|Running.*target/debug/peak|warning: peak|^error' dev.log | sed 's/\x1b\[[0-9;]*m//g' | tail -12
sleep 3
kill -TERM -- -$PGID 2>/dev/null; sleep 2; kill -KILL -- -$PGID 2>/dev/null
pkill -f "$WORK/src-tauri/target/debug/peak" 2>/dev/null
P=$(ss -ltnp 2>/dev/null | grep ':1420 ' | grep -oE 'pid=[0-9]+' | head -1 | cut -d= -f2); [ -n "$P" ] && kill "$P"

echo; echo "=== results"
echo "rustup musl target installed: $(rustup target list --installed | grep -c $TARGET)"
echo "\$ src-tauri/target/debug/peak collector"
src-tauri/target/debug/peak collector; CODE=$?
echo "exit=$CODE"
echo "ended $(date -u +%FT%TZ)"
exit $CODE
