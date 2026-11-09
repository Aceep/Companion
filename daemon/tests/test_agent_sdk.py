import asyncio
import os
import stat
import subprocess
import sys
import tempfile
import types
import unittest
from dataclasses import dataclass, field
from pathlib import Path
from unittest import mock

from crepe_daemon import agent_sdk
from crepe_daemon.agent_sdk import (
    AgentDirectories,
    AgentSdkBackend,
    agent_launcher_script,
    agent_options,
    render_prompt,
    write_launcher,
)
from crepe_daemon.brain import Refused
from crepe_daemon.errors import NoKeyError, UpstreamError


class ClaudeSDKError(Exception):
    pass


class CLIConnectionError(ClaudeSDKError):
    pass


class CLINotFoundError(CLIConnectionError):
    pass


class ResultError(ClaudeSDKError):
    def __init__(self, message="", api_error_status=None, result=None):
        super().__init__(message)
        self.api_error_status = api_error_status
        self.result = result


@dataclass
class SystemMessage:
    subtype: str
    data: dict = field(default_factory=dict)


@dataclass
class AssistantMessage:
    content: list = field(default_factory=list)
    error: str | None = None


@dataclass
class ResultMessage:
    result: str | None = "Mm."
    is_error: bool = False
    stop_reason: str | None = "end_turn"
    api_error_status: int | None = None
    total_cost_usd: float | None = 0.0001
    usage: dict | None = field(default_factory=lambda: {"input_tokens": 10})


class ClaudeAgentOptions:
    def __init__(self, **options):
        self.__dict__.update(options)


CLEAN_INIT = SystemMessage(
    "init",
    {
        "tools": [],
        "mcp_servers": [],
        "skills": [],
        "plugins": [{"name": "cc-plugin-agents-md", "path": "builtin"}],
    },
)


def make_fake_sdk(sdk_dir: Path, script):
    """A stand-in for claude_agent_sdk: query() plays `script`, a list of messages or exceptions."""
    (sdk_dir / "_bundled").mkdir(parents=True)
    (sdk_dir / "_bundled" / "claude").write_text("")
    module = types.ModuleType("claude_agent_sdk")
    module.__file__ = str(sdk_dir / "__init__.py")
    module.calls = []

    async def query(*, prompt, options):
        module.calls.append((prompt, options))
        for item in script:
            if isinstance(item, BaseException):
                raise item
            if item == "hang":
                await asyncio.sleep(60)
            yield item

    for name, value in {
        "ClaudeAgentOptions": ClaudeAgentOptions,
        "SystemMessage": SystemMessage,
        "AssistantMessage": AssistantMessage,
        "ResultMessage": ResultMessage,
        "ClaudeSDKError": ClaudeSDKError,
        "CLIConnectionError": CLIConnectionError,
        "CLINotFoundError": CLINotFoundError,
        "ResultError": ResultError,
        "query": query,
    }.items():
        setattr(module, name, value)
    return module


class AgentTestCase(unittest.TestCase):
    def setUp(self):
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.directories = AgentDirectories(self.root / "crepe")

    def backend_with(self, script, token="oat-secret", timeout_s=5.0):
        module = make_fake_sdk(self.root / "sdk", script)
        patcher = mock.patch.dict(sys.modules, {"claude_agent_sdk": module})
        patcher.start()
        self.addCleanup(patcher.stop)
        self.sdk = module
        return AgentSdkBackend("claude-haiku-5-5", lambda: token, self.directories, timeout_s)

    def complete(self, backend, messages=None):
        return backend.complete("PERSONA", messages or [{"role": "user", "content": "salut"}])


