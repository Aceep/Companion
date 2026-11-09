import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {NUDGE_KINDS, NudgeLimiter, isNudgeKind, type NudgeKind} from './nudgetext.js';

const OBJECT_PATH = '/io/github/aceep/Crepe';
const INTERFACE_NAME = 'io.github.aceep.Crepe';
const UNKNOWN_KIND_ERROR = `${INTERFACE_NAME}.Error.UnknownKind`;
const ERROR_PREFIX = `${INTERFACE_NAME}.Error`;
const TOO_FAST_ERROR = `${ERROR_PREFIX}.TooFast`;

const INTERFACE_XML = `
<node>
  <interface name="${INTERFACE_NAME}">
    <method name="Nudge">
      <arg type="s" name="kind" direction="in"/>
      <arg type="s" name="text" direction="in"/>
    </method>
    <method name="Remind">
      <arg type="s" name="when" direction="in"/>
      <arg type="s" name="text" direction="in"/>
      <arg type="s" name="confirmation" direction="out"/>
    </method>
    <method name="Ping">
      <arg type="s" name="version" direction="out"/>
    </method>
  </interface>
</node>`;

/** What `Remind()` answers: her confirmation, or a D-Bus error (`BadTime`, `TooMany`) with a French message. */
export type RemindOutcome = {ok: true; confirmation: string} | {ok: false; error: 'BadTime' | 'TooMany'; message: string};

/**
 * The extension's own D-Bus object on the shell's connection, so any
 * script can reach her through `org.gnome.Shell`: `Nudge()` makes her
 * react, `Remind()` sets a reminder, `Ping()` tells whether she is there. Unknown kinds are refused
 * with a D-Bus error; nudges past the rate limit are accepted and dropped. Reminders past it are
 * refused with `TooFast`, since the caller waits for a confirmation that would otherwise lie.
 */
export class NudgeService {
    private readonly exported: Gio.DBusExportedObject;
    private readonly limiter = new NudgeLimiter();

    constructor(version: string, onNudge: (kind: NudgeKind, text: string) => void, onRemind: (when: string, text: string) => RemindOutcome) {
        this.exported = Gio.DBusExportedObject.wrapJSObject(INTERFACE_XML, {
            NudgeAsync: ([kind, text]: [string, string], invocation: Gio.DBusMethodInvocation) => {
                if (!isNudgeKind(kind)) {
                    invocation.return_dbus_error(UNKNOWN_KIND_ERROR,
                        `unknown kind "${kind}", expected one of: ${NUDGE_KINDS.join(', ')}`);
                    return;
                }
                // The caller is told it went through either way: being ignored is her privilege.
                invocation.return_value(null);
                if (!this.limiter.allow(kind, Date.now()))
                    return;
                try {
                    onNudge(kind, text);
                } catch (error) {
                    console.warn(`Crêpe: nudge "${kind}" failed: ${error instanceof Error ? error.message : String(error)}`);
                }
            },
            RemindAsync: ([when, text]: [string, string], invocation: Gio.DBusMethodInvocation) => {
                if (!this.limiter.allow('remind', Date.now())) {
                    invocation.return_dbus_error(TOO_FAST_ERROR, 'Un pense-bête à la fois : réessaie dans quelques secondes.');
                    return;
                }
                let outcome: RemindOutcome;
                try {
                    outcome = onRemind(when, text);
                } catch (error) {
                    invocation.return_dbus_error(`${ERROR_PREFIX}.Failed`, error instanceof Error ? error.message : String(error));
                    return;
                }
                if (outcome.ok)
                    invocation.return_value(new GLib.Variant('(s)', [outcome.confirmation]));
                else
                    invocation.return_dbus_error(`${ERROR_PREFIX}.${outcome.error}`, outcome.message);
            },
            Ping: () => new GLib.Variant('(s)', [version]),
        });
        this.exported.export(Gio.DBus.session, OBJECT_PATH);
    }

    destroy(): void {
        this.exported.unexport();
    }
}
