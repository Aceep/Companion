import type {MoodLevel} from './mood.js';

/** Enough for the daemon to know what just happened, not a diary. */
const EVENTS_KEPT = 5;
const LINES_KEPT = 3;

export const WEEKDAYS = ['dimanche', 'lundi', 'mardi', 'mercredi', 'jeudi', 'vendredi', 'samedi'] as const;

export interface RecentEvent {
    ago_s: number;
    kind: string;
}

/**
 * The last few things that happened to her and the last few lines she
 * said, for the daemon to have something to go on, and how many tickets
 * a script last said were open, for her greetings. Pure bookkeeping, no
 * GNOME dependency: timestamps come in, nothing is scheduled.
 */
export class Recollection {
    private readonly events: {at: number; kind: string}[] = [];
    private readonly lines: string[] = [];
    private tickets: number | null = null;

    /** Null until a script has said. */
    get openTickets(): number | null {
        return this.tickets;
    }

    noteOpenTickets(count: number): void {
        this.tickets = count;
    }

    noteEvent(kind: string, now: number = Date.now()): void {
        this.events.push({at: now, kind});
        if (this.events.length > EVENTS_KEPT)
            this.events.shift();
    }

    noteLine(line: string): void {
        this.lines.push(line);
        if (this.lines.length > LINES_KEPT)
            this.lines.shift();
    }

    recentEvents(now: number = Date.now()): RecentEvent[] {
        return this.events.map(event => ({ago_s: Math.max(0, Math.round((now - event.at) / 1000)), kind: event.kind}));
    }

    lastLines(): string[] {
        return [...this.lines];
    }
}

/** What the shell knows about the moment; the window fields are null when she is not allowed to look. */
export interface Moment {
    date: Date;
    windowTitle: string | null;
    app: string | null;
    mood: MoodLevel;
    sleeping: boolean;
    recollection: Recollection;
}

/** The `context` argument of the daemon's `Ask()` and `Remark()`: a JSON object, every field optional. */
export function contextJson(moment: Moment): string {
    const context: Record<string, unknown> = {
        hour: moment.date.getHours(),
        weekday: WEEKDAYS[moment.date.getDay()],
        // The daemon knows no fury: gone off the screen is still a sulk to it.
        mood: moment.mood === 'furious' ? 'angry' : moment.mood,
        sleeping: moment.sleeping,
        events: moment.recollection.recentEvents(moment.date.getTime()),
        last_lines: moment.recollection.lastLines(),
    };
    if (moment.windowTitle)
        context['window_title'] = moment.windowTitle;
    if (moment.app)
        context['app'] = moment.app;
    return JSON.stringify(context);
}
