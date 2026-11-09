import Clutter from 'gi://Clutter';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FRAME_SIZE} from './animations.js';
import type {Point} from './geometry.js';
import {House, type Bounds, type Room, type Side} from './monitors.js';
import type {CrepeSettings} from './settings.js';
import {SIDE_PADDING, type CrepeSprite} from './sprite.js';

/** Sprite pixels of her body left on screen while she hides, enough to click her back. */
const PEEK_WIDTH = 10;

/** The shell adds `ease()` to every actor at runtime; the typings only see it on some import paths. */
interface EaseableActor extends Clutter.Actor {
    ease(params: {x: number; y?: number; duration: number; mode: Clutter.AnimationMode; onComplete: () => void}): void;
}

/**
 * Keeps Crêpe inside the work area of one of the monitors, the rooms of
 * her home, at a position stored as the room and fractions of its work
 * area so it survives rescales, monitor changes and logouts. Moves her
 * sideways at her current height for her own crawls, from one room to
 * the next where their monitors touch, and anywhere, off-screen
 * included, for trips she is sent on.
 */
export class Positioner {
    private readonly sprite: CrepeSprite;
    private readonly settings: CrepeSettings;
    private detached = false;

    /** Monitor and work-area changes are the presence's to follow: only it knows whether she is home. */
    constructor(sprite: CrepeSprite, settings: CrepeSettings) {
        this.sprite = sprite;
        this.settings = settings;
        this.place();
    }

    /**
     * Stops any move without remembering where it stopped: a disable with
     * nothing moving writes nothing. Whoever means "stop here and keep
     * this spot" calls `cancelMove()` first.
     */
    destroy(): void {
        this.sprite.actor.remove_all_transitions();
    }

    /** Puts her at the stored fractions of her room's work area, unless she is detached from them. */
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

    /** Where she is right now, in stage pixels. */
    get position(): Point {
        return {x: this.sprite.actor.x, y: this.sprite.actor.y};
    }

    /** The monitor index of the room she is in, or null with no monitor at all. */
    get roomIndex(): number | null {
        return this.house()?.roomOf(this.position)?.index ?? null;
    }

    /** Whether her top-left corner may sit at `point` without being snapped back inside a work area. */
    isInsideArea(point: Point): boolean {
        return this.house()?.isInside(point) ?? false;
    }

    /** Her room is a monitor that is not plugged in: she lives on the primary one meanwhile. */
    isHomeRoomMissing(): boolean {
        const house = this.house();
        return house !== null && house.roomInDirection(this.settings.homeMonitor) === null;
    }

    /** Her remembered spot, in stage pixels: in her room, or on the primary while it is missing. */
    homePosition(): Point | null {
        const house = this.house();
        const room = house?.roomInDirection(this.settings.homeMonitor) ?? house?.primary ?? null;
        if (!house || !room)
            return null;
        const bounds = house.bounds(room);
        return {
            x: bounds.minX + this.settings.fractionX * (bounds.maxX - bounds.minX),
            y: bounds.minY + this.settings.fractionY * (bounds.maxY - bounds.minY),
        };
    }

    /** The side of the nearest wall, an edge with no monitor past it at her height. */
    nearestSide(): Side {
        return this.house()?.nearestWall(this.position) ?? 'right';
    }

    /** Her x when she stands against the wall on that side, rooms in between crossed. */
    edgeX(side: Side): number | null {
        const house = this.house();
        const room = house?.wallRoom(this.position, side) ?? null;
        if (!house || !room)
            return null;
        const bounds = house.bounds(room);
        return side === 'left' ? bounds.minX : bounds.maxX;
    }

    /** A destination for a stroll, in her room or one she can crawl to, or null if there is no room. */
    pickDestination(): number | null {
        return this.house()?.pickDestination(this.position, Math.random) ?? null;
    }

    /**
     * Crawls her to `x` at a constant speed, keeping her height, from room
     * to room where the monitors touch. `onArrived` only fires when the
     * trip completes, not when it is cancelled.
     */
    moveTo(x: number, pixelsPerSecond: number, onArrived: () => void): void {
        const route = this.house()?.crawlRoute(this.position, x) ?? [{x, y: this.sprite.actor.y}];
        this.slideThrough(route, pixelsPerSecond, () => {
            this.rememberSpot(false);
            onArrived();
        });
    }

    /**
     * Slides her to any point at a constant speed, outside the work areas
     * included, without touching the remembered spot. Same `onArrived`
     * rule as `moveTo()`.
     */
    travelTo(point: Point, pixelsPerSecond: number, onArrived: () => void): void {
        const route = this.house()?.travelRoute(this.position, point) ?? [point];
        this.slideThrough(route, pixelsPerSecond, onArrived);
    }

