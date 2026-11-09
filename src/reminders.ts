import {WEEKDAYS} from './context.js';
import {oneLine} from './nudgetext.js';
import type {Scheduler} from './player.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** More than this and a new one is refused: a list this long is nobody's memory aid. */
export const MAX_PENDING = 20;
/** Left unanswered this long, a reminder is repeated. */
export const NAG_EVERY_MS = 5 * MINUTE;
export const MAX_NAGS = 3;
/** A reminder delivered this long after its time says it is late. */
export const LATE_AFTER_MS = 2 * MINUTE;
/** The clock is read every few seconds: a reminder is at most this late, and a suspended laptop catches up. */
const TICK_EVERY = 5 * SECOND;
/** "dans 400 h" is a typo, not a reminder. */
const MAX_AHEAD_MS = 48 * HOUR;
/** A reminder's text, kept to what her line can quote: a script may send anything, and it ends up in dconf. */
export const REMINDER_TEXT_MAX = 100;

/** What she tells whoever typed something she could not read. */
export const REMINDER_EXAMPLE = '« 15h30 appeler Paul », « dans 20 min sortir le pain » ou « demain 9h rendez-vous »';

export interface Reminder {
    id: string;
    /** Epoch milliseconds. */
    at: number;
    text: string;
}

export type ParsedReminder = {ok: true; at: Date; text: string} | {ok: false; reason: string};

/**
 * "dans 1h30", "dans 1h 30 min", "dans 2 heures": hours, and optionally
 * minutes, either glued to the "h" or followed by their unit, so the "2"
 * of "dans 1h 2 courses" stays in the text.
 */
const IN_HOURS = /^dans\s+(\d{1,3})\s*(?:h|heures?)(?:\s*(\d{1,2})\s*(?:min(?:utes?)?|mn|m)|(\d{1,2}))?(?![\p{L}\d])/u;
/** "dans 20 min". */
const IN_MINUTES = /^dans\s+(\d{1,4})\s*(?:min(?:utes?)?|mn|m)(?![\p{L}\d])/u;
/** "15h", "15h30", "15:30", "à 15 h 30", "midi", "à minuit". */
const CLOCK = /^(?:à\s*|a\s+)?(?:(\d{1,2})\s*(?:h|:)\s*(?:(\d{2}))?|(minuit|midi))(?![\p{L}\d])/u;
const NAMED_HOURS: Readonly<Record<string, number>> = {minuit: 0, midi: 12};
const TOMORROW = /^demain(?![\p{L}\d])\s*,?\s*/u;
/** What may sit between the time and the text: a colon, a dash with a space after it, or just spaces. */
const SEPARATOR = /^\s*(?::|[-–—](?=\s))?\s*/u;

/**
 * Reads "15h30 appeler Paul", "à 15h", "15:30 - x", "dans 20 min x",
 * "dans 1h30 x", "demain 9h x", "demain à 9h15 x" and "midi x" (or
 * "minuit"), relative to `now`.
 * A clock time that has already passed today means tomorrow. Seconds of
 * a clock time are 0; a delay keeps `now`'s seconds.
 */
export function parseReminder(input: string, now: Date): ParsedReminder {
    const trimmed = input.trim();
    if (trimmed.length === 0)
        return {ok: false, reason: 'Je ne vois rien à te rappeler.'};
    const lower = trimmed.toLowerCase();

    const relative = readDelay(lower);
    if (relative !== null) {
        if (!relative.ok)
            return relative;
        return withText(new Date(now.getTime() + relative.delayMs), trimmed.slice(relative.length));
    }

    const tomorrow = TOMORROW.exec(lower);
    const afterDay = tomorrow ? tomorrow[0].length : 0;
    const clock = CLOCK.exec(lower.slice(afterDay));
    if (!clock) {
        return {ok: false, reason: tomorrow ? 'Demain, oui, mais à quelle heure ?' : "Je ne vois pas d'heure."};
    }
    const named = clock[3];
    const hours = named === undefined ? Number(clock[1]) : NAMED_HOURS[named] ?? 0;
    const minutes = clock[2] === undefined ? 0 : Number(clock[2]);
    if (hours > 23 || minutes > 59)
        return {ok: false, reason: `${clock[1]}h${clock[2] ?? ''}, ça n'existe pas.`};

    const at = new Date(now.getFullYear(), now.getMonth(), now.getDate() + (tomorrow ? 1 : 0), hours, minutes, 0, 0);
    // Already past today: the next time it is that hour is tomorrow.
    if (at.getTime() <= now.getTime())
        at.setDate(at.getDate() + 1);
    return withText(at, trimmed.slice(afterDay + clock[0].length));
}

/**
 * What `Remind(when, text)` and the menu's entry hand over: `when` may
 * hold the text too, `text` may be empty or hold all of it when `when`
 * is blank.
 */