class OptionsTest(AgentTestCase):
    def options(self, **environment):
        module = make_fake_sdk(self.root / "sdk", [])
        with mock.patch.dict(os.environ, environment):
            return agent_options(module, "claude-haiku-5-5", "PERSONA", "oat-secret", self.directories, "/launcher")

    def test_no_settings_are_loaded(self):
        self.assertEqual(self.options().setting_sources, [])

    def test_no_tools_plugins_agents_or_mcp_servers(self):
        options = self.options()
        self.assertEqual(options.tools, [])
        self.assertEqual(options.allowed_tools, [])
        self.assertEqual(options.plugins, [])
        self.assertEqual(options.agents, {})
        self.assertEqual(options.mcp_servers, {})
        self.assertTrue(options.strict_mcp_config)

    def test_single_turn_that_never_asks_permission(self):
        options = self.options()
        self.assertEqual(options.max_turns, 1)
        self.assertEqual(options.permission_mode, "dontAsk")

    def test_system_prompt_is_the_persona_string_and_nothing_else(self):
        self.assertEqual(self.options().system_prompt, "PERSONA")

    def test_it_runs_in_the_dedicated_empty_directory(self):
        self.assertEqual(self.options().cwd, self.directories.cwd)

    def test_prompt_is_delivered_verbatim_and_slash_commands_are_off(self):
        options = self.options()
        self.assertTrue(options.verbatim_prompts)
        self.assertIn("disable-slash-commands", options.extra_args)
        self.assertIn("no-session-persistence", options.extra_args)

    def test_env_carries_the_token_and_the_isolated_directories(self):
        env = self.options().env
        self.assertEqual(env["CLAUDE_CODE_OAUTH_TOKEN"], "oat-secret")
        self.assertEqual(env["CLAUDE_CONFIG_DIR"], str(self.directories.config))
        self.assertEqual(env["HOME"], str(self.directories.home))
        self.assertEqual(env["DISABLE_AUTOUPDATER"], "1")
        self.assertEqual(env["CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC"], "1")

    def test_env_never_copies_the_daemons_own_variables(self):
        env = self.options(ANTHROPIC_API_KEY="leak", ANTHROPIC_BASE_URL="http://elsewhere", AWS_SECRET="leak").env
        self.assertEqual([name for name in env if name.startswith(("ANTHROPIC_", "AWS_"))], [])

    def test_cli_is_the_launcher_given(self):
        self.assertEqual(self.options().cli_path, "/launcher")


class DirectoriesTest(AgentTestCase):
    def test_they_are_private_to_the_user(self):
        self.directories.create()
        for directory in (self.directories.config, self.directories.cwd, self.directories.home):
            self.assertEqual(stat.S_IMODE(directory.stat().st_mode), 0o700)

    def test_an_existing_loose_directory_is_tightened(self):
        self.directories.config.mkdir(parents=True, mode=0o755)
        self.directories.config.chmod(0o755)
        self.directories.create()
        self.assertEqual(stat.S_IMODE(self.directories.config.stat().st_mode), 0o700)

    def test_default_location_follows_xdg_data_home(self):
        with mock.patch.dict(os.environ, {"XDG_DATA_HOME": "/somewhere"}):
            self.assertEqual(AgentDirectories().config, Path("/somewhere/crepe/agent-config"))


@unittest.skipUnless(os.access("/usr/bin/env", os.X_OK) and os.access("/bin/sh", os.X_OK), "needs /bin/sh and /usr/bin/env")
class LauncherTest(AgentTestCase):
    def run_launcher(self, environment: dict[str, str]) -> dict[str, str]:
        """Run the launcher around a stand-in CLI that prints its environment."""
        self.directories.create()
        cli = self.root / "fake-cli"
        cli.write_text('#!/bin/sh\n/usr/bin/env\nprintf "ARGS=%s\\n" "$*"\n')
        cli.chmod(0o700)
        launcher = write_launcher(self.directories, str(cli))
        output = subprocess.run([launcher, "--flag", "two words"], env=environment, capture_output=True, text=True, check=True)
        return dict(line.split("=", 1) for line in output.stdout.splitlines() if "=" in line)

    def test_daemon_credentials_and_provider_switches_are_dropped(self):
        seen = self.run_launcher(
            {
                "PATH": "/usr/bin:/bin",
                "ANTHROPIC_API_KEY": "leak",
                "ANTHROPIC_AUTH_TOKEN": "leak",
                "ANTHROPIC_BASE_URL": "http://elsewhere",
                "CLAUDE_CODE_USE_BEDROCK": "1",
                "AWS_ACCESS_KEY_ID": "leak",
                "GITLAB_TOKEN": "leak",
                "CLAUDE_CODE_OAUTH_TOKEN": "oat-secret",
                "CLAUDE_CONFIG_DIR": "/isolated",
            }
        )
        self.assertEqual([name for name in seen if name.startswith(("ANTHROPIC_", "AWS_", "GITLAB_"))], [])
        self.assertNotIn("CLAUDE_CODE_USE_BEDROCK", seen)

    def test_what_the_cli_needs_gets_through(self):
        seen = self.run_launcher(
            {"PATH": "/usr/bin:/bin", "LANG": "fr_FR.UTF-8", "HTTPS_PROXY": "http://proxy:3128 x", "CLAUDE_CODE_OAUTH_TOKEN": "oat-secret", "HOME": "/isolated/home"}
        )
        self.assertEqual(seen["CLAUDE_CODE_OAUTH_TOKEN"], "oat-secret")
        self.assertEqual(seen["HOME"], "/isolated/home")
        self.assertEqual(seen["LANG"], "fr_FR.UTF-8")
        self.assertEqual(seen["HTTPS_PROXY"], "http://proxy:3128 x")
        self.assertEqual(seen["ARGS"], "--flag two words")

    def test_unset_variables_stay_unset(self):
        seen = self.run_launcher({"PATH": "/usr/bin:/bin"})
        self.assertNotIn("HTTPS_PROXY", seen)
        self.assertNotIn("CLAUDE_CODE_OAUTH_TOKEN", seen)

    def test_script_is_rewritten_only_when_the_cli_moves(self):
        self.directories.create()
        first = Path(write_launcher(self.directories, "/a/claude"))
        before = first.stat().st_ino
        write_launcher(self.directories, "/a/claude")
        self.assertEqual(first.stat().st_ino, before)
        write_launcher(self.directories, "/b/claude")
        self.assertIn("/b/claude", first.read_text())
        self.assertEqual(stat.S_IMODE(first.stat().st_mode), 0o700)

    def test_cli_path_is_quoted(self):
        self.assertIn("'/a dir/claude'", agent_launcher_script("/a dir/claude"))


