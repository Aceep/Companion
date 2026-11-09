"""Daemon settings, read once at startup from a TOML file."""

import logging
import math
import os
import tomllib
from dataclasses import dataclass
from pathlib import Path

log = logging.getLogger(__name__)

DEFAULT_BACKEND = "api"
# The second backend, billed to the owner's subscription (see agent_sdk.py).
SUBSCRIPTION_BACKEND = "abonnement"
BACKENDS = (DEFAULT_BACKEND, SUBSCRIPTION_BACKEND)
DEFAULT_MODEL = "claude-haiku-5-5"
DEFAULT_DAILY_BUDGET = 200
DEFAULT_MAX_REPLY_CHARS = 160
# Below this a reply cannot even hold one of her short lines plus an ellipsis.
MIN_REPLY_CHARS = 20
DEFAULT_GITLAB_INTERVAL_MINUTES = 5
DEFAULT_REDMINE_INTERVAL_MINUTES = 10
DEFAULT_GIT_INTERVAL_MINUTES = 30
DEFAULT_GIT_NAG_AFTER_MINUTES = 120
DEFAULT_MACHINE_INTERVAL_MINUTES = 5
DEFAULT_DISK_PERCENT = 90
DEFAULT_DISK_PATHS = ("/", "~")
DEFAULT_BATTERY_PERCENT = 15
DEFAULT_LOAD_MINUTES = 10
DEFAULT_ICS_INTERVAL_MINUTES = 15
# A published calendar changes rarely and its server may throttle.
MIN_ICS_INTERVAL_MINUTES = 5
DEFAULT_ICS_WARN_MINUTES = 10
DEFAULT_SPOTIFY_PORT = 8898
DEFAULT_SPOTIFY_INTERVAL_SECONDS = 30
DEFAULT_SPOTIFY_IDLE_INTERVAL_SECONDS = 120
# Spotify publishes no rate limit; staying well apart avoids a 429 on a hobby app.
MIN_SPOTIFY_INTERVAL_SECONDS = 15
MIN_INTERVAL_MINUTES = 1
# CREPE_DEV=1 lets a manual test see several ticks in a couple of minutes.
DEV_MIN_INTERVAL_MINUTES = 0.05
DEV_MIN_SPOTIFY_INTERVAL_SECONDS = 3
DEV_ENV_VAR = "CREPE_DEV"


class ConfigError(Exception):
    pass


@dataclass(frozen=True)
class GitlabConfig:
    url: str
    interval_minutes: float = DEFAULT_GITLAB_INTERVAL_MINUTES
    # Paths with namespace; empty means the projects the user is a member of.
    projects: tuple[str, ...] = ()
    only_mine: bool = True


@dataclass(frozen=True)
class RedmineConfig:
    url: str
    interval_minutes: float = DEFAULT_REDMINE_INTERVAL_MINUTES


@dataclass(frozen=True)
class GitConfig:
    # Absolute paths, `~` already expanded: repos, or folders whose children are repos.
    paths: tuple[str, ...]
    interval_minutes: float = DEFAULT_GIT_INTERVAL_MINUTES
    nag_after_minutes: float = DEFAULT_GIT_NAG_AFTER_MINUTES
    # False: only uncommitted work nags, commits waiting for a push are left alone.
    unpushed: bool = True


@dataclass(frozen=True)
class MachineConfig:
    interval_minutes: float = DEFAULT_MACHINE_INTERVAL_MINUTES
    disk_percent: float = DEFAULT_DISK_PERCENT
    # `~` already expanded.
    disk_paths: tuple[str, ...] = tuple(os.path.expanduser(path) for path in DEFAULT_DISK_PATHS)
    battery_percent: float = DEFAULT_BATTERY_PERCENT
    load_minutes: float = DEFAULT_LOAD_MINUTES


@dataclass(frozen=True)
class IcsConfig:
    # May carry its secret in the path: never log it, only its host.
    url: str
    interval_minutes: float = DEFAULT_ICS_INTERVAL_MINUTES
    warn_minutes: float = DEFAULT_ICS_WARN_MINUTES

    def __repr__(self) -> str:
        return f"IcsConfig(url=<hidden>, interval_minutes={self.interval_minutes}, warn_minutes={self.warn_minutes})"


