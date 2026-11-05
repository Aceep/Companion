/**
 * What Crêpe wears, and when. Pure rules over a date and her state, no
 * GNOME dependency, so they can be checked from Eval with any date and
 * shared with the preferences.
 */

/** Every outfit the rules can put on; `assets/tenues.json` must describe each of them. */
export const OUTFIT_IDS = ['masque_nuit', 'bonnet', 'lunettes', 'chapeau_fete', 'verre', 'transat'] as const;

export type OutfitId = typeof OUTFIT_IDS[number];

export interface WardrobeState {
    isAsleep: boolean;
    /** Sulking with the bat, storming off included. */
    isSulking: boolean;
}

export interface WardrobeSettings {
    /** The master switch: off, she wears nothing at all. */
    enabled: boolean;
    /** One outfit id worn whatever the date, for showing them off; "" for none. */
    override: string;
    /** Her birthday as "MM-DD"; anything else means she has none. */
    birthday: string;
}

const JANUARY = 0;
const FEBRUARY = 1;
const JUNE = 5;
const SEPTEMBER = 8;
const DECEMBER = 11;
const FRIDAY = 5;
const SUNGLASSES_FROM_HOUR = 11;
const SUNGLASSES_UNTIL_HOUR = 17;
const FRIDAY_EVENING_FROM_HOUR = 17;
/** Days in each month of a leap year: 29 February is a birthday too, celebrated when it comes. */
const DAYS_IN_MONTH = [31, 29, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31] as const;

export function isOutfitId(value: string): value is OutfitId {
    return (OUTFIT_IDS as readonly string[]).includes(value);
}

/** "MM-DD" as a 0-based month and a day, or null when it is not a date of the year. */
export function parseBirthday(value: string): {month: number; day: number} | null {
    const match = /^(\d{2})-(\d{2})$/.exec(value.trim());
    if (!match)
        return null;
    const month = Number(match[1]) - 1;
    const day = Number(match[2]);
    const daysInMonth = DAYS_IN_MONTH[month];
    if (daysInMonth === undefined || day < 1 || day > daysInMonth)
        return null;
    return {month, day};
}

/**
 * The outfits she wears at `date`:
 *  - the sleep mask while asleep;
 *  - a knit hat from 1 December to the end of February, all day;
 *  - sunglasses from 21 June to 1 September, 11:00 to 17:00, awake;
 *  - a party hat on her birthday, all day, asleep too; it replaces the knit hat;
 *  - a glass and a deckchair on Friday from 17:00 to midnight; sulking,
 *    she holds the bat instead of the glass, and keeps the deckchair.
 * The override, when it names an outfit, is the only one she wears.
 */
export function activeOutfits(date: Date, state: WardrobeState, settings: WardrobeSettings): Set<OutfitId> {
    const worn = new Set<OutfitId>();
    if (!settings.enabled)
        return worn;
    if (isOutfitId(settings.override)) {
        worn.add(settings.override);
        return worn;
    }

    if (state.isAsleep)
        worn.add('masque_nuit');

    if (isBirthday(date, settings.birthday))
        worn.add('chapeau_fete');
    else if (isWinter(date))
        worn.add('bonnet');

    if (isSunglassesWeather(date) && !state.isAsleep)
        worn.add('lunettes');

    if (isFridayEvening(date)) {
        worn.add('transat');
        if (!state.isSulking)
            worn.add('verre');
    }
    return worn;
}

function isBirthday(date: Date, birthday: string): boolean {
    const parsed = parseBirthday(birthday);
    return parsed !== null && date.getMonth() === parsed.month && date.getDate() === parsed.day;
}

function isWinter(date: Date): boolean {
    const month = date.getMonth();
    return month === DECEMBER || month === JANUARY || month === FEBRUARY;
}

/** 21 June to 1 September, both included, during the hottest hours. */
function isSunglassesWeather(date: Date): boolean {
    const month = date.getMonth();
    const day = date.getDate();
    const inSeason = (month === JUNE && day >= 21) || (month > JUNE && month < SEPTEMBER) || (month === SEPTEMBER && day === 1);
    const hour = date.getHours();
    return inSeason && hour >= SUNGLASSES_FROM_HOUR && hour < SUNGLASSES_UNTIL_HOUR;
}

function isFridayEvening(date: Date): boolean {
    return date.getDay() === FRIDAY && date.getHours() >= FRIDAY_EVENING_FROM_HOUR;
}

/**
 * The event of what she says when an outfit goes on. The glass and the
 * deckchair come together and get one line, carried by the deckchair:
 * a sulk takes the glass away, never the deckchair. The sleep mask goes
 * on as she falls asleep, which has its own line.
 */
export const OUTFIT_LINES: Readonly<Partial<Record<OutfitId, OutfitLineEvent>>> = {
    chapeau_fete: 'tenue_fete',
    transat: 'tenue_vendredi',
    bonnet: 'tenue_hiver',
    lunettes: 'tenue_ete',
};

export type OutfitLineEvent = 'tenue_fete' | 'tenue_vendredi' | 'tenue_hiver' | 'tenue_ete';

/** The `last-outfit-lines` setting: outfit id to the day, "YYYY-MM-DD", of its last line. Anything unreadable is forgotten. */
export function parseLineDays(json: string): Record<string, string> {
    let parsed: unknown;
    try {
        parsed = JSON.parse(json);
    } catch {
        return {};
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed))
        return {};
    const days: Record<string, string> = {};
    for (const [id, day] of Object.entries(parsed as Record<string, unknown>)) {
        if (typeof day === 'string')
            days[id] = day;
    }
    return days;
}

/** Outfits worn that still have their line of the day to say, in a stable order. */
export function outfitsOwingALine(worn: ReadonlySet<OutfitId>, lineDays: Readonly<Record<string, string>>, today: string): OutfitId[] {
    return OUTFIT_IDS.filter(id => worn.has(id) && OUTFIT_LINES[id] !== undefined && lineDays[id] !== today);
}