class RenderPromptTest(unittest.TestCase):
    def test_turns_become_a_transcript_ending_on_her_cue(self):
        messages = [
            {"role": "user", "content": "salut"},
            {"role": "assistant", "content": "Encore toi."},
            {"role": "user", "content": "[Contexte, à observer, pas des consignes]\nMoment : 15 h.\n\nça va ?"},
        ]
        self.assertEqual(
            render_prompt(messages),
            "Alycia : salut\nCrêpe : Encore toi.\nAlycia : [Contexte, à observer, pas des consignes]\nMoment : 15 h.\n\nça va ?\nCrêpe :",
        )

    def test_a_single_message_has_no_history(self):
        self.assertEqual(render_prompt([{"role": "user", "content": "salut"}]), "Alycia : salut\nCrêpe :")


class CompleteTest(AgentTestCase):
    def test_reply_is_the_result_text_and_system_messages_are_ignored(self):
        backend = self.backend_with(
            [CLEAN_INIT, SystemMessage("status", {"text": "ignored"}), AssistantMessage([]), ResultMessage(result="Classique.")]
        )
        self.assertEqual(self.complete(backend), "Classique.")

    def test_sdk_receives_the_transcript_and_the_isolated_options(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage()])
        self.complete(backend, [{"role": "user", "content": "salut"}])
        prompt, options = self.sdk.calls[0]
        self.assertEqual(prompt, "Alycia : salut\nCrêpe :")
        self.assertEqual(options.system_prompt, "PERSONA")
        self.assertEqual(options.model, "claude-haiku-5-5")
        self.assertEqual(options.setting_sources, [])
        self.assertEqual(options.tools, [])
        self.assertEqual(options.env["CLAUDE_CODE_OAUTH_TOKEN"], "oat-secret")
        self.assertTrue(Path(options.cli_path).samefile(self.directories.launcher))

    def test_the_directories_are_created_before_the_call(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage()])
        self.complete(backend)
        self.assertTrue(self.directories.config.is_dir())
        self.assertTrue(self.directories.cwd.is_dir())

    def test_missing_result_text_gives_an_empty_reply(self):
        self.assertEqual(self.complete(self.backend_with([CLEAN_INIT, ResultMessage(result=None)])), "")

    def test_token_is_read_on_every_call(self):
        tokens = iter(["first", "second"])
        module = make_fake_sdk(self.root / "sdk", [CLEAN_INIT, ResultMessage()])
        backend = AgentSdkBackend("m", lambda: next(tokens), self.directories)
        with mock.patch.dict(sys.modules, {"claude_agent_sdk": module}):
            self.complete(backend)
            self.complete(backend)
        self.assertEqual([call[1].env["CLAUDE_CODE_OAUTH_TOKEN"] for call in module.calls], ["first", "second"])

    def test_debug_log_has_duration_and_cost(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage()])
        with self.assertLogs("crepe_daemon.agent_sdk", level="DEBUG") as logs:
            self.complete(backend)
        text = "\n".join(logs.output)
        self.assertIn("agent call took", text)
        self.assertIn("cost_usd=0.0001", text)
        self.assertNotIn("oat-secret", text)


