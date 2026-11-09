import type Meta from 'gi://Meta';

import type {IdleBehaviour} from './behaviour.js';
import type {Point, Rect} from './geometry.js';
import {isDesktop, type Presence} from './presence.js';
import type {Positioner} from './positioner.js';
import type {CrepeSettings} from './settings.js';
import type {CrepeSprite} from './sprite.js';
import type {TimerPool} from './timers.js';

/** A window being dragged or resized moves all the time; she waits for it to settle. */
const SETTLE_DELAY = 400;
/** She does not rush back the moment a window goes: it may come back just as fast. */
const RETURN_AFTER = 3 * 1000;
/** Moving aside more often than this would have her shuffling all day. */
const DODGE_EVERY = 10 * 1000;
/** Mid-crawl she is in nobody's way for long; she looks again this often until she stops. */
const CRAWL_RECHECK = 1000;
/** Share of her frame over the window past which she is in the way. */
const OVERLAP_LIMIT = 0.25;

/** Share of `own`'s area that `other` covers. */
export function overlapRatio(own: Rect, other: Rect): number {
    const width = Math.min(own.x + own.width, other.x + other.width) - Math.max(own.x, other.x);
    const height = Math.min(own.y + own.height, other.y + other.height) - Math.max(own.y, other.y);
    if (width <= 0 || height <= 0 || own.width <= 0 || own.height <= 0)
        return 0;
    return (width * height) / (own.width * own.height);
}

/**
 * The x closest to `x` where a frame `size` wide touches none of `window`
 * horizontally: just left of it or just right of it, between `minX` and
 * `maxX`. Null when neither fits, as next to a maximized window.
 */
export function freeSpotOnRow(x: number, size: number, window: Rect, minX: number, maxX: number): number | null {
    const candidates = [window.x - size, window.x + window.width].filter(candidate => candidate >= minX && candidate <= maxX);
    if (candidates.length === 0)
        return null;
    return candidates.reduce((best, candidate) => Math.abs(candidate - x) < Math.abs(best - x) ? candidate : best);
}

/**
 * On top of every window, she can sit right over what you are working on.
 * When the focused window comes under her, she crawls aside along her row,
 * or to the bottom-right corner when the window takes the whole row, both
 * in the room she is in, and back to her spot a little after the window
 * has lost focus or moved off it. A window on another monitor is not in
 * her way. Carried somewhere meanwhile, that is her spot now and there is
 * nothing to go back to. The first time a window sends her aside she may
 * say so.
 */
export class Dodger {
    private readonly sprite: CrepeSprite;
    private readonly presence: Presence;
    private readonly behaviour: IdleBehaviour;
    private readonly positioner: Positioner;
    private readonly timers: TimerPool;
    /** Told when a window sends her aside for the first time. */
    private readonly onFirstDodge: () => void;

    private focusHandlerId: number | null = null;
    private window: Meta.Window | null = null;
    private windowHandlerIds: number[] = [];
    private cancelCheck: (() => void) | null = null;
    private cancelReturn: (() => void) | null = null;
    private lastDodgeAt = Number.NEGATIVE_INFINITY;
    /** Sent to the corner: nowhere on her row was free, so being in the way there is no reason to move again. */
    private cornered = false;
    /** Windows that already sent her aside once, by id. */
    private readonly dodgedWindows = new Set<number>();

    constructor(
        sprite: CrepeSprite,
        presence: Presence,
        behaviour: IdleBehaviour,
        positioner: Positioner,
        timers: TimerPool,
        onFirstDodge: () => void,
    ) {
        this.sprite = sprite;
        this.presence = presence;
        this.behaviour = behaviour;
        this.positioner = positioner;
        this.timers = timers;
        this.onFirstDodge = onFirstDodge;
    }

    /**
     * Follows whether she should dodge at all (shown, the setting on, on top
     * of the windows). Turned off while out of a window's way, she goes back.
     */
    sync(active: boolean): void {
        if (active) {
            this.start();
            return;
        }
        const wasActive = this.focusHandlerId !== null;
        this.stop();
        if (wasActive)
            this.presence.undodge();
    }

    /** Stops watching; wherever she is, whoever stops her next puts her back. */
    stop(): void {
        if (this.focusHandlerId !== null)
            global.display.disconnect(this.focusHandlerId);
        this.focusHandlerId = null;
        this.unwatch();
        this.cancelCheck?.();
        this.cancelCheck = null;
        this.cancelReturn?.();
        this.cancelReturn = null;
        this.cornered = false;
    }

    private start(): void {
        if (this.focusHandlerId !== null)
            return;
        this.focusHandlerId = global.display.connect('notify::focus-window', () => this.onFocusChanged());
        this.onFocusChanged();
    }

    private onFocusChanged(): void {
        const window = global.display.focus_window;
        if (window !== this.window) {
            this.unwatch();
            this.watch(window);
        }
        this.scheduleCheck(SETTLE_DELAY);
    }

