export type Reaction = 'facepalm' | 'pouce';

/** Words of a title that is making you wait, as opposed to the busy keywords, which only mean something runs. */
const WAITING_WORDS = ['loading', 'chargement', 'compiling', 'building', 'installing', 'en cours'];
const WAITING_ENDINGS = ['…', '...'];

/**
 * Picks the reaction a piece of text deserves. Errors win over successes:
 * "build finished with errors" is a facepalm, not a thumbs up.
 */
export function classify(text: string, errorKeywords: readonly string[], successKeywords: readonly string[]): Reaction | null {
    const haystack = text.toLowerCase();
    if (containsAny(haystack, errorKeywords))
        return 'facepalm';
    if (containsAny(haystack, successKeywords))
        return 'pouce';
    return null;
}

/** Whether `text` contains one of `keywords`, ignoring case. */
export function containsKeyword(text: string, keywords: readonly string[]): boolean {
    return containsAny(text.toLowerCase(), keywords);
}

/** Whether a window title says it is making you wait: a waiting word, or trailing dots. */
export function looksLikeWaiting(title: string): boolean {
    const trimmed = title.trim();
    return containsKeyword(trimmed, WAITING_WORDS) || WAITING_ENDINGS.some(ending => trimmed.endsWith(ending));
}

function containsAny(haystack: string, needles: readonly string[]): boolean {
    return needles.some(needle => {
        const trimmed = needle.trim().toLowerCase();
        return trimmed.length > 0 && haystack.includes(trimmed);
    });
}