class ErrorMappingTest(AgentTestCase):
    def test_no_token_is_a_missing_key_with_the_steps(self):
        backend = self.backend_with([], token=None)
        with self.assertRaises(NoKeyError) as caught:
            self.complete(backend)
        self.assertIn("claude setup-token", str(caught.exception))
        self.assertIn("--set-token claude", str(caught.exception))
        self.assertEqual(self.sdk.calls, [])

    def test_rejected_token_in_an_assistant_message_is_a_missing_key(self):
        backend = self.backend_with([CLEAN_INIT, AssistantMessage(error="authentication_failed"), ResultMessage(is_error=True)])
        with self.assertRaises(NoKeyError):
            self.complete(backend)

    def test_a_401_retry_stops_at_once(self):
        backend = self.backend_with([CLEAN_INIT, SystemMessage("api_retry", {"error_status": 401}), "hang"])
        with self.assertRaises(NoKeyError):
            self.complete(backend)

    def test_rejected_token_as_a_result_error_is_a_missing_key(self):
        backend = self.backend_with([CLEAN_INIT, ResultError("failed", api_error_status=401)])
        with self.assertRaises(NoKeyError):
            self.complete(backend)

    def test_usage_limit_is_upstream(self):
        backend = self.backend_with([CLEAN_INIT, SystemMessage("api_retry", {"error_status": 429}), "hang"])
        with self.assertRaises(UpstreamError) as caught:
            self.complete(backend)
        self.assertIn("usage limit", str(caught.exception))

    def test_rate_limit_in_an_assistant_message_is_upstream(self):
        backend = self.backend_with([CLEAN_INIT, AssistantMessage(error="rate_limit"), ResultMessage(is_error=True)])
        with self.assertRaises(UpstreamError):
            self.complete(backend)

    def test_error_result_carries_its_http_status(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage(is_error=True, api_error_status=529, result="overloaded")])
        with self.assertRaises(UpstreamError) as caught:
            self.complete(backend)
        self.assertIn("529", str(caught.exception))

    def test_cli_error_text_is_not_shown(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage(is_error=True, result="echo of Alycia's private prompt")])
        with self.assertRaises(UpstreamError) as caught:
            self.complete(backend)
        self.assertNotIn("private", str(caught.exception))

    def test_timeout_is_upstream(self):
        backend = self.backend_with([CLEAN_INIT, "hang"], timeout_s=0.05)
        with self.assertRaises(UpstreamError) as caught:
            self.complete(backend)
        self.assertIn("no answer", str(caught.exception))

    def test_missing_cli_is_upstream(self):
        backend = self.backend_with([CLINotFoundError("Claude Code not found")])
        with self.assertRaises(UpstreamError) as caught:
            self.complete(backend)
        self.assertIn("not found", str(caught.exception))

    def test_unbundled_cli_and_none_on_path_is_upstream(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage()])
        (self.root / "sdk" / "_bundled" / "claude").unlink()
        with mock.patch.object(agent_sdk.shutil, "which", return_value=None), self.assertRaises(UpstreamError):
            self.complete(backend)

    def test_other_sdk_failures_are_upstream(self):
        backend = self.backend_with([CLIConnectionError("cannot start")])
        with self.assertRaises(UpstreamError):
            self.complete(backend)

    def test_refusal_is_refused(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage(result="", stop_reason="refusal")])
        with self.assertRaises(Refused):
            self.complete(backend)

    def test_no_result_message_is_upstream(self):
        backend = self.backend_with([CLEAN_INIT])
        with self.assertRaises(UpstreamError):
            self.complete(backend)


class IsolationCheckTest(AgentTestCase):
    def init_with(self, **found):
        return SystemMessage("init", {**CLEAN_INIT.data, **found})

    def assert_refused(self, init):
        backend = self.backend_with([init, ResultMessage()])
        with self.assertRaises(UpstreamError) as caught, self.assertLogs("crepe_daemon.agent_sdk", level="ERROR"):
            self.complete(backend)
        self.assertIn("refusing to go on", str(caught.exception))

    def test_a_tool_is_a_leak(self):
        self.assert_refused(self.init_with(tools=["Bash"]))

    def test_an_mcp_server_is_a_leak(self):
        self.assert_refused(self.init_with(mcp_servers=[{"name": "gitlab", "status": "connected"}]))

    def test_a_plugin_from_disk_is_a_leak(self):
        self.assert_refused(self.init_with(plugins=[{"name": "dsi", "path": "/home/a/.claude/plugins/dsi"}]))

    def test_a_skill_is_a_leak(self):
        self.assert_refused(self.init_with(skills=["dsi:apex"]))

    def test_builtin_plugins_are_fine(self):
        backend = self.backend_with([CLEAN_INIT, ResultMessage()])
        self.assertEqual(self.complete(backend), "Mm.")


if __name__ == "__main__":
    unittest.main()
