"""Backend that runs the persona through the Claude Agent SDK, on a subscription token.

The SDK drives the Claude Code CLI as a subprocess. That CLI normally loads the
user's whole setup (settings, hooks, plugins, MCP servers, memory), so every
call here is locked down: see agent_options() and agent_launcher_script().
"""

import asyncio
import gc
import logging
import os
import shlex
import shutil
import tempfile
import time
from pathlib import Path
from typing import Callable

from .brain import Refused
from .errors import NoKeyError, UpstreamError

log = logging.getLogger(__name__)

# The CLI starts a process and a TLS session per call; well past this the moment has passed.
AGENT_TIMEOUT_S = 60.0
MAX_TURNS = 1
# How long to wait for the CLI subprocess to be stopped once a call is over.
CLEANUP_TIMEOUT_S = 5.0
# Names of the speakers in persona.md's examples.
USER_LABEL = "Alycia"
ASSISTANT_LABEL = "Crêpe"
# HTTP statuses of a failing API call that mean "this token is not accepted".
AUTH_STATUSES = (401, 403)
RATE_LIMIT_STATUS = 429
# How the CLI reports the plugins it ships with.
BUILTIN_PLUGIN_PATH = "builtin"

TOKEN_ENV_VAR = "CLAUDE_CODE_OAUTH_TOKEN"
CONFIG_DIR_ENV_VAR = "CLAUDE_CONFIG_DIR"
NO_TOKEN_MESSAGE = "no subscription token: run `claude setup-token`, then python -m crepe_daemon --set-token claude"

# Set for the subprocess on top of the token and the directories. None of them
# changes what the model sees; they only switch off updates, telemetry, error
# reports, CLAUDE.md files, auto memory and the prompt history file.
QUIET_ENV = {
    "DISABLE_AUTOUPDATER": "1",
    "DISABLE_TELEMETRY": "1",
    "DISABLE_ERROR_REPORTING": "1",
    "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
    "CLAUDE_CODE_DISABLE_AUTO_MEMORY": "1",
    "CLAUDE_CODE_DISABLE_CLAUDE_MDS": "1",
    "CLAUDE_CODE_SKIP_PROMPT_HISTORY": "1",
    "CLAUDE_CODE_DISABLE_TERMINAL_TITLE": "1",
}
# What the launcher lets through from the daemon's own environment: locale,
# time zone, and the network settings a proxy or a private CA would need.
# Anything else, ANTHROPIC_* and cloud-provider switches first, is dropped.
INHERITED_ENV = (
    "PATH",
    "LANG",
    "LANGUAGE",
    "LC_ALL",
    "LC_CTYPE",
    "LC_MESSAGES",
    "TZ",
    "HTTPS_PROXY",
    "HTTP_PROXY",
    "NO_PROXY",
    "ALL_PROXY",
    "https_proxy",
    "http_proxy",
    "no_proxy",
    "all_proxy",
    "SSL_CERT_FILE",
    "SSL_CERT_DIR",
    "NODE_EXTRA_CA_CERTS",
)
# Added by the SDK itself to the subprocess environment.
SDK_ENV = ("CLAUDE_CODE_ENTRYPOINT", "CLAUDE_AGENT_SDK_VERSION", "CLAUDE_CODE_SDK_READS_SESSION_STATE", "PWD")


def default_data_dir() -> Path:
    base = os.environ.get("XDG_DATA_HOME") or os.path.join(os.path.expanduser("~"), ".local", "share")
    return Path(base) / "crepe"


class AgentDirectories:
    """The empty places the subprocess is confined to, all private to the user."""

    def __init__(self, data_dir: Path | None = None):
        root = data_dir or default_data_dir()
        # Holds the CLI's own state (and its session transcripts): nothing of the user's.
        self.config = root / "agent-config"
        # The working directory: never a repo.
        self.cwd = root / "agent-cwd"
        # HOME of the subprocess, so even a path that ignores CLAUDE_CONFIG_DIR finds nothing.
        self.home = root / "agent-home"
        self.launcher = root / "agent-launcher"

    def create(self) -> None:
        for directory in (self.config, self.cwd, self.home):
            directory.parent.mkdir(parents=True, exist_ok=True)
            directory.mkdir(mode=0o700, exist_ok=True)
            # mkdir's mode is masked by umask and ignored for an existing directory.
            directory.chmod(0o700)


def subprocess_env(token: str, directories: AgentDirectories) -> dict[str, str]:
    """The variables set explicitly on the subprocess, on top of the launcher's allowlist."""
    return {
        TOKEN_ENV_VAR: token,
        CONFIG_DIR_ENV_VAR: str(directories.config),
        "HOME": str(directories.home),
        **QUIET_ENV,
    }


