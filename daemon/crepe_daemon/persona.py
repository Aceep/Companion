"""Her system prompt, kept in persona.md next to this file."""

import re
from functools import cache
from pathlib import Path

PERSONA_PATH = Path(__file__).with_name("persona.md")
EXAMPLES_HEADING = "## Exemples"
_EXCHANGE = re.compile(r"^Alycia : (?P<user>.+)\nCrêpe : (?P<reply>.+)$", re.MULTILINE)


@cache
def system_prompt() -> str:
    """The persona, stable byte for byte so the prompt cache can reuse it."""
    return PERSONA_PATH.read_text(encoding="utf-8").strip()


def examples(prompt: str | None = None) -> list[tuple[str, str]]:
    """The (user, reply) example exchanges found after the examples heading."""
    prompt = prompt if prompt is not None else system_prompt()
    _, found, tail = prompt.partition(EXAMPLES_HEADING)
    if not found:
        return []
    return [(match["user"], match["reply"]) for match in _EXCHANGE.finditer(tail)]
