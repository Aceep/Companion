import json
import unittest

from crepe_daemon.context import MAX_CONTEXT_CHARS, Context, parse_context, render_context
from crepe_daemon.errors import InvalidError


class ParseContextTest(unittest.TestCase):
    def test_empty_string_is_an_empty_context(self):
        self.assertEqual(parse_context(""), Context())

    def test_full_context_is_parsed(self):
        context = parse_context(
            json.dumps(
                {
                    "hour": 14,
                    "weekday": "mardi",
                    "window_title": "main.rs - Code",
                    "app": "Code",
                    "mood": "annoyed",
                    "sleeping": False,
                    "events": [{"ago_s": 12, "kind": "notification"}],
                    "last_lines": ["Encore toi."],
                }
            )
        )
        self.assertEqual(context.hour, 14)
        self.assertEqual(context.mood, "annoyed")
        self.assertEqual(context.events[0].kind, "notification")
        self.assertEqual(context.last_lines, ("Encore toi.",))

    def test_unknown_keys_are_ignored(self):
        self.assertEqual(parse_context('{"weather": "rain"}'), Context())

    def test_bad_json_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context("{not json")

    def test_non_object_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context("[1, 2]")

    def test_string_hour_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context('{"hour": "14"}')

    def test_out_of_range_hour_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context('{"hour": 24}')

    def test_unknown_mood_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context('{"mood": "happy"}')

    def test_non_boolean_sleeping_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context('{"sleeping": "no"}')

    def test_event_without_kind_is_invalid(self):
        with self.assertRaises(InvalidError):
            parse_context('{"events": [{"ago_s": 3}]}')

    def test_last_lines_must_be_strings(self):
        with self.assertRaises(InvalidError):
            parse_context('{"last_lines": [1]}')

    def test_oversized_context_is_invalid(self):
        with self.assertRaisesRegex(InvalidError, "longer than"):
            parse_context(json.dumps({"window_title": "x" * MAX_CONTEXT_CHARS}))

    def test_context_at_the_size_limit_is_accepted(self):
        raw = json.dumps({"app": ""}) + " " * (MAX_CONTEXT_CHARS - len(json.dumps({"app": ""})))
        self.assertEqual(parse_context(raw), Context())

    def test_long_window_title_is_clipped(self):
        context = parse_context(json.dumps({"window_title": "x" * 1000}))
        self.assertLessEqual(len(context.window_title), 200)

    def test_events_are_sorted_most_recent_first_and_capped(self):
        events = [{"ago_s": seconds, "kind": "notification"} for seconds in range(30, 0, -1)]
        context = parse_context(json.dumps({"events": events}))
        self.assertEqual(len(context.events), 10)
        self.assertEqual(context.events[0].ago_s, 1)


class RenderContextTest(unittest.TestCase):
    def test_empty_context_renders_nothing(self):
        self.assertEqual(render_context(Context()), "")

    def test_rendering_is_french_and_mentions_every_field(self):
        context = parse_context(
            json.dumps(
                {
                    "hour": 23,
                    "weekday": "vendredi",
                    "window_title": "main.rs - Code",
                    "app": "Code",
                    "mood": "angry",
                    "sleeping": True,
                    "events": [{"ago_s": 125, "kind": "erreur"}],
                    "last_lines": ["Classique."],
                }
            )
        )
        rendered = render_context(context)
        self.assertIn("vendredi, 23 h", rendered)
        self.assertIn("« main.rs - Code »", rendered)
        self.assertIn("en colère", rendered)
        self.assertIn("Tu dormais", rendered)
        self.assertIn("erreur il y a 2 min", rendered)
        self.assertIn("« Classique. »", rendered)


if __name__ == "__main__":
    unittest.main()
