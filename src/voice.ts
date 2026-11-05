import type Gio from 'gi://Gio';

import type {CrepeSettings} from './settings.js';

const SECOND = 1000;
const HOUR = 60 * 60 * SECOND;

/** Every key `assets/repliques.json` must provide. */
export const VOICE_EVENTS = [
    'notification',
    'erreur',
    'succes',
    'retour',
    'clic',
    'endormissement',
    'matin',
    'soir',
    'vendredi',
    'commentaire',
    'agacee',
    'enervee',
    'boude',
    'deplacee',
    'patience',
    'trop_de_notifs',
    'couche_tard',
    'pause',
    'musique',
    'silence',
    'impatience',
    'enfin',
    'fin_du_chut',
    'perplexe',
] as const;

export type VoiceEvent = typeof VOICE_EVENTS[number];

/** Events the rest of the extension fires; the time-of-day ones are only chosen here. */
export type TriggerEvent = Exclude<VoiceEvent, 'matin' | 'soir' | 'vendredi'>;

/** What a line may refer to between braces: `{titre}` is the track playing, `{heure}` is filled here. */
export type LineValues = Readonly<Partial<Record<Placeholder, string>>>;

const PLACEHOLDERS = ['heure', 'titre'] as const;
type Placeholder = typeof PLACEHOLDERS[number];
const PLACEHOLDER_PATTERN = /\{([a-z]+)\}/g;

/** A chatty octopus is not a bored one: at most one line per 45 seconds. */
const GLOBAL_COOLDOWN = 45 * SECOND;

/** Chance that an event gets a line at all, once the cooldown allows it. */
const PROBABILITY: Record<TriggerEvent, number> = {
    notification: 0.35,
    erreur: 0.7,
    succes: 0.7,
    retour: 1.0,
    clic: 1.0,
    endormissement: 0.6,
    // Its rarity comes from the behaviour's timer, not from here.
    commentaire: 1.0,
    agacee: 1.0,
    enervee: 1.0,
    boude: 1.0,
    deplacee: 0.8,
    patience: 0.8,
    trop_de_notifs: 1.0,
    couche_tard: 1.0,
    pause: 1.0,
    musique: 0.3,
    silence: 0.7,
    impatience: 0.5,
    enfin: 0.9,
    fin_du_chut: 0.6,
    perplexe: 0.9,
};

/**
 * Replies to the user herself, and lines that come with something she
 * does for them (the mute offer, the break reminder, going to bed) or
 * answer something they just did (turning banners back on); making them
 * wait for a cooldown would read as ignoring them.
 */
const DIRECT_EVENTS: ReadonlySet<TriggerEvent> = new Set([
    'retour', 'clic', 'agacee', 'enervee', 'boude', 'trop_de_notifs', 'pause', 'couche_tard', 'fin_du_chut',
    'enfin', 'perplexe',
]);

/**
 * Direct replies that talk over whatever she was saying: the swing has to
 * come with its line, a sulk answers every click, and the mute offer
 * lands right when the previous notification's remark is still showing.
 * The applause and the head-scratch replace an error remark that is
 * usually still on screen, so they talk over it too.
 */
const INTERRUPTING_EVENTS: ReadonlySet<TriggerEvent> = new Set([
    'agacee', 'enervee', 'boude', 'trop_de_notifs', 'enfin', 'perplexe',
]);

/** Only greetings and plain clicks get a remark about the hour; a sulk does not chat about the weather. */
const CONTEXT_EVENTS: ReadonlySet<TriggerEvent> = new Set(['retour', 'clic']);

/** How long a time-of-day remark keeps her from making another one. */
const CONTEXT_COOLDOWN = 3 * HOUR;
const CONTEXT_PROBABILITY = 0.6;
const MORNING_ENDS_AT = 10;
const EVENING_STARTS_AT = 18.5;
const FRIDAY_EVENING_STARTS_AT = 16;
const FRIDAY = 5;

const decoder = new TextDecoder('utf-8');

/**
 * Picks what Crêpe says, from the lines written in `assets/repliques.json`.
 * Knows nothing about Clutter so it can be poked from Looking Glass or Eval:
 * `speak()` returns the line, or null when she keeps quiet.
 */
export class Voice {
    private readonly settings: CrepeSettings;
    private readonly isBubbleShowing: () => boolean;
    private lines = new Map<VoiceEvent, readonly string[]>();
    private readonly lastLine = new Map<VoiceEvent, string>();
    private lastSpokenAt = 0;
    private lastContextAt = 0;
    /** The day she last told the time, as "year-month-day". */
    private lastClockDay: string | null = null;

    constructor(settings: CrepeSettings, isBubbleShowing: () => boolean) {
        this.settings = settings;
        this.isBubbleShowing = isBubbleShowing;
    }

