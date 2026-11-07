#!/bin/sh
# `tauri build`, with retries on macOS only: making a .dmg sometimes fails on CI runners with
# "hdiutil: couldn't eject ... Resource busy", which is the machine, not the build. A retry reuses
# the compiled app. A failure anywhere else stops at once, and so does a third failure here.
case "$(uname -s)" in Darwin) tries=3 ;; *) tries=1 ;; esac
n=1
while :; do
  bun run tauri build "$@" && exit 0
  status=$?
  [ "$n" -ge "$tries" ] && exit "$status"
  echo "tauri build failed (attempt $n of $tries); clearing any mounted image and retrying" >&2
  for v in /Volumes/peak*; do
    [ -d "$v" ] && hdiutil detach "$v" -force >/dev/null 2>&1
  done
  sleep 20
  n=$((n + 1))
done
