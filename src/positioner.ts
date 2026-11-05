import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FRAME_SIZE} from './animations.js';
import type {CrepeSettings} from './settings.js';
import {SIDE_PADDING, type CrepeSprite} from './sprite.js';

const EDGE_MARGIN = 24;
/** Sprite pixels of her body left on screen while she hides, enough to click her back. */
const PEEK_WIDTH = 10;

/** The shell adds `ease()` to every actor at runtime; the typings only see it on some import paths. */
interface EaseableActor extends Clutter.Actor {
    ease(params: {x: number; y?: number; duration: number; mode: Clutter.AnimationMode; onComplete: () => void}): void;
}

/** Where her top-left corner may go, in stage pixels. */
interface PlacementArea {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

export interface Point {
    x: number;
    y: number;
}

export type Side = 'left' | 'right';

/**
 * Keeps Crêpe inside the primary monitor's work area, at a position stored
 * as fractions of it so it survives rescales, monitor changes and logouts.
 * Moves her sideways at her current height for her own crawls, and
 * anywhere, off-screen included, for trips she is sent on.
 */
export class Positioner {
    private readonly sprite: CrepeSprite;
    private readonly settings: CrepeSettings;
    private readonly monitorsHandlerId: number;
    private detached = false;

    constructor(sprite: CrepeSprite, settings: CrepeSettings) {
        this.sprite = sprite;
        this.settings = settings;
        this.monitorsHandlerId = Main.layoutManager.connect('monitors-changed', () => this.place());
        this.place();
    }

    destroy(): void {
        Main.layoutManager.disconnect(this.monitorsHandlerId);
        this.cancelMove();
    }

    /** Puts her at the stored fractions of the work area, unless she is detached from them. */
    place(): void {
        const home = this.homePosition();
        if (this.detached || !home)
            return;
        this.sprite.actor.set_position(home.x, home.y);
    }

    /**
     * Someone else decides where she is for now (hiding, perching on a
     * window): `place()` leaves her alone and her moves no longer
     * overwrite the remembered spot.
     */
    detach(): void {
        this.detached = true;
    }

    /** Her position is her remembered spot again; puts her there. */
    attach(): void {
        this.detached = false;
        this.place();
    }

    /** Her remembered spot, in stage pixels. */
    homePosition(): Point | null {
        const area = this.placementArea();
        if (!area)
            return null;
        return {
            x: area.minX + this.settings.fractionX * (area.maxX - area.minX),
            y: area.minY + this.settings.fractionY * (area.maxY - area.minY),
        };
    }

    /** The side of the work area she is closer to. */
    nearestSide(): Side {
        const area = this.placementArea();
        if (!area)
            return 'right';
        return this.sprite.actor.x < (area.minX + area.maxX) / 2 ? 'left' : 'right';
    }

    /** Her x when she stands against that edge of the work area. */
    edgeX(side: Side): number | null {
        const area = this.placementArea();
        if (!area)
            return null;
        return side === 'left' ? area.minX : area.maxX;
    }

    /** A destination at least a quarter of the screen away, or null if there is no room. */
    pickDestination(): number | null {
        const area = this.placementArea();
        if (!area || area.maxX - area.minX < this.sprite.size)
            return null;
        const width = area.maxX - area.minX;
        const current = this.sprite.actor.x;
        for (let attempt = 0; attempt < 10; attempt++) {
            const candidate = area.minX + Math.random() * width;
            if (Math.abs(candidate - current) >= width / 4)
                return Math.round(candidate);
        }
        return null;
    }

    /**
     * Slides her to `x` at a constant speed, keeping her height. `onArrived`
     * only fires when the trip completes, not when it is cancelled.
     */
    moveTo(x: number, pixelsPerSecond: number, onArrived: () => void): void {
        this.slide({x, y: this.sprite.actor.y}, pixelsPerSecond, () => {
            this.rememberFractionX();
            onArrived();
        });
    }

    /**
     * Slides her to any point at a constant speed, outside the work area
     * included, without touching the remembered spot. Same `onArrived`
     * rule as `moveTo()`.
     */
    travelTo(point: Point, pixelsPerSecond: number, onArrived: () => void): void {
        this.slide(point, pixelsPerSecond, onArrived);
    }

    /** Slides her past that edge of the monitor, at her current height, until only a sliver of her shows. */
    moveOffscreen(side: Side, pixelsPerSecond: number, onDone: () => void): void {
        const x = this.offscreenX(side);
        if (x === null)
            return;
        this.slide({x, y: this.sprite.actor.y}, pixelsPerSecond, onDone);
    }

    /** Same place as `moveOffscreen()`, right away: the monitors changed while she was hiding. */
    putOffscreen(side: Side): void {
        const x = this.offscreenX(side);
        if (x !== null)
            this.sprite.actor.x = x;
    }

    cancelMove(): void {
        this.sprite.actor.remove_all_transitions();
        this.rememberFractionX();
    }

    /**
     * Stores where she was dropped, then snaps her into the work area if
     * she landed outside it. Wherever she was before, that spot is hers now.
     */
    rememberPosition(): void {
        this.detached = false;
        const area = this.placementArea();
        if (!area)
            return;
        this.rememberFractionX();
        if (area.maxY > area.minY)
            this.settings.fractionY = toFraction(this.sprite.actor.y, area.minY, area.maxY);
        this.place();
    }

    placementArea(): PlacementArea | null {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return null;
        const workArea = Main.layoutManager.getWorkAreaForMonitor(monitor.index);
        return {
            minX: workArea.x + EDGE_MARGIN,
            maxX: workArea.x + workArea.width - this.sprite.size - EDGE_MARGIN,
            minY: workArea.y,
            maxY: workArea.y + workArea.height - this.sprite.size,
        };
    }

    private rememberFractionX(): void {
        const area = this.placementArea();
        if (this.detached || !area || area.maxX <= area.minX)
            return;
        this.settings.fractionX = toFraction(this.sprite.actor.x, area.minX, area.maxX);
    }

    /** Whichever axis has further to go sets the duration, so a diagonal trip keeps the crawl pace. */
    private slide(point: Point, pixelsPerSecond: number, onComplete: () => void): void {
        const actor = this.sprite.actor;
        const distance = Math.max(Math.abs(point.x - actor.x), Math.abs(point.y - actor.y));
        (actor as EaseableActor).ease({
            x: point.x,
            y: point.y,
            duration: (distance / pixelsPerSecond) * 1000,
            mode: Clutter.AnimationMode.LINEAR,
            onComplete,
        });
    }

    /** Her x when `PEEK_WIDTH` sprite pixels of her body, not of the empty frame around it, stay on the monitor. */
    private offscreenX(side: Side): number | null {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return null;
        const scale = this.sprite.currentScale;
        if (side === 'left')
            return monitor.x - (FRAME_SIZE - SIDE_PADDING - PEEK_WIDTH) * scale;
        return monitor.x + monitor.width - (SIDE_PADDING + PEEK_WIDTH) * scale;
    }
}

function toFraction(value: number, min: number, max: number): number {
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
}