    /**
     * Slides her past the wall on that side, at her current height, until
     * only a sliver of her shows, or, without `peek`, until her whole
     * frame is past it.
     */
    moveOffscreen(side: Side, pixelsPerSecond: number, onDone: () => void, peek = true): void {
        const x = this.offscreenX(side, peek);
        if (x === null)
            return;
        this.slideThrough([{x, y: this.sprite.actor.y}], pixelsPerSecond, onDone);
    }

    /** Same place as `moveOffscreen()`, right away: the monitors changed while she was hiding. */
    putOffscreen(side: Side, peek = true): void {
        const x = this.offscreenX(side, peek);
        if (x !== null)
            this.sprite.actor.x = x;
    }

    /**
     * Stops her where she is. Height included: crawling back to where she
     * was picked up moves her up or down too, and a stop halfway has to
     * leave the remembered spot under her, not at the height she was dropped at.
     */
    cancelMove(): void {
        this.sprite.actor.remove_all_transitions();
        this.rememberSpot(false);
    }

    /**
     * Stores where she was dropped, room included, then snaps her into
     * that room's work area if she landed outside it. Wherever she was
     * before, that spot is hers now.
     */
    rememberPosition(): void {
        this.detached = false;
        this.rememberSpot(true);
        this.place();
    }

    /** Where her top-left corner may go in the room she is in. */
    placementArea(): Bounds | null {
        return this.placementAreaAt(this.position);
    }

    /** Where her top-left corner may go in the room she would be in at `point`: while carried, the room under her. */
    placementAreaAt(point: Point): Bounds | null {
        const house = this.house();
        const room = house?.roomOf(point) ?? null;
        return house && room ? house.bounds(room) : null;
    }

    /** Where her top-left corner may go on that monitor, or in her room if it is gone. */
    placementAreaOfMonitor(index: number): Bounds | null {
        const house = this.house();
        const room = house?.roomByIndex(index) ?? null;
        return house && room ? house.bounds(room) : this.placementArea();
    }

    /**
     * The monitors as they are now. Built at each use rather than kept:
     * the presence follows monitor and work-area changes, and her size
     * changes with the scale.
     */
    private house(): House | null {
        const layout = Main.layoutManager;
        if (layout.monitors.length === 0)
            return null;
        const rooms: Room[] = layout.monitors.map(monitor => {
            const area = layout.getWorkAreaForMonitor(monitor.index);
            return {
                index: monitor.index,
                monitor: {x: monitor.x, y: monitor.y, width: monitor.width, height: monitor.height},
                area: {x: area.x, y: area.y, width: area.width, height: area.height},
            };
        });
        return new House(rooms, layout.primaryIndex, this.sprite.size);
    }

    /**
     * Her room and her fractions of its work area. `dropped` says she was
     * put there: her own crawls on the primary while her room is unplugged
     * must not make her forget it, so they only move her spot there.
     */
    private rememberSpot(dropped: boolean): void {
        const house = this.house();
        const room = house?.roomOf(this.position) ?? null;
        if (this.detached || !house || !room)
            return;
        const camping = room === house.primary && house.roomInDirection(this.settings.homeMonitor) === null;
        const direction = house.directionOf(room);
        if ((dropped || !camping) && direction !== this.settings.homeMonitor)
            this.settings.homeMonitor = direction;
        const bounds = house.bounds(room);
        if (bounds.maxX > bounds.minX)
            this.settings.fractionX = toFraction(this.sprite.actor.x, bounds.minX, bounds.maxX);
        if (bounds.maxY > bounds.minY)
            this.settings.fractionY = toFraction(this.sprite.actor.y, bounds.minY, bounds.maxY);
    }

    /** One slide per stop, so crossing into a smaller room she drops to its height at the edge, not on the way. */
    private slideThrough(route: readonly Point[], pixelsPerSecond: number, onComplete: () => void): void {
        const [next, ...rest] = route;
        if (!next) {
            onComplete();
            return;
        }
        this.slide(next, pixelsPerSecond, () => this.slideThrough(rest, pixelsPerSecond, onComplete));
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

    /**
     * Her x when `PEEK_WIDTH` sprite pixels of her body, not of the empty
     * frame around it, stay on the monitor whose edge is the wall on that
     * side. Without `peek` the whole frame goes: some gestures reach into its margin.
     */
    private offscreenX(side: Side, peek: boolean): number | null {
        const room = this.house()?.wallRoom(this.position, side) ?? null;
        if (!room)
            return null;
        const monitor = room.monitor;
        const scale = this.sprite.currentScale;
        if (!peek)
            return side === 'left' ? monitor.x - FRAME_SIZE * scale : monitor.x + monitor.width;
        if (side === 'left')
            return monitor.x - (FRAME_SIZE - SIDE_PADDING - PEEK_WIDTH) * scale;
        return monitor.x + monitor.width - (SIDE_PADDING + PEEK_WIDTH) * scale;
    }
}

function toFraction(value: number, min: number, max: number): number {
    return Math.min(1, Math.max(0, (value - min) / (max - min)));
}
