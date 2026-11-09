import os
import shutil
import subprocess
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from crepe_daemon.config import GitConfig
from crepe_daemon.watchers import GitWatcher, StateStore
from crepe_daemon.watchers import git as git_module
from crepe_daemon.watchers.git import GitError, run_git

from .test_watchers import StateDirTestCase

NOW = 1_800_000_000.0
HOUR = 3600


class FakeGit:
    """Answers `git status` and `git rev-list` per repo; a GitError value is raised."""

    def __init__(self):
        self.status: dict[str, object] = {}
        self.unpushed: dict[str, object] = {}
        self.calls: list[tuple[str, list[str]]] = []

    def __call__(self, repo: Path, args: list[str]) -> str:
        self.calls.append((str(repo), args))
        table = self.status if args[0] == "status" else self.unpushed
        answer = table.get(str(repo), "" if args[0] == "status" else GitError("git rev-list failed: no upstream"))
        if isinstance(answer, Exception):
            raise answer
        return answer


def porcelain(*entries: str) -> str:
    return "".join(entry + "\0" for entry in entries)


class GitWatcherTestCase(StateDirTestCase):
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.git = FakeGit()
        self.clock = {"now": NOW}

    def repo(self, name: str, parent: Path | None = None) -> Path:
        path = (parent or self.root) / name
        (path / ".git").mkdir(parents=True)
        return path

    def touch(self, repo: Path, relative: str, age_s: float) -> None:
        path = repo / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text("x")
        os.utime(path, (NOW - age_s, NOW - age_s))

    def make(self, paths: list[Path], nag_after_minutes: float = 120, unpushed: bool = True) -> GitWatcher:
        return GitWatcher(
            GitConfig(paths=tuple(str(path) for path in paths), nag_after_minutes=nag_after_minutes, unpushed=unpushed),
            self.record_nudge,
            StateStore(),
            run=self.git,
            now=lambda: self.clock["now"],
        )


class UncommittedTest(GitWatcherTestCase):
    def test_old_modified_file_nags_with_name_count_and_hours(self):
        repo = self.repo("crepe")
        self.touch(repo, "src/a.py", 3 * HOUR)
        self.touch(repo, "b.py", 60)
        self.git.status[str(repo)] = porcelain(" M src/a.py", "M  b.py", "?? notes.txt")
        self.assertEqual(self.make([repo]).tick(), [("travail_non_commite", "crepe · 3 fichiers · 3 h")])

    def test_recent_changes_do_not_nag(self):
        repo = self.repo("crepe")
        self.touch(repo, "a.py", 10 * 60)
        self.git.status[str(repo)] = porcelain(" M a.py")
        self.assertEqual(self.make([repo]).tick(), [])

    def test_dirtiness_seen_long_enough_nags_in_minutes_under_an_hour(self):
        repo = self.repo("crepe")
        self.git.status[str(repo)] = porcelain("?? new.txt")
        watcher = self.make([repo], nag_after_minutes=30)
        watcher.tick()
        self.clock["now"] += 45 * 60
        self.assertEqual(watcher.tick(), [("travail_non_commite", "crepe · 1 fichier · 45 min")])

    def test_one_nudge_per_repo_per_window(self):
        repo = self.repo("crepe")
        self.touch(repo, "a.py", 3 * HOUR)
        self.git.status[str(repo)] = porcelain(" M a.py")
        watcher = self.make([repo])
        watcher.tick()
        self.clock["now"] += HOUR
        self.assertEqual(watcher.tick(), [])
        self.clock["now"] += HOUR
        self.assertEqual(len(watcher.tick()), 1)

    def test_commit_resets_the_dirty_clock(self):
        repo = self.repo("crepe")
        self.git.status[str(repo)] = porcelain("?? a.txt")
        watcher = self.make([repo], nag_after_minutes=60)
        watcher.tick()
        self.git.status[str(repo)] = ""
        self.clock["now"] += 50 * 60
        watcher.tick()
        self.git.status[str(repo)] = porcelain("?? b.txt")
        self.clock["now"] += 20 * 60
        self.assertEqual(watcher.tick(), [])

    def test_dirty_since_survives_a_restart(self):
        repo = self.repo("crepe")
        self.git.status[str(repo)] = porcelain("?? a.txt")
        self.make([repo]).tick()
        self.clock["now"] += 2 * HOUR
        self.assertEqual(self.make([repo]).tick(), [("travail_non_commite", "crepe · 1 fichier · 2 h")])

    def test_at_most_two_nudges_per_look_oldest_first(self):
        ages = {"a": 3, "b": 9, "c": 5}
        repos = []
        for name, hours in ages.items():
            repo = self.repo(name)
            self.touch(repo, "f.py", hours * HOUR)
            self.git.status[str(repo)] = porcelain(" M f.py")
            repos.append(repo)
        watcher = self.make(repos)
        self.assertEqual([text for _kind, text in watcher.tick()], ["b · 1 fichier · 9 h", "c · 1 fichier · 5 h"])
        self.assertEqual([text for _kind, text in watcher.tick()], ["a · 1 fichier · 3 h"])

    def test_untracked_and_deleted_files_do_not_date_the_changes(self):
        repo = self.repo("crepe")
        self.touch(repo, "old-untracked.txt", 9 * HOUR)
        self.git.status[str(repo)] = porcelain("?? old-untracked.txt", " D gone.py")
        self.assertEqual(self.make([repo]).tick(), [])


