import json
import os
import tempfile
import unittest
from datetime import datetime, timedelta, timezone
from pathlib import Path
from unittest import mock
from urllib.parse import parse_qs, urlsplit

from crepe_daemon.config import GitlabConfig, RedmineConfig
from crepe_daemon.watchers import GitlabWatcher, RedmineWatcher, StateStore, WatcherError
from crepe_daemon.watchers.base import MAX_SEEN_IDS, remember_ids

GITLAB_URL = "https://gitlab.example.com"
REDMINE_URL = "https://redmine.example.com"


class FakeTransport:
    """Answers GETs from a path -> payload table and records every call."""

    def __init__(self, routes: dict | None = None):
        self.routes = dict(routes or {})
        self.calls: list[tuple[str, dict, dict]] = []

    def get_json(self, url: str, headers: dict[str, str]) -> object:
        parts = urlsplit(url)
        query = {key: values[0] for key, values in parse_qs(parts.query).items()}
        self.calls.append((parts.path, query, dict(headers)))
        if parts.path not in self.routes:
            raise WatcherError(f"HTTP 404 from {parts.path}")
        payload = self.routes[parts.path]
        if isinstance(payload, Exception):
            raise payload
        return payload

    def paths(self) -> list[str]:
        return [path for path, _query, _headers in self.calls]

    def queries_for(self, path: str) -> list[dict]:
        return [query for called, query, _headers in self.calls if called == path]


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


def pipeline(pipeline_id: int, ref: str = "main", username: str = "alycia") -> dict:
    return {"id": pipeline_id, "ref": ref, "status": "failed", "user": {"username": username}}


def issue(issue_id: int, subject: str = "Un ticket") -> dict:
    return {"id": issue_id, "subject": subject}


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


