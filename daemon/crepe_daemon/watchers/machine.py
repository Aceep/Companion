"""Disk, battery and load of this machine, from statvfs, /sys and /proc. Cheap and synchronous."""

import logging
import math
import os
import time
from pathlib import Path
from typing import Callable

from ..config import MachineConfig
from .base import Nudge, NudgeSender, StateStore, Watcher

log = logging.getLogger(__name__)

KIND = "machine"
# A disk hovering around the threshold would otherwise nudge at every look.
DISK_HYSTERESIS_POINTS = 3
DISK_REPEAT_S = 24 * 3600
# Charging is not always reported promptly; a clear gain also re-arms the warning.
BATTERY_REARM_POINTS = 10
POWER_SUPPLY_DIR = Path("/sys/class/power_supply")
LOADAVG_PATH = Path("/proc/loadavg")

# disk_usage(path) -> (mount point, used percent, device id). Raises OSError.
DiskUsage = Callable[[str], tuple[str, int, int]]


def disk_usage(path: str) -> tuple[str, int, int]:
    stats = os.statvfs(path)
    return _mount_point(path), used_percent(stats.f_blocks, stats.f_bfree, stats.f_bavail), os.stat(path).st_dev


def used_percent(blocks: int, free: int, available: int) -> int:
    """As df shows it: used over what non-root users can fill, rounded up."""
    used = blocks - free
    usable = used + available
    if usable <= 0:
        return 0
    return math.ceil(used * 100 / usable)


def _mount_point(path: str) -> str:
    current = os.path.realpath(path)
    while not os.path.ismount(current):
        current = os.path.dirname(current)
    return current


class MachineWatcher(Watcher):
    name = "machine"

    def __init__(
        self,
        config: MachineConfig,
        nudge: NudgeSender,
        state: StateStore,
        disk: DiskUsage = disk_usage,
        power_supply_dir: Path = POWER_SUPPLY_DIR,
        loadavg_path: Path = LOADAVG_PATH,
        cpu_count: Callable[[], int | None] = os.cpu_count,
        now: Callable[[], float] = time.time,
        **kwargs,
    ):
        super().__init__(config.interval_minutes * 60, None, nudge, state, **kwargs)
        self.config = config
        self._disk = disk
        self._power_supply_dir = power_supply_dir
        self._loadavg_path = loadavg_path
        self._cpu_count = cpu_count
        self._now = now
        # In memory only: a restart starts a new battery or load episode.
        self._battery_warned = False
        self._overloaded_since: float | None = None
        self._load_warned = False
        self._reported: set[str] = set()

    def poll(self, token: str | None) -> list[Nudge]:
        now = self._now()
        nudges = self._check_disks(now)
        nudges += self._check_battery()
        nudges += self._check_load(now)
        return nudges

    def _check_disks(self, now: float) -> list[Nudge]:
        saved = self.state.get(self.name).get("disks")
        saved = saved if isinstance(saved, dict) else {}
        disks: dict[str, dict] = {}
        nudges = []
        seen_devices: set[int] = set()
        for path in self.config.disk_paths:
            try:
                mount, percent, device = self._disk(path)
            except OSError as error:
                self._report_once(path, f"machine: cannot read disk usage of {path}: {error}")
                continue
            # "/" and "~" are often the same filesystem: one nudge, not two.
            if device in seen_devices:
                continue
            seen_devices.add(device)
            entry, due = self._disk_step(saved.get(mount), percent, now)
            disks[mount] = entry
            if due:
                nudges.append((KIND, f"disque {mount} {percent} %"))
        if disks != saved:
            self.state.put(self.name, {"disks": disks})
        return nudges

    def _disk_step(self, previous: object, percent: int, now: float) -> tuple[dict, bool]:
        previous = previous if isinstance(previous, dict) else {}
        alerted = previous.get("alerted") is True
        last_nudge = previous.get("last_nudge")
        last_nudge = last_nudge if isinstance(last_nudge, (int, float)) else None
        threshold = self.config.disk_percent
        if alerted and percent < threshold - DISK_HYSTERESIS_POINTS:
            return {"alerted": False}, False
        if percent < threshold:
            # Inside the hysteresis band: still alerted, nothing new to say.
            return ({"alerted": True, "last_nudge": last_nudge} if alerted else {"alerted": False}), False
        due = not alerted or last_nudge is None or now - last_nudge >= DISK_REPEAT_S
        return {"alerted": True, "last_nudge": now if due else last_nudge}, due

    def _check_battery(self) -> list[Nudge]:
        batteries = self._read_batteries()
        if not batteries:
            return []
        discharging = [capacity for capacity, status in batteries if status == "Discharging"]
        lowest = min(capacity for capacity, _status in batteries)
        threshold = self.config.battery_percent
        if not discharging or lowest > threshold + BATTERY_REARM_POINTS:
            self._battery_warned = False
            return []
        low = min(discharging)
        if low >= threshold or self._battery_warned:
            return []
        self._battery_warned = True
        return [(KIND, f"batterie {low} %")]

    def _read_batteries(self) -> list[tuple[int, str]]:
        try:
            supplies = sorted(self._power_supply_dir.glob("BAT*"))
        except OSError:
            return []
        batteries = []
        for supply in supplies:
            try:
                capacity = int((supply / "capacity").read_text().strip())
                status = (supply / "status").read_text().strip()
            except (OSError, ValueError):
                continue
            batteries.append((capacity, status))
        return batteries

    def _check_load(self, now: float) -> list[Nudge]:
        load = self._read_load()
        cpus = self._cpu_count() or 1
        if load is None or load <= cpus:
            self._overloaded_since = None
            self._load_warned = False
            return []
        if self._overloaded_since is None:
            self._overloaded_since = now
        minutes = int((now - self._overloaded_since) // 60)
        # Sampled once per look: "continuously" means at every look since then.
        if self._load_warned or now - self._overloaded_since < self.config.load_minutes * 60:
            return []
        self._load_warned = True
        return [(KIND, f"machine à genoux depuis {minutes} min")]

    def _read_load(self) -> float | None:
        try:
            return float(self._loadavg_path.read_text().split()[0])
        except (OSError, ValueError, IndexError) as error:
            self._report_once("loadavg", f"machine: cannot read {self._loadavg_path}: {error}")
            return None

    def _report_once(self, key: str, message: str) -> None:
        if key in self._reported:
            return
        self._reported.add(key)
        log.warning("%s", message)
