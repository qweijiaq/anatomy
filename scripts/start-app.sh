#!/usr/bin/env bash
# Open the built bundle from this directory, so the app's workspace is the project.
#
# `open out/anatomy.app` is the double-click path and works, but the cwd is then `/` and
# the app falls back to its data directory for `.ana/` — right for a user, wrong for
# someone who wants the reports next to the code they are testing. This launcher gives
# both: the bundle (own icon and Dock name) with the project as the workspace.
set -u -o pipefail
cd "$(dirname "$0")/.." || exit 1

bundle="out/anatomy.app"
if [ ! -x "$bundle/Contents/MacOS/Electron" ]; then
  echo "no bundle yet — run: npm run build:desktop && npm run build:bundle" >&2
  exit 1
fi

exec "$bundle/Contents/MacOS/Electron" "$PWD"
