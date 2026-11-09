/**
 * Her own language: every word of a line becomes a "crêpe", the way a
 * Pokémon only ever says its name, while the punctuation, the spaces and
 * the values that carry information stay as they are. Another pack's
 * character says its own word instead.
 */

/** The word Crêpe says, and the default for `crepify`. */
export const CREPE_WORD = 'crêpe';

const WORD_PATTERN = /[\p{L}\p{N}]+(?:['’-][\p{L}\p{N}]+)*/gu;
const LETTER = /\p{L}/u;
const VOWEL = /[aeiouyàâäéèêëîïôöùûüÿœæ]/iu;
const DIGIT = /\p{N}/u;
const UPPERCASE = /\p{Lu}/u;
const SENTENCE_END = /[.!?…]/u;

/** From this many letters a word may be drawn out: a long word gets a long crêpe. */
const LONG_WORD_LETTERS = 7;
const DRAWN_OUT_CHANCE = 1 / 3;

/**
 * `sentence` said in her language: every word becomes `said`. `keep` lists
 * substrings that survive verbatim (the values filled into the line);
 * words with a digit in them (a time, a count) are kept too, since the
 * number is the news. `random` is in [0, 1).
 */
export function crepify(sentence: string, keep: readonly string[], random: () => number, said: string = CREPE_WORD): string {
    const masked = maskKept(sentence, keep);
    const drawnOut = drawOut(said);
    let spoken = '';
    let copiedUpTo = 0;
    for (const match of masked.matchAll(WORD_PATTERN)) {
        const start = match.index;
        const word = match[0];
        const end = start + word.length;
        spoken += sentence.slice(copiedUpTo, start);
        spoken += DIGIT.test(word) ? word : crepeFor(word, endsExclaiming(masked, end), random, said, drawnOut);
        copiedUpTo = end;
    }
    return spoken + sentence.slice(copiedUpTo);
}

/** The word drawn out, its first vowel held: "crêêêpe", "poooireau". A word without one is drawn out as is. */
export function drawOut(said: string): string {
    const at = said.search(VOWEL);
    if (at === -1)
        return said;
    const vowel = said.charAt(at);
    return said.slice(0, at) + vowel.repeat(3) + said.slice(at + 1);
}

/** Whether a line comes out in Crêpe, for a share of `percent` out of 100. */
export function shouldCrepify(percent: number, random: () => number): boolean {
    return random() * 100 < percent;
}

/**
 * `sentence` with every kept substring blanked out, same length, so the
 * word search skips them and offsets still point into the original.
 */
function maskKept(sentence: string, keep: readonly string[]): string {
    let masked = sentence;
    for (const value of keep) {
        if (value.length === 0)
            continue;
        let from = sentence.indexOf(value);
        while (from !== -1) {
            masked = masked.slice(0, from) + ' '.repeat(value.length) + masked.slice(from + value.length);
            from = sentence.indexOf(value, from + value.length);
        }
    }
    return masked;
}

/** The word belongs to an exclamation when the first sentence end after it is a "!". */
function endsExclaiming(masked: string, wordEnd: number): boolean {
    const rest = masked.slice(wordEnd);
    const found = SENTENCE_END.exec(rest);
    return found !== null && found[0] === '!';
}

function crepeFor(word: string, exclaiming: boolean, random: () => number, said: string, drawnOut: string): string {
    const letters = [...word].filter(character => LETTER.test(character));
    const mayDrawOut = exclaiming || letters.length >= LONG_WORD_LETTERS;
    const crepe = mayDrawOut && random() < DRAWN_OUT_CHANCE ? drawnOut : said;
    // A lone capital ("À") is the start of a sentence, not shouting.
    if (letters.length > 1 && letters.every(letter => UPPERCASE.test(letter)))
        return crepe.toUpperCase();
    if (UPPERCASE.test(word.charAt(0)))
        return crepe.charAt(0).toUpperCase() + crepe.slice(1);
    return crepe;
}
