const SECOND = 1000;

/** What she is pestered with. Being carried around costs more patience than a click. */
export type PokeKind = 'click' | 'drag';

export type MoodLevel = 'calm' | 'annoyed' | 'angry';

export interface PokeResult {
    level: MoodLevel;
    /** True only on the poke that tips her over, so the bat comes out once per sulk. */
    becameAngry: boolean;
}

const POKE_POINTS: Record<PokeKind, number> = {
    click: 1,
    drag: 2,
};
/** Past this, more pestering only makes her take longer to calm down. */
const MAX_SCORE = 8;
const DECAY_EVERY = 20 * SECOND;
const ANNOYED_FROM = 3;
const ANGRY_FROM = 5;
const SULK_DURATION = 60 * SECOND;

/**
 * How fed up Crêpe is with being clicked and carried around. Pure
 * bookkeeping without timers: the score decays lazily from timestamps,
 * so it can be driven from a test or from Eval with a fake clock.
 */
export class Annoyance {
    private readonly now: () => number;
    private scoreAtLastPoke = 0;
    private lastPokeAt = 0;
    private sulkUntil = 0;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    get score(): number {
        return this.scoreAt(this.now());
    }

    get level(): MoodLevel {
        return levelFor(this.score);
    }

    get isSulking(): boolean {
        return this.now() < this.sulkUntil;
    }

    get sulkRemainingMs(): number {
        return Math.max(0, this.sulkUntil - this.now());
    }

    poke(kind: PokeKind): PokeResult {
        const now = this.now();
        const wasSulking = now < this.sulkUntil;
        this.scoreAtLastPoke = Math.min(MAX_SCORE, this.scoreAt(now) + POKE_POINTS[kind]);
        this.lastPokeAt = now;

        const level = levelFor(this.scoreAtLastPoke);
        const becameAngry = level === 'angry' && !wasSulking;
        // Pestering a sulking octopus only makes the sulk last longer.
        if (becameAngry || wasSulking)
            this.sulkUntil = now + SULK_DURATION;
        return {level, becameAngry};
    }

    /** One point forgiven per quiet stretch since the last poke. */
    private scoreAt(now: number): number {
        const forgiven = Math.floor((now - this.lastPokeAt) / DECAY_EVERY);
        return Math.max(0, this.scoreAtLastPoke - forgiven);
    }
}

function levelFor(score: number): MoodLevel {
    if (score >= ANGRY_FROM)
        return 'angry';
    if (score >= ANNOYED_FROM)
        return 'annoyed';
    return 'calm';
}
