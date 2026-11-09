"""Command line entry point: run the service, or manage the API key and watcher tokens."""

import argparse
import getpass
import logging
import sys
from pathlib import Path

from . import VERSION
from . import secrets as keyring
from .agent_sdk import AgentSdkBackend
from .brain import AnthropicBackend, Brain, FakeBackend
from .config import SUBSCRIPTION_BACKEND, Config, ConfigError, is_dev_mode, load_config
from .memory import DailyCounter, Memory

log = logging.getLogger("crepe_daemon")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="crepe_daemon", description="Crêpe's brain, on the session bus.")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--set-key", action="store_true", help="read an API key and store it in the keyring")
    action.add_argument("--forget-key", action="store_true", help="remove the API key from the keyring")
    action.add_argument(
        "--set-token", choices=sorted(keyring.TOKENS), help="read a token (a watcher's, or the subscription's) and store it in the keyring"
    )
    action.add_argument("--forget-token", choices=sorted(keyring.TOKENS), help="remove a token from the keyring")
    action.add_argument("--login", choices=["spotify"], help="connect an account that needs a browser consent")
    action.add_argument("--status", action="store_true", help="print the status of the running instance")
    parser.add_argument("--fake", action="store_true", help="never call the API, answer with canned lines")
    parser.add_argument("--config", type=Path, help="config file (default: $XDG_CONFIG_HOME/crepe/daemon.toml)")
    parser.add_argument("--debug", action="store_true", help="verbose logging")
    parser.add_argument("--version", action="version", version=VERSION)
    return parser


def main(argv: list[str] | None = None) -> int:
    args = build_parser().parse_args(argv)
    logging.basicConfig(
        level=logging.DEBUG if args.debug else logging.INFO,
        format="%(levelname)s %(name)s: %(message)s",
        stream=sys.stderr,
    )
    # The SDK's HTTP client logs every request at INFO.
    logging.getLogger("httpx").setLevel(logging.WARNING)

    if args.set_key:
        return set_key()
    if args.forget_key:
        return forget_key()
    if args.set_token:
        return set_token(args.set_token)
    if args.forget_token:
        return forget_token(args.forget_token)
    if args.login:
        return login(args.login, args.config)
    if args.status:
        return print_status()
    return run_service(args.config, args.fake)


def set_key() -> int:
    key = getpass.getpass("API key: ").strip()
    if not key:
        print("No key given, nothing stored.", file=sys.stderr)
        return 1
    try:
        keyring.store_key(key)
    except keyring.KeyringError as error:
        print(f"Could not store the key: {error}", file=sys.stderr)
        return 1
    print("Key stored in the keyring.")
    return 0


def forget_key() -> int:
    try:
        removed = keyring.clear_key()
    except keyring.KeyringError as error:
        print(f"Could not reach the keyring: {error}", file=sys.stderr)
        return 1
    print("Key removed." if removed else "There was no stored key.")
    return 0


TOKEN_PROMPTS = {
    "gitlab": "GitLab token (read_api): ",
    "redmine": "Redmine API key: ",
    "spotify": "Spotify refresh token: ",
    "claude": "Claude subscription token (from `claude setup-token`): ",
}


def set_token(name: str) -> int:
    token = getpass.getpass(TOKEN_PROMPTS[name]).strip()
    if not token:
        print("No token given, nothing stored.", file=sys.stderr)
        return 1
    try:
        keyring.store_token(name, token)
    except keyring.KeyringError as error:
        print(f"Could not store the token: {error}", file=sys.stderr)
        return 1
    print(f"{name} token stored in the keyring; it is picked up at the next look or request.")
    return 0


def forget_token(name: str) -> int:
    try:
        removed = keyring.clear_token(name)
    except keyring.KeyringError as error:
        print(f"Could not reach the keyring: {error}", file=sys.stderr)
        return 1
    print(f"{name} token removed." if removed else f"There was no stored {name} token.")
    return 0


def login(name: str, config_path: Path | None) -> int:
    from .spotify_login import LoginError, login as spotify_login, open_in_browser
    from .watchers.http import UrllibTransport

    try:
        config = load_config(config_path)
    except ConfigError as error:
        print(error, file=sys.stderr)
        return 2
    if config.spotify is None:
        print(
            "No [watchers.spotify] section with a client_id in the config: create the Spotify app first, "
            "see daemon/README.md.",
            file=sys.stderr,
        )
        return 2
    try:
        spotify_login(
            config.spotify,
            UrllibTransport(),
            lambda refresh_token: keyring.store_token(name, refresh_token),
            open_in_browser,
        )
    except LoginError as error:
        print(f"Login failed: {error}", file=sys.stderr)
        return 1
    print(
        "Spotify connected, refresh token stored in the keyring. The watcher picks it up at its next look; "
        "if it had stopped on a rejected token, restart the daemon: systemctl --user restart crepe-daemon"
    )
    return 0


def print_status() -> int:
    from .nudge import Nudger
    from .service import query_status

    status = query_status()
    if status is None:
        print("No running instance.", file=sys.stderr)
        return 1
    for key in sorted(status):
        print(f"{key}: {_format_status_value(status[key])}")
    extension_version = Nudger().ping()
    print(f"extension: {extension_version or 'not reachable'}")
    return 0


def _format_status_value(value: object) -> str:
    if isinstance(value, list):
        return ", ".join(str(item) for item in value) or "(none)"
    return str(value)


def run_service(config_path: Path | None, fake: bool) -> int:
    from .nudge import Nudger
    from .service import BrainService
    from .watchers import build_watchers

    try:
        config = load_config(config_path)
    except ConfigError as error:
        log.error("%s", error)
        return 2
    backend = FakeBackend() if fake else build_backend(config)
    brain = Brain(config, backend, Memory(), DailyCounter())
    key_lookup = key_lookup_for(config, fake)
    watchers = build_watchers(config, Nudger().nudge, dev=is_dev_mode())
    return BrainService(brain, fake=fake, key_lookup=key_lookup, watchers=watchers).run()


def build_backend(config: Config):
    if config.backend == SUBSCRIPTION_BACKEND:
        return AgentSdkBackend(config.model, lambda: keyring.lookup_token("claude"))
    return AnthropicBackend(config.model, keyring.lookup_key)


def key_lookup_for(config: Config, fake: bool):
    # Fake mode never calls the API, so it has no reason to wake the keyring:
    # on a bus without a secret service that lookup blocks for a long time.
    if fake:
        return keyring.lookup_key_from_env
    if config.backend == SUBSCRIPTION_BACKEND:
        return lambda: keyring.lookup_token("claude")
    return keyring.lookup_key
