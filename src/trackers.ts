const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

/** Every this many notifications within an hour, she offers to mute them. */
const NOTIFICATIONS_PER_ALERT = 10;
/** A title has to look busy at least this long for its end to count as a long task done. */
const LONG_TASK_FROM = 2 * MINUTE;
/** A title that keeps saying "loading" this long gets her tapping. */
const IMPATIENT_AFTER = 30 * SECOND;
/** How far back errors are remembered, for a success after a string of them or the same one coming back. */
const ERROR_MEMORY = 30 * MINUTE;
/** Idle this long and the stretch of work is over: that was a break, as far as she is concerned. */
export const BREAK_AFTER_IDLE_MS = 3 * MINUTE;
/** A bedtime lasts until this hour of the morning. */
const BEDTIME_ENDS_AT = 6;

/**
 * Notifications over the last rolling hour. `add()` says yes on the
 * 10th, 20th... of the hour. The thresholds start over an hour after the
 * last alert, so a steady trickle is pointed out once an hour, not once
 * per notification as old ones age out.
 */
export class NotificationTally {
    private arrivals: number[] = [];
    private nextAlertAt = NOTIFICATIONS_PER_ALERT;
    private lastAlertAt = 0;

    get count(): number {
        return this.arrivals.length;
    }

    /** Counts a notification arriving at `now`; true when the count deserves a remark. */
    add(now: number): boolean {
        this.arrivals = this.arrivals.filter(arrival => now - arrival < HOUR);
        this.arrivals.push(now);
        if (now - this.lastAlertAt >= HOUR)
            this.nextAlertAt = NOTIFICATIONS_PER_ALERT;
        if (this.arrivals.length < this.nextAlertAt)
            return false;
        this.lastAlertAt = now;
        this.nextAlertAt = (Math.floor(this.arrivals.length / NOTIFICATIONS_PER_ALERT) + 1) * NOTIFICATIONS_PER_ALERT;
        return true;
    }
}

/**
 * Long tasks seen through window titles: a title that says "building"
 * or "npm run" for a while, then stops saying it, is a task that just
 * ended. A title that says "loading" for half a minute is one she grows
 * impatient with. Kept per window, so focusing another one is not
 * mistaken for the end of the task.
 */
export class LongTasks {
    /** Writable so a test can make her impatient sooner. */
    impatientAfterMs = IMPATIENT_AFTER;
    private readonly busySince = new Map<number, number>();
    private readonly waitingSince = new Map<number, number>();

    /** True when `windowId`'s title just stopped looking busy after at least two minutes of it. */
    update(windowId: number, busy: boolean, now: number): boolean {
        const since = this.busySince.get(windowId);
        if (busy) {
            if (since === undefined)
                this.busySince.set(windowId, now);
            return false;
        }
        if (since === undefined)
            return false;
        this.busySince.delete(windowId);
        return now - since >= LONG_TASK_FROM;
    }

    /** The task ended in an error; the facepalm already said everything. */
    forget(windowId: number): void {
        this.busySince.delete(windowId);
    }

    /** Starts or ends the wait in `windowId`'s title. A wait goes on through retitles as long as they all say it. */
    wait(windowId: number, waiting: boolean, now: number): void {
        if (!waiting) {
            this.waitingSince.delete(windowId);
            return;
        }
        if (!this.waitingSince.has(windowId))
            this.waitingSince.set(windowId, now);
    }

    /** Milliseconds before the wait in `windowId` makes her impatient, 0 once it has; null when it is not waiting. */
    impatienceIn(windowId: number, now: number): number | null {
        const since = this.waitingSince.get(windowId);
        if (since === undefined)
            return null;
        return Math.max(0, since + this.impatientAfterMs - now);
    }
}

/** How many times something happened within the last `windowMs`. */
export class RollingCount {
    private readonly windowMs: number;
    private times: number[] = [];

    constructor(windowMs: number) {
        this.windowMs = windowMs;
    }

    add(now: number): void {
        this.prune(now);
        this.times.push(now);
    }

    count(now: number): number {
        this.prune(now);
        return this.times.length;
    }

    clear(): void {
        this.times = [];
    }

    private prune(now: number): void {
        this.times = this.times.filter(time => now - time < this.windowMs);
    }
}

/**
 * Errors she reacted to over the last half hour: all of them, to tell a
 * success that ends a string of failures, and per error (a window and its
 * exact title), to tell the same one coming back.
 */
export class ErrorHistory {
    private readonly all = new RollingCount(ERROR_MEMORY);
    private readonly byError = new Map<string, RollingCount>();

    count(now: number): number {
        return this.all.count(now);
    }

    /** How many times this very error was reacted to lately. */
    countOf(error: string, now: number): number {
        return this.byError.get(error)?.count(now) ?? 0;
    }

    /** `error` is null when there is nothing to tell it apart by, like a notification. */
    add(error: string | null, now: number): void {
        this.all.add(now);
        for (const [key, count] of this.byError) {
            if (count.count(now) === 0)
                this.byError.delete(key);
        }
        if (error === null)
            return;
        const count = this.byError.get(error) ?? new RollingCount(ERROR_MEMORY);
        count.add(now);
        this.byError.set(error, count);
    }

    /** The string of failures ended in a success; the next success starts from scratch. */
    clearStreak(): void {
        this.all.clear();
    }
}

/** What tells an error in a window title apart from another: the window and the exact title. */
export function errorKey(windowId: number, title: string): string {
    return `${windowId}\n${title}`;
}

/**
 * How long the user has been at it without a break, fed with the idle
 * time now and then. Three idle minutes count as a break.
 */
export class ContinuousActivity {
    private activeSince: number | null = null;

    /** True once the current stretch of activity has lasted `limitMs`; 0 never is. */
    isDue(idleMs: number, now: number, limitMs: number): boolean {
        if (idleMs >= BREAK_AFTER_IDLE_MS) {
            this.tookBreak();
            return false;
        }
        this.activeSince ??= now - idleMs;
        return limitMs > 0 && now - this.activeSince >= limitMs;
    }

    tookBreak(): void {
        this.activeSince = null;
    }

    /** She said it once; the next reminder waits for another full stretch, or a break. */
    reminded(now: number): void {
        this.activeSince = now;
    }
}

/**
 * Whether `date` falls between `bedtimeHour` and six in the morning,
 * so 1 a.m. is still past a 20:00 bedtime. 0 means she has no bedtime.
 */
export function isPastBedtime(date: Date, bedtimeHour: number): boolean {
    if (bedtimeHour <= 0)
        return false;
    const hour = date.getHours();
    if (bedtimeHour < BEDTIME_ENDS_AT)
        return hour >= bedtimeHour && hour < BEDTIME_ENDS_AT;
    return hour >= bedtimeHour || hour < BEDTIME_ENDS_AT;
}
