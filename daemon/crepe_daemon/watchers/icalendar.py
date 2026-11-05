"""Just enough of RFC 5545 to know what starts soon: VEVENTs and simple daily or weekly repeats.

Supported: folded lines; DTSTART/DTEND as UTC (`Z`), with `TZID=` (IANA
names, plus the usual Windows names Outlook writes), floating (local time)
or all-day (`VALUE=DATE`); SUMMARY; STATUS:CANCELLED (skipped); EXDATE;
moved instances (RECURRENCE-ID); RRULE with FREQ=DAILY or WEEKLY and
INTERVAL, COUNT, UNTIL, plain BYDAY (MO, TU...) and WKST. Any other rule
(MONTHLY, YEARLY, BYMONTH, BYSETPOS, BYDAY=1MO...) yields the first
instance only. VTIMEZONE blocks are ignored: zones come from the system
tz database.
"""

import logging
import re
from dataclasses import dataclass
from datetime import date, datetime, timedelta, timezone, tzinfo
from zoneinfo import ZoneInfo, ZoneInfoNotFoundError

log = logging.getLogger(__name__)

SUPPORTED_RULE_KEYS = {"FREQ", "INTERVAL", "COUNT", "UNTIL", "BYDAY", "WKST"}
WEEKDAYS = {"MO": 0, "TU": 1, "WE": 2, "TH": 3, "FR": 4, "SA": 5, "SU": 6}
# A COUNT-bounded rule has to be walked from its start; past this it is ignored.
MAX_EXPANSION_DAYS = 366 * 30
# What Outlook and Exchange write in TZID, for the zones its users are likely in.
WINDOWS_ZONES = {
    "Romance Standard Time": "Europe/Paris",
    "W. Europe Standard Time": "Europe/Berlin",
    "Central Europe Standard Time": "Europe/Budapest",
    "Central European Standard Time": "Europe/Warsaw",
    "GMT Standard Time": "Europe/London",
    "Greenwich Standard Time": "Atlantic/Reykjavik",
    "UTC": "UTC",
    "Eastern Standard Time": "America/New_York",
    "Central Standard Time": "America/Chicago",
    "Mountain Standard Time": "America/Denver",
    "Pacific Standard Time": "America/Los_Angeles",
    "E. Europe Standard Time": "Europe/Chisinau",
    "FLE Standard Time": "Europe/Kiev",
    "GTB Standard Time": "Europe/Bucharest",
    "Morocco Standard Time": "Africa/Casablanca",
    "Reunion Standard Time": "Indian/Reunion",
}

_ESCAPES = re.compile(r"\\([\\;,nN])")
_unknown_zones_reported: set[str] = set()

When = datetime | date


@dataclass(frozen=True)
class Occurrence:
    uid: str
    summary: str
    # Aware datetime for a timed event, a date for an all-day one.
    start: When
    # How many days an all-day occurrence covers; 0 for a timed one.
    days: int = 0

    @property
    def all_day(self) -> bool:
        return not isinstance(self.start, datetime)


@dataclass
class _Property:
    name: str
    params: dict[str, str]
    value: str


def occurrences(text: str, first_day: date, last_day: date, local_tz: tzinfo) -> list[Occurrence]:
    """Every non-cancelled occurrence whose day falls in [first_day, last_day], days taken in the event's zone."""
    events = [event for event in _vevents(_unfold(text)) if _first(event, "STATUS", "").upper() != "CANCELLED"]
    moved = _moved_instances(events, local_tz)
    found = []
    for event in events:
        found.extend(_event_occurrences(event, first_day, last_day, local_tz, moved))
    return found


def _unfold(text: str) -> list[str]:
    lines: list[str] = []
    for raw in text.replace("\r\n", "\n").replace("\r", "\n").split("\n"):
        if raw[:1] in (" ", "\t") and lines:
            lines[-1] += raw[1:]
        elif raw:
            lines.append(raw)
    return lines


def _vevents(lines: list[str]) -> list[list[_Property]]:
    events = []
    current: list[_Property] | None = None
    # VALARM and other components nested in a VEVENT have their own DTSTART and SUMMARY.
    nested = 0
    for line in lines:
        prop = _parse_line(line)
        if prop is None:
            continue
        if prop.name == "BEGIN":
            if prop.value.upper() == "VEVENT" and current is None:
                current = []
            elif current is not None:
                nested += 1
        elif prop.name == "END":
            if current is not None and nested:
                nested -= 1
            elif current is not None and prop.value.upper() == "VEVENT":
                events.append(current)
                current = None
        elif current is not None and not nested:
            current.append(prop)
    return events


