#!/bin/bash
# Launch the app in a detached session so it survives the agent shell teardown.
# `ELECTRON_RUN_AS_NODE` must be absent: with it Electron is a bare Node process
# and the window never opens.
unset ELECTRON_RUN_AS_NODE
cd "$(dirname "$0")" || exit 1
exec node_modules/electron/dist/Electron.app/Contents/MacOS/Electron .
