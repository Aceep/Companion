"""Meetings from a published calendar link (ICS), for calendars outside GNOME Online Accounts.

The link usually carries its secret in the path, so it is never logged:
errors name the host only.
"""

import logging
import math
import os
from datetime import date, datetime, timedelta, timezone, tzinfo
from typing import Callable
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

from ..config import IcsConfig
from .base import Nudge, NudgeSender, StateStore, Watcher
from .http import Transport
from .icalendar import Occurrence, occurrences

log = logging.getLogger(__name__)

KIND = "agenda"
MAX_NUDGES_PER_LOOK = 2
SENT_MEMORY = timedelta(hours=48)
# All-day events are announced with her morning lines, not at midnight.
MORNING_HOUR = 7
# Event days are in the event's zone, which can be a day off from ours.
DAY_MARGIN = timedelta(days=1)
TEXT_CHARS = 60
UNTITLED = "Événement"


def local_zone() -> tzinfo:
    """The system zone with its DST rules, not just today's offset."""
    name = os.environ.get("TZ", "").lstrip(":")
    try:
        if name:
            return ZoneInfo(name)
        with open("/etc/localtime", "rb") as handle:
            return ZoneInfo.from_file(handle, key="localtime")
    except (OSError, ValueError, ZoneInfoNotFoundError):
        return datetime.now().astimezone().tzinfo or timezone.utc


class IcsWatcher(Watcher):
    name = "ics"

    def __init__(
        self,
        config: IcsConfig,
        transport: Transport,
        nudge: NudgeSender,
        state: StateStore,
        now: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        local_tz: tzinfo | None = None,
        **kwargs,
    ):
        super().__init__(config.interval_minutes * 60, None, nudge, state, **kwargs)
        self.config = config
        self._transport = transport
        self._now = now
        self._tz = local_tz or local_zone()
        # Between two looks an event must not slip by: look ahead at least one interval.
        self._lead = timedelta(minutes=max(config.warn_minutes, config.interval_minutes))

    def poll(self, token: str | None) -> list[Nudge]:
        text = self._transport.get_text(self.config.url, {})
        now = self._now()
        local_now = now.astimezone(self._tz)
        today = local_now.date()
        found = occurrences(text, today - DAY_MARGIN, (local_now + self._lead).date() + DAY_MARGIN, self._tz)
        sent = _recent(self.state.get(self.name).get("sent"), now)

        due = self._starting_soon(found, now)
        if local_now.hour >= MORNING_HOUR:
            due += _today_all_day(found, today)
        nudges = []
        for key, nudge in due:
            if len(nudges) == MAX_NUDGES_PER_LOOK:
                break
            if key in sent:
                continue
            sent[key] = now.timestamp()
            nudges.append(nudge)
        self.state.put(self.name, {"sent": sent})
        return nudges

    def _starting_soon(self, found: list[Occurrence], now: datetime) -> list[tuple[str, Nudge]]:
        soon = [
            occurrence
            for occurrence in found
            if not occurrence.all_day and now <= occurrence.start <= now + self._lead
        ]
        due = []
        for occurrence in sorted(soon, key=lambda occurrence: occurrence.start):
            minutes = max(1, math.floor((occurrence.start - now).total_seconds() / 60 + 0.5))
            text = _with_suffix(occurrence.summary, f" dans {minutes} min")
            due.append((f"{occurrence.uid}|{occurrence.start.isoformat()}", (KIND, text)))
        return due


def _today_all_day(found: list[Occurrence], today: date) -> list[tuple[str, Nudge]]:
    due = []
    for occurrence in found:
        if occurrence.all_day and occurrence.start <= today < occurrence.start + timedelta(days=occurrence.days):
            # Keyed by today: a three-day event is announced on each of its days.
            due.append((f"{occurrence.uid}|{today.isoformat()}", (KIND, _with_suffix(occurrence.summary, " aujourd'hui"))))
    return due


def _with_suffix(summary: str, suffix: str) -> str:
    # The summary is cut, never the time: that is the useful part.
    title = summary or UNTITLED
    room = TEXT_CHARS - len(suffix)
    if len(title) > room:
        title = title[: room - 1].rstrip() + "…"
    return title + suffix


def _recent(saved: object, now: datetime) -> dict[str, float]:
    if not isinstance(saved, dict):
        return {}
    oldest = (now - SENT_MEMORY).timestamp()
    return {
        key: sent_at
        for key, sent_at in saved.items()
        if isinstance(sent_at, (int, float)) and not isinstance(sent_at, bool) and sent_at >= oldest
    }
