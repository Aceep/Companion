import type Gio from 'gi://Gio';

import {crepify, shouldCrepify} from './crepespeak.js';
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
    'batte_rangee',
    'deplacee',
    'retour_maison',
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
    'cerveau_absent',
    'cerveau_fatigue',
    'cerveau_panne',
    'depart',
    'retour_furieuse',
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
    'fin_concentration',
    'reunion_fin_resume',
    'reunion_fin_rien',
    'esquive',
    'curieuse',
    'souris',
    'bilan',
    'tenue_fete',
    'tenue_vendredi',
    'tenue_hiver',
    'tenue_ete',
    'encre',
    'pense_bete',
    'pense_bete_relance',
    'pense_bete_ok',
    'pense_bete_incompris',
    'pense_bete_en_retard',
    'pense_bete_plein',
    'rappel_pipeline',
    'rappel_commandes',
    'rappel_bouderie',
    'rappel_focus',
    'bilan_semaine',
] as const;

export type VoiceEvent = typeof VOICE_EVENTS[number];

/**
 * Events she tells on purpose, outside the chatter's rules: reminders
 * (`pick()`), and a fact of the week or the weekly bilan (`tell()`).
 */
export type ToldEvent = 'pense_bete' | 'pense_bete_relance' | 'pense_bete_ok' | 'pense_bete_incompris' |
    'pense_bete_en_retard' | 'pense_bete_plein' | 'rappel_pipeline' | 'rappel_commandes' | 'rappel_bouderie' |
    'rappel_focus' | 'bilan_semaine';

/** Events the rest of the extension fires; the time-of-day ones are only chosen here, the recap has `recap()`. */
export type TriggerEvent = Exclude<VoiceEvent, 'matin' | 'soir' | 'vendredi' | 'bilan' | ToldEvent>;

/**
 * What a line may refer to between braces: `{titre}` is the track playing,
 * `{texte}` what a script sent with a nudge (or what a reminder is about),
 * `{tickets}` how many tickets are open as a script last said, `{heure}`
 * is filled here with the time now, or with a reminder's own time.
 * `{quand}` is when a reminder will ring ("à 15h", "demain à 9h"), `{jour}`
 * and `{nombre}` the day and the count of a fact she brings up again. The recap's
 * counters are `{notifs}`, `{erreurs}`, `{succes}`, `{clics}` and `{nudges}`. `{resume}` is the summary of what scripts said during a meeting.
 */
export type LineValues = Readonly<Partial<Record<Placeholder, string>>>;

const PLACEHOLDERS = ['heure', 'titre', 'texte', 'tickets', 'notifs', 'erreurs', 'succes', 'clics', 'nudges', 'resume', 'quand', 'jour', 'nombre'] as const;
type Placeholder = typeof PLACEHOLDERS[number];
const PLACEHOLDER_PATTERN = /\{([a-z]+)\}/g;

/** A chatty octopus is not a bored one: at most one line per 45 seconds. */
const GLOBAL_COOLDOWN = 45 * SECOND;
/** Known open tickets come up in one greeting in three; every time would be nagging. */
const TICKETS_MENTION_CHANCE = 1 / 3;

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
    batte_rangee: 1.0,
    deplacee: 0.8,
    retour_maison: 1.0,
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
    cerveau_absent: 1.0,
    cerveau_fatigue: 1.0,
    cerveau_panne: 1.0,
    depart: 1.0,
    retour_furieuse: 1.0,
    // A script was set up on purpose to tell her: it gets its line.
    tache_terminee: 1.0,
    attention: 1.0,
    pipeline_echec: 1.0,
    ticket_nouveau: 1.0,
    tickets_ouverts: 1.0,
    travail_non_commite: 1.0,
    machine: 1.0,
    agenda: 1.0,
    commande_echec: 1.0,
    commande_longue: 1.0,
    fin_concentration: 1.0,
    reunion_fin_resume: 1.0,
    reunion_fin_rien: 1.0,
    // Moving out of the way is the point; saying so every time would be the opposite.
    esquive: 1 / 3,
    // Going to look is the gesture; a word every time would make a show of it.
    curieuse: 1 / 3,
    // Every other time: the creeping up is the joke, the line only its punchline.
    souris: 1 / 2,
    // Once a day at most per outfit already: when it comes, it is said.
    tenue_fete: 1.0,
    tenue_vendredi: 1.0,
    tenue_hiver: 1.0,
    tenue_ete: 1.0,
    // The ink goes with a sulk's own poke: it takes the place of that poke's line.
    encre: 1.0,
};

/**
 * Replies to the user herself (the daemon failing to answer them included), and lines that come with something she
 * does for them (the mute offer, the break reminder, going to bed) or
 * answer something they just did (turning banners back on); making them
 * wait for a cooldown would read as ignoring them. Nudges are messages a
 * script was set up to pass on: dropping them for a cooldown would lose them.
 * The end of a focus session answers the user having asked for one.
 */
