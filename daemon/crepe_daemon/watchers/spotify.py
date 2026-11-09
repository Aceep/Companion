"""What she is listening to: new tracks and the end of long listening sessions, from Spotify's Web API.

Tracks only. Ads and anything of unknown type are skipped without touching the
session, so an ad between two songs does not end it. Podcast episodes are not
music: no nudge, and they count as a stop for the session.
"""

import json
import logging
import time
from dataclasses import dataclass
from typing import Callable

from .. import spotify_auth
from ..config import SpotifyConfig
from ..nudge import clip_text
from ..secrets import KeyringError
from .base import Nudge, NudgeSender, StateStore, Watcher, WatcherError
from .http import HttpResponse, Transport

log = logging.getLogger(__name__)

API_URL = "https://api.spotify.com/v1"
CURRENTLY_PLAYING_PATH = "/me/player/currently-playing"
KIND_START = "musique"
KIND_END = "musique_fin"
# A shorter listening is not worth a "you listened for" line.
MIN_SESSION_S = 20 * 60
# Nothing playing for this long: poll less often.
IDLE_AFTER_S = 10 * 60
# Renew a little early so a request never leaves with a token about to expire.
EXPIRY_MARGIN_S = 60
QUOTA_BACKOFF_S = 3600
# A Retry-After beyond a day means something else is wrong; look again then anyway.
MAX_RETRY_AFTER_S = 24 * 3600
DEFAULT_RETRY_AFTER_S = 60
TEXT_CHARS = 60


@dataclass(frozen=True)
class Track:
    track_id: str
    title: str
    artists: tuple[str, ...]


class _Throttled(Exception):
    def __init__(self, pause_s: float):
        super().__init__(f"rate limited for {round(pause_s)} s")
        self.pause_s = pause_s


class _Halted(Exception):
    """The refresh token is dead: nothing more to do until she logs in again."""


# What one reading of the player says.
_NOTHING = "nothing"
_SKIP = "skip"


