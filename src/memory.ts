import {WEEKDAYS} from './context.js';
import {joinFrench} from './digest.js';
import {dayKey, sumDays, type DayCounts, type StatsDays} from './stats.js';

/** The events she brings an old fact up with; each has lines in `assets/repliques.json`. */
export type GagEvent = 'rappel_pipeline' | 'rappel_commandes' | 'rappel_bouderie' | 'rappel_focus';

export interface Gag {
    event: GagEvent;
    /** `{jour}` and `{nombre}` of her lines. */
    values: {jour: string; nombre: string};
}

interface GagRule {
    event: GagEvent;
    count: (counts: DayCounts) => number;
    /** A day below this is not worth bringing up. */
    threshold: number;
}

const RULES: readonly GagRule[] = [
    {event: 'rappel_pipeline', count: counts => counts.pipelines, threshold: 3},
    {event: 'rappel_commandes', count: counts => counts.commands, threshold: 5},
    // Storming off is a sulk that went further: it counts in the same fact.
    {event: 'rappel_bouderie', count: counts => counts.sulks + counts.storms, threshold: 2},
    {event: 'rappel_focus', count: counts => counts.focus, threshold: 3},
];

/** Yesterday back to the same weekday last week; today is the comment's own business. */
const DAYS_LOOKED_BACK = 7;

/**
 * The most notable fact of the last seven days before `today`, or null.
 * Notable is how far a day went past its rule's threshold (nine failed
 * commands against a threshold of five beats three failed pipelines
 * against three); a tie goes to the more recent day.
 */
export function pickGag(days: StatsDays, today: Date): Gag | null {
    let best: {gag: Gag; score: number} | null = null;
    for (let back = 1; back <= DAYS_LOOKED_BACK; back++) {
        // Noon steps clear of the hour lost or gained when the clocks change.
        const date = new Date(today.getFullYear(), today.getMonth(), today.getDate() - back, 12);
        const counts = days.get(dayKey(date));
        if (!counts)
            continue;
        for (const rule of RULES) {
            const count = rule.count(counts);
            if (count < rule.threshold)
                continue;
            const score = count / rule.threshold;
            if (best === null || score > best.score)
                best = {gag: {event: rule.event, values: {jour: dayName(date, back), nombre: String(count)}}, score};
        }
    }
    return best?.gag ?? null;
}

/** "hier", "mardi", and "mardi dernier" for the same weekday as today. */
function dayName(date: Date, back: number): string {
    if (back === 1)
        return 'hier';
    const weekday = WEEKDAYS[date.getDay()] ?? '';
    return back === DAYS_LOOKED_BACK ? `${weekday} dernier` : weekday;
}

/** What the week's bilan counts, in the order it tells it. */
const WEEK_PARTS: readonly (readonly [keyof DayCounts, string, string])[] = [
    ['notifications', 'notification', 'notifications'],
    ['pipelines', 'pipeline cassé', 'pipelines cassés'],
    ['commands', 'commande ratée', 'commandes ratées'],
    ['ignored', 'pense-bête ignoré', 'pense-bêtes ignorés'],
    ['clicks', 'clic sur moi', 'clics sur moi'],
    ['sulks', 'bouderie', 'bouderies'],
    ['storms', 'départ en furie', 'départs en furie'],
    ['focus', 'session de concentration', 'sessions de concentration'],
];

/** "42 notifications, 3 pipelines cassés et 2 bouderies" over the seven days up to `today`, or null for a week with nothing in it. */
export function weekResume(days: StatsDays, today: Date): string | null {
    const totals = sumDays(days, today, 7);
    const parts = WEEK_PARTS
        .filter(([counter]) => totals[counter] > 0)
        .map(([counter, singular, plural]) => `${totals[counter]} ${totals[counter] === 1 ? singular : plural}`);
    return joinFrench(parts);
}

const FRIDAY = 5;
const BILAN_FROM_HOUR = 17;

/** Friday from 17:00, once (`lastBilanDay` is the day it was last told), if the recap is on. */
export function weekBilanDue(now: Date, lastBilanDay: string, recapEnabled: boolean): boolean {
    return recapEnabled && now.getDay() === FRIDAY && now.getHours() >= BILAN_FROM_HOUR && lastBilanDay !== dayKey(now);
}
