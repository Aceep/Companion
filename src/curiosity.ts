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
