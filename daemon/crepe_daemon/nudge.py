"""Nudges to the extension: io.github.aceep.Crepe on the shell's bus name."""

import logging
import re
import time

from gi.repository import Gio, GLib

log = logging.getLogger(__name__)

SHELL_BUS_NAME = "org.gnome.Shell"
OBJECT_PATH = "/io/github/aceep/Crepe"
INTERFACE_NAME = "io.github.aceep.Crepe"
CALL_TIMEOUT_MS = 5000
# Her lines are short: the extension shows the text in a bubble.
MAX_TEXT_CHARS = 60
# The extension drops a second nudge of the same kind within 5 s; space them a bit more.
SAME_KIND_SPACING_S = 5.5
KINDS = frozenset(
    {
        "tache_terminee",
        "attention",
        "pipeline_echec",
        "ticket_nouveau",
        "tickets_ouverts",
        "info",
        "travail_non_commite",
        "machine",
        "agenda",
    }
)

_WHITESPACE = re.compile(r"\s+")


def clip_text(text: str, limit: int = MAX_TEXT_CHARS) -> str:
    """One line of at most `limit` characters, cut with a trailing ellipsis."""
    line = _WHITESPACE.sub(" ", text).strip()
    if len(line) <= limit:
        return line
    return line[: limit - 1].rstrip() + "…"


class Nudger:
    """Fire-and-forget calls to Nudge(). Must be used from the main loop thread.

    The extension may be disabled or the shell restarting: failures are
    logged and dropped, never raised.
    """

    def __init__(self, connection: Gio.DBusConnection | None = None):
        self._connection = connection
        self._next_slot: dict[str, float] = {}

    def nudge(self, kind: str, text: str) -> None:
        if kind not in KINDS:
            log.warning("not sending a nudge of unknown kind %r", kind)
            return
        line = clip_text(text)
        now = time.monotonic()
        slot = max(now, self._next_slot.get(kind, now))
        self._next_slot[kind] = slot + SAME_KIND_SPACING_S
        if slot <= now:
            self._send(kind, line)
            return
        GLib.timeout_add(int((slot - now) * 1000), self._send_later, kind, line)

    def _send_later(self, kind: str, line: str) -> bool:
        self._send(kind, line)
        return GLib.SOURCE_REMOVE

    def _send(self, kind: str, line: str) -> None:
        connection = self._get_connection()
        if connection is None:
            return
        log.info("nudge %s: %s", kind, line)
        connection.call(
            SHELL_BUS_NAME,
            OBJECT_PATH,
            INTERFACE_NAME,
            "Nudge",
            GLib.Variant("(ss)", (kind, line)),
            None,
            Gio.DBusCallFlags.NO_AUTO_START,
            CALL_TIMEOUT_MS,
            None,
            self._on_nudge_done,
            kind,
        )

    def ping(self) -> str | None:
        """The extension's version, or None when it does not answer. Blocks up to 5 s."""
        connection = self._get_connection()
        if connection is None:
            return None
        try:
            result = connection.call_sync(
                SHELL_BUS_NAME,
                OBJECT_PATH,
                INTERFACE_NAME,
                "Ping",
                None,
                GLib.VariantType.new("(s)"),
                Gio.DBusCallFlags.NO_AUTO_START,
                CALL_TIMEOUT_MS,
                None,
            )
        except GLib.Error as error:
            log.debug("ping failed: %s", error.message)
            return None
        (version,) = result.unpack()
        return version

    def _get_connection(self) -> Gio.DBusConnection | None:
        if self._connection is None:
            try:
                # The shared session connection, already open when the service runs.
                self._connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
            except GLib.Error as error:
                log.warning("cannot reach the session bus for nudges: %s", error.message)
                return None
        return self._connection

    def _on_nudge_done(self, connection: Gio.DBusConnection, result: Gio.AsyncResult, kind: str) -> None:
        try:
            connection.call_finish(result)
        except GLib.Error as error:
            # Disabled extension, shell restarting, rate limit: nothing to retry.
            log.info("nudge %s not delivered: %s", kind, error.message)
