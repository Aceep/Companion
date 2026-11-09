import os
import tempfile
import unittest
from datetime import date
from unittest import mock

from crepe_daemon.brain import FAKE_PREFIX, MAX_ASK_CHARS, REFUSAL_LINES, Brain, FakeBackend, Refused, postprocess
from crepe_daemon.config import Config
from crepe_daemon.errors import BudgetError, InvalidError, NoKeyError
from crepe_daemon.memory import REMARK_PROMPT, DailyCounter, Memory


class PostprocessTest(unittest.TestCase):
    def test_surrounding_quotes_and_spaces_are_stripped(self):
        self.assertEqual(postprocess('  "Encore toi."  ', 160), "Encore toi.")

    def test_french_quotes_are_stripped(self):
        self.assertEqual(postprocess("« Classique. »", 160), "Classique.")

    def test_speaker_label_is_dropped(self):
        self.assertEqual(postprocess("Crêpe : Mm.", 160), "Mm.")

    def test_newlines_collapse_to_one_space(self):
        self.assertEqual(postprocess("Bon.\n\nBen voilà.", 160), "Bon. Ben voilà.")

    def test_short_reply_is_untouched(self):
        self.assertEqual(postprocess("Je note.", 160), "Je note.")

    def test_long_reply_is_cut_at_a_sentence_end(self):
        first = "Une première phrase, assez longue pour ne pas être jetée."
        text = first + " " + "Puis une suite qui déborde " * 10
        self.assertEqual(postprocess(text, 160), first)

    def test_sentence_end_too_early_falls_back_to_a_word_cut(self):
        result = postprocess("Non. " + "Puis une suite qui déborde " * 10, 160)
        self.assertLessEqual(len(result), 160)
        self.assertTrue(result.endswith("…"))
        self.assertGreater(len(result), 100)

    def test_long_reply_without_sentence_end_is_cut_at_a_word(self):
        result = postprocess("mot " * 100, 160)
        self.assertLessEqual(len(result), 160)
        self.assertTrue(result.endswith("mot…"))

    def test_cap_is_never_exceeded(self):
        result = postprocess("x" * 500, 160)
        self.assertEqual(len(result), 160)


class ScriptedBackend:
    def __init__(self, reply="Mm.", error=None):
        self.reply = reply
        self.error = error
        self.calls = []

    def complete(self, system, messages):
        self.calls.append(messages)
        if self.error:
            raise self.error
        return self.reply


class BrainTest(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        patcher = mock.patch.dict(os.environ, {"XDG_STATE_HOME": directory.name})
        patcher.start()
        self.addCleanup(patcher.stop)

    def make_brain(self, backend, **config):
        counter = DailyCounter(today=lambda: date(2026, 11, 5))
        return Brain(Config(**config), backend, Memory(), counter)

    def test_ask_sends_context_and_question_in_the_user_turn(self):
        backend = ScriptedBackend()
        self.make_brain(backend).ask("salut", '{"hour": 15}')
        last_turn = backend.calls[0][-1]
        self.assertEqual(last_turn["role"], "user")
        self.assertIn("15 h", last_turn["content"])
        self.assertTrue(last_turn["content"].endswith("salut"))

    def test_ask_remembers_the_question_without_the_context(self):
        brain = self.make_brain(ScriptedBackend(reply='"Encore toi."'))
        brain.ask("salut", '{"hour": 15}')
        self.assertEqual(
            brain.memory.messages(),
            [{"role": "user", "content": "salut"}, {"role": "assistant", "content": "Encore toi."}],
        )

    def test_long_question_is_clipped_not_refused(self):
        backend = ScriptedBackend()
        brain = self.make_brain(backend)
        brain.ask("mot " * 400, "")
        sent = backend.calls[0][-1]["content"]
        self.assertEqual(len(sent), MAX_ASK_CHARS)
        self.assertTrue(sent.endswith("…"))
        self.assertEqual(brain.memory.messages()[0]["content"], sent)

    def test_forget_empties_the_memory(self):
        brain = self.make_brain(ScriptedBackend())
        brain.ask("salut", "")
        brain.forget()
        self.assertEqual(len(brain.memory), 0)

    def test_bad_context_is_invalid_before_any_call(self):
        backend = ScriptedBackend()
        with self.assertRaises(InvalidError):
            self.make_brain(backend).ask("salut", "{nope")
        self.assertEqual(backend.calls, [])

    def test_budget_stops_requests(self):
        brain = self.make_brain(ScriptedBackend(), daily_budget=1)
        brain.ask("un", "")
        with self.assertRaises(BudgetError):
            brain.ask("deux", "")

    def test_missing_key_does_not_count_against_the_budget(self):
        brain = self.make_brain(ScriptedBackend(error=NoKeyError("no key")))
        with self.assertRaises(NoKeyError):
            brain.ask("salut", "")
        self.assertEqual(brain.counter.count, 0)

    def test_refusal_gives_an_in_character_line_and_is_not_remembered(self):
        brain = self.make_brain(ScriptedBackend(error=Refused()))
        self.assertIn(brain.ask("salut", ""), REFUSAL_LINES)
        self.assertEqual(len(brain.memory), 0)

    def test_remark_is_silent_when_disabled(self):
        backend = ScriptedBackend()
        self.assertEqual(self.make_brain(backend).remark(""), "")
        self.assertEqual(backend.calls, [])

    def test_remark_is_silent_while_sleeping(self):
        backend = ScriptedBackend()
        self.assertEqual(self.make_brain(backend, remarks=True).remark('{"sleeping": true}'), "")
        self.assertEqual(backend.calls, [])

    def test_nothing_to_say_becomes_an_empty_remark(self):
        brain = self.make_brain(ScriptedBackend(reply="(rien)"), remarks=True)
        self.assertEqual(brain.remark('{"hour": 10}'), "")
        self.assertEqual(len(brain.memory), 0)

    def test_remark_is_remembered_after_a_terse_user_turn(self):
        brain = self.make_brain(ScriptedBackend(reply="Calme plat."), remarks=True)
        brain.remark('{"hour": 10}')
        self.assertEqual(brain.memory.messages()[0]["content"], REMARK_PROMPT)

    def test_fake_backend_is_deterministic_and_recognisable(self):
        brain = self.make_brain(FakeBackend())
        first = brain.ask("salut", "")
        brain.memory.clear()
        self.assertTrue(first.startswith(FAKE_PREFIX))
        self.assertEqual(brain.ask("salut", ""), first)


if __name__ == "__main__":
    unittest.main()
