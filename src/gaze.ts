import type {Rect} from './geometry.js';
import type {TimerPool} from './timers.js';

/** How often the pointer is looked at while the eyes follow it. */
const POLL_EVERY = 150;
/** Stage pixels around her body where the pointer is too close to look at: she looks straight at you. */
const DEAD_ZONE = 60;
/** A pointer left alone this long is no longer interesting. */
const STILL_AFTER = 4 * 1000;

/**
 * Where the eyes of the resting pose can point, named like the poses in
 * `assets/animations.json`. Ordered clockwise from the right, screen y
 * pointing down, so the index is the angle in eighths of a turn.
 */
export const GAZE_DIRECTIONS = ['est', 'sud_est', 'sud', 'sud_ouest', 'ouest', 'nord_ouest', 'nord', 'nord_est'] as const;

export type GazeDirection = typeof GAZE_DIRECTIONS[number];

/** Each resting pose and the prefix of its variants with the eyes turned, drawn by `scripts/make-eyes.py`. */
const GAZE_POSES: Readonly<Record<string, string>> = {
    attente: 'yeux',
    batte_tenue: 'batte_yeux',
};

/** The variant of `restPose` looking `direction`, or `restPose` itself when looking straight or it has none. */
export function gazePose(restPose: string, direction: GazeDirection | null): string {
    const prefix = GAZE_POSES[restPose];
    if (direction === null || prefix === undefined)
        return restPose;
    return `${prefix}_${direction}`;
}

/** The resting pose `name` is, or is a variant of, whichever way it looks; null for anything else. */
export function restPoseOf(name: string | null): string | null {
    if (name === null)
        return null;
    for (const [restPose, prefix] of Object.entries(GAZE_POSES)) {
        if (name === restPose)
            return restPose;
        const direction = name.startsWith(`${prefix}_`) ? name.slice(prefix.length + 1) : null;
        if (direction !== null && (GAZE_DIRECTIONS as readonly string[]).includes(direction))
            return restPose;
    }
    return null;
}

/** Which way to look at something `dx`, `dy` stage pixels away from her eyes. */
export function gazeTowards(dx: number, dy: number): GazeDirection {
    const eighths = Math.round(Math.atan2(dy, dx) / (Math.PI / 4));
    return GAZE_DIRECTIONS[(eighths + GAZE_DIRECTIONS.length) % GAZE_DIRECTIONS.length] ?? 'est';
}

/** Whatever shows the eyes: told where to look, and whether looking around makes sense right now. */
export interface GazeHolder {
    readonly canFollowPointer: boolean;
    lookTowards(direction: GazeDirection | null): void;
}

/** Where she is on the stage, read at each look. */
export interface GazeTarget {
    /** Between her eyes. */
    eyes: () => {x: number; y: number};
    /** Her body, for the dead zone around it. */
    body: () => Rect;
}

/**
 * Her eyes follow the pointer while she rests: polled, since a shell actor
 * sees no motion over other windows. Close to her, or left alone for a few
 * seconds, the pointer gets a straight look. Not running at all unless
 * started, so turning it off costs nothing. Something she was shown
 * (`lookAt()`) holds her eyes for a while, polling or not.
 */
export class EyesFollower {
    private readonly holder: GazeHolder;
    private readonly timers: TimerPool;
    private readonly target: GazeTarget;
    private cancelPoll: (() => void) | null = null;
    private lastX = Number.NaN;
    private lastY = Number.NaN;
    private movedAt = 0;
    /** Where `lookAt()` keeps her eyes until `cancelHold` runs out. */
    private heldDirection: GazeDirection | null = null;
    private cancelHold: (() => void) | null = null;

    constructor(holder: GazeHolder, timers: TimerPool, target: GazeTarget) {
        this.holder = holder;
        this.timers = timers;
        this.target = target;
    }

    get isFollowing(): boolean {
        return this.cancelPoll !== null;
    }

    start(): void {
        if (this.cancelPoll)
            return;
        this.poll();
    }

    stop(): void {
        this.cancelPoll?.();
        this.cancelPoll = null;
        this.cancelHold?.();
        this.cancelHold = null;
        this.heldDirection = null;
        this.lastX = Number.NaN;
        this.lastY = Number.NaN;
        this.holder.lookTowards(null);
    }

    /**
     * Looks towards `point`, in stage pixels, for `forMs`, whatever the
     * pointer does; then back to following it, or straight ahead when her
     * eyes do not follow it. Shown at once if she is resting.
     */
    lookAt(point: {x: number; y: number}, forMs: number): void {
        const eyes = this.target.eyes();
        this.heldDirection = gazeTowards(point.x - eyes.x, point.y - eyes.y);
        this.cancelHold?.();
        this.cancelHold = this.timers.schedule(forMs, () => {
            this.cancelHold = null;
            this.heldDirection = null;
            // Polling, the next look turns them; otherwise nobody else would.
            if (!this.isFollowing)
                this.holder.lookTowards(null);
        });
        if (this.holder.canFollowPointer)
            this.holder.lookTowards(this.heldDirection);
    }

    private poll(): void {
        this.cancelPoll = this.timers.schedule(POLL_EVERY, () => {
            this.cancelPoll = null;
            this.look();
            this.poll();
        });
    }

    private look(): void {
        const [x, y] = global.get_pointer();
        const now = Date.now();
        if (x !== this.lastX || y !== this.lastY) {
            this.lastX = x;
            this.lastY = y;
            this.movedAt = now;
        }
        if (!this.holder.canFollowPointer) {
            this.holder.lookTowards(null);
            return;
        }
        if (this.heldDirection !== null) {
            this.holder.lookTowards(this.heldDirection);
            return;
        }
        if (now - this.movedAt >= STILL_AFTER || this.isClose(x, y)) {
            this.holder.lookTowards(null);
            return;
        }
        const eyes = this.target.eyes();
        this.holder.lookTowards(gazeTowards(x - eyes.x, y - eyes.y));
    }

    private isClose(x: number, y: number): boolean {
        const body = this.target.body();
        return x >= body.x - DEAD_ZONE && x <= body.x + body.width + DEAD_ZONE &&
            y >= body.y - DEAD_ZONE && y <= body.y + body.height + DEAD_ZONE;
    }
}
