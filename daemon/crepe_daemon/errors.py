"""Errors the service turns into D-Bus errors. Messages are short and safe to show."""

ERROR_PREFIX = "io.github.aceep.Crepe.Brain.Error."


class BrainError(Exception):
    dbus_suffix = "Upstream"

    @property
    def dbus_name(self) -> str:
        return ERROR_PREFIX + self.dbus_suffix


class NoKeyError(BrainError):
    dbus_suffix = "NoKey"


class BudgetError(BrainError):
    dbus_suffix = "Budget"


class UpstreamError(BrainError):
    dbus_suffix = "Upstream"


class InvalidError(BrainError):
    dbus_suffix = "Invalid"
