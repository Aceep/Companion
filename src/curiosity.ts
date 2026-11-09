import type {Point} from './geometry.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

/** Focus kept in another room this long, and she wants to see what goes on there. */
export const VISIT_AFTER = 2 * MINUTE;
/** Focus back in her room this long, and there is nothing left to see over there. */
export const RETURN_AFTER = 3 * MINUTE;
/** Going to look more often than this would be keeping watch, not curiosity. */
export const VISIT_EVERY = 10 * MINUTE;

/** What keeps her from setting off on a visit, whatever the focus says. */
export type VisitBlocker = 'dodging' | 'perched' | 'hiding' | 'storming' | 'sulking' | 'focus' | 'meeting' | 'asleep' |
    'carried' | 'crawling';

export interface CuriosityInput {
    now: number;
    /** The monitor of the focused window; null with none, or with the desktop focused. */
    focusedRoom: number | null;
    /** The room she lives in, null with no monitor at all. */
    homeRoom: number | null;
    /** On a visit, wherever in the visited room she is: on its floor, perched there or out of a window's way. */
    visiting: boolean;
    /** Someone is at the keyboard or the mouse: not idle for the sleep delay. */
    userActive: boolean;
    blockers: readonly VisitBlocker[];
}

/** `visit`: go and see the focused window's room. `return`: the visit is over, home. */
export type CuriosityStep = 'visit' | 'return' | 'none';

/**
 * Whether she goes to see the room where you work when it is not hers,
 * and when she comes back. Fed at each look with where the focus is;
 * keeps no timer of its own, so a test drives it with any clock. Focus
 * moving between windows of the same room is still the same room.
 */
export class Curiosity {
    /** The room the focus has stayed in since `streakSince`, null for hers or none. */
    private streakRoom: number | null = null;
    private streakSince = 0;
    private tracking = false;
    private lastVisitAt = Number.NEGATIVE_INFINITY;

    update(input: CuriosityInput): CuriosityStep {
        const {now, focusedRoom, homeRoom} = input;
        if (homeRoom === null)
            return 'none';
        const elsewhere = focusedRoom !== null && focusedRoom !== homeRoom ? focusedRoom : null;
        if (!this.tracking || elsewhere !== this.streakRoom) {
            this.tracking = true;
            this.streakRoom = elsewhere;
            this.streakSince = now;
        }
        const lasted = now - this.streakSince;
        if (input.visiting)
            return elsewhere === null && lasted >= RETURN_AFTER ? 'return' : 'none';
        if (elsewhere === null)
            return 'none';
        // A window left focused while you are away is not where you work: the count starts again when you are back.
        if (!input.userActive) {
            this.streakSince = now;
            return 'none';
        }
        if (lasted < VISIT_AFTER || input.blockers.length > 0 || now - this.lastVisitAt < VISIT_EVERY)
            return 'none';
        this.lastVisitAt = now;
        return 'visit';
    }

    /** She stopped looking (hidden, disabled): wherever the focus is, it is new to her next time. */
    reset(): void {
        this.tracking = false;
    }
}

/** The pointer left alone this long, with someone still at the keyboard, and it is a toy. */
export const STILL_FOR = 2 * MINUTE;
/** She stares at it this long before creeping up on it. */
export const STARE_FOR = 3 * SECOND;
/** Playing more often than this would be a habit, not a whim. */
export const PLAY_EVERY = 15 * MINUTE;
/** Stage pixels from her frame: closer than this, there is nothing to creep up on. */
export const PLAY_FROM = 150;
/** Stage pixels the pointer may twitch by before it counts as moving. */
export const TWITCH = 20;

/** What keeps her from playing with the pointer, or stops a game under way. */
export type PlayBlocker = 'absent' | 'asleep' | 'elsewhere' | 'annoyed' | 'focus' | 'meeting' | 'hushed' | 'carried' | 'busy';

export interface PlayInput {
    now: number;
    pointer: Point;
    /** When the pointer last moved at all. */
    stillSince: number;
    /** Stage pixels from the pointer to her frame. */
    distance: number;
    blockers: readonly PlayBlocker[];
}

/** `stare`: eyes on it. `approach`: creep up on it. `recoil`: it moved while she crept, she backs off. */
export type PlayStep = 'stare' | 'approach' | 'recoil' | 'none';

/** Idle, eyes on the pointer, creeping up on it, or arrived next to it. */
export type PlayPhase = 'idle' | 'staring' | 'approaching' | 'arrived';

/**
 * Whether she plays with a pointer left alone while you type: she
 * stares, creeps up on it, and backs off if it moves. Fed at each look
 * at the pointer; keeps no timer of its own.
 */
export class PointerPlay {
    private current: PlayPhase = 'idle';
    /** Where the pointer was when she started staring: moving off it by more than a twitch ends the game. */
    private anchor: Point = {x: 0, y: 0};
    private staringSince = 0;
    private lastPlayAt = Number.NEGATIVE_INFINITY;

    get phase(): PlayPhase {
        return this.current;
    }

    update(input: PlayInput): PlayStep {
        if (this.current === 'idle')
            return this.maybeStare(input);
        if (input.blockers.length > 0) {
            this.current = 'idle';
            return 'none';
        }
        const moved = Math.hypot(input.pointer.x - this.anchor.x, input.pointer.y - this.anchor.y) > TWITCH;
        if (moved) {
            const creeping = this.current === 'approaching';
            this.current = 'idle';
            return creeping ? 'recoil' : 'none';
        }
        if (this.current === 'staring' && input.now - this.staringSince >= STARE_FOR) {
            this.current = 'approaching';
            return 'approach';
        }
        return 'none';
    }

    /** She got there with the pointer still in place. False when the game was over before she arrived. */
    arrived(): boolean {
        if (this.current !== 'approaching')
            return false;
        this.current = 'arrived';
        return true;
    }

    /** The game is off, whatever it was at: she could not set off, or she stopped looking. */
    cancel(): void {
        this.current = 'idle';
    }

    private maybeStare(input: PlayInput): PlayStep {
        const {now} = input;
        if (now - input.stillSince < STILL_FOR || input.distance < PLAY_FROM || input.blockers.length > 0 ||
            now - this.lastPlayAt < PLAY_EVERY)
            return 'none';
        this.current = 'staring';
        this.anchor = input.pointer;
        this.staringSince = now;
        this.lastPlayAt = now;
        return 'stare';
    }
}
