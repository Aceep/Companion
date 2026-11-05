"""What she remembers between runs: the last exchanges and today's request count."""

import json
import logging
import os
import tempfile
import threading
from datetime import date
from pathlib import Path
from typing import Callable

log = logging.getLogger(__name__)

MAX_EXCHANGES = 20
REMARK_PROMPT = "(remarque spontanée)"


def default_state_dir() -> Path:
    base = os.environ.get("XDG_STATE_HOME") or os.path.join(os.path.expanduser("~"), ".local", "state")
    return Path(base) / "crepe"


def atomic_write_json(path: Path, data: object) -> None:
    """Write next to the target then rename, so a crash never leaves half a file."""
    path.parent.mkdir(parents=True, exist_ok=True)
    descriptor, temp_name = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.", suffix=".tmp")
    try:
        with os.fdopen(descriptor, "w", encoding="utf-8") as handle:
            json.dump(data, handle, ensure_ascii=False, indent=1)
            handle.flush()
            os.fsync(handle.fileno())
        os.replace(temp_name, path)
    except BaseException:
        Path(temp_name).unlink(missing_ok=True)
        raise


def read_json(path: Path) -> object:
    try:
        with open(path, encoding="utf-8") as handle:
            return json.load(handle)
    except FileNotFoundError:
        return None
    except (OSError, json.JSONDecodeError) as error:
        log.warning("ignoring unreadable %s: %s", path, error)
        return None


class Memory:
    """The last MAX_EXCHANGES user/assistant pairs, persisted after every change."""

    def __init__(self, state_dir: Path | None = None, max_exchanges: int = MAX_EXCHANGES):
        self.path = (state_dir or default_state_dir()) / "history.json"
        self.max_exchanges = max_exchanges
        self._lock = threading.Lock()
        self._exchanges = self._load()

    def messages(self) -> list[dict]:
        """The history as alternating Messages API turns, oldest first."""
        with self._lock:
            turns = []
            for user_text, assistant_text in self._exchanges:
                turns.append({"role": "user", "content": user_text})
                turns.append({"role": "assistant", "content": assistant_text})
            return turns

    def __len__(self) -> int:
        with self._lock:
            return len(self._exchanges)

    def add(self, user_text: str, assistant_text: str) -> None:
        with self._lock:
            self._exchanges.append((user_text, assistant_text))
            del self._exchanges[: -self.max_exchanges]
            self._save()

    def add_remark(self, assistant_text: str) -> None:
        self.add(REMARK_PROMPT, assistant_text)

    def clear(self) -> None:
        with self._lock:
            self._exchanges = []
            self._save()

    def _save(self) -> None:
        data = [{"user": user_text, "assistant": assistant_text} for user_text, assistant_text in self._exchanges]
        atomic_write_json(self.path, data)

    def _load(self) -> list[tuple[str, str]]:
        data = read_json(self.path)
        if data is None:
            return []
        if not isinstance(data, list):
            log.warning("ignoring %s: not a list", self.path)
            return []
        exchanges = []
        for item in data:
            if (
                isinstance(item, dict)
                and isinstance(item.get("user"), str)
                and isinstance(item.get("assistant"), str)
                and item["user"]
                and item["assistant"]
            ):
                exchanges.append((item["user"], item["assistant"]))
        return exchanges[-self.max_exchanges :]


class DailyCounter:
    """Requests made today. Rolls over to zero on the first use of a new day."""

    def __init__(self, state_dir: Path | None = None, today: Callable[[], date] = date.today):
        self.path = (state_dir or default_state_dir()) / "requests.json"
        self._today = today
        self._lock = threading.Lock()
        self._date, self._count = self._load()

    @property
    def count(self) -> int:
        with self._lock:
            self._roll_over()
            return self._count

    def increment(self) -> int:
        with self._lock:
            self._roll_over()
            self._count += 1
            atomic_write_json(self.path, {"date": self._date.isoformat(), "count": self._count})
            return self._count

    def _roll_over(self) -> None:
        today = self._today()
        if today != self._date:
            self._date = today
            self._count = 0

    def _load(self) -> tuple[date, int]:
        today = self._today()
        data = read_json(self.path)
        if not isinstance(data, dict):
            return today, 0
        try:
            saved_date = date.fromisoformat(data["date"])
            count = data["count"]
        except (KeyError, TypeError, ValueError):
            return today, 0
        if saved_date != today or not isinstance(count, int) or count < 0:
            return today, 0
        return saved_date, count