class DiscoveryTest(GitWatcherTestCase):
    def test_folder_children_that_are_repos_are_watched(self):
        folder = self.root / "perso"
        first = self.repo("one", folder)
        (folder / "not-a-repo").mkdir()
        second = self.repo("two", folder)
        self.make([folder]).tick()
        self.assertEqual([repo for repo, _args in self.git.calls if _args[0] == "status"], [str(first), str(second)])

    def test_path_that_is_no_repo_is_logged_once_and_skipped(self):
        missing = self.root / "nowhere"
        watcher = self.make([missing])
        with self.assertLogs("crepe_daemon.watchers.git", level="WARNING") as logs:
            self.assertEqual(watcher.tick(), [])
            watcher.tick()
        self.assertEqual(len(logs.output), 1)

    def test_git_failure_is_logged_once_and_keeps_the_dirty_clock(self):
        repo = self.repo("crepe")
        self.git.status[str(repo)] = porcelain("?? a.txt")
        watcher = self.make([repo])
        watcher.tick()
        self.git.status[str(repo)] = GitError("git status failed: dubious ownership")
        with self.assertLogs("crepe_daemon.watchers.git", level="WARNING") as logs:
            watcher.tick()
            watcher.tick()
        self.assertEqual(len(logs.output), 1)
        self.git.status[str(repo)] = porcelain("?? a.txt")
        self.clock["now"] += 2 * HOUR
        self.assertEqual(len(watcher.tick()), 1)

    def test_no_more_than_fifty_repos_are_watched(self):
        folder = self.root / "many"
        for index in range(55):
            self.repo(f"r{index:02d}", folder)
        with self.assertLogs("crepe_daemon.watchers.git", level="WARNING"):
            self.make([folder]).tick()
        self.assertEqual(len([call for call in self.git.calls if call[1][0] == "status"]), 50)


class UnpushedTest(GitWatcherTestCase):
    def test_unpushed_commits_nag_after_the_window(self):
        repo = self.repo("crepe")
        self.git.unpushed[str(repo)] = "3\n"
        watcher = self.make([repo])
        self.assertEqual(watcher.tick(), [])
        self.clock["now"] += 2 * HOUR
        self.assertEqual(watcher.tick(), [("travail_non_commite", "crepe · 3 commits pas poussés")])

    def test_unpushed_commits_are_quiet_when_turned_off(self):
        repo = self.repo("crepe")
        self.git.unpushed[str(repo)] = "3\n"
        watcher = self.make([repo], unpushed=False)
        watcher.tick()
        self.clock["now"] += 3 * HOUR
        self.assertEqual(watcher.tick(), [])

    def test_branch_without_upstream_is_quiet(self):
        repo = self.repo("crepe")
        watcher = self.make([repo])
        watcher.tick()
        self.clock["now"] += 3 * HOUR
        self.assertEqual(watcher.tick(), [])


class RunGitTest(unittest.TestCase):
    def test_git_runs_read_only_with_a_timeout(self):
        completed = subprocess.CompletedProcess([], 0, stdout=b"", stderr=b"")
        with mock.patch.object(git_module.subprocess, "run", return_value=completed) as run:
            run_git(Path("/repo"), ["status", "--porcelain=v1"])
        args, kwargs = run.call_args
        self.assertEqual(args[0][:4], ["git", "-c", "core.fsmonitor=false", "--no-pager"])
        self.assertEqual(kwargs["env"]["GIT_OPTIONAL_LOCKS"], "0")
        self.assertEqual(kwargs["timeout"], 10)

    def test_non_zero_exit_raises_with_the_last_stderr_line(self):
        completed = subprocess.CompletedProcess([], 128, stdout=b"", stderr=b"fatal: not a git repository\n")
        with mock.patch.object(git_module.subprocess, "run", return_value=completed):
            with self.assertRaisesRegex(GitError, "not a git repository"):
                run_git(Path("/repo"), ["status"])

    def test_timeout_raises_a_git_error(self):
        with mock.patch.object(git_module.subprocess, "run", side_effect=subprocess.TimeoutExpired("git", 10)):
            with self.assertRaisesRegex(GitError, "more than 10 s"):
                run_git(Path("/repo"), ["status"])

    @unittest.skipUnless(shutil.which("git"), "git is not installed")
    def test_real_status_counts_changes_in_a_scratch_repo(self):
        isolated = {"GIT_CONFIG_GLOBAL": os.devnull, "GIT_CONFIG_SYSTEM": os.devnull}
        with tempfile.TemporaryDirectory() as directory, mock.patch.dict(os.environ, isolated):
            repo = Path(directory)
            subprocess.run(["git", "init", "-q", str(repo)], check=True)
            (repo / ".gitignore").write_text("*.log\n")
            (repo / "debug.log").write_text("ignored")
            (repo / "new.txt").write_text("untracked")
            output = run_git(repo, ["status", "--porcelain=v1", "-z", "--no-renames", "--untracked-files=normal"])
        self.assertEqual(sorted(record[3:] for record in output.split("\0") if record), [".gitignore", "new.txt"])


if __name__ == "__main__":
    unittest.main()