const DIRECT_EVENTS: ReadonlySet<TriggerEvent> = new Set([
    'retour', 'clic', 'agacee', 'enervee', 'boude', 'trop_de_notifs', 'pause', 'couche_tard', 'fin_du_chut',
    'enfin', 'perplexe', 'batte_rangee', 'retour_maison', 'cerveau_absent', 'cerveau_fatigue', 'cerveau_panne',
    'depart', 'retour_furieuse', 'tache_terminee', 'attention', 'pipeline_echec', 'ticket_nouveau', 'tickets_ouverts',
    'travail_non_commite', 'machine', 'agenda', 'commande_echec', 'commande_longue', 'fin_concentration',
    'reunion_fin_resume', 'reunion_fin_rien', 'encre',
]);

/**
 * Direct replies that talk over whatever she was saying: the swing has to
 * come with its line, a sulk answers every click, and the mute offer
 * lands right when the previous notification's remark is still showing.
 * The applause and the head-scratch replace an error remark that is
 * usually still on screen, so they talk over it too. Putting the bat away
 * closes the sulk, and crawling back home after a drop answers the drop:
 * both come with their gesture, whatever is still showing. A failed
 * question replaces the "…" she shows while waiting for the answer.
 * Storming off and coming back from it are the last word of a sulk. A
 * nudge passes on a message that would be lost if it waited its turn, and
 * the end of a focus session would be missed if it did.
 */
const INTERRUPTING_EVENTS: ReadonlySet<TriggerEvent> = new Set([
    'agacee', 'enervee', 'boude', 'trop_de_notifs', 'enfin', 'perplexe', 'batte_rangee', 'retour_maison',
    'cerveau_absent', 'cerveau_fatigue', 'cerveau_panne', 'depart', 'retour_furieuse',
    'tache_terminee', 'attention', 'pipeline_echec', 'ticket_nouveau', 'tickets_ouverts',
    'travail_non_commite', 'machine', 'agenda', 'commande_echec', 'commande_longue', 'fin_concentration',
    'reunion_fin_resume', 'reunion_fin_rien', 'encre',
]);

/** Only greetings and plain clicks get a remark about the hour; a sulk does not chat about the weather. */
const CONTEXT_EVENTS: ReadonlySet<TriggerEvent> = new Set(['retour', 'clic']);

/**
 * Lines whose words are the news: what a reminder is about and when, the
 * day's and the week's counts, what scripts said during a meeting, a
 * fact of the week brought up again. Said in Crêpe, the bubble's main
 * line would carry nothing; they are always said in clear.
 */
const CLEAR_EVENTS: ReadonlySet<VoiceEvent> = new Set([
    'pense_bete', 'pense_bete_relance', 'pense_bete_ok', 'pense_bete_incompris', 'pense_bete_en_retard',
    'pense_bete_plein', 'bilan', 'bilan_semaine', 'reunion_fin_resume', 'rappel_pipeline', 'rappel_commandes',
    'rappel_bouderie', 'rappel_focus',
]);

/**
 * What she says: `text` goes in the bubble, and `translation` is the
 * same line in clear when `text` is in Crêpe, null when it already is.
 */
export interface Utterance {
    readonly text: string;
    readonly translation: string | null;
}

/** The line as anyone can read it, whichever way she said it. */
export function inClear(utterance: Utterance): string {
    return utterance.translation ?? utterance.text;
}