    private watch(window: Meta.Window | null): void {
        if (!window)
            return;
        this.window = window;
        const settle = () => this.scheduleCheck(SETTLE_DELAY);
        this.windowHandlerIds = [
            window.connect('position-changed', settle),
            window.connect('size-changed', settle),
            window.connect('notify::minimized', settle),
            window.connect('unmanaged', () => {
                this.unwatch();
                settle();
            }),
        ];
    }

    private unwatch(): void {
        if (this.window) {
            for (const id of this.windowHandlerIds)
                this.window.disconnect(id);
        }
        this.windowHandlerIds = [];
        this.window = null;
    }

    private scheduleCheck(delayMs: number): void {
        this.cancelCheck?.();
        this.cancelCheck = this.timers.schedule(delayMs, () => {
            this.cancelCheck = null;
            this.check();
        });
    }

    private check(): void {
        const frame = this.focusedFrame();
        const origin = this.presence.dodgeOrigin;
        if (origin) {
            this.checkWhileDodged(frame, origin);
            return;
        }
        this.cornered = false;
        if (frame && overlapRatio(this.frameAt(this.positioner.position), frame) > OVERLAP_LIMIT && this.presence.isHome)
            this.dodge(frame);
    }

    /**
     * Back home once the spot she left is clear of the focused window, a
     * little later. Still in the way where she went (the window grew or
     * followed her), she moves aside again.
     */
    private checkWhileDodged(frame: Rect | null, origin: Point): void {
        if (!frame || overlapRatio(this.frameAt(origin), frame) <= OVERLAP_LIMIT) {
            this.scheduleReturn();
            return;
        }
        this.cancelReturn?.();
        this.cancelReturn = null;
        if (!this.cornered && overlapRatio(this.frameAt(this.positioner.position), frame) > OVERLAP_LIMIT)
            this.dodge(frame);
    }

    private scheduleReturn(): void {
        if (this.cancelReturn)
            return;
        this.cancelReturn = this.timers.schedule(RETURN_AFTER, () => {
            this.cancelReturn = null;
            const origin = this.presence.dodgeOrigin;
            // Carried somewhere meanwhile: that is her spot now.
            if (!origin)
                return;
            const frame = this.focusedFrame();
            if (frame && overlapRatio(this.frameAt(origin), frame) > OVERLAP_LIMIT) {
                this.check();
                return;
            }
            // Asleep, she would only be teleported home: she goes when she wakes up and something moves.
            if (this.behaviour.isAsleep) {
                this.scheduleReturn();
                return;
            }
            this.cornered = false;
            // A window may have come under her spot during the trip.
            this.presence.undodge(() => this.scheduleCheck(SETTLE_DELAY));
        });
    }

    private dodge(window: Rect): void {
        // Stopping a crawl halfway would leave her remembered spot behind her, and the way back would end in a jump.
        if (this.behaviour.isCrawling) {
            this.scheduleCheck(CRAWL_RECHECK);
            return;
        }
        if (!this.mayMove())
            return;
        const wait = this.lastDodgeAt + DODGE_EVERY - Date.now();
        if (wait > 0) {
            this.scheduleCheck(wait);
            return;
        }
        const area = this.positioner.placementArea();
        if (!area)
            return;
        const here = this.positioner.position;
        const x = freeSpotOnRow(here.x, this.sprite.size, window, area.minX, area.maxX);
        const spot = x === null ? {x: area.maxX, y: area.maxY} : {x, y: here.y};
        if (!this.presence.dodge(spot))
            return;
        this.lastDodgeAt = Date.now();
        this.cornered = x === null;
        const id = this.window?.get_id();
        if (id === undefined || this.dodgedWindows.has(id))
            return;
        this.dodgedWindows.add(id);
        // Squeezed into the corner by a window taking all the room, she keeps it to herself.
        if (!this.cornered)
            this.onFirstDodge();
    }

    /** Not while hidden, storming off, perched, asleep, carried or focusing. */
    private mayMove(): boolean {
        return !this.presence.isAway && !this.presence.isStorming && !this.presence.isPerched &&
            !this.behaviour.isAsleep && !this.behaviour.isDragging && !this.behaviour.focusMode;
    }

    /** The focused window's frame, when it is one she could be in the way of: in the room she is in. */
    private focusedFrame(): Rect | null {
        const window = this.window;
        if (!window || window.minimized || window.is_fullscreen() || isDesktop(window))
            return null;
        if (window.get_monitor() !== this.positioner.roomIndex)
            return null;
        return window.get_frame_rect();
    }

    /** Her whole frame were she at `point`. */
    private frameAt(point: Point): Rect {
        return {x: point.x, y: point.y, width: this.sprite.size, height: this.sprite.size};
    }
}
