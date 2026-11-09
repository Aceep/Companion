"""The D-Bus face of the brain: io.github.aceep.Crepe.Brain on the session bus."""

import logging
import signal
from concurrent.futures import ThreadPoolExecutor
from typing import Callable

from gi.repository import Gio, GLib

from . import VERSION
from .brain import Brain
from .errors import ERROR_PREFIX, BrainError, UpstreamError
from .watchers import WatcherPool

log = logging.getLogger(__name__)

BUS_NAME = "io.github.aceep.Crepe.Brain"
OBJECT_PATH = "/io/github/aceep/Crepe/Brain"
INTERFACE_NAME = "io.github.aceep.Crepe.Brain"

INTERFACE_XML = f"""
<node>
  <interface name="{INTERFACE_NAME}">
    <method name="Ask">
      <arg name="text" type="s" direction="in"/>
      <arg name="context" type="s" direction="in"/>
      <arg name="reply" type="s" direction="out"/>
    </method>
    <method name="Remark">
      <arg name="context" type="s" direction="in"/>
      <arg name="reply" type="s" direction="out"/>
    </method>
    <method name="Status">
      <arg name="status" type="a{{sv}}" direction="out"/>
    </method>
    <method name="Forget"/>
  </interface>
</node>
"""


class BrainService:
    def __init__(
        self,
        brain: Brain,
        fake: bool,
        key_lookup: Callable[[], str | None],
        watchers: WatcherPool | None = None,
    ):
        self.brain = brain
        self.fake = fake
        self._key_lookup = key_lookup
        self.watchers = watchers or WatcherPool([])
        # A keyring lookup can block (an unlock prompt), so it never runs on
        # the main loop; Status reports the last known answer.
        self._has_key = False
        # One worker: requests run one at a time, later ones wait their turn.
        self._executor = ThreadPoolExecutor(max_workers=1, thread_name_prefix="brain")
        self._loop = GLib.MainLoop()
        self._exit_code = 0
        self._registration_id = 0
        self._owner_id = 0
        self._node_info = Gio.DBusNodeInfo.new_for_xml(INTERFACE_XML)

    def run(self) -> int:
        self._owner_id = Gio.bus_own_name(
            Gio.BusType.SESSION,
            BUS_NAME,
            Gio.BusNameOwnerFlags.NONE,
            self._on_bus_acquired,
            self._on_name_acquired,
            self._on_name_lost,
        )
        for signum in (signal.SIGTERM, signal.SIGINT):
            GLib.unix_signal_add(GLib.PRIORITY_DEFAULT, signum, self._on_signal, signum)
        self._run_in_worker(self._refresh_key_state, on_done=lambda _result: None)
        self.watchers.start()
        self._loop.run()
        self._shutdown()
        return self._exit_code

    def _shutdown(self) -> None:
        if self._owner_id:
            Gio.bus_unown_name(self._owner_id)
        self.watchers.stop()
        # Pending requests are dropped; their callers get a D-Bus timeout or disconnect.
        self._executor.shutdown(wait=False, cancel_futures=True)
        log.info("stopped")

    def _on_signal(self, signum: int) -> bool:
        log.info("received %s, stopping", signal.Signals(signum).name)
        self._loop.quit()
        return GLib.SOURCE_REMOVE

    def _on_bus_acquired(self, connection: Gio.DBusConnection, name: str) -> None:
        self._registration_id = connection.register_object(
            OBJECT_PATH,
            self._node_info.interfaces[0],
            self._on_method_call,
            None,
            None,
        )

    def _on_name_acquired(self, connection: Gio.DBusConnection, name: str) -> None:
        log.info("owning %s (fake=%s, backend=%s, model=%s)", name, self.fake, self.brain.config.backend, self.brain.config.model)

    def _on_name_lost(self, connection: Gio.DBusConnection | None, name: str) -> None:
        if connection is None:
            log.error("cannot connect to the session bus")
        else:
            log.error("lost or could not own %s (another instance running?)", name)
        self._exit_code = 1
        self._loop.quit()

    def _on_method_call(
        self,
        connection: Gio.DBusConnection,
        sender: str,
        object_path: str,
        interface_name: str,
        method_name: str,
        parameters: GLib.Variant,
        invocation: Gio.DBusMethodInvocation,
    ) -> None:
        if method_name == "Ask":
            text, context = parameters.unpack()
            self._answer_later(invocation, lambda: self.brain.ask(text, context))
        elif method_name == "Remark":
            (context,) = parameters.unpack()
            self._answer_later(invocation, lambda: self.brain.remark(context))
        elif method_name == "Status":
            invocation.return_value(GLib.Variant("(a{sv})", (self._status(),)))
            # Picks up a key stored with --set-key while running, for the next Status.
            self._run_in_worker(self._refresh_key_state, on_done=lambda _result: None)
        elif method_name == "Forget":
            self.brain.memory.clear()
            log.info("memory cleared")
            invocation.return_value(None)
        else:
            invocation.return_dbus_error(ERROR_PREFIX + "Invalid", f"unknown method {method_name}")

    def _status(self) -> dict:
        config = self.brain.config
        return {
            "has_key": GLib.Variant("b", self._has_key),
            "backend": GLib.Variant("s", config.backend),
            "model": GLib.Variant("s", config.model),
            "requests_today": GLib.Variant("u", self.brain.counter.count),
            "daily_budget": GLib.Variant("u", config.daily_budget),
            "remarks_enabled": GLib.Variant("b", config.remarks),
            "fake": GLib.Variant("b", self.fake),
            "version": GLib.Variant("s", VERSION),
            "watchers": GLib.Variant("as", self.watchers.names),
        }

    def _answer_later(self, invocation: Gio.DBusMethodInvocation, work: Callable[[], str]) -> None:
        def reply(result: str | BrainError) -> None:
            if isinstance(result, BrainError):
                invocation.return_dbus_error(result.dbus_name, str(result))
            else:
                invocation.return_value(GLib.Variant("(s)", (result,)))

        def guarded() -> str | BrainError:
            try:
                return work()
            except BrainError as error:
                log.info("%s: %s", error.dbus_name, error)
                return error
            finally:
                self._refresh_key_state()

        self._run_in_worker(guarded, on_done=reply)

    def _run_in_worker(self, work: Callable, on_done: Callable) -> None:
        def finish(future) -> None:
            try:
                result = future.result()
            except Exception:
                # Logged here, never sent: the caller only gets a short message.
                log.exception("request failed")
                result = _internal_error()
            GLib.idle_add(_call_once, on_done, result)

        self._executor.submit(work).add_done_callback(finish)

    def _refresh_key_state(self) -> None:
        self._has_key = self._key_lookup() is not None


def _internal_error() -> BrainError:
    return UpstreamError("internal error, see the daemon log")


def _call_once(callback: Callable, result) -> bool:
    callback(result)
    return GLib.SOURCE_REMOVE


def query_status() -> dict | None:
    """Status() of the running instance, or None when there is none."""
    try:
        connection = Gio.bus_get_sync(Gio.BusType.SESSION, None)
        result = connection.call_sync(
            BUS_NAME,
            OBJECT_PATH,
            INTERFACE_NAME,
            "Status",
            None,
            GLib.VariantType.new("(a{sv})"),
            Gio.DBusCallFlags.NO_AUTO_START,
            5000,
            None,
        )
    except GLib.Error as error:
        log.debug("status call failed: %s", error.message)
        return None
    (status,) = result.unpack()
    return status
