import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from crepe_daemon.config import (
    Config,
    ConfigError,
    GitConfig,
    IcsConfig,
    MachineConfig,
    default_config_path,
    load_config,
    parse_config,
)


class ConfigTest(unittest.TestCase):
    def test_missing_file_gives_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            config = load_config(Path(directory) / "absent.toml")
        self.assertEqual(config, Config())
        self.assertEqual(config.model, "claude-haiku-5-5")
        self.assertEqual(config.daily_budget, 200)
        self.assertFalse(config.remarks)
        self.assertEqual(config.max_reply_chars, 160)

    def test_file_values_override_defaults(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "daemon.toml"
            path.write_text('model = "claude-other"\ndaily_budget = 5\nremarks = true\nmax_reply_chars = 90\n')
            config = load_config(path)
        self.assertEqual(config, Config(model="claude-other", daily_budget=5, remarks=True, max_reply_chars=90))

    def test_default_path_follows_xdg_config_home(self):
        with mock.patch.dict(os.environ, {"XDG_CONFIG_HOME": "/somewhere"}):
            self.assertEqual(default_config_path(), Path("/somewhere/crepe/daemon.toml"))

    def test_backend_defaults_to_the_api(self):
        self.assertEqual(parse_config({}).backend, "api")

    def test_subscription_backend_is_accepted(self):
        self.assertEqual(parse_config({"backend": "abonnement"}).backend, "abonnement")

    def test_unknown_backend_is_rejected(self):
        for value in ("sdk", "", "API", 1, None):
            with self.subTest(value=value), self.assertRaises(ConfigError):
                parse_config({"backend": value})

    def test_model_still_applies_to_the_subscription_backend(self):
        config = parse_config({"backend": "abonnement", "model": "haiku"})
        self.assertEqual((config.backend, config.model), ("abonnement", "haiku"))

    def test_unknown_keys_are_ignored(self):
        with self.assertLogs("crepe_daemon.config", level="WARNING"):
            self.assertEqual(parse_config({"colour": "blue"}), Config())

    def test_wrong_type_is_rejected(self):
        with self.assertRaises(ConfigError):
            parse_config({"daily_budget": "lots"})

    def test_boolean_budget_is_rejected(self):
        with self.assertRaises(ConfigError):
            parse_config({"daily_budget": True})

    def test_tiny_reply_cap_is_rejected(self):
        with self.assertRaises(ConfigError):
            parse_config({"max_reply_chars": 5})

    def test_broken_toml_is_an_error(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / "daemon.toml"
            path.write_text("model = \n")
            with self.assertRaises(ConfigError):
                load_config(path)


class WatcherConfigTest(unittest.TestCase):
    def test_no_section_means_no_watcher(self):
        config = parse_config({})
        self.assertEqual((config.git, config.machine, config.ics, config.spotify), (None, None, None, None))

    def test_missing_url_is_rejected(self):
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"ics": {}}})

    def test_sub_minute_interval_is_rejected_outside_dev_mode(self):
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"machine": {"interval_minutes": 0.1}}})

    def test_dev_mode_allows_short_intervals(self):
        raw = {"watchers": {"machine": {"interval_minutes": 0.05}}}
        self.assertEqual(parse_config(raw, dev=True).machine.interval_minutes, 0.05)
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"machine": {"interval_minutes": 0.01}}}, dev=True)

    def test_dev_mode_comes_from_crepe_dev(self):
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, {"CREPE_DEV": "1"}):
            path = Path(directory) / "daemon.toml"
            path.write_text("[watchers.machine]\ninterval_minutes = 0.1\n")
            self.assertEqual(load_config(path).machine.interval_minutes, 0.1)

    def test_boolean_interval_is_rejected(self):
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"machine": {"interval_minutes": True}}})

    def test_unknown_watcher_is_ignored(self):
        with self.assertLogs("crepe_daemon.config", level="WARNING"):
            self.assertEqual(parse_config({"watchers": {"jira": {}}}), Config())

    def test_former_gitlab_section_is_ignored_with_a_warning(self):
        with self.assertLogs("crepe_daemon.config", level="WARNING") as logs:
            self.assertEqual(parse_config({"watchers": {"gitlab": {"url": "https://gitlab.example.com"}}}), Config())
        self.assertIn("gitlab", logs.output[0])


