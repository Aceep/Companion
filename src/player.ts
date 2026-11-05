import {IDLE_ANIMATION, type AnimationDef} from './animations.js';

/** Runs `callback` after `delayMs`; returns a function that cancels it. */
export type Scheduler = (delayMs: number, callback: () => void) => () => void;

export type FrameListener = (animation: AnimationDef, frameIndex: number) => void;

export interface PlayOptions {
    /** Called when a one-shot animation reaches its last frame. */
    onDone?: () => void;
}

/**
 * Animation state machine, independent from Clutter so it can be reasoned
 * about (and tested) without a running GNOME Shell.
 *
 * Rules, from Theo's brief:
 *  - looping animations run until something else is played;
 *  - one-shot animations play once, then fall back to the idle animation;
 *  - an animation with a tail loop plays once, then loops its tail forever.
 */
export class AnimationPlayer {
    private readonly animations: Map<string, AnimationDef>;
    private readonly schedule: Scheduler;
    private readonly onFrame: FrameListener;

    private current: AnimationDef | null = null;
    private frameIndex = 0;
    private inTailLoop = false;
    private cancelTimer: (() => void) | null = null;
    private onDone: (() => void) | null = null;

    constructor(animations: Map<string, AnimationDef>, schedule: Scheduler, onFrame: FrameListener) {
        this.animations = animations;
        this.schedule = schedule;
        this.onFrame = onFrame;
    }

    get currentName(): string | null {
        return this.current?.name ?? null;
    }

    has(name: string): boolean {
        return this.animations.has(name);
    }

    play(name: string, options: PlayOptions = {}): void {
        const animation = this.animations.get(name);
        if (!animation)
            throw new Error(`unknown animation "${name}"`);

        this.clearTimer();
        this.current = animation;
        this.frameIndex = 0;
        this.inTailLoop = false;
        this.onDone = options.onDone ?? null;
        this.showFrame();
    }

    stop(): void {
        this.clearTimer();
        this.current = null;
        this.onDone = null;
    }

    private showFrame(): void {
        const animation = this.current;
        if (!animation)
            return;

        this.onFrame(animation, this.frameIndex);
        const duration = animation.durationsMs[this.frameIndex] ?? 150;
        this.cancelTimer = this.schedule(duration, () => {
            this.cancelTimer = null;
            this.advance();
        });
    }

    private advance(): void {
        const animation = this.current;
        if (!animation)
            return;

        const next = this.nextFrameIndex(animation);
        if (next !== null) {
            this.frameIndex = next;
            this.showFrame();
            return;
        }

        const done = this.onDone;
        this.onDone = null;
        this.play(IDLE_ANIMATION);
        done?.();
    }

    /** Index of the frame after the current one, or null when the animation is over. */
    private nextFrameIndex(animation: AnimationDef): number | null {
        const last = animation.frames.length - 1;
        const tail = animation.tailLoop;

        if (tail && this.inTailLoop && this.frameIndex === tail[1])
            return tail[0];
        if (this.frameIndex < last)
            return this.frameIndex + 1;
        if (animation.loop)
            return 0;
        if (tail) {
            this.inTailLoop = true;
            return tail[0];
        }
        return null;
    }

    private clearTimer(): void {
        this.cancelTimer?.();
        this.cancelTimer = null;
    }
}
