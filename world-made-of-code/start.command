#!/bin/bash
# A World Made of Code — macOS launcher.
# Double-click this file in Finder (or run ./start.command in Terminal).
# Opens the scene fullscreen with no browser UI. Quit with Cmd+Q.

DIR="$(cd "$(dirname "$0")" && pwd)"
URL="file://${DIR// /%20}/index.html${1:+?$1}"

if [ -d "/Applications/Google Chrome.app" ] || [ -d "$HOME/Applications/Google Chrome.app" ]; then
  # A separate profile lets kiosk mode start even if Chrome is already open.
  open -na "Google Chrome" --args \
    --user-data-dir="${TMPDIR:-/tmp}/world-made-of-code-chrome" \
    --kiosk --no-first-run --no-default-browser-check \
    "$URL"
else
  # Safari / default browser: press F (or double-click) for fullscreen.
  open "$URL"
fi
