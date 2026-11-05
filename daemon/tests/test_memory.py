import json
import os
import tempfile
import unittest
from datetime import date
from pathlib import Path
from unittest import mock

from crepe_daemon.memory import REMARK_PROMPT, DailyCounter, Memory, atomic_write_json, default_state_dir


class StateDirTestCase(unittest.TestCase):
    def setUp(self):
        self._directory = tempfile.TemporaryDirectory()
        self.addCleanup(self._directory.cleanup)
        patcher = mock.patch.dict(os.environ, {"XDG_STATE_HOME": self._directory.name})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.state_dir = Path(self._directory.name) / "crepe"


class MemoryTest(StateDirTestCase):
    def test_state_dir_follows_xdg_state_home(self):
        self.assertEqual(default_state_dir(), self.state_dir)

    def test_history_is_trimmed_to_twenty_exchanges(self):
        memory = Memory()
        for index in range(25):
            memory.add(f"question {index}", f"réponse {index}")
        self.assertEqual(len(memory), 20)
        messages = memory.messages()
        self.assertEqual(len(messages), 40)
        self.assertEqual(messages[0], {"role": "user", "content": "question 5"})
        self.assertEqual(messages[-1], {"role": "assistant", "content": "réponse 24"})

    def test_history_survives_a_restart(self):
        Memory().add("salut", "Encore toi.")
        self.assertEqual(Memory().messages()[-1]["content"], "Encore toi.")

    def test_history_file_holds_the_turns(self):
        Memory().add("salut", "Encore toi.")
        saved = json.loads((self.state_dir / "history.json").read_text(encoding="utf-8"))
        self.assertEqual(saved, [{"user": "salut", "assistant": "Encore toi."}])

    def test_remark_is_stored_after_a_terse_user_turn(self):
        memory = Memory()
        memory.add_remark("Calme plat.")
        self.assertEqual(memory.messages()[0]["content"], REMARK_PROMPT)

    def test_clear_empties_memory_on_disk_too(self):
        memory = Memory()
        memory.add("salut", "Mm.")
        memory.clear()
        self.assertEqual(Memory().messages(), [])

    def test_corrupt_history_is_ignored(self):
        self.state_dir.mkdir(parents=True)
        (self.state_dir / "history.json").write_text("{oops")
        with self.assertLogs("crepe_daemon.memory", level="WARNING"):
            self.assertEqual(Memory().messages(), [])

    def test_failed_write_keeps_the_previous_file(self):
        target = self.state_dir / "history.json"
        atomic_write_json(target, ["before"])
        with self.assertRaises(TypeError):
            atomic_write_json(target, [object()])
        self.assertEqual(json.loads(target.read_text()), ["before"])
        self.assertEqual(sorted(path.name for path in self.state_dir.iterdir()), ["history.json"])


class DailyCounterTest(StateDirTestCase):
    def test_counter_persists_within_a_day(self):
        today = date(2026, 11, 5)
        DailyCounter(today=lambda: today).increment()
        self.assertEqual(DailyCounter(today=lambda: today).count, 1)

    def test_counter_rolls_over_at_date_change(self):
        clock = {"today": date(2026, 11, 5)}
        counter = DailyCounter(today=lambda: clock["today"])
        counter.increment()
        counter.increment()
        clock["today"] = date(2026, 11, 6)
        self.assertEqual(counter.count, 0)
        self.assertEqual(counter.increment(), 1)

    def test_saved_count_from_yesterday_starts_at_zero(self):
        DailyCounter(today=lambda: date(2026, 11, 5)).increment()
        self.assertEqual(DailyCounter(today=lambda: date(2026, 11, 6)).count, 0)


if __name__ == "__main__":
    unittest.main()
