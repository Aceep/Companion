import os
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from crepe_daemon import nudge as nudge_module
from crepe_daemon.brain import Brain, FakeBackend
from crepe_daemon.config import Config, GitConfig, IcsConfig, MachineConfig, SpotifyConfig
from crepe_daemon.memory import DailyCounter, Memory
from crepe_daemon.nudge import KINDS, MAX_TEXT_CHARS, Nudger, clip_text
from crepe_daemon.service import BrainService
from crepe_daemon.watchers import StateStore, WatcherPool, build_watchers


class FakeConnection:
    def __init__(self):
        self.calls = []

    def call(self, bus_name, object_path, interface, method, parameters, *_rest):
        self.calls.append((bus_name, object_path, interface, method, parameters.unpack()))


class ClipTextTest(unittest.TestCase):
    def test_short_text_is_kept(self):
        self.assertEqual(clip_text("crepe · main"), "crepe · main")

    def test_text_becomes_one_line(self):
        self.assertEqual(clip_text("deux\n  lignes"), "deux lignes")

    def test_long_text_is_cut_with_an_ellipsis(self):
        clipped = clip_text("a" * 100)
        self.assertEqual(len(clipped), MAX_TEXT_CHARS)
        self.assertTrue(clipped.endswith("…"))


class NudgerTest(unittest.TestCase):
    def test_nudge_calls_the_extension_on_the_shell_name(self):
        connection = FakeConnection()
        Nudger(connection).nudge("pipeline_echec", "crepe · main")
        self.assertEqual(
            connection.calls,
            [("org.gnome.Shell", "/io/github/aceep/Crepe", "io.github.aceep.Crepe", "Nudge", ("pipeline_echec", "crepe · main"))],
        )

    def test_local_watcher_kinds_are_known(self):
        self.assertLessEqual({"travail_non_commite", "machine", "agenda"}, KINDS)

    def test_terminal_hook_kinds_are_known(self):
        self.assertLessEqual({"commande_echec", "commande_longue"}, KINDS)

    def test_unknown_kind_is_not_sent(self):
        connection = FakeConnection()
        with self.assertLogs("crepe_daemon.nudge", level="WARNING"):
            Nudger(connection).nudge("party", "yay")
        self.assertEqual(connection.calls, [])

    def test_second_nudge_of_a_kind_waits_for_the_rate_limit(self):
        connection = FakeConnection()
        nudger = Nudger(connection)
        with mock.patch.object(nudge_module.GLib, "timeout_add") as timeout_add:
            nudger.nudge("ticket_nouveau", "#1 a")
            nudger.nudge("ticket_nouveau", "#2 b")
            nudger.nudge("tickets_ouverts", "3")
        self.assertEqual([call[4] for call in connection.calls], [("ticket_nouveau", "#1 a"), ("tickets_ouverts", "3")])
        delay_ms = timeout_add.call_args.args[0]
        self.assertGreaterEqual(delay_ms, 5000)
        self.assertLessEqual(delay_ms, 5500)


class StatusWatchersTest(unittest.TestCase):
    def test_status_lists_the_active_watchers(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"XDG_STATE_HOME": directory}):
            state_dir = Path(directory)
            brain = Brain(Config(), FakeBackend(), Memory(state_dir), DailyCounter(state_dir))
            pool = WatcherPool([SimpleNamespace(name="git"), SimpleNamespace(name="ics")])
            status = BrainService(brain, fake=True, key_lookup=lambda: None, watchers=pool)._status()
        self.assertEqual(status["watchers"].unpack(), ["git", "ics"])

    def test_no_watchers_gives_an_empty_list(self):
        with tempfile.TemporaryDirectory() as directory:
            state_dir = Path(directory)
            brain = Brain(Config(), FakeBackend(), Memory(state_dir), DailyCounter(state_dir))
            status = BrainService(brain, fake=True, key_lookup=lambda: None)._status()
        self.assertEqual(status["watchers"].unpack(), [])


class BuildWatchersTest(unittest.TestCase):
    def test_every_configured_watcher_is_built_in_order(self):
        config = Config(
            git=GitConfig(paths=("/nowhere",)),
            machine=MachineConfig(),
            ics=IcsConfig(url="https://example.com/c.ics"),
            spotify=SpotifyConfig(client_id="abc"),
        )
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"TZ": "UTC"}):
            pool = build_watchers(config, lambda kind, text: None, state=StateStore(Path(directory)), transport=object())
        self.assertEqual(pool.names, ["git", "machine", "ics", "spotify"])


if __name__ == "__main__":
    unittest.main()
