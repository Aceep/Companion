import io
import json
import os
import tempfile
import unittest
import urllib.error
from pathlib import Path
from unittest import mock

from crepe_daemon.watchers import StateStore, Watcher, WatcherError
from crepe_daemon.watchers.http import MAX_RESPONSE_BYTES, UrllibTransport


class StubWatcher(Watcher):
    """Polls nothing: each look returns, or raises, the next scripted outcome and records the token it got."""

    name = "stub"
    token_hint = "--set-token stub"

    def __init__(self, outcomes: list, token_lookup=None, nudge=lambda kind, text: None, interval_s: float = 300):
        super().__init__(interval_s, token_lookup, nudge, StateStore())
        self.outcomes = list(outcomes)
        self.tokens: list[str | None] = []

    def poll(self, token):
        self.tokens.append(token)
        outcome = self.outcomes.pop(0) if self.outcomes else []
        if isinstance(outcome, Exception):
            raise outcome
        return outcome


class FakeScheduler:
    """Collects timers instead of arming them; fire() runs the next one."""

    def __init__(self):
        self.delays: list[float] = []
        self._pending = []

    def __call__(self, delay_s, callback):
        self.delays.append(delay_s)
        self._pending.append(callback)

    def fire(self):
        self._pending.pop(0)()


def run_now(work, on_done):
    on_done(work())


class StateDirTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = mock.patch.dict(os.environ, {"XDG_STATE_HOME": directory.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state_file = Path(directory.name) / "crepe" / "watchers.json"
        self.nudges: list[tuple[str, str]] = []

    def record_nudge(self, kind: str, text: str) -> None:
        self.nudges.append((kind, text))


class TokenCheckTest(StateDirTestCase):
    def test_missing_token_stays_idle_without_polls_or_errors(self):
        watcher = StubWatcher([[("x", "y")]], token_lookup=lambda: None)
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO") as logs:
            self.assertEqual(watcher.tick(), [])
            self.assertEqual(watcher.tick(), [])
        self.assertEqual(len([line for line in logs.output if "no token" in line]), 1)
        self.assertEqual(watcher.tokens, [])

    def test_empty_token_counts_as_missing(self):
        watcher = StubWatcher([], token_lookup=lambda: "")
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO"):
            self.assertEqual(watcher.tick(), [])
        self.assertEqual(watcher.tokens, [])

    def test_token_stored_later_is_picked_up(self):
        token = {"value": None}
        watcher = StubWatcher([], token_lookup=lambda: token["value"])
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO"):
            watcher.tick()
            token["value"] = "stored-later"
            watcher.tick()
        self.assertEqual(watcher.tokens, ["stored-later"])

    def test_watcher_without_token_lookup_polls_with_none(self):
        watcher = StubWatcher([])
        watcher.tick()
        self.assertEqual(watcher.tokens, [None])


class BackoffTest(StateDirTestCase):
    def make_running(self, outcomes: list):
        watcher = StubWatcher(outcomes, nudge=self.record_nudge)
        scheduler = FakeScheduler()
        watcher.start(run_now, schedule=scheduler)
        return watcher, scheduler

    def failing_then_recording_nudge(self, kind: str, text: str) -> None:
        if text == "a":
            raise RuntimeError("bus gone")
        self.record_nudge(kind, text)

    def test_first_look_waits_thirty_seconds(self):
        _watcher, scheduler = self.make_running([])
        self.assertEqual(scheduler.delays, [30])

    def test_interval_doubles_after_three_failures_and_caps_at_an_hour(self):
        _watcher, scheduler = self.make_running([WatcherError("HTTP 502") for _ in range(7)])
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            for _ in range(7):
                scheduler.fire()
        self.assertEqual(scheduler.delays[1:], [300, 300, 600, 1200, 2400, 3600, 3600])

    def test_success_resets_the_interval(self):
        watcher, scheduler = self.make_running([WatcherError("HTTP 502") for _ in range(4)] + [[]])
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            for _ in range(4):
                scheduler.fire()
        self.assertEqual(watcher.current_interval_s, 1200)
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO"):
            scheduler.fire()
        self.assertEqual(watcher.failures, 0)
        self.assertEqual(scheduler.delays[-1], 300)

    def test_unexpected_exception_counts_as_a_failure(self):
        watcher, scheduler = self.make_running([RuntimeError("boom")])
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            scheduler.fire()
        self.assertEqual(watcher.failures, 1)
        self.assertEqual(scheduler.delays[-1], 300)

    def test_nudges_are_sent_from_the_completed_tick(self):
        _watcher, scheduler = self.make_running([[], [("agenda", "Point dans 5 min")]])
        scheduler.fire()
        scheduler.fire()
        self.assertEqual(self.nudges, [("agenda", "Point dans 5 min")])

    def test_raising_sender_does_not_stop_the_watcher(self):
        watcher = StubWatcher([[("agenda", "a")], [("agenda", "b")]], nudge=self.failing_then_recording_nudge)
        scheduler = FakeScheduler()
        watcher.start(run_now, schedule=scheduler)
        with self.assertLogs("crepe_daemon.watchers.base", level="ERROR"):
            scheduler.fire()
        scheduler.fire()
        self.assertEqual(scheduler.delays, [30, 300, 300])
        self.assertEqual(self.nudges, [("agenda", "b")])

    def test_stopped_watcher_schedules_nothing_more(self):
        watcher, scheduler = self.make_running([])
        watcher.stop()
        scheduler.fire()
        self.assertEqual(scheduler.delays, [30])


class UrllibTransportTest(unittest.TestCase):
    URL = "https://api.example.com/v1/thing"

    def answer(self, body: bytes):
        response = mock.MagicMock()
        response.__enter__.return_value = response
        response.status = 200
        response.headers = {}
        response.read.side_effect = lambda limit: body[:limit]
        return response

    def test_request_refuses_a_body_over_the_cap(self):
        transport = UrllibTransport()
        with mock.patch.object(transport._opener, "open", return_value=self.answer(b"x" * (MAX_RESPONSE_BYTES + 1))):
            with self.assertRaisesRegex(WatcherError, "response from api.example.com/v1/thing is too large"):
                transport.request("GET", self.URL, {})

    def test_request_keeps_a_body_at_the_cap(self):
        transport = UrllibTransport()
        with mock.patch.object(transport._opener, "open", return_value=self.answer(b"x" * MAX_RESPONSE_BYTES)):
            self.assertEqual(len(transport.request("GET", self.URL, {}).body), MAX_RESPONSE_BYTES)

    def test_request_refuses_an_error_body_over_the_cap(self):
        transport = UrllibTransport()
        body = io.BytesIO(b"x" * (MAX_RESPONSE_BYTES + 1))
        error = urllib.error.HTTPError(self.URL, 500, "Server Error", {}, body)
        with mock.patch.object(transport._opener, "open", side_effect=error):
            with self.assertRaisesRegex(WatcherError, "too large"):
                transport.request("GET", self.URL, {})

    def test_get_text_refuses_a_body_over_the_cap(self):
        transport = UrllibTransport()
        with mock.patch.object(transport._opener, "open", return_value=self.answer(b"x" * (MAX_RESPONSE_BYTES + 1))):
            with self.assertRaisesRegex(WatcherError, "response from api.example.com is too large"):
                transport.get_text(self.URL, {})


class StateStoreTest(StateDirTestCase):
    def test_watchers_share_one_file_without_clobbering(self):
        StateStore().put("git", {"repos": {"a": 1}})
        StateStore().put("ics", {"announced": {"b": 2}})
        saved = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(saved, {"git": {"repos": {"a": 1}}, "ics": {"announced": {"b": 2}}})

    def test_corrupt_file_starts_empty(self):
        self.state_file.parent.mkdir(parents=True)
        self.state_file.write_text("[1, 2")
        with self.assertLogs("crepe_daemon.memory", level="WARNING"):
            self.assertEqual(StateStore().get("git"), {})


if __name__ == "__main__":
    unittest.main()
