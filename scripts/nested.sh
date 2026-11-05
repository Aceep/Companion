#!/usr/bin/env bash
# Run a nested GNOME Shell with Crêpe enabled, isolated from the live session:
# its own D-Bus and an in-memory GSettings backend, so enabling the extension
# there never touches the real session. Close the window to stop.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
UUID="$(node -e 'console.log(require(process.argv[1]).uuid)' "$ROOT/metadata.json")"
"$ROOT/scripts/install.sh"

export MUTTER_DEBUG_DUMMY_MODE_SPECS="${MUTTER_DEBUG_DUMMY_MODE_SPECS:-1440x900}"
export GSETTINGS_BACKEND=memory
export SHELL_DEBUG=all

exec dbus-run-session -- bash -c '
    gnome-shell --nested --wayland --no-x11 &
    shell_pid=$!
    sleep 4
    gnome-extensions enable "$1" || echo "could not enable $1 (is the nested shell up?)" >&2
    wait "$shell_pid"
' _ "$UUID"
