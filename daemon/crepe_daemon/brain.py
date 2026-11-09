"""Turns a message and its context into one short line in her voice."""

import logging
import random
import re
import zlib
from typing import Callable, Protocol

from .config import Config
from .context import Context, clip, parse_context, render_context
from .errors import BudgetError, NoKeyError, UpstreamError
from .memory import REMARK_PROMPT, DailyCounter, Memory
from .persona import system_prompt

log = logging.getLogger(__name__)

# Room for a short reply plus whatever little thinking low effort does.
MAX_TOKENS = 300
REQUEST_TIMEOUT_S = 20.0
# A chat line, not a document: longer text is cut rather than refused, so the
# extension never meets an error it has no line for.
MAX_ASK_CHARS = 500
# One retry: past that the moment has passed and a canned line does better.
MAX_RETRIES = 1
NOTHING_TO_SAY = "(rien)"
REFUSAL_LINES = ("Non.", "Pas ça.", "Je passe.", "Mm. Non.", "Sans moi.")
EMPTY_REPLY_LINES = ("Mm.", "…", "Je dis rien.")
FAKE_PREFIX = "[fake] "
FAKE_LINES = ("Mm.", "Encore toi.", "Je note.", "Classique.", "Huit bras et rien à faire.")

QUOTE_CHARS = "\"'«»“”„‘’`"
SPACE_CHARS = " \t  "
SPEAKER_LABEL = re.compile(r"^\s*crêpe\s*:\s*", re.IGNORECASE)
SENTENCE_END = re.compile(r"[.!?…](?=\s|$)")


class Refused(Exception):
    """The model declined to answer; she says no in her own words instead."""


class Backend(Protocol):
    def complete(self, system: str, messages: list[dict]) -> str:
        """Return the raw reply text. Raises BrainError subclasses or Refused."""
        ...


class AnthropicBackend:
    def __init__(self, model: str, key_provider: Callable[[], str | None]):
        self.model = model
        self._key_provider = key_provider
        self._client = None
        self._client_key: str | None = None

    def complete(self, system: str, messages: list[dict]) -> str:
        # Imported here so --fake and the unit tests run without the SDK.
        import anthropic

        client = self._client_for(self._key_provider(), anthropic)
        try:
            response = client.messages.create(
                model=self.model,
                max_tokens=MAX_TOKENS,
                output_config={"effort": "low"},
                system=[{"type": "text", "text": system, "cache_control": {"type": "ephemeral"}}],
                messages=messages,
            )
        except anthropic.AuthenticationError as error:
            raise NoKeyError("the API key was rejected") from error
        except anthropic.RateLimitError as error:
            raise UpstreamError("rate limited, try again later") from error
        except anthropic.APIStatusError as error:
            raise UpstreamError(f"API error, HTTP {error.status_code}") from error
        except anthropic.APIConnectionError as error:
            raise UpstreamError("cannot reach the API") from error
        except anthropic.APIError as error:
            raise UpstreamError("unexpected API error") from error

        usage = response.usage
        log.debug(
            "usage: in=%s out=%s cache_read=%s cache_write=%s stop=%s",
            usage.input_tokens,
            usage.output_tokens,
            usage.cache_read_input_tokens,
            usage.cache_creation_input_tokens,
            response.stop_reason,
        )
        if response.stop_reason == "refusal":
            raise Refused()
        # With adaptive thinking a response may start with thinking blocks.
        return "".join(block.text for block in response.content if block.type == "text")

    def _client_for(self, key: str | None, anthropic_module):
        if not key:
            raise NoKeyError("no API key: run python -m crepe_daemon --set-key")
        if self._client is None or key != self._client_key:
            self._client = anthropic_module.Anthropic(api_key=key, timeout=REQUEST_TIMEOUT_S, max_retries=MAX_RETRIES)
            self._client_key = key
        return self._client


class FakeBackend:
    """Never calls the API: a canned line picked from the last user turn."""

    def complete(self, system: str, messages: list[dict]) -> str:
        last_user = messages[-1]["content"] if messages else ""
        index = zlib.crc32(last_user.encode("utf-8")) % len(FAKE_LINES)
        return FAKE_PREFIX + FAKE_LINES[index]


def postprocess(text: str, max_chars: int) -> str:
    """Make a raw reply fit the speech bubble: one line, no quotes, short."""
    text = " ".join(text.split())
    text = SPEAKER_LABEL.sub("", text)
    text = text.strip(QUOTE_CHARS + SPACE_CHARS)
    return cap_length(text, max_chars)


def cap_length(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    window = text[:max_chars]
    sentence_ends = [match.end() for match in SENTENCE_END.finditer(window)]
    # A sentence end too close to the start would throw most of the reply away.
    if sentence_ends and sentence_ends[-1] >= max_chars // 3:
        return window[: sentence_ends[-1]].rstrip()
    word_cut = text[: max_chars - 1].rsplit(" ", 1)[0].rstrip(" ,;:")
    if len(word_cut) >= max_chars // 3:
        return word_cut + "…"
    return text[: max_chars - 1] + "…"


class Brain:
    """Budget, memory and persona around a backend. Not thread-safe by itself:
    the service calls ask(), remark() and forget() from a single worker thread."""

    def __init__(self, config: Config, backend: Backend, memory: Memory, counter: DailyCounter):
        self.config = config
        self.backend = backend
        self.memory = memory
        self.counter = counter

    def ask(self, text: str, raw_context: str) -> str:
        context = parse_context(raw_context)
        user_text = clip(text, MAX_ASK_CHARS)
        if not user_text:
            return ""
        reply = self._complete(context, user_text, remember_as=user_text)
        return reply or random.choice(EMPTY_REPLY_LINES)

    def forget(self) -> None:
        self.memory.clear()
        log.info("memory cleared")

    def remark(self, raw_context: str) -> str:
        context = parse_context(raw_context)
        if not self.config.remarks or context.sleeping:
            return ""
        return self._complete(context, REMARK_PROMPT, remember_as=REMARK_PROMPT)

    def _complete(self, context: Context, user_text: str, remember_as: str) -> str:
        self._check_budget()
        rendered = render_context(context)
        current = f"{rendered}\n\n{user_text}" if rendered else user_text
        messages = self.memory.messages() + [{"role": "user", "content": current}]
        try:
            raw = self.backend.complete(system_prompt(), messages)
        except NoKeyError:
            raise
        except Refused:
            self.counter.increment()
            log.info("request declined, answering with a fallback line")
            # Not remembered: replaying a declined turn would only get declined again.
            return random.choice(REFUSAL_LINES)
        except UpstreamError:
            # It reached the API (or tried to): it counts against the budget.
            self.counter.increment()
            raise
        self.counter.increment()
        reply = postprocess(raw, self.config.max_reply_chars)
        if reply == NOTHING_TO_SAY:
            reply = ""
        if reply:
            self.memory.add(remember_as, reply)
        return reply

    def _check_budget(self) -> None:
        used = self.counter.count
        if used >= self.config.daily_budget:
            raise BudgetError(f"daily budget reached ({used}/{self.config.daily_budget})")
