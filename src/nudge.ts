import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

const OBJECT_PATH = '/io/github/aceep/Crepe';
const INTERFACE_NAME = 'io.github.aceep.Crepe';
const UNKNOWN_KIND_ERROR = `${INTERFACE_NAME}.Error.UnknownKind`;
const ERROR_PREFIX = `${INTERFACE_NAME}.Error`;

/** A script stuck in a loop gets one reaction per kind every five seconds; the rest is dropped. */
const NUDGE_EVERY_MS = 5 * 1000;
/** `{texte}` goes inside one of her lines, which have to stay short. */
export const TEXT_IN_LINE_MAX = 60;
/** An `info` nudge is the whole line, as long as one of the daemon's replies may be. */
export const INFO_MAX = 160;

/** What a script may tell her about. */
export const NUDGE_KINDS = [
    'tache_terminee',
    'attention',
    'pipeline_echec',
    'ticket_nouveau',
    'tickets_ouverts',
    'travail_non_commite',
    'machine',
    'agenda',
    'commande_echec',
    'commande_longue',
    'musique',
    'musique_fin',
    'info',
] as const;

export type NudgeKind = typeof NUDGE_KINDS[number];

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

/** At most one nudge per kind per five seconds. Pure bookkeeping, timestamps come in. */
export class NudgeLimiter {
    private readonly lastAt = new Map<NudgeKind, number>();

    /** True when a nudge of this kind arriving at `now` gets through, and counts it. */
    allow(kind: NudgeKind, now: number): boolean {
        const last = this.lastAt.get(kind);
        if (last !== undefined && now - last < NUDGE_EVERY_MS)
            return false;
        this.lastAt.set(kind, now);
        return true;
    }
}

/**
 * The extension's own D-Bus object on the shell's connection, so any
 * script can reach her through `org.gnome.Shell`: `Nudge()` makes her
 * react, `Remind()` sets a reminder, `Ping()` tells whether she is there. Unknown kinds are refused
 * with a D-Bus error; nudges past the rate limit are accepted and dropped.
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

function isNudgeKind(kind: string): kind is NudgeKind {
    return (NUDGE_KINDS as readonly string[]).includes(kind);
}

/**
 * What a script sent, fit for her bubble: one line, whitespace runs
 * collapsed, cut with "…" past `max` characters. Plain text all the way,
 * the bubble's label does not read markup.
 */
export function oneLine(text: string, max: number): string {
    const characters = [...text.replace(/\s+/g, ' ').trim()];
    if (characters.length <= max)
        return characters.join('');
    return `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

/** A count of tickets, when the text is nothing but digits. */
export function ticketCount(text: string): number | null {
    const trimmed = text.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