def _parse_line(line: str) -> _Property | None:
    in_quotes = False
    for index, char in enumerate(line):
        if char == '"':
            in_quotes = not in_quotes
        elif char == ":" and not in_quotes:
            head, value = line[:index], line[index + 1 :]
            break
    else:
        return None
    name, *raw_params = _split_unquoted(head, ";")
    params = {}
    for raw in raw_params:
        key, _, param_value = raw.partition("=")
        params[key.upper()] = param_value.strip('"')
    return _Property(name.upper(), params, value)


def _split_unquoted(text: str, separator: str) -> list[str]:
    parts, current, in_quotes = [], [], False
    for char in text:
        if char == '"':
            in_quotes = not in_quotes
        if char == separator and not in_quotes:
            parts.append("".join(current))
            current = []
        else:
            current.append(char)
    parts.append("".join(current))
    return parts


def _first(event: list[_Property], name: str, default: str) -> str:
    for prop in event:
        if prop.name == name:
            return prop.value
    return default


def _first_prop(event: list[_Property], name: str) -> _Property | None:
    return next((prop for prop in event if prop.name == name), None)


def _uid(event: list[_Property]) -> str:
    return _first(event, "UID", "") or f"{_first(event, 'SUMMARY', '')}@{_first(event, 'DTSTART', '')}"


def _summary(event: list[_Property]) -> str:
    raw = _first(event, "SUMMARY", "")
    text = _ESCAPES.sub(lambda match: " " if match.group(1) in "nN" else match.group(1), raw)
    return " ".join(text.split())


def _moved_instances(events: list[list[_Property]], local_tz: tzinfo) -> set[tuple[str, When]]:
    # A moved instance replaces the one its series would have produced at RECURRENCE-ID.
    moved = set()
    for event in events:
        recurrence_id = _first_prop(event, "RECURRENCE-ID")
        when = _parse_when(recurrence_id, local_tz) if recurrence_id else None
        if when is not None:
            moved.add((_uid(event), when))
    return moved


def _event_occurrences(
    event: list[_Property], first_day: date, last_day: date, local_tz: tzinfo, moved: set[tuple[str, When]]
) -> list[Occurrence]:
    start_prop = _first_prop(event, "DTSTART")
    start = _parse_when(start_prop, local_tz) if start_prop else None
    if start is None:
        return []
    uid, summary = _uid(event), _summary(event)
    days = _all_day_span(event, start, local_tz)
    rule = _parse_rule(_first(event, "RRULE", "")) if not _first_prop(event, "RECURRENCE-ID") else None
    if rule is None:
        # A long all-day event that began before the window still covers part of it.
        covered_until = _day(start) + timedelta(days=max(days, 1))
        instances = [start] if _day(start) <= last_day and covered_until > first_day else []
    else:
        excluded = _excluded(event, local_tz) | {when for moved_uid, when in moved if moved_uid == uid}
        instances = [when for when in _expand(start, rule, first_day, last_day, local_tz) if when not in excluded]
    return [Occurrence(uid, summary, when, days) for when in instances]


def _all_day_span(event: list[_Property], start: When, local_tz: tzinfo) -> int:
    if isinstance(start, datetime):
        return 0
    end_prop = _first_prop(event, "DTEND")
    end = _parse_when(end_prop, local_tz) if end_prop else None
    if isinstance(end, date) and not isinstance(end, datetime) and end > start:
        return (end - start).days
    return 1


def _excluded(event: list[_Property], local_tz: tzinfo) -> set[When]:
    excluded = set()
    for prop in event:
        if prop.name != "EXDATE":
            continue
        for value in prop.value.split(","):
            when = _parse_when(_Property(prop.name, prop.params, value.strip()), local_tz)
            if when is not None:
                excluded.add(when)
    return excluded


