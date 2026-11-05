import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {IdleBehaviour} from './behaviour.js';
import type {Point, Positioner, Side} from './positioner.js';
import type {CrepeSettings} from './settings.js';
import {FEET_PADDING, type CrepeSprite} from './sprite.js';

/** Sprite pixels per second on errands: four times her idle crawl, or reaching a window would take half a minute. */
const ERRAND_SPEED = 40;

/**
 * home: at her remembered spot, or crawling back to it from a window.
 * perched: on the focused window's title bar, or on her way there.
 * leaving, away, returning: hiding at the edge of the screen, a sliver of her
 * still showing, or on the way there or back.
 */
type State = 'home' | 'perched' | 'leaving' | 'away' | 'returning';

/**
 * Where Crêpe is when it is not her own spot: hiding off-screen, or
 * sitting on the focused window's title bar. The trips go through the
 * behaviour, so she crawls and her routine steps aside, and through the
 * positioner, detached so they never overwrite her remembered spot.
 */
export class Presence {
    private readonly sprite: CrepeSprite;
    private readonly positioner: Positioner;
    private readonly behaviour: IdleBehaviour;
    private readonly settings: CrepeSettings;
    private readonly monitorsHandlerId: number;

    private state: State = 'home';
    private hidingSide: Side = 'right';
    private travelling = false;
    private focusHandlerId: number | null = null;
    private perchWindow: Meta.Window | null = null;
    private perchHandlerIds: number[] = [];

    constructor(sprite: CrepeSprite, positioner: Positioner, behaviour: IdleBehaviour, settings: CrepeSettings) {
        this.sprite = sprite;
        this.positioner = positioner;
        this.behaviour = behaviour;
        this.settings = settings;
        this.monitorsHandlerId = Main.layoutManager.connect('monitors-changed', () => this.settle());
    }

    /** Hiding or on her way to hide: what the menu offers is to come back. */
    get isHidden(): boolean {
        return this.state === 'leaving' || this.state === 'away';
    }

    /** Off-screen or on the way there or back: notifications go unnoticed. */
    get isAway(): boolean {
        return this.isHidden || this.state === 'returning';
    }

    /** Call once the behaviour runs. */
    start(): void {
        this.refresh();
    }

    /** Back home at once, nothing followed. */
    stop(): void {
        this.unfollowFocus();
        this.releaseWindow();
        this.state = 'home';
        this.travelling = false;
        this.behaviour.allowCrawling(true);
        this.positioner.attach();
    }

    destroy(): void {
        this.stop();
        Main.layoutManager.disconnect(this.monitorsHandlerId);
    }

    /** The perch setting changed. */
    refresh(): void {
        if (this.settings.perch) {
            this.followFocus();
            return;
        }
        this.unfollowFocus();
        this.goHome();
    }

    toggleHidden(): void {
        if (this.isHidden)
            this.comeBack();
        else
            this.hide();
    }

    /** She crawls to the nearest edge of the screen, then past it until only a sliver shows. Halfway back, she turns around. */
    hide(): void {
        if (this.isHidden)
            return;
        const side = this.positioner.nearestSide();
        const edgeX = this.positioner.edgeX(side);
        if (edgeX === null)
            return;
        const speed = this.speed();
        const x = this.sprite.actor.x;
        const pastEdge = side === 'right' ? x >= edgeX : x <= edgeX;
        const slideOff = (done: () => void) => this.positioner.moveOffscreen(side, speed, done);
        const previous = this.state;
        this.state = 'leaving';
        this.hidingSide = side;
        this.positioner.detach();
        this.behaviour.suspend(() => this.comeBack());
        const started = this.errand(side === 'right', done => {
            if (pastEdge)
                slideOff(done);
            else
                this.positioner.moveTo(edgeX, speed, () => slideOff(done));
        }, () => {
            this.state = 'away';
        });
        if (started) {
            this.releaseWindow();
            return;
        }
        this.state = previous;
        this.behaviour.resume();
        if (previous === 'home')
            this.positioner.attach();
    }

    /** From the edge of the screen, or halfway there, back to her remembered spot: the menu, a click on her or a nap out there. */
    comeBack(): void {
        const home = this.positioner.homePosition();
        if (!this.isHidden || !home)
            return;
        this.state = 'returning';
        const started = this.errand(home.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(home, this.speed(), done), () => this.arriveHome());
        if (!started)
            this.arriveHome();
    }

    /** She is picked up: whatever trip or perch she was on is over, and where she is dropped is her spot. */
    releaseForDrag(): void {
        const wasAway = this.isAway;
        this.releaseWindow();
        this.travelling = false;
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        if (wasAway)
            this.behaviour.resume();
    }

