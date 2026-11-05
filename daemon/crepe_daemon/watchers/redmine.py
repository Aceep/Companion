"""Open Redmine issues assigned to the key's owner."""

import logging
from datetime import datetime
from typing import Callable

from ..config import RedmineConfig
from .base import Nudge, NudgeSender, StateStore, TokenLookup, Watcher, WatcherError, remember_ids
from .http import Transport, build_url

log = logging.getLogger(__name__)

MAX_NEW_ISSUE_NUDGES = 2
SUBJECT_CHARS = 40
# Her morning lines can mention the count: sent once a day from this hour on.
MORNING_HOUR = 7
ISSUE_QUERY = {"assigned_to_id": "me", "status_id": "open", "limit": 100, "sort": "updated_on:desc"}


class RedmineWatcher(Watcher):
    name = "redmine"
    token_hint = "--set-token redmine"

    def __init__(
        self,
        config: RedmineConfig,
        transport: Transport,
        token_lookup: TokenLookup,
        nudge: NudgeSender,
        state: StateStore,
        now: Callable[[], datetime] = datetime.now,
        **kwargs,
    ):
        super().__init__(config.interval_minutes * 60, token_lookup, nudge, state, **kwargs)
        self.config = config
        self._transport = transport
        self._now = now

    def poll(self, token: str) -> list[Nudge]:
        payload = self._transport.get_json(
            build_url(self.config.url, "/issues.json", ISSUE_QUERY),
            {"X-Redmine-API-Key": token},
        )
        issues, count = _parse_issues(payload)
        now = self._now()
        today = now.date().isoformat()
        state = self.state.get(self.name)
        first_look = not state.get("initialized")
        seen = [item for item in state.get("seen_ids", []) if isinstance(item, int)]
        seen_set = set(seen)

        nudges = []
        unseen = [issue for issue in issues if issue["id"] not in seen_set]
        if not first_look:
            # Most recently updated first; the others are only marked seen.
            for issue in unseen[:MAX_NEW_ISSUE_NUDGES]:
                nudges.append(("ticket_nouveau", f"#{issue['id']} {_clip(issue['subject'], SUBJECT_CHARS)}"))

        morning_day = state.get("morning_day")
        after_morning = now.hour >= MORNING_HOUR
        morning_due = after_morning and morning_day != today
        if first_look or count != state.get("last_count") or morning_due:
            nudges.append(("tickets_ouverts", str(count)))
            if after_morning:
                morning_day = today

        self.state.put(
            self.name,
            {
                "initialized": True,
                "seen_ids": remember_ids(seen, reversed([issue["id"] for issue in unseen])),
                "last_count": count,
                "morning_day": morning_day,
            },
        )
        return nudges


def _parse_issues(payload: object) -> tuple[list[dict], int]:
    if not isinstance(payload, dict) or not isinstance(payload.get("issues"), list):
        raise WatcherError("Redmine /issues.json has no issue list")
    issues = []
    for issue in payload["issues"]:
        if isinstance(issue, dict) and isinstance(issue.get("id"), int):
            subject = issue.get("subject")
            issues.append({"id": issue["id"], "subject": subject if isinstance(subject, str) else ""})
    total = payload.get("total_count")
    count = total if isinstance(total, int) and not isinstance(total, bool) and total >= 0 else len(issues)
    return issues, count


def _clip(text: str, limit: int) -> str:
    line = " ".join(text.split())
    if len(line) <= limit:
        return line
    return line[: limit - 1].rstrip() + "…"