export function parseReminderRequest(when: string, text: string, now: Date): ParsedReminder {
    return parseReminder([when.trim(), text.trim()].filter(part => part.length > 0).join(' '), now);
}

type Delay = {ok: true; delayMs: number; length: number} | {ok: false; reason: string};

function readDelay(lower: string): Delay | null {
    const hours = IN_HOURS.exec(lower);
    const minutes = hours ? null : IN_MINUTES.exec(lower);
    const match = hours ?? minutes;
    if (!match)
        return null;
    const extraMinutes = hours ? hours[2] ?? hours[3] : undefined;
    if (hours && extraMinutes !== undefined && Number(extraMinutes) > 59)
        return {ok: false, reason: `${hours[1]}h${extraMinutes}, ça n'existe pas.`};
    const delayMs = hours
        ? Number(hours[1]) * HOUR + (extraMinutes === undefined ? 0 : Number(extraMinutes) * MINUTE)
        : Number(match[1]) * MINUTE;
    if (delayMs < MINUTE)
        return {ok: false, reason: 'Dans combien de temps, exactement ?'};
    if (delayMs > MAX_AHEAD_MS)
        return {ok: false, reason: "C'est trop loin, je ne retiens pas plus de deux jours."};
    return {ok: true, delayMs, length: match[0].length};
}

function withText(at: Date, rest: string): ParsedReminder {
    const text = oneLine(rest.replace(SEPARATOR, ''), REMINDER_TEXT_MAX);
    if (text.length === 0)
        return {ok: false, reason: "Et je te rappelle quoi, au juste ?"};
    return {ok: true, at, text};
}

/** "15h", "15h05", "9h30". */
export function clockLabel(date: Date): string {
    const minutes = date.getMinutes();
    return `${date.getHours()}h${minutes === 0 ? '' : String(minutes).padStart(2, '0')}`;
}

/** "à 15h", "demain à 9h", "jeudi à 9h", "le 12/11 à 9h", relative to `now`. */
export function whenLabel(at: Date, now: Date): string {
    const startOf = (date: Date) => new Date(date.getFullYear(), date.getMonth(), date.getDate(), 12).getTime();
    const days = Math.round((startOf(at) - startOf(now)) / (24 * HOUR));
    const time = clockLabel(at);
    if (days <= 0)
        return `à ${time}`;
    if (days === 1)
        return `demain à ${time}`;
    if (days < 7)
        return `${WEEKDAYS[at.getDay()]} à ${time}`;
    return `le ${at.getDate()}/${at.getMonth() + 1} à ${time}`;
}

/** What she says when the voice has no line for it (talking off). */
export function plainConfirmation(at: Date, now: Date): string {
    return `Je te le rappelle ${whenLabel(at, now)}.`;
}

/**
 * The setting's JSON, read leniently like the stats: what cannot be read
 * is dropped. Ids made by older versions could repeat across sessions;
 * a repeated one gets a suffix, so a click or a cancel removes only one.
 */
export function parseReminders(json: string): Reminder[] {
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return [];
    }
    if (!Array.isArray(raw))
        return [];
    const reminders: Reminder[] = [];
    const taken = new Set<string>();
    for (const item of raw as unknown[]) {
        if (typeof item !== 'object' || item === null)
            continue;
        const {id, at, text} = item as Record<string, unknown>;
        if (typeof id !== 'string' || typeof at !== 'number' || !Number.isFinite(at) || typeof text !== 'string')
            continue;
        const capped = oneLine(text, REMINDER_TEXT_MAX);
        if (capped.length === 0)
            continue;
        const unique = uniqueId(id, taken);
        taken.add(unique);
        reminders.push({id: unique, at, text: capped});
    }
    return reminders.sort((first, second) => first.at - second.at).slice(0, MAX_PENDING);
}

/** `candidate`, or `candidate-2`, `candidate-3`... the first one not in `taken`. */
function uniqueId(candidate: string, taken: ReadonlySet<string>): string {
    if (!taken.has(candidate))
        return candidate;
    let suffix = 2;
    while (taken.has(`${candidate}-${suffix}`))
        suffix += 1;
    return `${candidate}-${suffix}`;
}

