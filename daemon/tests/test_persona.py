import unittest

from crepe_daemon.persona import examples, system_prompt


class PersonaTest(unittest.TestCase):
    def test_persona_has_eight_to_ten_examples(self):
        self.assertTrue(8 <= len(examples()) <= 10)

    def test_every_example_reply_is_in_the_system_prompt(self):
        prompt = system_prompt()
        for user_text, reply in examples():
            self.assertIn(f"Alycia : {user_text}\nCrêpe : {reply}", prompt)

    def test_example_replies_are_short(self):
        for _, reply in examples():
            self.assertLessEqual(len(reply), 90, reply)

    def test_example_replies_have_no_exclamation_marks(self):
        for _, reply in examples():
            self.assertNotIn("!", reply)

    def test_persona_stays_under_nine_hundred_words(self):
        self.assertLess(len(system_prompt().split()), 900)

    def test_persona_explains_the_nothing_to_say_answer(self):
        self.assertIn("(rien)", system_prompt())


if __name__ == "__main__":
    unittest.main()