def agent_launcher_script(cli_path: str) -> str:
    """A shell script that starts the CLI from an empty environment.

    The SDK merges its env option over the daemon's own environment, so an
    ANTHROPIC_API_KEY, ANTHROPIC_BASE_URL or cloud-provider variable in the
    daemon's environment would reach the CLI, and the CLI gives them
    precedence over the subscription token. env -i with an allowlist is the
    only way to leave them out.
    """
    allowed = [*INHERITED_ENV, TOKEN_ENV_VAR, CONFIG_DIR_ENV_VAR, "HOME", *QUIET_ENV, *SDK_ENV]
    # ${NAME+"NAME=$NAME"} expands to the assignment only when NAME is set.
    assignments = " \\\n  ".join(f'${{{name}+"{name}=${name}"}}' for name in allowed)
    return f"#!/bin/sh\nexec /usr/bin/env -i \\\n  {assignments} \\\n  {shlex.quote(cli_path)} \"$@\"\n"


def write_launcher(directories: AgentDirectories, cli_path: str) -> str:
    """Install the launcher script if it is missing or outdated; return its path."""
    script = agent_launcher_script(cli_path)
    path = directories.launcher
    try:
        if path.read_text(encoding="utf-8") == script and os.access(path, os.X_OK):
            return str(path)
    except FileNotFoundError:
        pass
    descriptor, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            handle.write(script)
        os.chmod(temp_name, 0o700)
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise
    return str(path)


def bundled_cli_path(sdk_module) -> str | None:
    """The CLI shipped inside the SDK wheel, else a `claude` found on PATH."""
    bundled = Path(sdk_module.__file__).parent / "_bundled" / "claude"
    if bundled.is_file():
        return str(bundled)
    return shutil.which("claude")


def render_prompt(messages: list[dict]) -> str:
    """The memory turns and the current message as one transcript, ready for the next reply.

    The query takes a single prompt, so the turns become the "Alycia : ..." /
    "Crêpe : ..." lines the persona's examples use, ending on her cue.
    """
    labels = {"user": USER_LABEL, "assistant": ASSISTANT_LABEL}
    lines = [f"{labels[message['role']]} : {message['content']}" for message in messages]
    lines.append(f"{ASSISTANT_LABEL} :")
    return "\n".join(lines)


def agent_options(
    sdk_module,
    model: str,
    system: str,
    token: str,
    directories: AgentDirectories,
    cli_path: str,
):
    """The options of one call: no settings, hooks, plugins, MCP servers or tools."""
    return sdk_module.ClaudeAgentOptions(
        model=model,
        # A plain string replaces Claude Code's own prompt: the persona only.
        system_prompt=system,
        cwd=directories.cwd,
        cli_path=cli_path,
        env=subprocess_env(token, directories),
        # [] loads no user, project or local settings file, so no hooks either.
        setting_sources=[],
        plugins=[],
        agents={},
        # [] removes every built-in tool; allowed_tools would only pre-approve some.
        tools=[],
        allowed_tools=[],
        mcp_servers={},
        # Ignore any MCP configuration the CLI would find by itself.
        strict_mcp_config=True,
        max_turns=MAX_TURNS,
        # Never asks: whatever is not pre-approved is denied.
        permission_mode="dontAsk",
        extra_args={
            # No skill, no slash command, not even the CLI's own.
            "disable-slash-commands": None,
            # No transcript of the exchange on disk.
            "no-session-persistence": None,
        },
        # The prompt carries window titles: no @file expansion, no slash command.
        verbatim_prompts=True,
    )