class LocalWatcherConfigTest(unittest.TestCase):
    def test_git_paths_are_required(self):
        with self.assertRaisesRegex(ConfigError, "watchers.git.paths is required"):
            parse_config({"watchers": {"git": {}}})

    def test_git_paths_must_be_a_non_empty_list(self):
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"git": {"paths": []}}})
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"git": {"paths": "~/perso"}}})

    def test_git_defaults_and_home_expansion(self):
        with mock.patch.dict(os.environ, {"HOME": "/home/someone"}):
            config = parse_config({"watchers": {"git": {"paths": ["~/perso", "/var/www/projet"]}}})
        self.assertEqual(config.git, GitConfig(paths=("/home/someone/perso", "/var/www/projet")))
        self.assertEqual((config.git.interval_minutes, config.git.nag_after_minutes), (30, 120))

    def test_git_nag_after_below_a_minute_is_rejected(self):
        with self.assertRaisesRegex(ConfigError, "watchers.git.nag_after_minutes must be a number >= 1"):
            parse_config({"watchers": {"git": {"paths": ["/x"], "nag_after_minutes": 0}}})

    def test_git_unpushed_defaults_to_true(self):
        config = parse_config({"watchers": {"git": {"paths": ["/x"]}}})
        self.assertTrue(config.git.unpushed)

    def test_git_unpushed_must_be_a_boolean(self):
        with self.assertRaisesRegex(ConfigError, "watchers.git.unpushed must be true or false"):
            parse_config({"watchers": {"git": {"paths": ["/x"], "unpushed": "non"}}})

    def test_machine_section_alone_gives_defaults(self):
        with mock.patch.dict(os.environ, {"HOME": "/home/someone"}):
            config = parse_config({"watchers": {"machine": {}}})
        self.assertEqual(
            config.machine,
            MachineConfig(interval_minutes=5, disk_percent=90, disk_paths=("/", "/home/someone"), battery_percent=15, load_minutes=10),
        )

    def test_machine_percent_above_a_hundred_is_rejected(self):
        with self.assertRaisesRegex(ConfigError, "watchers.machine.disk_percent must be a number between 0 and 100"):
            parse_config({"watchers": {"machine": {"disk_percent": 120}}})

    def test_machine_disk_paths_must_be_strings(self):
        with self.assertRaises(ConfigError):
            parse_config({"watchers": {"machine": {"disk_paths": ["/", 3]}}})

    def test_ics_url_is_kept_verbatim_with_defaults(self):
        url = "https://outlook.example.com/owa/calendar/x/secret/calendar.ics/"
        config = parse_config({"watchers": {"ics": {"url": url, "token_purpose": "ignored"}}})
        self.assertEqual(config.ics, IcsConfig(url=url, interval_minutes=15, warn_minutes=10))

    def test_ics_url_must_be_http(self):
        with self.assertRaisesRegex(ConfigError, "watchers.ics.url must be an http\\(s\\) URL"):
            parse_config({"watchers": {"ics": {"url": "webcal://example.com/cal.ics"}}})

    def test_ics_interval_under_five_minutes_is_rejected(self):
        with self.assertRaisesRegex(ConfigError, "watchers.ics.interval_minutes must be a number >= 5"):
            parse_config({"watchers": {"ics": {"url": "https://example.com/c.ics", "interval_minutes": 2}}})

    def test_ics_dev_mode_allows_short_intervals(self):
        raw = {"watchers": {"ics": {"url": "https://example.com/c.ics", "interval_minutes": 0.1}}}
        self.assertEqual(parse_config(raw, dev=True).ics.interval_minutes, 0.1)

    def test_config_error_never_quotes_the_ics_url(self):
        with self.assertRaises(ConfigError) as raised:
            parse_config({"watchers": {"ics": {"url": "https://example.com/secret.ics", "warn_minutes": "x"}}})
        self.assertNotIn("secret", str(raised.exception))


if __name__ == "__main__":
    unittest.main()