@dataclass(frozen=True)
class SpotifyConfig:
    # Public identifier of her own Spotify app (PKCE has no client secret).
    client_id: str
    redirect_port: int = DEFAULT_SPOTIFY_PORT
    interval_seconds: float = DEFAULT_SPOTIFY_INTERVAL_SECONDS
    # Used once nothing has played for a while.
    idle_interval_seconds: float = DEFAULT_SPOTIFY_IDLE_INTERVAL_SECONDS


@dataclass(frozen=True)
class Config:
    backend: str = DEFAULT_BACKEND
    model: str = DEFAULT_MODEL
    daily_budget: int = DEFAULT_DAILY_BUDGET
    remarks: bool = False
    max_reply_chars: int = DEFAULT_MAX_REPLY_CHARS
    # A watcher runs only when its config section exists.
    gitlab: GitlabConfig | None = None
    redmine: RedmineConfig | None = None
    git: GitConfig | None = None
    machine: MachineConfig | None = None
    ics: IcsConfig | None = None
    spotify: SpotifyConfig | None = None


def default_config_path() -> Path:
    base = os.environ.get("XDG_CONFIG_HOME") or os.path.join(os.path.expanduser("~"), ".config")
    return Path(base) / "crepe" / "daemon.toml"


def is_dev_mode() -> bool:
    return os.environ.get(DEV_ENV_VAR) == "1"


def load_config(path: Path | None = None) -> Config:
    path = path or default_config_path()
    try:
        with open(path, "rb") as handle:
            raw = tomllib.load(handle)
    except FileNotFoundError:
        log.info("no config at %s, using defaults", path)
        return Config()
    except (OSError, tomllib.TOMLDecodeError) as error:
        raise ConfigError(f"cannot read {path}: {error}") from error
    return parse_config(raw, dev=is_dev_mode())


def parse_config(raw: dict, dev: bool = False) -> Config:
    known = {"backend", "model", "daily_budget", "remarks", "max_reply_chars", "watchers"}
    for key in sorted(set(raw) - known):
        log.warning("ignoring unknown config key %r", key)

    backend = raw.get("backend", DEFAULT_BACKEND)
    if backend not in BACKENDS:
        raise ConfigError("backend must be " + " or ".join(f'"{name}"' for name in BACKENDS))

    model = raw.get("model", DEFAULT_MODEL)
    if not isinstance(model, str) or not model.strip():
        raise ConfigError("model must be a non-empty string")

    daily_budget = raw.get("daily_budget", DEFAULT_DAILY_BUDGET)
    if not _is_int(daily_budget) or daily_budget < 0:
        raise ConfigError("daily_budget must be an integer >= 0")

    remarks = raw.get("remarks", False)
    if not isinstance(remarks, bool):
        raise ConfigError("remarks must be true or false")

    max_reply_chars = raw.get("max_reply_chars", DEFAULT_MAX_REPLY_CHARS)
    if not _is_int(max_reply_chars) or max_reply_chars < MIN_REPLY_CHARS:
        raise ConfigError(f"max_reply_chars must be an integer >= {MIN_REPLY_CHARS}")

    watchers = raw.get("watchers", {})
    if not isinstance(watchers, dict):
        raise ConfigError("watchers must be a table")
    for key in sorted(set(watchers) - {"gitlab", "redmine", "git", "machine", "ics", "spotify"}):
        log.warning("ignoring unknown watcher %r", key)
    min_interval = DEV_MIN_INTERVAL_MINUTES if dev else MIN_INTERVAL_MINUTES

    return Config(
        backend=backend,
        model=model.strip(),
        daily_budget=daily_budget,
        remarks=remarks,
        max_reply_chars=max_reply_chars,
        gitlab=_parse_gitlab(watchers["gitlab"], min_interval) if "gitlab" in watchers else None,
        redmine=_parse_redmine(watchers["redmine"], min_interval) if "redmine" in watchers else None,
        git=_parse_git(watchers["git"], min_interval) if "git" in watchers else None,
        machine=_parse_machine(watchers["machine"], min_interval) if "machine" in watchers else None,
        ics=_parse_ics(watchers["ics"], dev) if "ics" in watchers else None,
        spotify=_parse_spotify(watchers["spotify"], dev) if "spotify" in watchers else None,
    )