/** The settings the voice reads; narrower than `CrepeSettings` so the tests can hand in a plain object. */
export type VoiceSettings = Pick<CrepeSettings, 'talk' | 'crepeSpeech'>;

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
    private readonly settings: VoiceSettings;
    private readonly isBubbleShowing: () => boolean;
    /** In [0, 1); injectable so tests can pin every draw. */
    private readonly random: () => number;
    private lines = new Map<VoiceEvent, readonly string[]>();
    private readonly lastLine = new Map<VoiceEvent, string>();
    private lastSpokenAt = 0;
    private lastContextAt = 0;
    /** The day she last told the time, as "year-month-day". */
    private lastClockDay: string | null = null;

    constructor(settings: VoiceSettings, isBubbleShowing: () => boolean, random: () => number = Math.random) {
        this.settings = settings;
        this.isBubbleShowing = isBubbleShowing;
        this.random = random;
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

    /** Whether an idle remark would be let through right now: talking allowed and the cooldown over. */
    get mayRemark(): boolean {
        return this.settings.talk && Date.now() - this.lastSpokenAt >= GLOBAL_COOLDOWN;
    }

    /**
     * A remark written elsewhere (the daemon's), under the rules of an idle
     * one: the talk switch and the cooldown. Returns it, or null when she
     * keeps quiet. Never in Crêpe: it was written to be read.
     */
    utter(line: string): string | null {
        if (!this.mayRemark)
            return null;
        this.lastSpokenAt = Date.now();
        return line;
    }

    /**
     * Something a script asked her to pass on as is: only the talk switch
     * keeps it to herself. Returns it, or null when she keeps quiet. Never
     * in Crêpe, since it is passed on as is.
     */
    relay(line: string): string | null {
        if (!this.settings.talk)
            return null;
        this.lastSpokenAt = Date.now();
        return line;
    }

    /**
     * The evening recap, from the day's counters; null counters mean an
     * empty day and pick one of the lines without any. It waits for the
     * bubble to be free rather than talk over something. Returns the line,
     * or null when she keeps quiet, so the caller can try again later.
     */
    recap(counts: LineValues | null): Utterance | null {
        if (!this.settings.talk || this.isBubbleShowing())
            return null;
        const line = this.pickLine('bilan', counts ?? {}, counts === null ? null : 'any');
        if (line === null)
            return null;
        this.lastSpokenAt = Date.now();
        return line;
    }

    /**
     * A reminder's line: said whatever the talk switch, the cooldown or
     * the bubble say, since she was asked for it. Null only when no line
     * can be filled from `values`.
     */
    pick(event: ToldEvent, values: LineValues = {}): Utterance | null {
        const line = this.pickLine(event, values, null);
        if (line !== null)
            this.lastSpokenAt = Date.now();
        return line;
    }

    /**
     * A fact of the week or the weekly bilan, under the rules of the
     * recap: the talk switch, and the bubble free. `needsValues` keeps
     * only the lines that use one of `values` (the bilan has others for
     * a week with nothing in it). Null when she keeps quiet.
     */
    tell(event: ToldEvent, values: LineValues, needsValues: boolean): Utterance | null {
        if (!this.settings.talk || this.isBubbleShowing())
            return null;
        const line = this.pickLine(event, values, needsValues ? 'any' : null);
        if (line !== null)
            this.lastSpokenAt = Date.now();
        return line;
    }

    /**
     * Lines with a placeholder missing from `values` are never picked.
     * Lines with `{tickets}` only one time in three when it is known.
     */
    speak(event: TriggerEvent, values: LineValues = {}): Utterance | null {
        if (!this.settings.talk)
            return null;
        const now = Date.now();
        if (DIRECT_EVENTS.has(event)) {
            if (this.isBubbleShowing() && !INTERRUPTING_EVENTS.has(event))
                return null;
        } else if (now - this.lastSpokenAt < GLOBAL_COOLDOWN) {
            return null;
        }
        if (this.random() >= PROBABILITY[event])
            return null;

        const date = new Date(now);
        const tellsTime = this.isFirstMorningGreeting(event, date);
        const chosen = tellsTime ? 'matin' : this.withTimeOfDay(event, now);
        const line = this.pickWithTickets(chosen, {heure: clock(date), ...values}, tellsTime);
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
        if (context === null || this.random() >= CONTEXT_PROBABILITY)
            return event;
        return context;
    }

    /**
     * The time told wins over the tickets. Otherwise, with the tickets
     * known and the odds for it, a line about them if the event has one.
     */
    private pickWithTickets(event: VoiceEvent, values: LineValues, tellsTime: boolean): Utterance | null {
        const {tickets, ...withoutTickets} = values;
        if (tellsTime)
            return this.pickLine(event, withoutTickets, 'heure');
        if (tickets !== undefined && this.random() < TICKETS_MENTION_CHANCE) {
            const line = this.pickLine(event, values, 'tickets');
            if (line !== null)
                return line;
        }
        return this.pickLine(event, withoutTickets, null);
    }

    /**
     * A random line that `values` can fill, never the one she said last
     * time for the same event. `mention` keeps only lines using that
     * placeholder, or using any placeholder at all for 'any'. Said in
     * Crêpe as often as the setting asks, the filled values kept as is.
     */
    private pickLine(event: VoiceEvent, values: LineValues, mention: Placeholder | 'any' | null): Utterance | null {
        const candidates = (this.lines.get(event) ?? []).filter(line =>
            placeholdersOf(line).every(name => values[name] !== undefined) && mentions(line, mention));
        const previous = this.lastLine.get(event);
        const fresh = candidates.length > 1 ? candidates.filter(line => line !== previous) : candidates;
        const line = fresh[Math.floor(this.random() * fresh.length)];
        if (line === undefined)
            return null;
        this.lastLine.set(event, line);
        const filledValues: string[] = [];
        const filled = line.replace(PLACEHOLDER_PATTERN, (_match, name: Placeholder) => {
            const value = values[name] ?? '';
            filledValues.push(value);
            return value;
        });
        // A cut `{texte}` already ends with an ellipsis: the line's own full stop would double it.
        // A line that opens on a placeholder ("{jour}, ...") still starts with a capital.
        const sentence = capitalised(filled.replace(/…\./g, '…'));
        if (CLEAR_EVENTS.has(event) || !shouldCrepify(this.settings.crepeSpeech, this.random))
            return {text: sentence, translation: null};
        // A line opening on a placeholder gave that value a capital: it is kept as it now reads.
        const opening = filledValues[0];
        const keep = line.startsWith('{') && opening !== undefined ? [capitalised(opening), ...filledValues] : filledValues;
        return {text: crepify(sentence, keep, this.random), translation: sentence};
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

function capitalised(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
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

function mentions(line: string, mention: Placeholder | 'any' | null): boolean {
    if (mention === null)
        return true;
    const names = placeholdersOf(line);
    return mention === 'any' ? names.length > 0 : names.includes(mention);
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