    loadLines(assetsDir: Gio.File): void {
        const file = assetsDir.get_child('repliques.json');
        const [, contents] = file.load_contents(null);
        const raw = JSON.parse(decoder.decode(contents)) as Record<string, unknown>;

        const lines = new Map<VoiceEvent, readonly string[]>();
        for (const event of VOICE_EVENTS)
            lines.set(event, validLines(event, raw[event]));
        this.lines = lines;
    }

    /** Lines with a placeholder missing from `values` are never picked. */
    speak(event: TriggerEvent, values: LineValues = {}): string | null {
        if (!this.settings.talk)
            return null;
        const now = Date.now();
        if (DIRECT_EVENTS.has(event)) {
            if (this.isBubbleShowing() && !INTERRUPTING_EVENTS.has(event))
                return null;
        } else if (now - this.lastSpokenAt < GLOBAL_COOLDOWN) {
            return null;
        }
        if (Math.random() >= PROBABILITY[event])
            return null;

        const date = new Date(now);
        const tellsTime = this.isFirstMorningGreeting(event, date);
        const chosen = tellsTime ? 'matin' : this.withTimeOfDay(event, now);
        const line = this.pickLine(chosen, {...values, heure: clock(date)}, tellsTime ? 'heure' : null);
        if (line === null)
            return null;
        this.lastSpokenAt = now;
        if (chosen !== event)
            this.lastContextAt = now;
        if (tellsTime)
            this.lastClockDay = dayOf(date);
        return line;
    }

    /** The first greeting or click of the day, before ten, tells the time. */
    private isFirstMorningGreeting(event: TriggerEvent, date: Date): boolean {
        return CONTEXT_EVENTS.has(event) && hourOf(date) < MORNING_ENDS_AT && dayOf(date) !== this.lastClockDay;
    }

    /** Greetings and clicks sometimes get a remark about the hour instead. */
    private withTimeOfDay(event: TriggerEvent, now: number): VoiceEvent {
        if (!CONTEXT_EVENTS.has(event) || now - this.lastContextAt < CONTEXT_COOLDOWN)
            return event;
        const context = timeOfDay(new Date(now));
        if (context === null || Math.random() >= CONTEXT_PROBABILITY)
            return event;
        return context;
    }

    /**
     * A random line that `values` can fill, never the one she said last
     * time for the same event. `mention` keeps only lines using that placeholder.
     */
    private pickLine(event: VoiceEvent, values: LineValues, mention: Placeholder | null): string | null {
        const candidates = (this.lines.get(event) ?? []).filter(line =>
            placeholdersOf(line).every(name => values[name] !== undefined) &&
            (mention === null || placeholdersOf(line).includes(mention)));
        const previous = this.lastLine.get(event);
        const fresh = candidates.length > 1 ? candidates.filter(line => line !== previous) : candidates;
        const line = fresh[Math.floor(Math.random() * fresh.length)];
        if (line === undefined)
            return null;
        this.lastLine.set(event, line);
        return line.replace(PLACEHOLDER_PATTERN, (_match, name: Placeholder) => values[name] ?? '');
    }
}

/** Friday wins over a plain evening: it is the more interesting news. */
function timeOfDay(date: Date): VoiceEvent | null {
    const hour = hourOf(date);
    if (hour < MORNING_ENDS_AT)
        return 'matin';
    if (date.getDay() === FRIDAY && hour >= FRIDAY_EVENING_STARTS_AT)
        return 'vendredi';
    if (hour >= EVENING_STARTS_AT)
        return 'soir';
    return null;
}

function hourOf(date: Date): number {
    return date.getHours() + date.getMinutes() / 60;
}

function clock(date: Date): string {
    return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function dayOf(date: Date): string {
    return `${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`;
}

function placeholdersOf(line: string): Placeholder[] {
    return namesBetweenBraces(line).filter(isPlaceholder);
}

function namesBetweenBraces(line: string): string[] {
    return [...line.matchAll(PLACEHOLDER_PATTERN)].map(match => match[1] ?? '');
}

function isPlaceholder(name: string): name is Placeholder {
    return (PLACEHOLDERS as readonly string[]).includes(name);
}

function validLines(event: VoiceEvent, value: unknown): readonly string[] {
    if (!Array.isArray(value) || value.length === 0)
        throw new Error(`repliques.json: "${event}" must be a non-empty list of lines`);
    if (!value.every(line => typeof line === 'string' && line.length > 0))
        throw new Error(`repliques.json: "${event}" contains something that is not a line`);
    const lines = value as string[];
    // A typo like {heures} would make the line silently unpickable.
    const unknown = lines.flatMap(namesBetweenBraces).find(name => !isPlaceholder(name));
    if (unknown !== undefined)
        throw new Error(`repliques.json: "${event}" uses an unknown placeholder {${unknown}}`);
    return lines;
}
