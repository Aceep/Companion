"""Local git repos with work left uncommitted or unpushed for too long. Read-only."""

import logging
import os
import subprocess
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Callable

from ..config import GitConfig
from .base import Nudge, NudgeSender, StateStore, Watcher

log = logging.getLogger(__name__)

KIND = "travail_non_commite"
MAX_REPOS = 50
MAX_NUDGES_PER_LOOK = 2
GIT_TIMEOUT_S = 10
BASENAME_CHARS = 30
# Read-only: no optional index refresh, no prompt, and no fsmonitor hook,
# which a repo's config could point at any command.
GIT_ENV = {"GIT_OPTIONAL_LOCKS": "0", "GIT_TERMINAL_PROMPT": "0", "LC_ALL": "C"}
GIT_PREFIX = ("git", "-c", "core.fsmonitor=false", "--no-pager")


class GitError(Exception):
    """git could not run or exited non-zero. The message is safe to log."""


# run_git(repo, args) -> stdout. Raises GitError.
GitRunner = Callable[[Path, list[str]], str]


def run_git(repo: Path, args: list[str]) -> str:
    try:
        completed = subprocess.run(
            [*GIT_PREFIX, "-C", str(repo), *args],
            capture_output=True,
            timeout=GIT_TIMEOUT_S,
            env={**os.environ, **GIT_ENV},
            stdin=subprocess.DEVNULL,
            check=False,
        )
    except FileNotFoundError:
        raise GitError("git is not installed") from None
    except subprocess.TimeoutExpired:
        raise GitError(f"git {args[0]} took more than {GIT_TIMEOUT_S} s") from None
    except OSError as error:
        raise GitError(f"cannot run git: {error}") from None
    if completed.returncode != 0:
        message = completed.stderr.decode("utf-8", "replace").strip().splitlines()
        raise GitError(f"git {args[0]} failed: {message[-1] if message else completed.returncode}")
    return completed.stdout.decode("utf-8", "replace")


@dataclass(frozen=True)
class RepoStatus:
    changed_files: int
    # Oldest mtime among modified tracked files that still exist; None if none.
    oldest_change: float | None
    # None when the branch has no upstream.
    unpushed_commits: int | None