def _parse_when(prop: _Property, local_tz: tzinfo) -> When | None:
    value = prop.value.strip()
    try:
        if prop.params.get("VALUE", "").upper() == "DATE" or len(value) == 8:
            return datetime.strptime(value, "%Y%m%d").date()
        if value.endswith("Z"):
            return datetime.strptime(value[:-1], "%Y%m%dT%H%M%S").replace(tzinfo=timezone.utc)
        naive = datetime.strptime(value, "%Y%m%dT%H%M%S")
    except ValueError:
        return None
    zone = _zone(prop.params["TZID"], local_tz) if "TZID" in prop.params else local_tz
    return naive.replace(tzinfo=zone)


def _zone(tzid: str, local_tz: tzinfo) -> tzinfo:
    name = WINDOWS_ZONES.get(tzid, tzid)
    try:
        return ZoneInfo(name)
    except (ZoneInfoNotFoundError, ValueError):
        if tzid not in _unknown_zones_reported:
            _unknown_zones_reported.add(tzid)
            log.warning("ics: unknown time zone %r, using local time", tzid)
        return local_tz


@dataclass(frozen=True)
class _Rule:
    freq: str
    interval: int
    count: int | None
    until: When | None
    weekdays: frozenset[int]
    week_start: int


def _parse_rule(text: str) -> _Rule | None:
    """A DAILY or WEEKLY rule we can expand, else None (the event then counts once)."""
    if not text:
        return None
    parts = dict(part.partition("=")[::2] for part in text.upper().split(";") if part)
    if set(parts) - SUPPORTED_RULE_KEYS or parts.get("FREQ") not in ("DAILY", "WEEKLY"):
        return None
    byday = [day for day in parts.get("BYDAY", "").split(",") if day]
    if any(day not in WEEKDAYS for day in byday) or parts.get("WKST", "MO") not in WEEKDAYS:
        return None
    try:
        interval = int(parts.get("INTERVAL", "1"))
        count = int(parts["COUNT"]) if "COUNT" in parts else None
    except ValueError:
        return None
    if interval < 1 or (count is not None and count < 1):
        return None
    until = _parse_when(_Property("UNTIL", {}, parts["UNTIL"]), timezone.utc) if "UNTIL" in parts else None
    if "UNTIL" in parts and until is None:
        return None
    return _Rule(
        freq=parts["FREQ"],
        interval=interval,
        count=count,
        until=until,
        weekdays=frozenset(WEEKDAYS[day] for day in byday),
        week_start=WEEKDAYS[parts.get("WKST", "MO")],
    )


def _expand(start: When, rule: _Rule, first_day: date, last_day: date, local_tz: tzinfo) -> list[When]:
    start_day = _day(start)
    weekdays = rule.weekdays or (frozenset({start_day.weekday()}) if rule.freq == "WEEKLY" else frozenset())
    # Without COUNT every day can be tested on its own, so start near the window.
    day = start_day if rule.count is not None else max(start_day, first_day)
    produced = 0
    found = []
    for _ in range(MAX_EXPANSION_DAYS):
        if day > last_day:
            break
        if _matches(day, start_day, rule, weekdays):
            when = _at(day, start)
            if _after_until(when, rule.until, local_tz):
                break
            produced += 1
            if rule.count is not None and produced > rule.count:
                break
            if day >= first_day:
                found.append(when)
        day += timedelta(days=1)
    return found


def _matches(day: date, start_day: date, rule: _Rule, weekdays: frozenset[int]) -> bool:
    if weekdays and day.weekday() not in weekdays:
        return False
    if rule.freq == "DAILY":
        return (day - start_day).days % rule.interval == 0
    first_week = start_day - timedelta(days=(start_day.weekday() - rule.week_start) % 7)
    return ((day - first_week).days // 7) % rule.interval == 0


def _at(day: date, start: When) -> When:
    if not isinstance(start, datetime):
        return day
    # Same wall-clock time in the event's zone, so DST changes keep 10:00 at 10:00.
    return datetime.combine(day, start.time(), tzinfo=start.tzinfo)


def _after_until(when: When, until: When | None, local_tz: tzinfo) -> bool:
    if until is None:
        return False
    if not isinstance(until, datetime):
        return _day(when) > until
    if not isinstance(when, datetime):
        return when > until.astimezone(local_tz).date()
    return when > until


def _day(when: When) -> date:
    return when.date() if isinstance(when, datetime) else when
