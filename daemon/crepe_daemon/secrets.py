"""The API key, the subscription token and the Spotify token, kept in the desktop keyring through libsecret."""

import logging
import os
from typing import NamedTuple

import gi

gi.require_version("Secret", "1")
from gi.repository import GLib, Secret  # noqa: E402

log = logging.getLogger(__name__)

ENV_VAR = "CREPE_API_KEY"
LABEL = "Crêpe API key"
ATTRIBUTES = {"purpose": "api-key"}
SCHEMA = Secret.Schema.new(
    "io.github.aceep.crepe",
    Secret.SchemaFlags.NONE,
    {"purpose": Secret.SchemaAttributeType.STRING},
)


class Token(NamedTuple):
    purpose: str
    env_var: str
    label: str
    # What --set-token asks for.
    prompt: str


# Other tokens, by their name on the command line.
TOKENS = {
    # The OAuth refresh token, written by --login spotify and rotated by the watcher.
    "spotify": Token(
        "spotify-refresh-token", "CREPE_SPOTIFY_REFRESH_TOKEN", "Crêpe Spotify refresh token", "Spotify refresh token: "
    ),
    # The subscription token from `claude setup-token`, for backend = "abonnement".
    "claude": Token(
        "claude-oauth-token",
        "CREPE_CLAUDE_OAUTH_TOKEN",
        "Crêpe Claude subscription token",
        "Claude subscription token (from `claude setup-token`): ",
    ),
}


class KeyringError(Exception):
    pass


_lookup_failure_reported = False


def lookup_key_from_env() -> str | None:
    """The key from CREPE_API_KEY only, without touching the keyring."""
    from_env = os.environ.get(ENV_VAR, "").strip()
    return from_env or None


def lookup_key() -> str | None:
    """The key from CREPE_API_KEY if set and non-empty, else from the keyring.

    Returns None when there is no key or no reachable secret service: a
    missing keyring means "no key", not a crash.
    """
    return lookup_key_from_env() or _lookup(ATTRIBUTES)


def store_key(key: str) -> None:
    _store(ATTRIBUTES, LABEL, key)


def clear_key() -> bool:
    """Remove the stored key. True if there was one."""
    return _clear(ATTRIBUTES)


def lookup_token(name: str) -> str | None:
    """A named token ("spotify" or "claude"): its env override if set, else the keyring."""
    token = TOKENS[name]
    from_env = os.environ.get(token.env_var, "").strip()
    return from_env or _lookup({"purpose": token.purpose})


def store_token(name: str, token: str) -> None:
    _store({"purpose": TOKENS[name].purpose}, TOKENS[name].label, token)


def clear_token(name: str) -> bool:
    """Remove a stored token. True if there was one."""
    return _clear({"purpose": TOKENS[name].purpose})


def _lookup(attributes: dict) -> str | None:
    try:
        stored = Secret.password_lookup_sync(SCHEMA, attributes, None)
    except GLib.Error as error:
        _report_lookup_failure(error.message)
        return None
    return stored.strip() if stored and stored.strip() else None


def _store(attributes: dict, label: str, secret: str) -> None:
    try:
        stored = Secret.password_store_sync(SCHEMA, attributes, Secret.COLLECTION_DEFAULT, label, secret, None)
    except GLib.Error as error:
        raise KeyringError(error.message) from error
    if not stored:
        raise KeyringError("the keyring refused to store the secret")


def _clear(attributes: dict) -> bool:
    try:
        return Secret.password_clear_sync(SCHEMA, attributes, None)
    except GLib.Error as error:
        raise KeyringError(error.message) from error


def _report_lookup_failure(message: str) -> None:
    # Looked up on every request: say it loudly once, then quietly.
    global _lookup_failure_reported
    if _lookup_failure_reported:
        log.debug("keyring lookup failed: %s", message)
        return
    _lookup_failure_reported = True
    log.warning("keyring lookup failed, treating it as no key: %s", message)