class AgentSdkBackend:
    def __init__(
        self,
        model: str,
        token_provider: Callable[[], str | None],
        directories: AgentDirectories | None = None,
        timeout_s: float = AGENT_TIMEOUT_S,
    ):
        self.model = model
        self._token_provider = token_provider
        self._directories = directories or AgentDirectories()
        self._timeout_s = timeout_s

    def complete(self, system: str, messages: list[dict]) -> str:
        # Imported here so --fake and the unit tests run without the SDK.
        import claude_agent_sdk

        token = self._token_provider()
        if not token:
            raise NoKeyError(NO_TOKEN_MESSAGE)
        self._directories.create()
        cli_path = bundled_cli_path(claude_agent_sdk)
        if cli_path is None:
            raise UpstreamError("Claude Code CLI not found")
        launcher = write_launcher(self._directories, cli_path)
        options = agent_options(claude_agent_sdk, self.model, system, token, self._directories, launcher)

        started = time.monotonic()
        try:
            # Runs on the brain worker thread, which has no event loop of its own.
            result = _run_in_fresh_loop(
                asyncio.wait_for(self._run(claude_agent_sdk, render_prompt(messages), options), self._timeout_s)
            )
        except TimeoutError as error:
            raise UpstreamError(f"no answer after {self._timeout_s:g} s") from error
        except claude_agent_sdk.CLINotFoundError as error:
            raise UpstreamError("Claude Code CLI not found") from error
        except claude_agent_sdk.CLIConnectionError as error:
            raise UpstreamError("cannot start the Claude Code CLI") from error
        except claude_agent_sdk.ResultError as error:
            raise _error_for_status(error.api_error_status, error.result or "") from error
        except claude_agent_sdk.ClaudeSDKError as error:
            raise UpstreamError("the Claude Code CLI failed") from error
        finally:
            log.debug("agent call took %.2f s", time.monotonic() - started)

        log.debug(
            "agent result: cost_usd=%s (an estimate) usage=%s stop=%s",
            result.total_cost_usd,
            result.usage,
            result.stop_reason,
        )
        return self._reply_of(result)

    async def _run(self, sdk_module, prompt: str, options):
        """Stream the messages and return the final result message."""
        result = None
        stream = sdk_module.query(prompt=prompt, options=options)
        try:
            async for message in stream:
                if isinstance(message, sdk_module.SystemMessage):
                    if message.subtype == "init":
                        _check_isolation(message.data)
                    elif message.subtype == "api_retry":
                        _stop_on_retry(message.data)
                elif isinstance(message, sdk_module.AssistantMessage):
                    if message.error:
                        raise _error_for_assistant(message.error)
                elif isinstance(message, sdk_module.ResultMessage):
                    result = message
        finally:
            # Closing the stream is what stops the subprocess when the call is cancelled.
            await stream.aclose()
        if result is None:
            raise UpstreamError("the Claude Code CLI ended without an answer")
        return result

    @staticmethod
    def _reply_of(result) -> str:
        if result.stop_reason == "refusal":
            raise Refused()
        if result.is_error:
            raise _error_for_status(result.api_error_status, result.result or "")
        return result.result or ""


def _run_in_fresh_loop(coroutine):
    """asyncio.run, but letting the SDK finish stopping its subprocess before the loop closes."""
    loop = asyncio.new_event_loop()
    try:
        return loop.run_until_complete(coroutine)
    finally:
        # An abandoned SDK generator is closed by a task the loop schedules when it is
        # collected; closing the loop first fails with "Event loop is closed" on stderr.
        gc.collect()
        loop.run_until_complete(_settle())
        loop.run_until_complete(loop.shutdown_asyncgens())
        loop.close()


async def _settle() -> None:
    await asyncio.sleep(0)
    pending = asyncio.all_tasks() - {asyncio.current_task()}
    if pending:
        await asyncio.wait(pending, timeout=CLEANUP_TIMEOUT_S)


def _check_isolation(init: dict) -> None:
    """Stop if the CLI reports anything of the user's setup: better no answer than a leaky one.

    The CLI always lists its own built-in plugins; only tools, MCP servers,
    skills and plugins that come from somewhere else are a leak.
    """
    leaks = {
        "tools": init.get("tools"),
        "skills": init.get("skills"),
        "mcp_servers": init.get("mcp_servers"),
        "plugins": [plugin for plugin in init.get("plugins") or [] if plugin.get("path") != BUILTIN_PLUGIN_PATH],
    }
    for key, found in leaks.items():
        if found:
            log.error("isolation check failed: the CLI loaded %s: %s", key, found)
            raise UpstreamError(f"the Claude Code CLI loaded {key}, refusing to go on")


def _stop_on_retry(retry: dict) -> None:
    """The CLI retries failed calls for a long while; a rejected token or a spent quota will not get better."""
    status = retry.get("error_status")
    if status in AUTH_STATUSES or status == RATE_LIMIT_STATUS:
        raise _error_for_status(status, "")


def _error_for_status(status: int | None, text: str) -> Exception:
    if status in AUTH_STATUSES:
        return NoKeyError("the subscription token was rejected: run `claude setup-token` again, then --set-token claude")
    if status == RATE_LIMIT_STATUS:
        return UpstreamError("subscription usage limit reached, try again later")
    if status is not None:
        return UpstreamError(f"API error, HTTP {status}")
    # No status: the CLI failed before reaching the API. Its text is not shown (it may echo input).
    log.debug("agent error without status: %s", text[:200])
    return UpstreamError("the Claude Code CLI reported an error")


def _error_for_assistant(kind: str) -> Exception:
    if kind == "authentication_failed":
        return NoKeyError("the subscription token was rejected: run `claude setup-token` again, then --set-token claude")
    if kind in ("rate_limit", "billing_error"):
        return UpstreamError("subscription usage limit reached, try again later")
    return UpstreamError(f"agent error: {kind}")
