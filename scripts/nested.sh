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
    # Enabling too early makes D-Bus activate a stand-in for
    # org.gnome.Shell.Extensions and the extension stays INITIALIZED, so
    # wait until the nested shell owns that name itself: it claims
    # org.gnome.Shell at once but exports the extension system only once it
    # is up. NameHasOwner never activates anything, unlike calling the name.
    for _ in $(seq 1 120); do
        kill -0 "$shell_pid" 2>/dev/null || break
        gdbus call --session --dest org.freedesktop.DBus --object-path /org/freedesktop/DBus \
            --method org.freedesktop.DBus.NameHasOwner org.gnome.Shell.Extensions 2>/dev/null \
            | grep -q true && break
        sleep 0.5
    done
    gnome-extensions enable "$1" || echo "could not enable $1 (is the nested shell up?)" >&2
    wait "$shell_pid"
' _ "$UUID"
