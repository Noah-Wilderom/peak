#!/bin/sh
# Installs a released Peak for this user: no root, no build tools.
#   curl -fsSL https://github.com/Noah-Wilderom/peak/releases/latest/download/install.sh | sh
#   install.sh --file <downloaded AppImage>     install that file instead of downloading
# Linux: an AppImage at ~/.local/bin/peak, plus a menu entry. It updates itself in place.
# macOS: use the .dmg from the release page; this script only links the `peak` command to it.
# Set PEAK_INSTALL_DIR to choose another directory. Never edits a shell profile.
set -eu
REPO=${PEAK_RELEASE_REPO:-Noah-Wilderom/peak}
DEST=${PEAK_INSTALL_DIR:-$HOME/.local/bin}
FILE=
[ "${1:-}" = "--file" ] && FILE=${2:?--file needs a path}

mkdir -p "$DEST"
case "$(uname -s)" in
Darwin)
  APP=/Applications/peak.app/Contents/MacOS/peak
  [ -x "$APP" ] || { echo "Install peak.app from the .dmg on https://github.com/$REPO/releases first." >&2; exit 1; }
  ln -sf "$APP" "$DEST/peak"
  ;;
Linux)
  [ "$(uname -m)" = x86_64 ] || { echo "No Linux release for $(uname -m) yet." >&2; exit 1; }
  TMP=$(mktemp "$DEST/.peak.XXXXXX")
  trap 'rm -f "$TMP"' EXIT
  if [ -n "$FILE" ]; then
    cp "$FILE" "$TMP"
  else
    BASE=${PEAK_RELEASE_BASE:-https://github.com/$REPO/releases/latest/download}
    VERSION=$(curl -fsSL "$BASE/latest.json" | sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' | head -1)
    [ -n "$VERSION" ] || { echo "Couldn't read the latest version from $BASE/latest.json" >&2; exit 1; }
    NAME="peak_${VERSION}_amd64.AppImage"
    curl -fL --progress-bar -o "$TMP" "$BASE/$NAME"
    WANT=$(curl -fsSL "$BASE/SHA256SUMS" | awk -v n="$NAME" '$2 == n { print $1 }')
    GOT=$(sha256sum "$TMP" | cut -d' ' -f1)
    [ -n "$WANT" ] && [ "$WANT" = "$GOT" ] || { echo "Checksum mismatch for $NAME: nothing installed." >&2; exit 1; }
  fi
  chmod 755 "$TMP"
  if [ -e "$DEST/peak" ]; then
    echo "Replacing $DEST/peak: $("$DEST/peak" version 2>/dev/null || echo 'an earlier build')"
  fi
  mv -f "$TMP" "$DEST/peak"
  trap - EXIT
  APPS=${XDG_DATA_HOME:-$HOME/.local/share}/applications
  mkdir -p "$APPS"
  printf '[Desktop Entry]\nType=Application\nName=Peak\nComment=Process monitor and memory profiler\nExec=%s\nCategories=Development;\nTerminal=false\n' "$DEST/peak" > "$APPS/peak.desktop"
  ;;
*)
  echo "On Windows, run the installer from https://github.com/$REPO/releases." >&2
  exit 1
  ;;
esac

if [ "$(uname -s)" = Linux ] && "$DEST/peak" version 2>&1 | grep -q 'shared libraries'; then
  echo "Installed $DEST/peak, but it can't run here: $("$DEST/peak" version 2>&1 | head -1)" >&2
  echo "The AppImage uses the graphics and font libraries of a desktop system. On Debian or Ubuntu:" >&2
  echo "  sudo apt install libegl1 libgl1 libx11-xcb1 libx11-6 libdrm2 libexpat1 libfontconfig1 libfreetype6 libfribidi0 libgbm1 libharfbuzz0b libwayland-client0 libxcb1" >&2
  exit 1
fi
echo "Installed: $("$DEST/peak" version 2>/dev/null || echo "$DEST/peak")"
echo "History and settings are untouched. Run 'peak' to open the app."
case ":$PATH:" in
*":$DEST:"*)
  FOUND=$(command -v peak || true)
  [ "$FOUND" = "$DEST/peak" ] || echo "Note: $FOUND comes first on your PATH, so 'peak' runs that one. Remove it, or call $DEST/peak."
  ;;
*)
  echo "$DEST isn't on your PATH. Use $DEST/peak, or add this to your shell profile:"
  echo "  export PATH=\"$DEST:\$PATH\""
  ;;
esac
if [ "$(uname -s)" = Linux ] && ! { command -v ldconfig >/dev/null && ldconfig -p || /sbin/ldconfig -p; } 2>/dev/null | grep -q libfuse.so.2; then
  echo "Note: AppImages need libfuse2 (on Ubuntu 24.04: sudo apt install libfuse2t64)."
  echo "Without it, set APPIMAGE_EXTRACT_AND_RUN=1 before running peak."
fi
