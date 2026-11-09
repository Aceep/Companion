import Meta from 'gi://Meta';

import type {IdleBehaviour} from './behaviour.js';
import {Curiosity, PointerPlay, type PlayBlocker, type VisitBlocker} from './curiosity.js';
import {OVERLAP_LIMIT, freeSpotOnRow, overlapRatio} from './dodge.js';
import type {EyesFollower, PointerWatcher} from './gaze.js';
import type {Point, Rect} from './geometry.js';
import type {Bounds} from './monitors.js';
import {isDesktop, type Presence} from './presence.js';
import type {Positioner} from './positioner.js';
import type {CrepeSprite} from './sprite.js';
import type {TimerPool} from './timers.js';

/** How often she checks where the focus is; a visit is a matter of minutes, not of seconds. */
const LOOK_EVERY = 5 * 1000;
/** Arrived, she looks at the window that drew her there for this long. */
const STARE_AT_WINDOW = 4 * 1000;
/** Idle shorter than this with the pointer still for minutes: someone is typing, the pointer is left alone. */
const TYPING_WITHIN = 60 * 1000;
/** Stage pixels between her body and the pointer when she stops by it. */
const STOP_SHORT = 30;

/**
 * Where a visit to `window` ends: on her usual row `y` of its room,
 * centred under it when that leaves her out of its way, otherwise just
 * beside it, the way a dodge does, or in the bottom-right corner when it
 * takes the whole row.
 */
function visitSpot(window: Rect, size: number, area: Bounds, y: number): Point {
    const centred = Math.min(area.maxX, Math.max(area.minX, window.x + window.width / 2 - size / 2));
    if (overlapRatio({x: centred, y, width: size, height: size}, window) <= OVERLAP_LIMIT)
        return {x: centred, y};
    const x = freeSpotOnRow(centred, size, window, area.minX, area.maxX);
    return x === null ? {x: area.maxX, y: area.maxY} : {x, y};
}

/**
 * The monitors are rooms of her home, and a window in another room
 * than hers does not exist for her, until you have worked in it for a
 * while: then she goes to see. On a visit the visited room is hers for
 * everything (strolls, dodging, perching), but her spot stays where it
 * was, and once you are back to work in her room for a while she
 * crawls back there. `Curiosity` decides; this only looks and moves her.
 */
export class Visits {
    private readonly sprite: CrepeSprite;
    private readonly presence: Presence;
    private readonly behaviour: IdleBehaviour;
    private readonly positioner: Positioner;
    private readonly eyes: EyesFollower;
    private readonly timers: TimerPool;
    /** A meeting, silent or hidden: she keeps to her room. */
    private readonly inMeeting: () => boolean;
    private readonly curiosity = new Curiosity();
    private cancelLook: (() => void) | null = null;

    constructor(
        sprite: CrepeSprite,
        presence: Presence,
        behaviour: IdleBehaviour,
        positioner: Positioner,
        eyes: EyesFollower,
        timers: TimerPool,
        inMeeting: () => boolean,
    ) {
        this.sprite = sprite;
        this.presence = presence;
        this.behaviour = behaviour;
        this.positioner = positioner;
        this.eyes = eyes;
        this.timers = timers;
        this.inMeeting = inMeeting;
    }

    /** Looks only while she is shown; whatever visit she is on, the presence ends it when she is hidden. */
    sync(active: boolean): void {
        if (active)
            this.start();
        else
            this.stop();
    }

    stop(): void {
        this.cancelLook?.();
        this.cancelLook = null;
        this.curiosity.reset();
    }

    private start(): void {
        if (this.cancelLook)
            return;
        this.scheduleLook();
    }

    private scheduleLook(): void {
        this.cancelLook = this.timers.schedule(LOOK_EVERY, () => {
            this.cancelLook = null;
            this.look();
            this.scheduleLook();
        });
    }

    private look(): void {
        const window = this.focusedWindow();
        const step = this.curiosity.update({
            now: Date.now(),
            focusedRoom: window?.get_monitor() ?? null,
            homeRoom: this.positioner.homeRoomIndex,
            visiting: this.presence.isVisiting,
            userActive: this.behaviour.isUserActive,
            blockers: this.blockers(),
        });
        if (step === 'visit' && window)
            this.visit(window);
        // Asleep or carried she cannot set off, and a crawl of her own is finished first: the next look tries again.
        else if (step === 'return' && !this.behaviour.isCrawling)
            this.presence.endVisit();
    }

    private visit(window: Meta.Window): void {
        const room = window.get_monitor();
        const area = this.positioner.placementAreaOfMonitor(room);
        const y = this.positioner.rowIn(room);
        if (!area || y === null)
            return;
        const frame = window.get_frame_rect();
        const spot = visitSpot(frame, this.sprite.size, area, y);
        // Where the window was when it drew her: it may be gone by the time she gets there.
        const centre = {x: frame.x + frame.width / 2, y: frame.y + frame.height / 2};
        this.presence.visit(spot, room, () => {
            this.eyes.lookAt(centre, STARE_AT_WINDOW);
            this.behaviour.remark('curieuse');
        });
    }

