"""What every watcher shares: the timer, the backoff, the token check and the saved state."""

import copy
import logging
import threading
from concurrent.futures import CancelledError, Future, ThreadPoolExecutor
from pathlib import Path
from typing import Callable, TypeVar

from gi.repository import GLib

from ..memory import atomic_write_json, default_state_dir, read_json

log = logging.getLogger(__name__)

# Login is busy enough: the first look waits a little.
FIRST_DELAY_S = 30
# Past this many failures in a row, every further failure doubles the interval.
FAILURES_BEFORE_BACKOFF = 3
MAX_BACKOFF_INTERVAL_S = 3600

Result = TypeVar("Result")
Nudge = tuple[str, str]
NudgeSender = Callable[[str, str], None]
TokenLookup = Callable[[], str | None]
# run_in_worker(work, on_done): runs work off the main loop, then on_done(result) on it.
WorkerRunner = Callable[[Callable[[], object], Callable[[object], None]], None]
# schedule(delay_s, callback): calls callback once on the main loop after delay_s.
Scheduler = Callable[[float, Callable[[], None]], None]


class WatcherError(Exception):
    """An expected failure (network, HTTP status, odd payload). The message is safe to log."""


class StateStore:
    """Per-watcher state in one JSON file, rewritten atomically on every change."""

    def __init__(self, state_dir: Path | None = None):
        self.path = (state_dir or default_state_dir()) / "watchers.json"
        self._lock = threading.Lock()
        data = read_json(self.path)
        self._data = data if isinstance(data, dict) else {}

    def get(self, name: str) -> dict:
        with self._lock:
            section = self._data.get(name)
            return copy.deepcopy(section) if isinstance(section, dict) else {}

    def put(self, name: str, section: dict) -> None:
        with self._lock:
            self._data[name] = copy.deepcopy(section)
            atomic_write_json(self.path, self._data)


def schedule_with_glib(delay_s: float, callback: Callable[[], None]) -> None:
    def fire() -> bool:
        callback()
        return GLib.SOURCE_REMOVE

    GLib.timeout_add_seconds(max(1, round(delay_s)), fire)


def run_in_executor(
    executor: ThreadPoolExecutor,
    work: Callable[[], Result],
    on_done: Callable[[Result], None],
    on_failure: Callable[[Exception], Result],
) -> None:
    """Run `work` on `executor`, then `on_done(result)` on the main loop.

    When `work` raises, the error is logged with its stack and `on_done`
    gets `on_failure(error)` instead. Work cancelled by an executor shutdown
    calls nothing: the daemon is stopping, that is no failure.
    """

    def finish(future: Future) -> None:
        try:
            result = future.result()
        except CancelledError:
            return
        except Exception as error:
            log.exception("worker task failed")
            result = on_failure(error)
        GLib.idle_add(_call_once, on_done, result)

    executor.submit(work).add_done_callback(finish)


class Watcher:
    """Polls something every `interval_s` and returns nudges to send.

    Subclasses implement `poll(token)`, which runs in a worker thread (HTTP
    calls block) and returns the nudges to send. The base class looks the
    token up before each poll, sends the nudges from the main loop, and
    backs off when polls keep failing. A watcher built with
    `token_lookup=None` needs no token and polls with `None`.
    """

    name = "watcher"
    token_hint = ""

    def __init__(
        self,
        interval_s: float,
        token_lookup: TokenLookup | None,
        nudge: NudgeSender,
        state: StateStore,
        first_delay_s: float = FIRST_DELAY_S,
    ):
        self.interval_s = interval_s
        self.first_delay_s = first_delay_s
        self.state = state
        self._token_lookup = token_lookup
        self._nudge = nudge
        self._failures = 0
        self._idle_reported = False
        self._stopped = False
        self._run_in_worker: WorkerRunner | None = None
        self._schedule: Scheduler = schedule_with_glib

    @property
    def failures(self) -> int:
        return self._failures

    @property
    def current_interval_s(self) -> float:
        if self._failures < FAILURES_BEFORE_BACKOFF:
            return self.interval_s
        doubled = self.interval_s * 2 ** (self._failures - FAILURES_BEFORE_BACKOFF + 1)
        return min(doubled, max(self.interval_s, MAX_BACKOFF_INTERVAL_S))

    def start(self, run_in_worker: WorkerRunner, schedule: Scheduler = schedule_with_glib) -> None:
        self._run_in_worker = run_in_worker
        self._schedule = schedule
        self._stopped = False
        log.info("%s: watching every %s s, first look in %s s", self.name, round(self.interval_s), round(self.first_delay_s))
        self._schedule(self.first_delay_s, self._on_timer)

    def stop(self) -> None:
        self._stopped = True

    def tick(self) -> list[Nudge]:
        """One look, in the calling thread. Raises on failure."""
        if self._token_lookup is None:
            return self.poll(None)
        token = self._token_lookup()
        if not token:
            if not self._idle_reported:
                self._idle_reported = True
                log.info("%s: no token, idle until one is stored (%s)", self.name, self.token_hint)
            return []
        if self._idle_reported:
            self._idle_reported = False
            log.info("%s: token found, watching", self.name)
        return self.poll(token)

    def poll(self, token: str | None) -> list[Nudge]:
        raise NotImplementedError

    def _on_timer(self) -> None:
        if self._stopped or self._run_in_worker is None:
            return
        self._run_in_worker(self._guarded_tick, self._complete)

    def _guarded_tick(self) -> list[Nudge] | Exception:
        try:
            return self.tick()
        except WatcherError as error:
            return error
        except Exception as error:
            log.exception("%s: unexpected failure", self.name)
            return error

    def _complete(self, outcome: object) -> None:
        if self._stopped:
            return
        if isinstance(outcome, Exception):
            self._failures += 1
            log.warning(
                "%s: look failed (%d in a row), next in %s s: %s",
                self.name,
                self._failures,
                round(self.current_interval_s),
                outcome,
            )
        else:
            if self._failures:
                log.info("%s: back to normal after %d failures", self.name, self._failures)
            self._failures = 0
            for kind, text in outcome:
                self._nudge(kind, text)
        self._schedule(self.current_interval_s, self._on_timer)


class WatcherPool:
    """The configured watchers and the one worker thread they share.

    The brain has its own worker, so a slow server never delays a reply.
    """

    def __init__(self, watchers: list[Watcher]):
        self.watchers = list(watchers)
        self._executor: ThreadPoolExecutor | None = None

    @property
    def names(self) -> list[str]:
        return [watcher.name for watcher in self.watchers]

    def start(self) -> None:
        if not self.watchers:
            return
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="watchers")
        for watcher in self.watchers:
            watcher.start(self._run_in_worker)

    def stop(self) -> None:
        for watcher in self.watchers:
            watcher.stop()
        if self._executor is not None:
            self._executor.shutdown(wait=False, cancel_futures=True)

    def _run_in_worker(self, work: Callable[[], object], on_done: Callable[[object], None]) -> None:
        assert self._executor is not None
        # A failed look comes back as its exception, which counts as a failure.
        run_in_executor(self._executor, work, on_done, on_failure=lambda error: error)


def _call_once(callback: Callable[[object], None], result: object) -> bool:
    callback(result)
    return GLib.SOURCE_REMOVE