class GitlabWatcherTest(StateDirTestCase):
    def make(self, transport, token="glpat-secret", **config):
        return GitlabWatcher(
            GitlabConfig(url=GITLAB_URL, **config),
            transport,
            lambda: token,
            self.record_nudge,
            StateStore(),
            utcnow=lambda: datetime(2026, 11, 5, 9, 0, tzinfo=timezone.utc),
        )

    def transport(self, pipelines: list[dict], projects: list[dict] | None = None) -> FakeTransport:
        return FakeTransport(
            {
                "/api/v4/user": {"username": "alycia"},
                "/api/v4/projects": projects if projects is not None else [{"id": 7, "name": "crepe"}],
                "/api/v4/projects/7/pipelines": pipelines,
            }
        )

    def test_first_tick_marks_everything_seen_and_nudges_nothing(self):
        watcher = self.make(self.transport([pipeline(3), pipeline(2)]))
        self.assertEqual(watcher.tick(), [])
        self.assertEqual(sorted(StateStore().get("gitlab")["seen_ids"]), [2, 3])

    def test_new_failed_pipeline_gives_one_nudge_with_project_and_ref(self):
        transport = self.transport([pipeline(2)])
        watcher = self.make(transport)
        watcher.tick()
        transport.routes["/api/v4/projects/7/pipelines"] = [pipeline(5, ref="feat/v1"), pipeline(2)]
        self.assertEqual(watcher.tick(), [("pipeline_echec", "crepe · feat/v1")])

    def test_several_new_pipelines_in_a_project_give_a_single_nudge(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        transport.routes["/api/v4/projects/7/pipelines"] = [pipeline(9, ref="b"), pipeline(8, ref="a")]
        self.assertEqual(watcher.tick(), [("pipeline_echec", "crepe · b")])
        self.assertEqual(watcher.tick(), [])

    def test_seen_pipeline_is_not_nudged_twice(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        transport.routes["/api/v4/projects/7/pipelines"] = [pipeline(4)]
        watcher.tick()
        self.assertEqual(watcher.tick(), [])

    def test_only_mine_filters_on_the_token_owner(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        transport.routes["/api/v4/projects/7/pipelines"] = [pipeline(6, username="someone-else")]
        self.assertEqual(watcher.tick(), [])
        self.assertEqual(transport.queries_for("/api/v4/projects/7/pipelines")[-1]["username"], "alycia")

    def test_token_owner_is_looked_up_once(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        watcher.tick()
        self.assertEqual(transport.paths().count("/api/v4/user"), 1)

    def test_only_mine_false_nudges_for_anyone(self):
        transport = self.transport([])
        watcher = self.make(transport, only_mine=False)
        watcher.tick()
        transport.routes["/api/v4/projects/7/pipelines"] = [pipeline(6, username="someone-else")]
        self.assertEqual(watcher.tick(), [("pipeline_echec", "crepe · main")])
        self.assertNotIn("/api/v4/user", transport.paths())
        self.assertNotIn("username", transport.queries_for("/api/v4/projects/7/pipelines")[-1])

    def test_token_goes_in_the_private_token_header(self):
        transport = self.transport([])
        self.make(transport).tick()
        self.assertTrue(all(headers == {"PRIVATE-TOKEN": "glpat-secret"} for _path, _query, headers in transport.calls))

    def test_member_projects_are_listed_by_activity_and_capped_at_thirty(self):
        projects = [{"id": index, "name": f"p{index}"} for index in range(1, 41)]
        transport = self.transport([], projects=projects)
        for project in projects:
            transport.routes[f"/api/v4/projects/{project['id']}/pipelines"] = []
        self.make(transport).tick()
        listing = transport.queries_for("/api/v4/projects")[0]
        self.assertEqual(listing["membership"], "true")
        self.assertEqual(listing["order_by"], "last_activity_at")
        polled = [path for path in transport.paths() if path.endswith("/pipelines")]
        self.assertEqual(len(polled), 30)

    def test_configured_projects_are_resolved_by_path(self):
        transport = self.transport([])
        transport.routes["/api/v4/projects/team%2Fcrepe"] = {"id": 7, "name": "crepe"}
        watcher = self.make(transport, projects=("team/crepe",))
        watcher.tick()
        watcher.tick()
        self.assertNotIn("/api/v4/projects", transport.paths())
        self.assertEqual(transport.paths().count("/api/v4/projects/team%2Fcrepe"), 1)

    def test_second_tick_asks_only_for_recently_updated_pipelines(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        watcher.tick()
        queries = transport.queries_for("/api/v4/projects/7/pipelines")
        self.assertNotIn("updated_after", queries[0])
        self.assertEqual(queries[1]["updated_after"], "2026-11-05T08:50:00Z")
        self.assertEqual(queries[1]["status"], "failed")

    def test_seen_ids_survive_a_restart(self):
        self.make(self.transport([pipeline(2)])).tick()
        self.assertEqual(self.make(self.transport([pipeline(2)])).tick(), [])

    def test_seen_ids_are_trimmed_to_the_most_recent_two_hundred(self):
        transport = self.transport([pipeline(index) for index in range(250, 0, -1)])
        self.make(transport).tick()
        saved = json.loads(self.state_file.read_text(encoding="utf-8"))["gitlab"]["seen_ids"]
        self.assertEqual(len(saved), MAX_SEEN_IDS)
        self.assertEqual(min(saved), 51)
        self.assertEqual(max(saved), 250)

    def test_missing_token_stays_idle_without_calls_or_errors(self):
        transport = self.transport([pipeline(2)])
        watcher = self.make(transport, token=None)
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO") as logs:
            self.assertEqual(watcher.tick(), [])
            self.assertEqual(watcher.tick(), [])
        self.assertEqual(len([line for line in logs.output if "no token" in line]), 1)
        self.assertEqual(transport.calls, [])

    def test_token_stored_later_is_picked_up(self):
        token = {"value": None}
        transport = self.transport([])
        watcher = GitlabWatcher(
            GitlabConfig(url=GITLAB_URL), transport, lambda: token["value"], self.record_nudge, StateStore()
        )
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO"):
            watcher.tick()
            token["value"] = "glpat-later"
            watcher.tick()
        self.assertIn("/api/v4/user", transport.paths())


class BackoffTest(StateDirTestCase):
    def make_running(self, transport):
        watcher = GitlabWatcher(
            GitlabConfig(url=GITLAB_URL, interval_minutes=5), transport, lambda: "token", self.record_nudge, StateStore()
        )
        scheduler = FakeScheduler()
        watcher.start(run_now, schedule=scheduler)
        return watcher, scheduler

    def test_first_look_waits_thirty_seconds(self):
        _watcher, scheduler = self.make_running(FakeTransport())
        self.assertEqual(scheduler.delays, [30])

    def test_interval_doubles_after_three_failures_and_caps_at_an_hour(self):
        _watcher, scheduler = self.make_running(FakeTransport({"/api/v4/user": WatcherError("HTTP 502")}))
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            for _ in range(7):
                scheduler.fire()
        self.assertEqual(scheduler.delays[1:], [300, 300, 600, 1200, 2400, 3600, 3600])

    def test_success_resets_the_interval(self):
        transport = FakeTransport({"/api/v4/user": WatcherError("HTTP 502")})
        watcher, scheduler = self.make_running(transport)
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            for _ in range(4):
                scheduler.fire()
        self.assertEqual(watcher.current_interval_s, 1200)
        transport.routes.update(
            {"/api/v4/user": {"username": "alycia"}, "/api/v4/projects": [{"id": 7, "name": "crepe"}],
             "/api/v4/projects/7/pipelines": []}
        )
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO"):
            scheduler.fire()
        self.assertEqual(watcher.failures, 0)
        self.assertEqual(scheduler.delays[-1], 300)

    def test_unexpected_exception_counts_as_a_failure(self):
        _watcher, scheduler = self.make_running(FakeTransport({"/api/v4/user": RuntimeError("boom")}))
        with self.assertLogs("crepe_daemon.watchers.base", level="WARNING"):
            scheduler.fire()
        self.assertEqual(scheduler.delays[-1], 300)

    def test_nudges_are_sent_from_the_completed_tick(self):
        transport = FakeTransport(
            {"/api/v4/user": {"username": "alycia"}, "/api/v4/projects": [{"id": 7, "name": "crepe"}],
             "/api/v4/projects/7/pipelines": []}
        )
        _watcher, scheduler = self.make_running(transport)
        scheduler.fire()
        transport.routes["/api/v4/projects/7/pipelines"] = [pipeline(11)]
        scheduler.fire()
        self.assertEqual(self.nudges, [("pipeline_echec", "crepe · main")])

    def test_stopped_watcher_schedules_nothing_more(self):
        watcher, scheduler = self.make_running(FakeTransport())
        watcher.stop()
        scheduler.fire()
        self.assertEqual(scheduler.delays, [30])


class RedmineWatcherTest(StateDirTestCase):
    def setUp(self):
        super().setUp()
        self.clock = {"now": datetime(2026, 11, 5, 9, 0)}

    def make(self, transport, token="redmine-key"):
        return RedmineWatcher(
            RedmineConfig(url=REDMINE_URL),
            transport,
            lambda: token,
            self.record_nudge,
            StateStore(),
            now=lambda: self.clock["now"],
        )

    def transport(self, issues: list[dict], total: int | None = None) -> FakeTransport:
        return FakeTransport({"/issues.json": {"issues": issues, "total_count": len(issues) if total is None else total}})

    def set_issues(self, transport, issues, total=None):
        transport.routes["/issues.json"] = {"issues": issues, "total_count": len(issues) if total is None else total}

    def test_first_tick_marks_seen_and_sends_only_the_count(self):
        self.assertEqual(self.make(self.transport([issue(1), issue(2)])).tick(), [("tickets_ouverts", "2")])

    def test_query_asks_for_my_open_issues_with_the_key_header(self):
        transport = self.transport([])
        self.make(transport).tick()
        path, query, headers = transport.calls[0]
        self.assertEqual(path, "/issues.json")
        self.assertEqual(
            query, {"assigned_to_id": "me", "status_id": "open", "limit": "100", "sort": "updated_on:desc"}
        )
        self.assertEqual(headers, {"X-Redmine-API-Key": "redmine-key"})

    def test_new_issue_gives_a_nudge_with_id_and_subject(self):
        transport = self.transport([issue(1)])
        watcher = self.make(transport)
        watcher.tick()
        self.set_issues(transport, [issue(42, "Corriger le calcul des congés"), issue(1)])
        self.assertEqual(
            watcher.tick(),
            [("ticket_nouveau", "#42 Corriger le calcul des congés"), ("tickets_ouverts", "2")],
        )

    def test_long_subject_is_cut_to_forty_characters(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        self.set_issues(transport, [issue(7, "x" * 60)], total=0)
        kind, text = watcher.tick()[0]
        self.assertEqual(kind, "ticket_nouveau")
        self.assertEqual(text, "#7 " + "x" * 39 + "…")

    def test_at_most_two_new_issue_nudges_per_tick_and_the_rest_marked_seen(self):
        transport = self.transport([])
        watcher = self.make(transport)
        watcher.tick()
        self.set_issues(transport, [issue(5), issue(4), issue(3)], total=0)
        new = [text for kind, text in watcher.tick() if kind == "ticket_nouveau"]
        self.assertEqual(new, ["#5 Un ticket", "#4 Un ticket"])
        self.assertEqual(watcher.tick(), [])

    def test_unchanged_count_sends_nothing(self):
        transport = self.transport([issue(1)])
        watcher = self.make(transport)
        watcher.tick()
        self.assertEqual(watcher.tick(), [])

    def test_changed_count_is_sent(self):
        transport = self.transport([issue(1), issue(2)])
        watcher = self.make(transport)
        watcher.tick()
        self.set_issues(transport, [issue(1)])
        self.assertEqual(watcher.tick(), [("tickets_ouverts", "1")])

    def test_count_uses_total_beyond_the_first_page(self):
        self.assertEqual(self.make(self.transport([issue(1)], total=130)).tick(), [("tickets_ouverts", "130")])

    def test_count_is_sent_once_a_day_at_the_first_tick_after_seven(self):
        transport = self.transport([issue(1)])
        watcher = self.make(transport)
        sent = []
        for moment in (
            datetime(2026, 11, 5, 6, 30),
            datetime(2026, 11, 5, 6, 50),
            datetime(2026, 11, 5, 7, 5),
            datetime(2026, 11, 5, 8, 0),
            datetime(2026, 11, 6, 6, 59),
            datetime(2026, 11, 6, 7, 10),
        ):
            self.clock["now"] = moment
            if watcher.tick():
                sent.append(moment)
        self.assertEqual(
            sent, [datetime(2026, 11, 5, 6, 30), datetime(2026, 11, 5, 7, 5), datetime(2026, 11, 6, 7, 10)]
        )

    def test_first_tick_after_seven_counts_as_the_morning_one(self):
        transport = self.transport([issue(1)])
        watcher = self.make(transport)
        watcher.tick()
        self.clock["now"] += timedelta(hours=1)
        self.assertEqual(watcher.tick(), [])

    def test_state_survives_a_restart(self):
        transport = self.transport([issue(1)])
        self.make(transport).tick()
        self.assertEqual(self.make(transport).tick(), [])

    def test_seen_ids_are_trimmed_to_two_hundred(self):
        transport = self.transport([issue(index) for index in range(1, 101)])
        watcher = self.make(transport)
        watcher.tick()
        for start in (101, 201):
            self.set_issues(transport, [issue(index) for index in range(start + 99, start - 1, -1)])
            watcher.tick()
        saved = json.loads(self.state_file.read_text(encoding="utf-8"))["redmine"]["seen_ids"]
        self.assertEqual(len(saved), 200)
        self.assertEqual(min(saved), 101)

    def test_missing_key_stays_idle(self):
        transport = self.transport([issue(1)])
        with self.assertLogs("crepe_daemon.watchers.base", level="INFO"):
            self.assertEqual(self.make(transport, token="").tick(), [])
        self.assertEqual(transport.calls, [])

    def test_payload_without_issues_is_a_watcher_error(self):
        with self.assertRaises(WatcherError):
            self.make(FakeTransport({"/issues.json": {"oops": True}})).tick()


class StateStoreTest(StateDirTestCase):
    def test_watchers_share_one_file_without_clobbering(self):
        StateStore().put("gitlab", {"seen_ids": [1]})
        StateStore().put("redmine", {"seen_ids": [2]})
        saved = json.loads(self.state_file.read_text(encoding="utf-8"))
        self.assertEqual(saved, {"gitlab": {"seen_ids": [1]}, "redmine": {"seen_ids": [2]}})

    def test_corrupt_file_starts_empty(self):
        self.state_file.parent.mkdir(parents=True)
        self.state_file.write_text("[1, 2")
        with self.assertLogs("crepe_daemon.memory", level="WARNING"):
            self.assertEqual(StateStore().get("gitlab"), {})

    def test_remember_ids_keeps_order_and_limit(self):
        self.assertEqual(remember_ids([1, 2, 3], [3, 4, 5], limit=4), [2, 3, 4, 5])


if __name__ == "__main__":
    unittest.main()