    /** Not while dodging, perched, hiding, storming off, sulking, focusing, in a meeting, asleep, carried or crawling. */
    private blockers(): VisitBlocker[] {
        const {presence, behaviour} = this;
        const reasons: [VisitBlocker, boolean][] = [
            ['dodging', presence.isDodged],
            ['perched', presence.isPerched],
            ['hiding', presence.isAway],
            ['storming', presence.isStorming || behaviour.isFurious],
            ['sulking', behaviour.isSulking],
            ['focus', behaviour.focusMode],
            ['meeting', this.inMeeting()],
            ['asleep', behaviour.isAsleep],
            ['carried', behaviour.isDragging],
            // Her own crawl, or a trip she is on: a visit sets off from her spot, not from halfway somewhere.
            ['crawling', behaviour.isCrawling || !presence.isHome],
        ];
        return reasons.filter(([, applies]) => applies).map(([blocker]) => blocker);
    }

    /** A window she could go and see: a normal one, shown, not the desktop's. */
    private focusedWindow(): Meta.Window | null {
        const window = global.display.focus_window;
        if (!window || window.minimized || isDesktop(window) || window.get_window_type() !== Meta.WindowType.NORMAL)
            return null;
        return window;
    }
}

/** Stage pixels from `point` to the nearest edge of `rect`, 0 inside it. */
function distanceTo(point: Point, rect: Rect): number {
    const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
    const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
    return Math.hypot(dx, dy);
}

/**
 * A pointer left alone while you type is a toy: she stares at it,
 * creeps up on it along her row, and backs off if it moves. Next to it
 * is not where she lives: her next stroll, or the end of the visit, takes
 * her back. Fed by the eyes' own polling of the pointer, so with her
 * eyes not following it there is no game either. `PointerPlay` decides.
 */
export class PointerGame implements PointerWatcher {
    private readonly sprite: CrepeSprite;
    private readonly presence: Presence;
    private readonly behaviour: IdleBehaviour;
    private readonly positioner: Positioner;
    private readonly eyes: EyesFollower;
    /** Her body on the stage: she stops short of the pointer with it, not with her empty frame. */
    private readonly body: () => Rect;
    private readonly inMeeting: () => boolean;
    private readonly play = new PointerPlay();

    constructor(
        sprite: CrepeSprite,
        presence: Presence,
        behaviour: IdleBehaviour,
        positioner: Positioner,
        eyes: EyesFollower,
        body: () => Rect,
        inMeeting: () => boolean,
    ) {
        this.sprite = sprite;
        this.presence = presence;
        this.behaviour = behaviour;
        this.positioner = positioner;
        this.eyes = eyes;
        this.body = body;
        this.inMeeting = inMeeting;
    }

    polled(pointer: Point, stillSince: number, now: number): void {
        const frame = {x: this.sprite.actor.x, y: this.sprite.actor.y, width: this.sprite.size, height: this.sprite.size};
        const step = this.play.update({now, pointer, stillSince, distance: distanceTo(pointer, frame), blockers: this.blockers()});
        if (step === 'approach' && !this.approach(pointer))
            this.play.cancel();
        else if (step === 'recoil')
            this.presence.recoil();
        this.eyes.fixate(this.play.phase !== 'idle');
    }

    stopped(): void {
        this.play.cancel();
    }

    /** Along her row to `STOP_SHORT` from the pointer, or right under or over it when it is well above or below her. */
    private approach(pointer: Point): boolean {
        const area = this.positioner.placementArea();
        if (!area)
            return false;
        const frameX = this.sprite.actor.x;
        const body = this.body();
        const bodyLeft = body.x - frameX;
        const bodyRight = body.x + body.width - frameX;
        const above = body.y - pointer.y;
        const below = pointer.y - (body.y + body.height);
        let x: number;
        if (Math.max(above, below) > STOP_SHORT)
            x = pointer.x - (bodyLeft + bodyRight) / 2;
        else if (pointer.x > body.x + body.width)
            x = pointer.x - STOP_SHORT - bodyRight;
        else
            x = pointer.x + STOP_SHORT - bodyLeft;
        const spot = {x: Math.min(area.maxX, Math.max(area.minX, x)), y: this.sprite.actor.y};
        return this.presence.approach(spot, () => {
            if (this.play.arrived())
                this.behaviour.remark('souris');
        });
    }

    /**
     * Not unless she is calm, awake, at her spot or on a visit, free, not
     * focusing, in a meeting, hushed or carried, with someone typing. Her
     * own approach is no reason to stop it.
     */
    private blockers(): PlayBlocker[] {
        const {presence, behaviour} = this;
        const creeping = this.play.phase === 'approaching';
        const reasons: [PlayBlocker, boolean][] = [
            ['absent', behaviour.idleTimeMs >= TYPING_WITHIN],
            ['asleep', behaviour.isAsleep],
            ['elsewhere', presence.isAway || presence.isStorming || presence.isPerched || presence.isDodged],
            ['annoyed', behaviour.moodLevel !== 'calm' || behaviour.isSulking],
            ['focus', behaviour.focusMode],
            ['meeting', this.inMeeting()],
            ['hushed', behaviour.isHushed],
            ['carried', behaviour.isDragging],
            ['busy', !creeping && (behaviour.isCrawling || behaviour.isTapping || !presence.isSettled)],
        ];
        return reasons.filter(([, applies]) => applies).map(([blocker]) => blocker);
    }
}
