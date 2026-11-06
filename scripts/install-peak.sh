#!/bin/sh
# Copies the built app to a directory as the `peak` command. It never edits shell profiles;
# if the directory isn't on PATH, it says so. Normally run through `task peak:install`.
set -eu
ROOT=$(cd "$(dirname "$0")/.." && pwd)
BIN=$ROOT/src-tauri/target/release/peak
DEST=${PEAK_INSTALL_DIR:-$HOME/.local/bin}

if [ ! -x "$BIN" ]; then
  echo "No build at $BIN. Run: task peak:build" >&2
  exit 1
fi

mkdir -p "$DEST"
# Copied aside and renamed in, so a running Peak can be replaced.
install -m 755 "$BIN" "$DEST/.peak.$$"
mv -f "$DEST/.peak.$$" "$DEST/peak"
echo "Installed $DEST/peak"

case ":$PATH:" in
  *":$DEST:"*)
    FOUND=$(command -v peak || true)
    if [ "$FOUND" != "$DEST/peak" ]; then
      echo "Note: 'peak' currently runs $FOUND, which comes first on your PATH."
    else
      echo "Run 'peak' to open the app, or 'peak run -- <command>' with the app open."
    fi
    ;;
  *)
    echo "$DEST isn't on your PATH, so bare 'peak' won't work yet. Either run it directly:"
    echo "  $DEST/peak"
    echo "or add this line to your shell profile and open a new terminal:"
    echo "  export PATH=\"$DEST:\$PATH\""
    ;;
esac