    /** The sprite was rescaled or the monitors changed: put her back where her state says. */
    settle(): void {
        // A trip in progress ends where it was headed; a perch trip snaps to the window on arrival.
        if (this.travelling)
            return;
        switch (this.state) {
        case 'away':
            this.positioner.putOffscreen(this.hidingSide);
            break;
        case 'perched':
            this.snapToPerch();
            break;
        default:
            this.positioner.place();
        }
    }

    private arriveHome(): void {
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        this.positioner.attach();
        this.behaviour.resume();
    }

    private followFocus(): void {
        if (this.focusHandlerId === null)
            this.focusHandlerId = global.display.connect('notify::focus-window', () => this.onFocusChanged());
        this.onFocusChanged();
    }

    private unfollowFocus(): void {
        if (this.focusHandlerId === null)
            return;
        global.display.disconnect(this.focusHandlerId);
        this.focusHandlerId = null;
    }

    private onFocusChanged(): void {
        if (this.isAway)
            return;
        const window = global.display.focus_window;
        if (!window || isDesktop(window)) {
            this.goHome();
            return;
        }
        // Dialogs, popups, fullscreen windows, other monitors: she stays where she is.
        if (window === this.perchWindow || !canPerchOn(window))
            return;
        this.perchOn(window);
    }

    private perchOn(window: Meta.Window): void {
        const previousWindow = this.perchWindow;
        this.perchWindow = window;
        const spot = this.perchSpot();
        if (!spot) {
            this.perchWindow = previousWindow;
            return;
        }
        this.positioner.detach();
        const started = this.errand(spot.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(spot, this.speed(), done), () => this.snapToPerch());
        if (!started) {
            // Asleep: she stays put and perches on the next focus change instead.
            this.perchWindow = previousWindow;
            if (this.state === 'home')
                this.positioner.attach();
            return;
        }
        this.disconnectWindow(previousWindow);
        this.state = 'perched';
        this.behaviour.allowCrawling(false);
        this.perchHandlerIds = [
            window.connect('position-changed', () => this.followWindow()),
            window.connect('size-changed', () => this.followWindow()),
            window.connect('notify::minimized', () => {
                if (window.minimized)
                    this.goHome();
            }),
            window.connect('unmanaged', () => this.goHome()),
        ];
    }

    /** Off the window and back to her remembered spot. */
    private goHome(): void {
        if (this.state !== 'perched')
            return;
        this.releaseWindow();
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        const home = this.positioner.homePosition();
        if (!home)
            return;
        const started = this.errand(home.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(home, this.speed(), done), () => this.positioner.attach());
        if (!started)
            this.positioner.attach();
    }

    /** Runs a trip through the behaviour, keeping track of whether one is under way. */
    private errand(goingRight: boolean, move: (onArrived: () => void) => void, onArrived: () => void): boolean {
        this.travelling = true;
        const started = this.behaviour.travel(goingRight, move, () => {
            this.travelling = false;
            onArrived();
        });
        if (!started)
            this.travelling = false;
        return started;
    }

    /** While a trip is under way the window moving is caught up with on arrival. */
    private followWindow(): void {
        if (!this.travelling)
            this.snapToPerch();
    }

    private snapToPerch(): void {
        const spot = this.perchSpot();
        if (spot)
            this.sprite.actor.set_position(spot.x, spot.y);
    }

    /**
     * Her right edge on the window's, her tentacles on the top of its
     * title bar. Kept inside the work area, so on a maximized window she
     * sits over the right end of the title bar instead of above it.
     */
    private perchSpot(): Point | null {
        const area = this.positioner.placementArea();
        if (!area || !this.perchWindow)
            return null;
        const frame = this.perchWindow.get_frame_rect();
        const size = this.sprite.size;
        return {
            x: clamp(frame.x + frame.width - size, area.minX, area.maxX),
            y: clamp(frame.y - size + FEET_PADDING * this.sprite.currentScale, area.minY, area.maxY),
        };
    }

    private releaseWindow(): void {
        this.disconnectWindow(this.perchWindow);
        this.perchWindow = null;
    }

    private disconnectWindow(window: Meta.Window | null): void {
        if (window) {
            for (const id of this.perchHandlerIds)
                window.disconnect(id);
        }
        this.perchHandlerIds = [];
    }

    private speed(): number {
        return ERRAND_SPEED * this.sprite.currentScale;
    }
}

/** Desktop icons extensions draw the desktop in a plain window that they keep out of the window list. */
function isDesktop(window: Meta.Window): boolean {
    return window.get_window_type() === Meta.WindowType.DESKTOP || window.is_skip_taskbar();
}

function canPerchOn(window: Meta.Window): boolean {
    return window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.is_fullscreen() &&
        !window.minimized &&
        window.get_monitor() === Main.layoutManager.primaryIndex;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