/** Time of creation plus a random part: two sessions adding one at the same minute still get two ids. */
export function newReminderId(): string {
    return `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

export function serializeReminders(reminders: readonly Reminder[]): string {
    return JSON.stringify(reminders.map(({id, at, text}) => ({id, at, text})));
}

/** How a reminder reaches her bubble: the first time, late (a meeting, a logout), or once more. */
export type DeliveryKind = 'first' | 'late' | 'nag';

export interface ReminderHooks {
    read: () => string;
    write: (json: string) => void;
    schedule: Scheduler;
    now: () => number;
    /** A fresh id; `newReminderId` when not given. */
    newId?: () => string;
    /** She can say it now: on stage, not in a meeting, not off in a fury. */
    canDeliver: () => boolean;
    deliver: (reminder: Reminder, kind: DeliveryKind) => void;
    /** A delivery went unanswered for `nagEveryMs`. */
    ignored: (reminder: Reminder) => void;
    /** The pending list changed, for the menu. */
    changed: () => void;
}

interface Delivery {
    reminder: Reminder;
    shownAt: number;
    nags: number;
}

/**
 * The pending reminders: kept in a setting, delivered when their time
 * comes (or right away when it already has), repeated every five minutes
 * until she is clicked, up to three times. One at a time: the next due
 * one waits until the shown one is acknowledged or given up on, so none
 * replaces another on her bubble unseen. No GNOME dependency: the clock,
 * the ids and the timers come in, so it can be driven from a test.
 */
export class ReminderCenter {
    /** Writable so a test can shorten the five minutes. */
    nagEveryMs = NAG_EVERY_MS;
    private readonly hooks: ReminderHooks;
    private readonly newId: () => string;
    private pending: Reminder[] = [];
    /** The one on her bubble, waiting for a click. */
    private shown: Delivery | null = null;
    private cancelTick: (() => void) | null = null;

    constructor(hooks: ReminderHooks) {
        this.hooks = hooks;
        this.newId = hooks.newId ?? newReminderId;
    }

    /** Loads what the last session left; what is overdue is delivered by the first tick. */
    start(): void {
        this.pending = parseReminders(this.hooks.read());
        this.hooks.changed();
        this.scheduleTick(2 * SECOND);
    }

    destroy(): void {
        this.cancelTick?.();
        this.cancelTick = null;
        this.shown = null;
        this.pending = [];
    }

    /** Soonest first. */
    list(): readonly Reminder[] {
        return this.pending;
    }

    /** One is on her bubble, waiting for a click. */
    get isShowing(): boolean {
        return this.shown !== null;
    }

    /** `text` is stored on one line and cut to `REMINDER_TEXT_MAX`. */
    add(at: Date, text: string): {ok: true; reminder: Reminder} | {ok: false; reason: 'full'} {
        if (this.pending.length >= MAX_PENDING)
            return {ok: false, reason: 'full'};
        const id = uniqueId(this.newId(), new Set(this.pending.map(reminder => reminder.id)));
        const reminder: Reminder = {id, at: at.getTime(), text: oneLine(text, REMINDER_TEXT_MAX)};
        this.pending = [...this.pending, reminder].sort((first, second) => first.at - second.at);
        this.save();
        return {ok: true, reminder};
    }

    cancel(id: string): boolean {
        if (!this.pending.some(reminder => reminder.id === id))
            return false;
        this.remove([id]);
        return true;
    }

    /** She was clicked: whatever she was showing is understood. True when there was something. */
    acknowledge(): boolean {
        if (this.shown === null)
            return false;
        this.remove([this.shown.reminder.id]);
        return true;
    }

    /**
     * Repeats the shown reminder once it is left unanswered long enough,
     * or else delivers the soonest due one. Also called by hand when a
     * meeting ends.
     */
    tick(): void {
        const now = this.hooks.now();
        if (this.shown !== null) {
            this.nag(this.shown, now);
            return;
        }
        const due = this.pending.find(reminder => reminder.at <= now);
        if (due === undefined || !this.hooks.canDeliver())
            return;
        this.shown = {reminder: due, shownAt: now, nags: 0};
        this.hooks.deliver(due, now - due.at > LATE_AFTER_MS ? 'late' : 'first');
    }

    private nag(delivery: Delivery, now: number): void {
        if (now - delivery.shownAt < this.nagEveryMs || !this.hooks.canDeliver())
            return;
        const reminder = delivery.reminder;
        this.hooks.ignored(reminder);
        if (delivery.nags >= MAX_NAGS) {
            this.remove([reminder.id]);
            return;
        }
        delivery.nags += 1;
        delivery.shownAt = now;
        this.hooks.deliver(reminder, 'nag');
    }

    private scheduleTick(delayMs: number): void {
        this.cancelTick = this.hooks.schedule(delayMs, () => {
            this.cancelTick = null;
            this.tick();
            this.scheduleTick(TICK_EVERY);
        });
    }

    private remove(ids: readonly string[]): void {
        this.pending = this.pending.filter(reminder => !ids.includes(reminder.id));
        if (this.shown !== null && ids.includes(this.shown.reminder.id))
            this.shown = null;
        this.save();
    }

    private save(): void {
        this.hooks.write(serializeReminders(this.pending));
        this.hooks.changed();
    }
}
