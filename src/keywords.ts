export type Reaction = 'facepalm' | 'pouce';

/** Words of a title that is making you wait, as opposed to the busy keywords, which only mean something runs. */
const WAITING_WORDS = ['loading', 'chargement', 'compiling', 'building', 'installing', 'en cours'];
const WAITING_ENDINGS = ['…', '...'];

export interface KeywordLists {
    readonly error: readonly string[];
    readonly success: readonly string[];
    readonly busy: readonly string[];
}

/**
 * The keyword settings, each list compiled once into a single pattern
 * instead of being searched again for every notification and title.
 */
export class KeywordMatcher {
    private readonly error: RegExp | null;
    private readonly success: RegExp | null;
    private readonly busy: RegExp | null;

    constructor(lists: KeywordLists) {
        this.error = wholeWordPattern(lists.error);
        this.success = wholeWordPattern(lists.success);
        this.busy = wholeWordPattern(lists.busy);
    }

    /**
     * Picks the reaction a piece of text deserves. Errors win over successes:
     * "build finished with error" is a facepalm, not a thumbs up.
     */
    classify(text: string): Reaction | null {
        if (matches(this.error, text))
            return 'facepalm';
        if (matches(this.success, text))
            return 'pouce';
        return null;
    }

    /** Whether `text` has one of the busy keywords. */
    looksBusy(text: string): boolean {
        return matches(this.busy, text);
    }
}

const WAITING_PATTERN = wholeWordPattern(WAITING_WORDS);

/** Whether a window title says it is making you wait: a waiting word, or trailing dots. */
export function looksLikeWaiting(title: string): boolean {
    const trimmed = title.trim();
    return matches(WAITING_PATTERN, trimmed) || WAITING_ENDINGS.some(ending => trimmed.endsWith(ending));
}

function matches(pattern: RegExp | null, text: string): boolean {
    return pattern !== null && pattern.test(text);
}

/**
 * One case-insensitive pattern matching any of `keywords` as a whole word,
 * or null when the list has none. A word ends at anything that is not a
 * letter or a digit in any script, so "test" stays out of "Latest" and
 * "échec" out of nothing, while "error:" and "[failed]" still count. One
 * trailing "s" is allowed before that end, since titles say "3 errors" and
 * "tests passed" as often as the singular.
 */
function wholeWordPattern(keywords: readonly string[]): RegExp | null {
    const alternatives = keywords
        .map(keyword => keyword.trim())
        .filter(keyword => keyword.length > 0)
        .map(escapeRegExp);
    if (alternatives.length === 0)
        return null;
    return new RegExp(`(?<![\\p{L}\\p{N}])(?:${alternatives.join('|')})s?(?![\\p{L}\\p{N}])`, 'iu');
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