class SpotifyWatcher(Watcher):
    name = "spotify"
    token_hint = "--login spotify"

    def __init__(
        self,
        config: SpotifyConfig,
        transport: Transport,
        token_lookup: Callable[[], str | None],
        token_store: Callable[[str], None],
        nudge: NudgeSender,
        state: StateStore,
        now: Callable[[], float] = time.monotonic,
        api_url: str = API_URL,
        token_url: str = spotify_auth.TOKEN_URL,
        **kwargs,
    ):
        super().__init__(config.interval_seconds, token_lookup, nudge, state, **kwargs)
        self.config = config
        self._transport = transport
        self._token_store = token_store
        self._now = now
        self._api_url = api_url
        self._token_url = token_url
        # In memory only: the access token is never written anywhere.
        self._access_token: str | None = None
        self._access_expires_at = 0.0
        self._refresh_token: str | None = None
        # The keyring value `_refresh_token` came from, to notice a new login.
        self._keyring_token: str | None = None
        self._halted = False
        self._pause_s: float | None = None
        # Like the extension's MPRIS rule, the first state seen is not news.
        self._initialized = False
        self._last_track_id: str | None = None
        self._listening_since: float | None = None
        self._idle_since: float | None = None

    @property
    def current_interval_s(self) -> float:
        if self._pause_s is not None:
            return self._pause_s
        return super().current_interval_s

    def _complete(self, outcome: object) -> None:
        if self._halted:
            return
        super()._complete(outcome)

    def poll(self, token: str) -> list[Nudge]:
        if self._halted:
            return []
        self._pause_s = None
        self._adopt_keyring_token(token)
        try:
            reading = self._read_player()
        except _Throttled as throttled:
            self._pause_s = throttled.pause_s
            log.warning("spotify: rate limited, next look in %s s", round(throttled.pause_s))
            return []
        except _Halted:
            self._halted = True
            log.error("spotify: Spotify refused the refresh token; run `--login spotify` again, then restart the daemon")
            return []
        nudges = self._follow_session(reading)
        self.interval_s = self.config.idle_interval_seconds if self._is_idle() else self.config.interval_seconds
        return nudges

    def _adopt_keyring_token(self, token: str) -> None:
        if token == self._keyring_token:
            return
        # First look, or a new `--login`: whatever access token we held belongs to the old grant.
        self._keyring_token = token
        self._refresh_token = token
        self._access_token = None

    def _read_player(self) -> Track | str:
        if self._access_token is None or self._now() >= self._access_expires_at - EXPIRY_MARGIN_S:
            self._refresh()
        response = self._get_currently_playing()
        if response.status == 401:
            # Revoked or expired earlier than announced: renew once, then insist.
            self._access_token = None
            self._refresh()
            response = self._get_currently_playing()
        return self._interpret(response)

    def _get_currently_playing(self) -> HttpResponse:
        response = self._transport.request(
            "GET", self._api_url + CURRENTLY_PLAYING_PATH, {"Authorization": f"Bearer {self._access_token}"}
        )
        if response.status == 429:
            raise _Throttled(_throttle_pause(response))
        return response

    def _interpret(self, response: HttpResponse) -> Track | str:
        if response.status == 204:
            return _NOTHING
        if response.status != 200:
            raise WatcherError(f"HTTP {response.status} from api.spotify.com{CURRENTLY_PLAYING_PATH}")
        if not response.body.strip():
            return _NOTHING
        try:
            payload = json.loads(response.body)
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise WatcherError("response from api.spotify.com is not JSON") from None
        return _reading_from(payload)

    def _refresh(self) -> None:
        try:
            grant = spotify_auth.refresh_access_token(
                self._transport, self.config.client_id, self._refresh_token, self._token_url
            )
        except spotify_auth.TokenEndpointError as error:
            if error.status == 429:
                raise _Throttled(error.retry_after_s or DEFAULT_RETRY_AFTER_S) from None
            if error.error == "invalid_grant":
                raise _Halted from None
            raise WatcherError(str(error)) from None
        self._access_token = grant.access_token
        self._access_expires_at = self._now() + grant.expires_in_s
        if grant.refresh_token and grant.refresh_token != self._refresh_token:
            self._keep_rotated_token(grant.refresh_token)

    def _keep_rotated_token(self, refresh_token: str) -> None:
        # The old one may stop working; losing the new one would force a new login.
        self._refresh_token = refresh_token
        try:
            self._token_store(refresh_token)
        except KeyringError as error:
            log.warning("spotify: cannot store the renewed token, keeping it in memory only: %s", error)
            return
        self._keyring_token = refresh_token

    def _follow_session(self, reading: Track | str) -> list[Nudge]:
        if reading == _SKIP:
            return []
        now = self._now()
        nudges: list[Nudge] = []
        if isinstance(reading, Track):
            self._idle_since = None
            if self._initialized and reading.track_id != self._last_track_id:
                nudges.append((KIND_START, clip_text(_describe(reading), TEXT_CHARS)))
            self._last_track_id = reading.track_id
            if self._listening_since is None:
                self._listening_since = now
        else:
            if self._listening_since is not None and now - self._listening_since >= MIN_SESSION_S:
                minutes = round((now - self._listening_since) / 60)
                nudges.append((KIND_END, f"{minutes} min"))
            self._listening_since = None
            if self._idle_since is None:
                self._idle_since = now
        self._initialized = True
        return nudges

    def _is_idle(self) -> bool:
        return self._idle_since is not None and self._now() - self._idle_since >= IDLE_AFTER_S


def _reading_from(payload: object) -> Track | str:
    if not isinstance(payload, dict):
        raise WatcherError("Spotify's currently-playing answer is not an object")
    kind = payload.get("currently_playing_type")
    if kind in ("ad", "unknown"):
        return _SKIP
    item = payload.get("item")
    if payload.get("is_playing") is not True or kind != "track" or not isinstance(item, dict):
        return _NOTHING
    title = item.get("name")
    if not isinstance(title, str) or not title.strip():
        return _NOTHING
    artists = tuple(
        artist["name"] for artist in item.get("artists") or [] if isinstance(artist, dict) and isinstance(artist.get("name"), str)
    )
    # Local files have no id.
    track_id = item.get("id") or item.get("uri") or title
    return Track(track_id=str(track_id), title=title, artists=artists)


def _describe(track: Track) -> str:
    return f"{track.title} — {', '.join(track.artists)}" if track.artists else track.title


def _throttle_pause(response: HttpResponse) -> float:
    if _is_quota_exceeded(response.body):
        return QUOTA_BACKOFF_S
    try:
        pause = float(response.headers["retry-after"])
    except (KeyError, ValueError):
        return DEFAULT_RETRY_AFTER_S
    return min(max(pause, 1.0), MAX_RETRY_AFTER_S)


def _is_quota_exceeded(body: bytes) -> bool:
    try:
        payload = json.loads(body)
    except (UnicodeDecodeError, json.JSONDecodeError):
        return False
    return isinstance(payload, dict) and "QUOTA_EXCEEDED" in json.dumps(payload).upper()
