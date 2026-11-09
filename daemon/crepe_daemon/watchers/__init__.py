"""Watchers: look at local repos, the machine, a calendar and Spotify now and then, and nudge her."""

from .. import secrets as keyring
from ..config import Config
from .base import FIRST_DELAY_S, NudgeSender, StateStore, Watcher, WatcherError, WatcherPool
from .git import GitWatcher
from .http import Transport, UrllibTransport
from .ics import IcsWatcher
from .machine import MachineWatcher
from .spotify import SpotifyWatcher

__all__ = [
    "GitWatcher",
    "IcsWatcher",
    "MachineWatcher",
    "SpotifyWatcher",
    "StateStore",
    "Watcher",
    "WatcherError",
    "WatcherPool",
    "build_watchers",
]


def build_watchers(
    config: Config,
    nudge: NudgeSender,
    state: StateStore | None = None,
    transport: Transport | None = None,
    dev: bool = False,
) -> WatcherPool:
    """One watcher per config section present. In dev mode the first look waits at most one interval instead of 30 s."""
    state = state or StateStore()
    transport = transport or UrllibTransport()
    watchers: list[Watcher] = []
    if config.git is not None:
        watchers.append(
            GitWatcher(config.git, nudge, state, first_delay_s=_first_delay(config.git.interval_minutes, dev))
        )
    if config.machine is not None:
        watchers.append(
            MachineWatcher(config.machine, nudge, state, first_delay_s=_first_delay(config.machine.interval_minutes, dev))
        )
    if config.ics is not None:
        watchers.append(
            IcsWatcher(config.ics, transport, nudge, state, first_delay_s=_first_delay(config.ics.interval_minutes, dev))
        )
    if config.spotify is not None:
        watchers.append(
            SpotifyWatcher(
                config.spotify,
                transport,
                lambda: keyring.lookup_token("spotify"),
                lambda token: keyring.store_token("spotify", token),
                nudge,
                state,
                first_delay_s=_first_delay(config.spotify.interval_seconds / 60, dev),
            )
        )
    return WatcherPool(watchers)


def _first_delay(interval_minutes: float, dev: bool) -> float:
    return min(FIRST_DELAY_S, interval_minutes * 60) if dev else FIRST_DELAY_S
