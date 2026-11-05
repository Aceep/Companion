import tempfile
import unittest
from pathlib import Path

from crepe_daemon.config import MachineConfig
from crepe_daemon.watchers import MachineWatcher, StateStore
from crepe_daemon.watchers.machine import used_percent

from .test_watchers import StateDirTestCase

NOW = 1_800_000_000.0
DAY = 24 * 3600


class FakeDisks:
    """path -> (mount, percent, device), or an OSError to raise."""

    def __init__(self):
        self.table: dict[str, object] = {}

    def __call__(self, path: str) -> tuple[str, int, int]:
        answer = self.table[path]
        if isinstance(answer, Exception):
            raise answer
        return answer


class MachineTestCase(StateDirTestCase):
    def setUp(self):
        super().setUp()
        directory = tempfile.TemporaryDirectory()
        self.addCleanup(directory.cleanup)
        self.root = Path(directory.name)
        self.power = self.root / "power_supply"
        self.power.mkdir()
        self.loadavg = self.root / "loadavg"
        self.set_load(0.5)
        self.disks = FakeDisks()
        self.clock = {"now": NOW}

    def make(self, **config) -> MachineWatcher:
        config.setdefault("disk_paths", ())
        return MachineWatcher(
            MachineConfig(**config),
            self.record_nudge,
            StateStore(),
            disk=self.disks,
            power_supply_dir=self.power,
            loadavg_path=self.loadavg,
            cpu_count=lambda: 4,
            now=lambda: self.clock["now"],
        )

    def set_load(self, one_minute: float) -> None:
        self.loadavg.write_text(f"{one_minute} 1.00 1.00 2/300 12345\n")

    def set_battery(self, capacity: int, status: str, name: str = "BAT0") -> None:
        battery = self.power / name
        battery.mkdir(exist_ok=True)
        (battery / "capacity").write_text(f"{capacity}\n")
        (battery / "status").write_text(f"{status}\n")


class DiskTest(MachineTestCase):
    def disk_watcher(self, percent: int) -> MachineWatcher:
        self.disks.table["/"] = ("/", percent, 1)
        return self.make(disk_paths=("/",), disk_percent=90)

    def set_percent(self, percent: int) -> None:
        self.disks.table["/"] = ("/", percent, 1)

    def test_full_disk_nudges_with_mount_and_percent(self):
        self.assertEqual(self.disk_watcher(93).tick(), [("machine", "disque / 93 %")])

    def test_disk_under_threshold_is_quiet(self):
        self.assertEqual(self.disk_watcher(89).tick(), [])

    def test_still_full_disk_is_not_repeated_within_a_day(self):
        watcher = self.disk_watcher(93)
        watcher.tick()
        self.clock["now"] += DAY - 60
        self.assertEqual(watcher.tick(), [])

    def test_still_full_disk_is_repeated_after_a_day(self):
        watcher = self.disk_watcher(93)
        watcher.tick()
        self.clock["now"] += DAY
        self.assertEqual(len(watcher.tick()), 1)

    def test_small_dip_under_threshold_does_not_rearm(self):
        watcher = self.disk_watcher(91)
        watcher.tick()
        self.set_percent(88)
        watcher.tick()
        self.set_percent(91)
        self.assertEqual(watcher.tick(), [])

    def test_drop_past_hysteresis_then_crossing_again_nudges(self):
        watcher = self.disk_watcher(91)
        watcher.tick()
        self.set_percent(86)
        watcher.tick()
        self.set_percent(90)
        self.assertEqual(watcher.tick(), [("machine", "disque / 90 %")])

    def test_alert_survives_a_restart(self):
        self.disk_watcher(93).tick()
        self.assertEqual(self.disk_watcher(93).tick(), [])

    def test_two_paths_on_the_same_filesystem_nudge_once(self):
        self.disks.table["/"] = ("/", 95, 1)
        self.disks.table["/home/me"] = ("/", 95, 1)
        self.assertEqual(len(self.make(disk_paths=("/", "/home/me")).tick()), 1)

    def test_unreadable_path_is_logged_once(self):
        self.disks.table["/gone"] = FileNotFoundError(2, "No such file or directory")
        watcher = self.make(disk_paths=("/gone",))
        with self.assertLogs("crepe_daemon.watchers.machine", level="WARNING") as logs:
            watcher.tick()
            watcher.tick()
        self.assertEqual(len(logs.output), 1)

    def test_zero_threshold_always_nudges_first(self):
        self.disks.table["/"] = ("/", 12, 1)
        self.assertEqual(self.make(disk_paths=("/",), disk_percent=0).tick(), [("machine", "disque / 12 %")])

    def test_used_percent_matches_df(self):
        # 1000 blocks, 300 free of which 250 usable by users: 700 / 950, rounded up.
        self.assertEqual(used_percent(1000, 300, 250), 74)

    def test_used_percent_of_an_empty_filesystem_is_zero(self):
        self.assertEqual(used_percent(0, 0, 0), 0)


class BatteryTest(MachineTestCase):
    def test_discharging_below_threshold_nudges_once(self):
        self.set_battery(12, "Discharging")
        watcher = self.make()
        self.assertEqual(watcher.tick(), [("machine", "batterie 12 %")])
        self.set_battery(9, "Discharging")
        self.assertEqual(watcher.tick(), [])

    def test_charging_low_battery_is_quiet(self):
        self.set_battery(10, "Charging")
        self.assertEqual(self.make().tick(), [])

    def test_charging_rearms_the_warning(self):
        self.set_battery(12, "Discharging")
        watcher = self.make()
        watcher.tick()
        self.set_battery(13, "Charging")
        watcher.tick()
        self.set_battery(12, "Discharging")
        self.assertEqual(len(watcher.tick()), 1)

    def test_rising_past_threshold_plus_ten_rearms(self):
        self.set_battery(12, "Discharging")
        watcher = self.make()
        watcher.tick()
        self.set_battery(26, "Discharging")
        watcher.tick()
        self.set_battery(14, "Discharging")
        self.assertEqual(len(watcher.tick()), 1)

    def test_no_battery_is_silently_nothing(self):
        with self.assertNoLogs("crepe_daemon.watchers.machine", level="DEBUG"):
            self.assertEqual(self.make().tick(), [])


class LoadTest(MachineTestCase):
    def test_load_above_cpu_count_long_enough_nudges_once(self):
        watcher = self.make(load_minutes=10)
        self.set_load(6.0)
        self.assertEqual(watcher.tick(), [])
        self.clock["now"] += 5 * 60
        self.assertEqual(watcher.tick(), [])
        self.clock["now"] += 6 * 60
        self.assertEqual(watcher.tick(), [("machine", "machine à genoux depuis 11 min")])
        self.clock["now"] += 5 * 60
        self.assertEqual(watcher.tick(), [])

    def test_calm_look_ends_the_episode(self):
        watcher = self.make(load_minutes=10)
        self.set_load(6.0)
        watcher.tick()
        self.clock["now"] += 8 * 60
        self.set_load(1.0)
        watcher.tick()
        self.set_load(6.0)
        self.clock["now"] += 5 * 60
        self.assertEqual(watcher.tick(), [])

    def test_load_equal_to_cpu_count_is_not_overload(self):
        watcher = self.make(load_minutes=0)
        self.set_load(4.0)
        self.assertEqual(watcher.tick(), [])


if __name__ == "__main__":
    unittest.main()
