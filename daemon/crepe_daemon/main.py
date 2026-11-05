"""Command line entry point: run the service, or manage the API key and watcher tokens."""

import argparse
import getpass
import logging
import sys
from pathlib import Path

from . import VERSION
from . import secrets as keyring
from .brain import AnthropicBackend, Brain, FakeBackend
from .config import ConfigError, is_dev_mode, load_config
from .memory import DailyCounter, Memory

log = logging.getLogger("crepe_daemon")


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(prog="crepe_daemon", description="Crêpe's brain, on the session bus.")
    action = parser.add_mutually_exclusive_group()
    action.add_argument("--set-key", action="store_true", help="read an API key and store it in the keyring")
    action.add_argument("--forget-key", action="store_true", help="remove the API key from the keyring")
    action.add_argument(
        "--set-token", choices=sorted(keyring.TOKENS), help="read a watcher token and store it in the keyring"
    )
    action.add_argument("--forget-token", choices=sorted(keyring.TOKENS), help="remove a watcher token from the keyring")
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


TOKEN_PROMPTS = {"gitlab": "GitLab token (read_api): ", "redmine": "Redmine API key: "}


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
    print(f"{name} token stored in the keyring; the watcher picks it up at its next look.")
    return 0


def forget_token(name: str) -> int:
    try:
        removed = keyring.clear_token(name)
    except keyring.KeyringError as error:
        print(f"Could not reach the keyring: {error}", file=sys.stderr)
        return 1
    print(f"{name} token removed." if removed else f"There was no stored {name} token.")
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
    backend = FakeBackend() if fake else AnthropicBackend(config.model, keyring.lookup_key)
    brain = Brain(config, backend, Memory(), DailyCounter())
    # Fake mode never calls the API, so it has no reason to wake the keyring:
    # on a bus without a secret service that lookup blocks for a long time.
    key_lookup = keyring.lookup_key_from_env if fake else keyring.lookup_key
    watchers = build_watchers(config, Nudger().nudge, dev=is_dev_mode())
    return BrainService(brain, fake=fake, key_lookup=key_lookup, watchers=watchers).run()
