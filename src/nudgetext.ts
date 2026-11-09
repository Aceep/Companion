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

export function isNudgeKind(kind: string): kind is NudgeKind {
    return (NUDGE_KINDS as readonly string[]).includes(kind);
}

/**
 * Control and format characters that are not whitespace: escapes, bells,
 * zero-width spaces and bidi overrides, which a script could use to make
 * her line read differently from what it holds. Tabs and newlines are
 * whitespace and become spaces instead. The zero-width joiner stays: it
 * holds emoji sequences such as 👩‍💻 together, and dropping it would show
 * their parts side by side. Variation selectors are marks, not format
 * characters, so they are kept already.
 */
const INVISIBLE = /(?![\s\u200D])[\p{Cc}\p{Cf}]/gu;

/**
 * What a script sent, fit for her bubble: invisible characters dropped,
 * one line, whitespace runs collapsed, cut with "…" past `max` characters
 * (code points, so an emoji is never split in half). Plain text all the
 * way, the bubble's label does not read markup.
 */
export function oneLine(text: string, max: number): string {
    const characters = [...text.replace(INVISIBLE, '').replace(/\s+/g, ' ').trim()];
    if (characters.length <= max)
        return characters.join('');
    return `${characters.slice(0, max - 1).join('').trimEnd()}…`;
}

/** A count of tickets, when the text is nothing but digits. */
export function ticketCount(text: string): number | null {
    const trimmed = text.trim();
    return /^\d+$/.test(trimmed) ? Number(trimmed) : null;
}
