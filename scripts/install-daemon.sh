#!/usr/bin/env bash
# Install or update Crêpe's brain daemon for the current user.
#
#   scripts/install-daemon.sh [--no-enable]
#
# Copies the package to $XDG_DATA_HOME/crepe/daemon, keeps a venv with the
# pinned SDKs in $XDG_DATA_HOME/crepe/daemon-venv, installs the systemd user
# unit, then reloads systemd and enables the unit unless --no-enable is given.
# Safe to run again: every step replaces what the previous run left.
set -euo pipefail

enable=1
for arg in "$@"; do
    case "$arg" in
        --no-enable) enable=0 ;;
        -h|--help) sed -n '2,10p' "$0"; exit 0 ;;
        *) echo "unknown option: $arg" >&2; exit 2 ;;
    esac
done

repo_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
source_dir="$repo_dir/daemon"
data_home="${XDG_DATA_HOME:-$HOME/.local/share}"
config_home="${XDG_CONFIG_HOME:-$HOME/.config}"
install_dir="$data_home/crepe/daemon"
venv_dir="$data_home/crepe/daemon-venv"
unit_dir="$config_home/systemd/user"
unit_path="$unit_dir/crepe-daemon.service"

echo "Installing the package to $install_dir"
mkdir -p "$install_dir"
staging="$(mktemp -d "$install_dir/.crepe_daemon.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
cp -r "$source_dir/crepe_daemon" "$staging/"
find "$staging" -name '__pycache__' -type d -prune -exec rm -rf {} +
rm -rf "$install_dir/crepe_daemon"
mv "$staging/crepe_daemon" "$install_dir/crepe_daemon"

if [ ! -x "$venv_dir/bin/python" ]; then
    echo "Creating the venv in $venv_dir"
    # System site packages keep PyGObject (gi) importable.
    python3 -m venv --system-site-packages "$venv_dir"
fi
echo "Installing Python dependencies"
"$venv_dir/bin/python" -m pip install --quiet --disable-pip-version-check -r "$source_dir/requirements.txt"
"$venv_dir/bin/python" -c 'import gi; gi.require_version("Secret", "1"); from gi.repository import Gio, Secret' \
    || { echo "PyGObject with Gio and Secret is missing from the system Python" >&2; exit 1; }
# The Agent SDK wheel (backend = "abonnement") bundles the Claude Code CLI, a
# ~300 MB executable; no separate install and no Node are needed. Only the
# subscription backend runs it, so a platform whose wheel lacks it is not fatal.
if "$venv_dir/bin/python" -c 'import pathlib, sys, claude_agent_sdk; sys.exit(not (pathlib.Path(claude_agent_sdk.__file__).parent / "_bundled" / "claude").is_file())'; then
    echo "The Agent SDK bundles its CLI; nothing else to install for backend = \"abonnement\"."
else
    echo "Note: the Agent SDK wheel has no bundled CLI on this platform; backend = \"abonnement\" needs a 'claude' executable on PATH." >&2
fi

echo "Installing the unit to $unit_path"
mkdir -p "$unit_dir"
unit="$(cat "$source_dir/crepe-daemon.service")"
default_data_home="$HOME/.local/share"
if [ "$data_home" != "$default_data_home" ]; then
    # The template assumes the default data dir; spell out the real one.
    unit="${unit//%h\/.local\/share/$data_home}"
fi
printf '%s\n' "$unit" > "$unit_path.tmp"
mv "$unit_path.tmp" "$unit_path"

if [ "$enable" -eq 1 ]; then
    systemctl --user daemon-reload
    systemctl --user enable --now crepe-daemon.service
    systemctl --user restart crepe-daemon.service
    echo "crepe-daemon is running."
else
    echo "Not enabled (--no-enable). To start it:"
    echo "  systemctl --user daemon-reload && systemctl --user enable --now crepe-daemon.service"
fi
echo "Store the API key once with:"
echo "  PYTHONPATH=$install_dir $venv_dir/bin/python -m crepe_daemon --set-key"
echo "For backend = \"abonnement\" (see daemon/README.md), after running 'claude setup-token':"
echo "  PYTHONPATH=$install_dir $venv_dir/bin/python -m crepe_daemon --set-token claude"
echo "Watcher tokens, if [watchers.gitlab] or [watchers.redmine] is configured:"
echo "  PYTHONPATH=$install_dir $venv_dir/bin/python -m crepe_daemon --set-token gitlab|redmine"
