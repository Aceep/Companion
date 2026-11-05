"""Failed pipelines on a GitLab instance, read with a read_api token."""

import logging
import urllib.parse
from datetime import datetime, timedelta, timezone
from typing import Callable

from ..config import GitlabConfig
from .base import Nudge, NudgeSender, StateStore, TokenLookup, Watcher, WatcherError, remember_ids
from .http import Transport, build_url

log = logging.getLogger(__name__)

# Keeps a tick to a few dozen requests when no project list is configured.
MAX_MEMBER_PROJECTS = 30
PIPELINES_PER_PAGE = 20
# updated_after is compared with the server clock; overlap and let seen ids dedupe.
UPDATED_AFTER_MARGIN = timedelta(minutes=10)


class GitlabWatcher(Watcher):
    name = "gitlab"
    token_hint = "--set-token gitlab"

    def __init__(
        self,
        config: GitlabConfig,
        transport: Transport,
        token_lookup: TokenLookup,
        nudge: NudgeSender,
        state: StateStore,
        utcnow: Callable[[], datetime] = lambda: datetime.now(timezone.utc),
        **kwargs,
    ):
        super().__init__(config.interval_minutes * 60, token_lookup, nudge, state, **kwargs)
        self.config = config
        self._transport = transport
        self._utcnow = utcnow
        self._api = config.url + "/api/v4"
        # In memory only: the token owner and configured paths resolved to ids.
        self._owner: tuple[str, str] | None = None
        self._resolved_projects: dict[str, tuple[int, str]] = {}

    def poll(self, token: str) -> list[Nudge]:
        headers = {"PRIVATE-TOKEN": token}
        started_at = self._utcnow()
        state = self.state.get(self.name)
        first_look = not state.get("initialized")
        seen = [item for item in state.get("seen_ids", []) if isinstance(item, int)]
        seen_set = set(seen)
        updated_after = state.get("checked_at") if not first_look else None
        username = self._owner_username(token, headers) if self.config.only_mine else None

        nudges = []
        for project_id, project_name in self._projects(headers):
            params: dict[str, object] = {"status": "failed", "per_page": PIPELINES_PER_PAGE}
            if isinstance(updated_after, str):
                params["updated_after"] = updated_after
            if username:
                params["username"] = username
            pipelines = self._get_list(f"/projects/{project_id}/pipelines", params, headers)
            unseen = [
                pipeline
                for pipeline in pipelines
                if _pipeline_id(pipeline) is not None and _pipeline_id(pipeline) not in seen_set
            ]
            mine = [pipeline for pipeline in unseen if _triggered_by(pipeline, username)]
            if mine and not first_look:
                # Newest first: one nudge per project per tick, the rest only marked seen.
                nudges.append(("pipeline_echec", f"{project_name} · {mine[0].get('ref') or '?'}"))
            new_ids = [_pipeline_id(pipeline) for pipeline in unseen]
            seen = remember_ids(seen, reversed(new_ids))
            seen_set.update(new_ids)

        self.state.put(
            self.name,
            {
                "initialized": True,
                "seen_ids": seen,
                "checked_at": _iso(started_at - UPDATED_AFTER_MARGIN),
            },
        )
        return nudges

    def _owner_username(self, token: str, headers: dict[str, str]) -> str:
        if self._owner is None or self._owner[0] != token:
            user = self._get("/user", None, headers)
            username = user.get("username") if isinstance(user, dict) else None
            if not isinstance(username, str) or not username:
                raise WatcherError("GitLab /user has no username")
            self._owner = (token, username)
        return self._owner[1]

    def _projects(self, headers: dict[str, str]) -> list[tuple[int, str]]:
        if self.config.projects:
            return [self._resolve(path, headers) for path in self.config.projects]
        listing = self._get_list(
            "/projects",
            {"membership": "true", "simple": "true", "per_page": 100, "order_by": "last_activity_at"},
            headers,
        )
        return [_project_entry(project) for project in listing[:MAX_MEMBER_PROJECTS]]

    def _resolve(self, path: str, headers: dict[str, str]) -> tuple[int, str]:
        if path not in self._resolved_projects:
            project = self._get(f"/projects/{urllib.parse.quote(path, safe='')}", None, headers)
            self._resolved_projects[path] = _project_entry(project)
        return self._resolved_projects[path]

    def _get(self, path: str, params: dict[str, object] | None, headers: dict[str, str]) -> object:
        return self._transport.get_json(build_url(self._api, path, params), headers)

    def _get_list(self, path: str, params: dict[str, object], headers: dict[str, str]) -> list[dict]:
        payload = self._get(path, params, headers)
        if not isinstance(payload, list):
            raise WatcherError(f"GitLab {path} did not return a list")
        return [item for item in payload if isinstance(item, dict)]


def _project_entry(project: object) -> tuple[int, str]:
    if not isinstance(project, dict) or not isinstance(project.get("id"), int):
        raise WatcherError("GitLab returned a project without an id")
    name = project.get("name") or project.get("path_with_namespace") or str(project["id"])
    return project["id"], str(name)


def _pipeline_id(pipeline: dict) -> int | None:
    pipeline_id = pipeline.get("id")
    return pipeline_id if isinstance(pipeline_id, int) else None


def _triggered_by(pipeline: dict, username: str | None) -> bool:
    if username is None:
        return True
    # The username query parameter already filters; the list may not carry the user.
    user = pipeline.get("user")
    if not isinstance(user, dict) or "username" not in user:
        return True
    return user["username"] == username


def _iso(moment: datetime) -> str:
    return moment.astimezone(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