class GitWatcher(Watcher):
    name = "git"

    def __init__(
        self,
        config: GitConfig,
        nudge: NudgeSender,
        state: StateStore,
        run: GitRunner = run_git,
        now: Callable[[], float] = time.time,
        **kwargs,
    ):
        super().__init__(config.interval_minutes * 60, None, nudge, state, **kwargs)
        self.config = config
        self._run = run
        self._now = now
        self._nag_after_s = config.nag_after_minutes * 60
        # Each broken path or repo is reported once per run, not at every look.
        self._reported: set[str] = set()

    def poll(self, token: str | None) -> list[Nudge]:
        now = self._now()
        saved = self.state.get(self.name).get("repos")
        saved = saved if isinstance(saved, dict) else {}
        repos: dict[str, dict] = {}
        candidates: list[tuple[float, Nudge, str, str]] = []

        for repo in self._find_repos():
            key = str(repo)
            status = self._status(repo)
            if status is None:
                # A passing git failure must not restart the dirty clock.
                if isinstance(saved.get(key), dict):
                    repos[key] = saved[key]
                continue
            entry = _track(saved.get(key), status, now)
            if not entry:
                continue
            repos[key] = entry
            candidates.extend(self._due_nudges(repo, key, entry, status, now))

        nudges = []
        # Oldest work first; anything over the cap stays due for the next look.
        for _since, nudge, key, field in sorted(candidates, key=lambda candidate: candidate[0])[:MAX_NUDGES_PER_LOOK]:
            repos[key][field] = now
            nudges.append(nudge)
        self.state.put(self.name, {"repos": repos})
        return nudges

    def _due_nudges(
        self, repo: Path, key: str, entry: dict, status: RepoStatus, now: float
    ) -> list[tuple[float, Nudge, str, str]]:
        label = _clip(repo.name or key, BASENAME_CHARS)
        due = []
        dirty_since = entry.get("dirty_since")
        if dirty_since is not None:
            since = min(dirty_since, status.oldest_change) if status.oldest_change is not None else dirty_since
            if self._is_due(since, entry.get("nagged_at"), now):
                text = f"{label} · {_plural(status.changed_files, 'fichier')} · {_age(now - since)}"
                due.append((since, (KIND, text), key, "nagged_at"))
        unpushed_since = entry.get("unpushed_since")
        if unpushed_since is not None and self._is_due(unpushed_since, entry.get("unpushed_nagged_at"), now):
            count = status.unpushed_commits or 0
            text = f"{label} · {count} commit{'s' if count > 1 else ''} pas poussé{'s' if count > 1 else ''}"
            due.append((unpushed_since, (KIND, text), key, "unpushed_nagged_at"))
        return due

    def _is_due(self, since: float, last_nag: float | None, now: float) -> bool:
        if now - since < self._nag_after_s:
            return False
        return last_nag is None or now - last_nag >= self._nag_after_s

    def _find_repos(self) -> list[Path]:
        repos: list[Path] = []
        for configured in self.config.paths:
            path = Path(configured)
            if _is_repo(path):
                repos.append(path)
                continue
            children = self._child_repos(path)
            if not children:
                self._report_once(configured, f"git: {configured} is not a repo nor a folder of repos, skipped")
            repos.extend(children)
        unique = list(dict.fromkeys(repos))
        if len(unique) > MAX_REPOS:
            self._report_once("max-repos", f"git: {len(unique)} repos found, only the first {MAX_REPOS} are watched")
        return unique[:MAX_REPOS]

    def _child_repos(self, folder: Path) -> list[Path]:
        try:
            children = sorted(child for child in folder.iterdir() if child.is_dir())
        except OSError:
            return []
        return [child for child in children if _is_repo(child)]

    def _status(self, repo: Path) -> RepoStatus | None:
        try:
            porcelain = self._run(repo, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"])
        except GitError as error:
            self._report_once(str(repo), f"git: {repo} skipped: {error}")
            return None
        entries = _parse_porcelain(porcelain)
        return RepoStatus(
            changed_files=len(entries),
            oldest_change=_oldest_mtime(repo, entries),
            unpushed_commits=self._unpushed(repo),
        )

    def _unpushed(self, repo: Path) -> int | None:
        try:
            output = self._run(repo, ["rev-list", "--count", "@{upstream}..HEAD"])
        except GitError as error:
            # Status just worked, so this is a branch without upstream or a detached HEAD.
            log.debug("git: %s has no upstream: %s", repo, error)
            return None
        try:
            return int(output.strip())
        except ValueError:
            return None

    def _report_once(self, key: str, message: str) -> None:
        if key in self._reported:
            return
        self._reported.add(key)
        log.warning("%s", message)


def _track(previous: object, status: RepoStatus, now: float) -> dict:
    """The saved entry of a repo after this look: since when it is dirty or ahead, and the last nags."""
    previous = previous if isinstance(previous, dict) else {}
    entry: dict = {}
    if status.changed_files:
        entry["dirty_since"] = _number(previous.get("dirty_since"), now)
        if _number(previous.get("nagged_at"), None) is not None:
            entry["nagged_at"] = previous["nagged_at"]
    if status.unpushed_commits:
        entry["unpushed_since"] = _number(previous.get("unpushed_since"), now)
        if _number(previous.get("unpushed_nagged_at"), None) is not None:
            entry["unpushed_nagged_at"] = previous["unpushed_nagged_at"]
    return entry


def _parse_porcelain(output: str) -> list[tuple[str, str]]:
    """(XY status, path) pairs from `git status --porcelain=v1 -z --no-renames`."""
    entries = []
    for record in output.split("\0"):
        if len(record) > 3:
            entries.append((record[:2], record[3:]))
    return entries


def _oldest_mtime(repo: Path, entries: list[tuple[str, str]]) -> float | None:
    oldest = None
    for code, relative in entries:
        if code == "??" or "D" in code:
            continue
        try:
            mtime = (repo / relative).stat().st_mtime
        except OSError:
            continue
        oldest = mtime if oldest is None else min(oldest, mtime)
    return oldest


def _is_repo(path: Path) -> bool:
    # `.git` is a file in worktrees and submodules.
    return (path / ".git").exists()


def _age(seconds: float) -> str:
    minutes = int(seconds // 60)
    if minutes < 60:
        return f"{minutes} min"
    return f"{minutes // 60} h"


def _plural(count: int, word: str) -> str:
    return f"{count} {word}{'s' if count > 1 else ''}"


def _number(value: object, default: float | None) -> float | None:
    return value if isinstance(value, (int, float)) and not isinstance(value, bool) else default


def _clip(text: str, limit: int) -> str:
    return text if len(text) <= limit else text[: limit - 1] + "…"
