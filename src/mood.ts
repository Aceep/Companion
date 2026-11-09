const SECOND = 1000;

/** What she is pestered with. Being carried around costs more patience than a click. */
export type PokeKind = 'click' | 'drag';

/** Furious only happens to an octopus already sulking: she has stormed off the screen. */
export type MoodLevel = 'calm' | 'annoyed' | 'angry' | 'furious';

export interface PokeResult {
    level: MoodLevel;
    /** True only on the poke that tips her over, so the bat comes out once per sulk. */
    becameAngry: boolean;
    /** True only on the poke that sends a sulking octopus off the screen, once per departure. */
    becameFurious: boolean;
}

const POKE_POINTS: Record<PokeKind, number> = {
    click: 1,
    drag: 2,
};
/** Past this, more pestering only makes her take longer to calm down. */
const MAX_SCORE = 12;
const DECAY_EVERY = 20 * SECOND;
const ANNOYED_FROM = 4;
const ANGRY_FROM = 8;
const SULK_DURATION = 90 * SECOND;
/** Back from storming off, she still sulks at least this long. */
const SULK_AFTER_STORMING_OFF = 60 * SECOND;

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
    /** Gone off the screen in a fury, until `cameBack()`. */
    private stormedOff = false;

    constructor(now: () => number = () => Date.now()) {
        this.now = now;
    }

    get score(): number {
        return this.scoreAt(this.now());
    }

    get level(): MoodLevel {
        return this.stormedOff ? 'furious' : levelFor(this.score);
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
        // A calm octopus pushed to the cap only gets angry; it takes pestering her mid-sulk.
        const becameFurious = wasSulking && !this.stormedOff && this.scoreAtLastPoke >= MAX_SCORE;
        if (becameFurious)
            this.stormedOff = true;
        // Pestering a sulking octopus only makes the sulk last longer.
        if (becameAngry || wasSulking)
            this.sulkUntil = now + SULK_DURATION;
        return {level: this.stormedOff ? 'furious' : level, becameAngry, becameFurious};
    }

    /**
     * A point of irritation that is not a poke (a reminder she keeps being
     * ignored on): it never tips her into sulking by itself, it only gets
     * her closer to it.
     */
    irritate(): void {
        const now = this.now();
        const current = this.scoreAt(now);
        this.scoreAtLastPoke = Math.max(current, Math.min(ANGRY_FROM - 1, current + 1));
        this.lastPokeAt = now;
    }

    /**
     * Back from storming off: down to just angry, so the next poke does
     * not send her away again, and still sulking for a while.
     */
    cameBack(): void {
        const now = this.now();
        this.stormedOff = false;
        this.scoreAtLastPoke = Math.min(ANGRY_FROM, this.scoreAt(now));
        this.lastPokeAt = now;
        this.sulkUntil = Math.max(this.sulkUntil, now + SULK_AFTER_STORMING_OFF);
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
