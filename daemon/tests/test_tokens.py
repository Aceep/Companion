import io
import os
import unittest
from contextlib import redirect_stdout
from unittest import mock

from crepe_daemon import main as cli
from crepe_daemon import secrets as keyring
from crepe_daemon.agent_sdk import AgentSdkBackend
from crepe_daemon.brain import AnthropicBackend
from crepe_daemon.config import Config


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
        environment = mock.patch.dict(os.environ, {"CREPE_SPOTIFY_REFRESH_TOKEN": "", "CREPE_CLAUDE_OAUTH_TOKEN": ""})
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
        self.assertEqual(self.run_cli("--set-token", "spotify", typed=" refresh-abc \n"), 0)
        self.assertEqual(self.secret.items["spotify-refresh-token"], ("Crêpe Spotify refresh token", "refresh-abc"))
        self.assertEqual(keyring.lookup_token("spotify"), "refresh-abc")

    def test_set_token_prompts_with_the_token_own_prompt(self):
        with (
            mock.patch("getpass.getpass", return_value="oat-abc") as getpass,
            mock.patch("logging.basicConfig"),
            redirect_stdout(io.StringIO()),
        ):
            cli.main(["--set-token", "claude"])
        getpass.assert_called_once_with(keyring.TOKENS["claude"].prompt)

    def test_each_token_has_its_own_purpose(self):
        self.run_cli("--set-token", "spotify", typed="refresh-abc")
        self.assertIsNone(keyring.lookup_token("claude"))

    def test_spotify_refresh_token_has_its_own_purpose_and_can_be_forgotten(self):
        keyring.store_token("spotify", "refresh-abc")
        self.assertEqual(self.secret.items["spotify-refresh-token"][1], "refresh-abc")
        self.assertEqual(self.run_cli("--forget-token", "spotify"), 0)
        self.assertIsNone(keyring.lookup_token("spotify"))

    def test_claude_token_has_its_own_purpose(self):
        self.run_cli("--set-token", "claude", typed=" oat-abc \n")
        self.assertEqual(self.secret.items["claude-oauth-token"], ("Crêpe Claude subscription token", "oat-abc"))
        self.assertEqual(keyring.lookup_token("claude"), "oat-abc")
        self.assertNotIn("api-key", self.secret.items)

    def test_claude_token_can_be_forgotten(self):
        keyring.store_token("claude", "oat-abc")
        self.assertEqual(self.run_cli("--forget-token", "claude"), 0)
        self.assertIsNone(keyring.lookup_token("claude"))

    def test_claude_token_env_override_wins_over_the_keyring(self):
        keyring.store_token("claude", "from-keyring")
        with mock.patch.dict(os.environ, {"CREPE_CLAUDE_OAUTH_TOKEN": "from-env"}):
            self.assertEqual(keyring.lookup_token("claude"), "from-env")

    def test_backend_picks_its_own_credential(self):
        keyring.store_token("claude", "oat-abc")
        api = cli.key_lookup_for(Config(backend="api"), fake=False)
        subscription = cli.key_lookup_for(Config(backend="abonnement"), fake=False)
        with mock.patch.dict(os.environ, {"CREPE_API_KEY": ""}):
            self.assertIsNone(api())
        self.assertEqual(subscription(), "oat-abc")

    def test_fake_mode_never_touches_the_keyring(self):
        self.assertIs(cli.key_lookup_for(Config(backend="abonnement"), fake=True), keyring.lookup_key_from_env)

    def test_backend_class_follows_the_config(self):
        self.assertIsInstance(cli.build_backend(Config(backend="api")), AnthropicBackend)
        self.assertIsInstance(cli.build_backend(Config(backend="abonnement")), AgentSdkBackend)

    def test_api_backend_gets_the_configured_request_timeout(self):
        backend = cli.build_backend(Config(backend="api", request_timeout_s=12))
        anthropic = mock.Mock()
        backend._client_for("key", anthropic)
        self.assertEqual(anthropic.Anthropic.call_args.kwargs["timeout"], 12)

    def test_subscription_backend_gets_the_configured_agent_timeout(self):
        backend = cli.build_backend(Config(backend="abonnement", agent_timeout_s=25))
        self.assertEqual(backend._timeout_s, 25)

    def test_empty_input_stores_nothing(self):
        with mock.patch("sys.stderr", io.StringIO()):
            self.assertEqual(self.run_cli("--set-token", "spotify", typed="  "), 1)
        self.assertEqual(self.secret.items, {})

    def test_forget_token_removes_it(self):
        self.run_cli("--set-token", "spotify", typed="refresh-abc")
        self.assertEqual(self.run_cli("--forget-token", "spotify"), 0)
        self.assertIsNone(keyring.lookup_token("spotify"))

    def test_api_key_is_untouched_by_tokens(self):
        self.run_cli("--set-token", "spotify", typed="refresh-abc")
        self.assertNotIn("api-key", self.secret.items)

    def test_env_override_wins_over_the_keyring(self):
        self.run_cli("--set-token", "spotify", typed="from-keyring")
        with mock.patch.dict(os.environ, {"CREPE_SPOTIFY_REFRESH_TOKEN": "from-env"}):
            self.assertEqual(keyring.lookup_token("spotify"), "from-env")

    def test_unknown_watcher_name_is_refused(self):
        with self.assertRaises(SystemExit), mock.patch("sys.stderr", io.StringIO()):
            self.run_cli("--set-token", "jira")

    def test_removed_gitlab_token_name_is_refused(self):
        with self.assertRaises(SystemExit), mock.patch("sys.stderr", io.StringIO()):
            self.run_cli("--set-token", "gitlab")


if __name__ == "__main__":
    unittest.main()
