import unittest
import urllib.error
from datetime import date, datetime, timedelta, timezone
from unittest import mock
from zoneinfo import ZoneInfo

from crepe_daemon.config import IcsConfig
from crepe_daemon.watchers import IcsWatcher, StateStore, WatcherError
from crepe_daemon.watchers.http import UrllibTransport
from crepe_daemon.watchers.icalendar import occurrences

from .test_watchers import StateDirTestCase

PARIS = ZoneInfo("Europe/Paris")
UTC = timezone.utc
SECRET_URL = "https://outlook.example.com/owa/calendar/abc@example.com/s3cr3t-t0ken/calendar.ics"
# Thursday 5 November 2026, 09:00 in Paris (CET, UTC+1).
NOW = datetime(2026, 11, 5, 8, 0, tzinfo=UTC)


def calendar(*events: str) -> str:
    body = "".join(events)
    return f"BEGIN:VCALENDAR\r\nVERSION:2.0\r\nPRODID:-//test//EN\r\n{body}END:VCALENDAR\r\n"


def vevent(*lines: str) -> str:
    return "BEGIN:VEVENT\r\n" + "".join(line + "\r\n" for line in lines) + "END:VEVENT\r\n"


FIXTURE = calendar(
    vevent("UID:floating", "SUMMARY:Café", "DTSTART:20261105T090500", "DTEND:20261105T091500"),
    vevent("UID:paris", "SUMMARY:Point équipe", "DTSTART;TZID=Europe/Paris:20261105T090800"),
    vevent("UID:utc", "SUMMARY:Daily US", "DTSTART:20261105T080700Z"),
    vevent("UID:holiday", "SUMMARY:Pont", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261107"),
    # Started in summer time: on 5 November it must still be 09:06 on the wall clock.
    vevent("UID:weekly", "SUMMARY:Hebdo", "DTSTART;TZID=Europe/Paris:20260903T090600", "RRULE:FREQ=WEEKLY;BYDAY=TH"),
    vevent("UID:cancelled", "SUMMARY:Annulé", "STATUS:CANCELLED", "DTSTART;TZID=Europe/Paris:20261105T090300"),
)


def starts(text: str, first_day=date(2026, 11, 4), last_day=date(2026, 11, 6)) -> dict[str, list]:
    found: dict[str, list] = {}
    for occurrence in occurrences(text, first_day, last_day, PARIS):
        found.setdefault(occurrence.uid, []).append(occurrence.start)
    return found


def utc(*parts: int) -> datetime:
    return datetime(*parts, tzinfo=UTC)


class ParserTest(unittest.TestCase):
    def test_floating_time_is_local(self):
        self.assertEqual(starts(FIXTURE)["floating"], [utc(2026, 11, 5, 8, 5)])

    def test_tzid_time_uses_that_zone(self):
        self.assertEqual(starts(FIXTURE)["paris"], [utc(2026, 11, 5, 8, 8)])

    def test_utc_time(self):
        self.assertEqual(starts(FIXTURE)["utc"], [utc(2026, 11, 5, 8, 7)])

    def test_all_day_event_is_a_date_spanning_its_days(self):
        [occurrence] = [item for item in occurrences(FIXTURE, date(2026, 11, 4), date(2026, 11, 6), PARIS) if item.uid == "holiday"]
        self.assertEqual((occurrence.start, occurrence.days, occurrence.all_day), (date(2026, 11, 5), 2, True))

    def test_weekly_repeat_keeps_wall_clock_time_across_dst(self):
        self.assertEqual(starts(FIXTURE)["weekly"], [utc(2026, 11, 5, 8, 6)])

    def test_cancelled_event_is_skipped(self):
        self.assertNotIn("cancelled", starts(FIXTURE))

    def test_windows_zone_name_from_outlook(self):
        text = calendar(vevent("UID:w", "DTSTART;TZID=Romance Standard Time:20261105T100000"))
        self.assertEqual(starts(text)["w"], [utc(2026, 11, 5, 9, 0)])

    def test_unknown_zone_falls_back_to_local_time(self):
        text = calendar(vevent("UID:z", "DTSTART;TZID=Somewhere/Odd:20261105T100000"))
        with self.assertLogs("crepe_daemon.watchers.icalendar", level="WARNING"):
            self.assertEqual(starts(text)["z"], [utc(2026, 11, 5, 9, 0)])

    def test_folded_lines_and_escapes_are_undone(self):
        text = calendar(vevent("UID:f", "SUMMARY:Revue\\, sprint", " 42\\nsalle B", "DTSTART:20261105T100000Z"))
        [occurrence] = occurrences(text, date(2026, 11, 4), date(2026, 11, 6), PARIS)
        self.assertEqual(occurrence.summary, "Revue, sprint42 salle B")

    def test_alarm_inside_an_event_does_not_override_it(self):
        text = calendar(
            vevent(
                "UID:a", "SUMMARY:Réunion", "DTSTART:20261105T100000Z",
                "BEGIN:VALARM", "SUMMARY:Rappel", "TRIGGER:-PT15M", "END:VALARM",
            )
        )
        [occurrence] = occurrences(text, date(2026, 11, 4), date(2026, 11, 6), PARIS)
        self.assertEqual(occurrence.summary, "Réunion")

    def test_daily_interval_skips_days(self):
        text = calendar(vevent("UID:d", "DTSTART:20261101T070000Z", "RRULE:FREQ=DAILY;INTERVAL=2"))
        self.assertEqual(starts(text)["d"], [utc(2026, 11, 5, 7, 0)])

    def test_count_ends_the_series(self):
        text = calendar(vevent("UID:c", "DTSTART:20261102T070000Z", "RRULE:FREQ=DAILY;COUNT=3"))
        self.assertEqual(starts(text), {"c": [utc(2026, 11, 4, 7, 0)]})

    def test_until_ends_the_series(self):
        text = calendar(vevent("UID:u", "DTSTART:20261102T070000Z", "RRULE:FREQ=DAILY;UNTIL=20261104T235959Z"))
        self.assertEqual(starts(text), {"u": [utc(2026, 11, 4, 7, 0)]})

    def test_weekly_byday_and_interval(self):
        text = calendar(vevent("UID:b", "DTSTART:20261019T070000Z", "RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=MO,TH"))
        self.assertEqual(starts(text, date(2026, 11, 1), date(2026, 11, 14))["b"], [utc(2026, 11, 2, 7, 0), utc(2026, 11, 5, 7, 0)])

    def test_exdate_removes_an_instance(self):
        text = calendar(
            vevent("UID:x", "DTSTART;TZID=Europe/Paris:20261103T090000", "RRULE:FREQ=DAILY",
                   "EXDATE;TZID=Europe/Paris:20261105T090000")
        )
        self.assertEqual(starts(text)["x"], [utc(2026, 11, 4, 8, 0), utc(2026, 11, 6, 8, 0)])

    def test_moved_instance_replaces_the_original(self):
        text = calendar(
            vevent("UID:m", "DTSTART:20261103T080000Z", "RRULE:FREQ=DAILY"),
            vevent("UID:m", "RECURRENCE-ID:20261105T080000Z", "DTSTART:20261105T130000Z"),
        )
        self.assertEqual(sorted(starts(text)["m"]), [utc(2026, 11, 4, 8, 0), utc(2026, 11, 5, 13, 0), utc(2026, 11, 6, 8, 0)])

    def test_unsupported_rule_yields_only_the_first_instance(self):
        text = calendar(vevent("UID:y", "DTSTART:20261005T070000Z", "RRULE:FREQ=MONTHLY;BYMONTHDAY=5"))
        self.assertNotIn("y", starts(text))


class FakeIcsTransport:
    def __init__(self, text: str):
        self.text = text
        self.calls: list[str] = []

    def get_text(self, url: str, headers: dict[str, str]) -> str:
        self.calls.append(url)
        if isinstance(self.text, Exception):
            raise self.text
        return self.text


class IcsWatcherTest(StateDirTestCase):
    def setUp(self):
        super().setUp()
        self.clock = {"now": NOW}

    def make(self, text: str, interval_minutes: float = 15, warn_minutes: float = 10) -> IcsWatcher:
        self.transport = FakeIcsTransport(text)
        return IcsWatcher(
            IcsConfig(url=SECRET_URL, interval_minutes=interval_minutes, warn_minutes=warn_minutes),
            self.transport,
            self.record_nudge,
            StateStore(),
            now=lambda: self.clock["now"],
            local_tz=PARIS,
        )

    def event_in(self, minutes: int, summary: str, uid: str | None = None) -> str:
        start = (self.clock["now"] + timedelta(minutes=minutes)).strftime("%Y%m%dT%H%M%SZ")
        return vevent(f"UID:{uid or summary}", f"SUMMARY:{summary}", f"DTSTART:{start}")

    def test_event_starting_soon_nudges_with_minutes(self):
        self.assertEqual(self.make(calendar(self.event_in(5, "Point équipe"))).tick(), [("agenda", "Point équipe dans 5 min")])

    def test_lead_covers_one_interval_so_nothing_slips_between_looks(self):
        watcher = self.make(calendar(self.event_in(12, "Rétro"), self.event_in(20, "Plus tard")))
        self.assertEqual(watcher.tick(), [("agenda", "Rétro dans 12 min")])

    def test_event_is_nudged_once(self):
        watcher = self.make(calendar(self.event_in(5, "Point")))
        watcher.tick()
        self.clock["now"] += timedelta(minutes=2)
        self.assertEqual(watcher.tick(), [])

    def test_past_event_is_not_nudged(self):
        self.assertEqual(self.make(calendar(self.event_in(-1, "Déjà"))).tick(), [])

    def test_at_most_two_per_look_soonest_first(self):
        watcher = self.make(calendar(self.event_in(9, "C"), self.event_in(3, "A"), self.event_in(6, "B")))
        self.assertEqual([text for _kind, text in watcher.tick()], ["A dans 3 min", "B dans 6 min"])
        self.assertEqual([text for _kind, text in watcher.tick()], ["C dans 9 min"])

    def test_all_day_event_is_announced_once_that_day(self):
        watcher = self.make(calendar(vevent("UID:h", "SUMMARY:Pont", "DTSTART;VALUE=DATE:20261105")))
        self.assertEqual(watcher.tick(), [("agenda", "Pont aujourd'hui")])
        self.clock["now"] += timedelta(hours=3)
        self.assertEqual(watcher.tick(), [])

    def test_all_day_event_waits_for_the_morning(self):
        self.clock["now"] = datetime(2026, 11, 5, 5, 0, tzinfo=UTC)
        watcher = self.make(calendar(vevent("UID:h", "SUMMARY:Pont", "DTSTART;VALUE=DATE:20261105")))
        self.assertEqual(watcher.tick(), [])

    def test_multi_day_event_is_announced_each_day(self):
        watcher = self.make(calendar(vevent("UID:h", "SUMMARY:Salon", "DTSTART;VALUE=DATE:20261105", "DTEND;VALUE=DATE:20261107")))
        watcher.tick()
        self.clock["now"] += timedelta(days=1)
        self.assertEqual(watcher.tick(), [("agenda", "Salon aujourd'hui")])

    def test_long_all_day_event_started_days_ago_is_announced(self):
        watcher = self.make(calendar(vevent("UID:h", "SUMMARY:Congés", "DTSTART;VALUE=DATE:20261101", "DTEND;VALUE=DATE:20261110")))
        self.assertEqual(watcher.tick(), [("agenda", "Congés aujourd'hui")])

    def test_sent_events_are_forgotten_after_two_days(self):
        watcher = self.make(calendar(self.event_in(5, "Point")))
        watcher.tick()
        self.transport.text = calendar()
        self.clock["now"] += timedelta(hours=49)
        watcher.tick()
        self.assertEqual(StateStore().get("ics")["sent"], {})

    def test_long_summary_is_cut_but_keeps_the_time(self):
        [(_kind, text)] = self.make(calendar(self.event_in(5, "R" * 80))).tick()
        self.assertEqual(len(text), 60)
        self.assertTrue(text.endswith("… dans 5 min"))

    def test_fetch_failure_is_a_watcher_error(self):
        watcher = self.make(WatcherError("HTTP 503 from outlook.example.com"))
        with self.assertRaises(WatcherError):
            watcher.tick()


class SecretUrlTest(unittest.TestCase):
    def test_http_error_names_the_host_only(self):
        transport = UrllibTransport()
        error = urllib.error.HTTPError(SECRET_URL, 404, "Not Found", {}, None)
        with mock.patch.object(transport._opener, "open", side_effect=error):
            with self.assertRaises(WatcherError) as raised:
                transport.get_text(SECRET_URL, {})
        self.assertEqual(str(raised.exception), "HTTP 404 from outlook.example.com")

    def test_bad_url_error_does_not_quote_the_url(self):
        transport = UrllibTransport()
        with mock.patch.object(transport._opener, "open", side_effect=ValueError(f"bad {SECRET_URL}")):
            with self.assertRaises(WatcherError) as raised:
                transport.get_text(SECRET_URL, {})
        self.assertNotIn("s3cr3t", str(raised.exception))

    def test_config_repr_hides_the_url(self):
        self.assertNotIn("s3cr3t", repr(IcsConfig(url=SECRET_URL)))


if __name__ == "__main__":
    unittest.main()
