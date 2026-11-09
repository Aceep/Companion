import os
import tempfile
import threading
import unittest
from concurrent.futures import ThreadPoolExecutor
from datetime import date
from pathlib import Path
from unittest import mock

from gi.repository import GLib

from crepe_daemon.brain import Brain
from crepe_daemon.config import Config
from crepe_daemon.errors import ERROR_PREFIX
from crepe_daemon.memory import DailyCounter, Memory
from crepe_daemon.service import BrainService
from crepe_daemon.watchers import base


class FakeInvocation:
    def __init__(self):
        self.values: list = []
        self.errors: list[tuple[str, str]] = []

    def return_value(self, value):
        self.values.append(value)

    def return_dbus_error(self, name, message):
        self.errors.append((name, message))


class GatedBackend:
    """Replies once `release` is set, so a test can hold an exchange in flight."""

    def __init__(self, reply="Mm.", error: Exception | None = None):
        self.reply = reply
        self.error = error
        self.started = threading.Event()
        self.release = threading.Event()
        self.release.set()

    def complete(self, system, messages):
        self.started.set()
        self.release.wait(5)
        if self.error:
            raise self.error
        return self.reply


def call_idle_now(callback, *args):
    # The main loop is not running in tests: idle callbacks run in the worker thread instead.
    callback(*args)


class ServiceTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.state_dir = Path(directory.name)
        patcher = mock.patch.object(base.GLib, "idle_add", side_effect=call_idle_now)
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_service(self, backend, **config) -> BrainService:
        counter = DailyCounter(self.state_dir, today=lambda: date(2026, 11, 5))
        brain = Brain(Config(**config), backend, Memory(self.state_dir), counter)
        service = BrainService(brain, fake=True, key_lookup=lambda: "key")
        self.addCleanup(service._executor.shutdown, wait=True)
        return service

    def call(self, service: BrainService, method: str, *arguments: str) -> FakeInvocation:
        invocation = FakeInvocation()
        signature = "(" + "s" * len(arguments) + ")"
        service._on_method_call(None, ":1.1", "/", "iface", method, GLib.Variant(signature, arguments), invocation)
        return invocation

    def drain(self, service: BrainService) -> None:
        service._executor.submit(lambda: None).result(timeout=5)


class AnswerLaterTest(ServiceTestCase):
    def test_reply_is_returned_as_a_string(self):
        service = self.make_service(GatedBackend(reply="Encore toi."))
        invocation = self.call(service, "Ask", "salut", "")
        self.drain(service)
        self.assertEqual([value.unpack() for value in invocation.values], [("Encore toi.",)])

    def test_brain_error_becomes_its_dbus_error(self):
        service = self.make_service(GatedBackend(), daily_budget=0)
        with self.assertLogs("crepe_daemon.service", level="INFO"):
            invocation = self.call(service, "Ask", "salut", "")
            self.drain(service)
        self.assertEqual(invocation.errors[0][0], ERROR_PREFIX + "Budget")

    def test_unexpected_exception_becomes_upstream_without_its_message(self):
        service = self.make_service(GatedBackend(error=RuntimeError("secret detail")))
        with self.assertLogs("crepe_daemon.watchers.base", level="ERROR"):
            invocation = self.call(service, "Ask", "salut", "")
            self.drain(service)
        self.assertEqual(invocation.errors, [(ERROR_PREFIX + "Upstream", "internal error, see the daemon log")])

    def test_oversized_context_is_refused_as_invalid(self):
        service = self.make_service(GatedBackend())
        with self.assertLogs("crepe_daemon.service", level="INFO"):
            invocation = self.call(service, "Ask", "salut", "{" + " " * 10000 + "}")
            self.drain(service)
        self.assertEqual(invocation.errors[0][0], ERROR_PREFIX + "Invalid")


class ForgetTest(ServiceTestCase):
    def test_forget_answers_with_no_value(self):
        service = self.make_service(GatedBackend())
        with self.assertLogs("crepe_daemon.brain", level="INFO"):
            invocation = self.call(service, "Forget")
            self.drain(service)
        self.assertEqual(invocation.values, [None])

    def test_forget_waits_for_the_exchange_in_flight(self):
        backend = GatedBackend()
        backend.release.clear()
        service = self.make_service(backend)
        ask = self.call(service, "Ask", "salut", "")
        self.assertTrue(backend.started.wait(5))
        with self.assertLogs("crepe_daemon.brain", level="INFO"):
            forget = self.call(service, "Forget")
            self.assertEqual(forget.values, [])
            backend.release.set()
            self.drain(service)
        self.assertEqual(len(ask.values), 1)
        self.assertEqual(forget.values, [None])
        self.assertEqual(len(service.brain.memory), 0)


class RunInExecutorTest(unittest.TestCase):
    def setUp(self):
        patcher = mock.patch.object(base.GLib, "idle_add", side_effect=call_idle_now)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.results: list = []

    def test_result_is_handed_to_on_done(self):
        with ThreadPoolExecutor(max_workers=1) as executor:
            base.run_in_executor(executor, lambda: 42, self.results.append, on_failure=lambda error: None)
        self.assertEqual(self.results, [42])

    def test_failure_is_logged_and_replaced(self):
        def boom():
            raise RuntimeError("boom")

        with self.assertLogs("crepe_daemon.watchers.base", level="ERROR"):
            with ThreadPoolExecutor(max_workers=1) as executor:
                base.run_in_executor(executor, boom, self.results.append, on_failure=lambda error: "fallback")
        self.assertEqual(self.results, ["fallback"])

    def test_cancelled_work_is_dropped_without_logging(self):
        gate = threading.Event()
        executor = ThreadPoolExecutor(max_workers=1)
        executor.submit(gate.wait, 5)
        with self.assertNoLogs("crepe_daemon", level="DEBUG"):
            base.run_in_executor(executor, lambda: 1, self.results.append, on_failure=lambda error: None)
            executor.shutdown(wait=False, cancel_futures=True)
            gate.set()
            executor.shutdown(wait=True)
        self.assertEqual(self.results, [])


if __name__ == "__main__":
    unittest.main()