def _parse_gitlab(raw: object, min_interval: float) -> GitlabConfig:
    section = _watcher_section(raw, "gitlab", {"url", "interval_minutes", "projects", "only_mine"})
    projects = section.get("projects", [])
    if not isinstance(projects, list) or not all(isinstance(path, str) and path.strip() for path in projects):
        raise ConfigError("watchers.gitlab.projects must be a list of non-empty strings")
    only_mine = section.get("only_mine", True)
    if not isinstance(only_mine, bool):
        raise ConfigError("watchers.gitlab.only_mine must be true or false")
    return GitlabConfig(
        url=_parse_url(section, "gitlab"),
        interval_minutes=_parse_interval(section, "gitlab", DEFAULT_GITLAB_INTERVAL_MINUTES, min_interval),
        projects=tuple(path.strip().strip("/") for path in projects),
        only_mine=only_mine,
    )


def _parse_redmine(raw: object, min_interval: float) -> RedmineConfig:
    section = _watcher_section(raw, "redmine", {"url", "interval_minutes"})
    return RedmineConfig(
        url=_parse_url(section, "redmine"),
        interval_minutes=_parse_interval(section, "redmine", DEFAULT_REDMINE_INTERVAL_MINUTES, min_interval),
    )


def _parse_git(raw: object, min_interval: float) -> GitConfig:
    section = _watcher_section(raw, "git", {"paths", "interval_minutes", "nag_after_minutes", "unpushed"})
    if "paths" not in section:
        raise ConfigError("watchers.git.paths is required: a list of repos or folders of repos")
    paths = _parse_path_list(section, "git", "paths", ())
    if not paths:
        raise ConfigError("watchers.git.paths must not be empty")
    unpushed = section.get("unpushed", True)
    if not isinstance(unpushed, bool):
        raise ConfigError("watchers.git.unpushed must be true or false")
    return GitConfig(
        paths=paths,
        interval_minutes=_parse_interval(section, "git", DEFAULT_GIT_INTERVAL_MINUTES, min_interval),
        nag_after_minutes=_parse_number(section, "git", "nag_after_minutes", DEFAULT_GIT_NAG_AFTER_MINUTES, 1),
        unpushed=unpushed,
    )


def _parse_machine(raw: object, min_interval: float) -> MachineConfig:
    known = {"interval_minutes", "disk_percent", "disk_paths", "battery_percent", "load_minutes"}
    section = _watcher_section(raw, "machine", known)
    return MachineConfig(
        interval_minutes=_parse_interval(section, "machine", DEFAULT_MACHINE_INTERVAL_MINUTES, min_interval),
        disk_percent=_parse_number(section, "machine", "disk_percent", DEFAULT_DISK_PERCENT, 0, 100),
        disk_paths=_parse_path_list(section, "machine", "disk_paths", DEFAULT_DISK_PATHS),
        battery_percent=_parse_number(section, "machine", "battery_percent", DEFAULT_BATTERY_PERCENT, 0, 100),
        load_minutes=_parse_number(section, "machine", "load_minutes", DEFAULT_LOAD_MINUTES, 0),
    )


