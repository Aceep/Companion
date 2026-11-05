import io
import os
import unittest
from contextlib import redirect_stdout
from unittest import mock

from crepe_daemon import main as cli
from crepe_daemon import secrets as keyring


class FakeSecret:
    """Stands in for gi's Secret module: a dict keyed by the purpose attribute."""

    COLLECTION_DEFAULT = "default"

    def __init__(self):
        self.items: dict[str, tuple[str, str]] = {}

    def password_store_sync(self, schema, attributes, collection, label, secret, cancellable):
        self.items[attributes["purpose"]] = (label, secret)
        return True

    def password_lookup_sync(self, schema, attributes, cancellable):
        item = self.items.get(attributes["purpose"])
        return item[1] if item else None

    def password_clear_sync(self, schema, attributes, cancellable):
        return self.items.pop(attributes["purpose"], None) is not None


class TokenTest(unittest.TestCase):
    def setUp(self):
        self.secret = FakeSecret()
        patcher = mock.patch.object(keyring, "Secret", self.secret)
        patcher.start()
        self.addCleanup(patcher.stop)
        environment = mock.patch.dict(os.environ, {"CREPE_GITLAB_TOKEN": "", "CREPE_REDMINE_KEY": ""})
        environment.start()
        self.addCleanup(environment.stop)

    def run_cli(self, *argv: str, typed: str = "") -> int:
        # main() configures root logging, which would leak into later tests' output.
        with (
            mock.patch("getpass.getpass", return_value=typed),
            mock.patch("logging.basicConfig"),
            redirect_stdout(io.StringIO()),
        ):
            return cli.main(list(argv))

    def test_set_token_stores_under_the_watcher_purpose(self):
        self.assertEqual(self.run_cli("--set-token", "gitlab", typed=" glpat-abc \n"), 0)
        self.assertEqual(self.secret.items["gitlab-token"], ("Crêpe GitLab token", "glpat-abc"))
        self.assertEqual(keyring.lookup_token("gitlab"), "glpat-abc")

    def test_redmine_key_has_its_own_purpose(self):
        self.run_cli("--set-token", "redmine", typed="rm-key")
        self.assertIn("redmine-key", self.secret.items)
        self.assertIsNone(keyring.lookup_token("gitlab"))

    def test_empty_input_stores_nothing(self):
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.run_cli("--set-token", "gitlab", typed="  "), 1)
        self.assertEqual(self.secret.items, {})

    def test_forget_token_removes_it(self):
        self.run_cli("--set-token", "redmine", typed="rm-key")
        self.assertEqual(self.run_cli("--forget-token", "redmine"), 0)
        self.assertIsNone(keyring.lookup_token("redmine"))

    def test_api_key_is_untouched_by_tokens(self):
        self.run_cli("--set-token", "gitlab", typed="glpat-abc")
        self.assertNotIn("api-key", self.secret.items)

    def test_env_override_wins_over_the_keyring(self):
        self.run_cli("--set-token", "gitlab", typed="from-keyring")
        with mock.patch.dict(os.environ, {"CREPE_GITLAB_TOKEN": "from-env"}):
            self.assertEqual(keyring.lookup_token("gitlab"), "from-env")

    def test_unknown_watcher_name_is_refused(self):
        with self.assertRaises(SystemExit), mock.patch("sys.stderr", io.StringIO()):
            self.run_cli("--set-token", "jira")


if __name__ == "__main__":
    unittest.main()
