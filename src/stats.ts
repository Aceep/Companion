import type {Scheduler} from './player.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const DAY = 24 * 60 * MINUTE;

/** A month of days is enough for the preferences page; older ones are dropped at the next write. */
const DAYS_KEPT = 30;
/** Each write goes through dconf to disk; once a minute is plenty for counters nobody reads live. */
const WRITE_EVERY = MINUTE;

/** What she counts, per day. */
export const STAT_COUNTERS = [
    'notifications',
    'errors',
    'successes',
    'clicks',
    'drags',
    'sulks',
    'storms',
    'nudges',
    'talks',
    'crawls',
    'remarks',
] as const;

export type StatCounter = typeof STAT_COUNTERS[number];

export type DayCounts = Record<StatCounter, number>;

/** Days by "YYYY-MM-DD", as stored in the `stats` setting. */
export type StatsDays = Map<string, DayCounts>;

export function emptyCounts(): DayCounts {
    const counts = {} as DayCounts;
    for (const counter of STAT_COUNTERS)
        counts[counter] = 0;
    return counts;
}

/** The local calendar day, the way the setting keys it. */
export function dayKey(date: Date): string {
    const month = String(date.getMonth() + 1).padStart(2, '0');
    const day = String(date.getDate()).padStart(2, '0');
    return `${date.getFullYear()}-${month}-${day}`;
}

/**
 * The setting's JSON, read leniently: a hand-edited or truncated value
 * loses what cannot be read instead of breaking the extension.
 */
export function parseStats(json: string): StatsDays {
    const days: StatsDays = new Map();
    let raw: unknown;
    try {
        raw = JSON.parse(json);
    } catch {
        return days;
    }
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        return days;
    for (const [day, value] of Object.entries(raw as Record<string, unknown>)) {
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || typeof value !== 'object' || value === null)
            continue;
        const counts = emptyCounts();
        for (const counter of STAT_COUNTERS) {
            const count = (value as Record<string, unknown>)[counter];
            if (typeof count === 'number' && Number.isFinite(count) && count > 0)
                counts[counter] = Math.floor(count);
        }
        days.set(day, counts);
    }
    return days;
}

/** Only the last 30 days up to `today` are written; the keys sort as dates, so the oldest go first. */
export function serializeStats(days: StatsDays, today: Date): string {
    const oldestKept = dayKey(new Date(today.getTime() - (DAYS_KEPT - 1) * DAY));
    const kept: Record<string, DayCounts> = {};
    for (const day of [...days.keys()].sort()) {
        const counts = days.get(day);
        if (counts && day >= oldestKept)
            kept[day] = counts;
    }
    return JSON.stringify(kept);
}

/** Totals over the `dayCount` days ending with `today`, today included. */
export function sumDays(days: StatsDays, today: Date, dayCount: number): DayCounts {
    const total = emptyCounts();
    for (let back = 0; back < dayCount; back++) {
        // Noon steps clear of the hour lost or gained when the clocks change.
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12);
        const counts = days.get(dayKey(date));
        if (!counts)
            continue;
        for (const counter of STAT_COUNTERS)
            total[counter] += counts[counter];
    }
    return total;
}

/**
 * The day's counters, kept in memory and written to the `stats` setting
 * at most once a minute. `read` and `write` give the setting's string;
 * nothing here knows about GSettings, so it can be poked from Eval.
 */
export class StatsStore {
    private readonly read: () => string;
    private readonly write: (json: string) => void;
    private readonly schedule: Scheduler;
    private days: StatsDays;
    private lastWritten: string;
    private cancelWrite: (() => void) | null = null;

    constructor(read: () => string, write: (json: string) => void, schedule: Scheduler) {
        this.read = read;
        this.write = write;
        this.schedule = schedule;
        this.lastWritten = read();
        this.days = parseStats(this.lastWritten);
    }

    increment(counter: StatCounter, now: Date = new Date()): void {
        const day = dayKey(now);
        const counts = this.days.get(day) ?? emptyCounts();
        counts[counter] += 1;
        this.days.set(day, counts);
        this.cancelWrite ??= this.schedule(WRITE_EVERY, () => {
            this.cancelWrite = null;
            this.flush();
        });
    }

    /** A copy: whoever reads it cannot change the counters by accident. */
    today(now: Date = new Date()): DayCounts {
        return {...(this.days.get(dayKey(now)) ?? emptyCounts())};
    }

    /**
     * The setting changed. Our own write comes back as the same string;
     * anything else is someone else's (the preferences' reset button) and wins,
     * counts not yet written included.
     */
    settingChanged(): void {
        const json = this.read();
        if (json === this.lastWritten)
            return;
        this.cancelWrite?.();
        this.cancelWrite = null;
        this.lastWritten = json;
        this.days = parseStats(json);
    }

    flush(now: Date = new Date()): void {
        this.cancelWrite?.();
        this.cancelWrite = null;
        const json = serializeStats(this.days, now);
        if (json === this.lastWritten)
            return;
        this.lastWritten = json;
        this.write(json);
    }
}