def _parse_ics(raw: object, dev: bool) -> IcsConfig:
    # token_purpose is accepted for symmetry with the other watchers; the secret lives in the URL.
    section = _watcher_section(raw, "ics", {"url", "interval_minutes", "warn_minutes", "token_purpose"})
    url = section.get("url")
    if not isinstance(url, str) or not url.strip().startswith(("https://", "http://")):
        raise ConfigError("watchers.ics.url must be an http(s) URL")
    min_interval = DEV_MIN_INTERVAL_MINUTES if dev else MIN_ICS_INTERVAL_MINUTES
    return IcsConfig(
        # Not stripped of a trailing slash: the published link must be used verbatim.
        url=url.strip(),
        interval_minutes=_parse_interval(section, "ics", DEFAULT_ICS_INTERVAL_MINUTES, min_interval),
        warn_minutes=_parse_number(section, "ics", "warn_minutes", DEFAULT_ICS_WARN_MINUTES, 1),
    )


def _parse_spotify(raw: object, dev: bool) -> SpotifyConfig:
    section = _watcher_section(raw, "spotify", {"client_id", "redirect_port", "interval_seconds", "idle_interval_seconds"})
    client_id = section.get("client_id")
    if not isinstance(client_id, str) or not client_id.strip():
        raise ConfigError("watchers.spotify.client_id is required: the Client ID of your Spotify app")
    port = section.get("redirect_port", DEFAULT_SPOTIFY_PORT)
    # Below 1024 a regular user cannot listen.
    if not _is_int(port) or not 1024 <= port <= 65535:
        raise ConfigError("watchers.spotify.redirect_port must be an integer between 1024 and 65535")
    min_interval = DEV_MIN_SPOTIFY_INTERVAL_SECONDS if dev else MIN_SPOTIFY_INTERVAL_SECONDS
    interval = _parse_number(section, "spotify", "interval_seconds", DEFAULT_SPOTIFY_INTERVAL_SECONDS, min_interval)
    idle_interval = _parse_number(
        section, "spotify", "idle_interval_seconds", DEFAULT_SPOTIFY_IDLE_INTERVAL_SECONDS, min_interval
    )
    if idle_interval < interval:
        raise ConfigError("watchers.spotify.idle_interval_seconds must not be shorter than interval_seconds")
    return SpotifyConfig(
        client_id=client_id.strip(), redirect_port=port, interval_seconds=interval, idle_interval_seconds=idle_interval
    )


def _parse_path_list(section: dict, name: str, key: str, default: tuple[str, ...]) -> tuple[str, ...]:
    paths = section.get(key, list(default))
    if not isinstance(paths, list) or not all(isinstance(path, str) and path.strip() for path in paths):
        raise ConfigError(f"watchers.{name}.{key} must be a list of non-empty strings")
    return tuple(os.path.expanduser(path.strip()) for path in paths)


def _parse_number(
    section: dict, name: str, key: str, default: float, minimum: float, maximum: float | None = None
) -> float:
    value = section.get(key, default)
    if not _is_number(value) or not math.isfinite(value) or value < minimum or (maximum is not None and value > maximum):
        bounds = f">= {minimum}" if maximum is None else f"between {minimum} and {maximum}"
        raise ConfigError(f"watchers.{name}.{key} must be a number {bounds}")
    return float(value)


def _watcher_section(raw: object, name: str, known: set[str]) -> dict:
    if not isinstance(raw, dict):
        raise ConfigError(f"watchers.{name} must be a table")
    for key in sorted(set(raw) - known):
        log.warning("ignoring unknown config key %r in watchers.%s", key, name)
    return raw


def _parse_url(section: dict, name: str) -> str:
    url = section.get("url")
    if not isinstance(url, str) or not url.strip().startswith(("https://", "http://")):
        raise ConfigError(f"watchers.{name}.url must be an http(s) URL")
    return url.strip().rstrip("/")


def _parse_interval(section: dict, name: str, default: float, minimum: float) -> float:
    interval = section.get("interval_minutes", default)
    if not _is_number(interval) or not math.isfinite(interval) or interval < minimum:
        raise ConfigError(f"watchers.{name}.interval_minutes must be a number >= {minimum}")
    return float(interval)


def _is_int(value: object) -> bool:
    # TOML booleans are Python bools, which are ints too.
    return isinstance(value, int) and not isinstance(value, bool)


def _is_number(value: object) -> bool:
    return _is_int(value) or isinstance(value, float)
