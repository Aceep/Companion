import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {IdleBehaviour} from './behaviour.js';
import type {Point} from './geometry.js';
import type {Hitbox} from './hitbox.js';
import type {Side} from './monitors.js';
import type {Positioner} from './positioner.js';
import type {CrepeSettings} from './settings.js';
import {FEET_PADDING, type CrepeSprite} from './sprite.js';

/** Sprite pixels per second on errands: four times her idle crawl, or reaching a window would take half a minute. */
const ERRAND_SPEED = 40;

/**
 * home: at her remembered spot, or crawling back to it from a window.
 * visiting: gone to see another room, or the pointer in hers, on her way there or settled there.
 * perched: on the focused window's title bar, or on her way there.
 * dodged: out of the focused window's way on her row, or on her way there.
 * leaving, away, returning: hiding at the edge of the screen, a sliver of her
 * still showing, or on the way there or back. Storming off in a fury goes
 * through the same states with nothing of her left showing.
 */
type State = 'home' | 'visiting' | 'perched' | 'dodged' | 'leaving' | 'away' | 'returning';

/**
 * Where Crêpe is when it is not her own spot: hiding off-screen, sitting
 * on the focused window's title bar, out of that window's way, or on a
 * visit to another room, which perching and dodging there keep going
 * until she is sent home. The trips go through the
 * behaviour, so she crawls and her routine steps aside, and through the
 * positioner, detached so they never overwrite her remembered spot.
 */
export class Presence {
    private readonly sprite: CrepeSprite;
    private readonly hitbox: Hitbox;
    private readonly positioner: Positioner;
    private readonly behaviour: IdleBehaviour;
    private readonly settings: CrepeSettings;
    private readonly monitorsHandlerId: number;
    private readonly workAreasHandlerId: number;

    private state: State = 'home';
    private hidingSide: Side = 'right';
    /** Gone in a fury: out of reach and out of sight, back only when `stormBack()` says so. */
    private storming = false;
    private travelling = false;
    private focusHandlerId: number | null = null;
    private perchWindow: Meta.Window | null = null;
    private perchHandlerIds: number[] = [];
    /** Her room was unplugged at the last look: when it is back, she crawls there. */
    private homeMissing: boolean;
    /**
     * The monitor she went to see, while the visit lasts, whether she is
     * on its floor, perched there or out of a window's way there; null at home.
     */
    private visitedRoom: number | null = null;
    /** Out of a window's way on a visit: where she stood, to go back to instead of home. */
    private dodgedFrom: Point | null = null;
    /** A visit a few steps from her spot, to the pointer: her next stroll is the way back. */
    private strollEndsVisit = false;
    /** Creeping up on the pointer: where she set off from, and whether on a visit, for `recoil()`. */
    private approachFrom: {spot: Point; wasVisiting: boolean} | null = null;

    constructor(sprite: CrepeSprite, hitbox: Hitbox, positioner: Positioner, behaviour: IdleBehaviour, settings: CrepeSettings) {
        this.sprite = sprite;
        this.hitbox = hitbox;
        this.positioner = positioner;
        this.behaviour = behaviour;
        this.settings = settings;
        this.homeMissing = positioner.isHomeRoomMissing();
        behaviour.setStrollOverride(() => this.strollHome());
        // The only listeners to these: with the positioner listening too, which ran first decided where she ended up.
        this.monitorsHandlerId = Main.layoutManager.connect('monitors-changed', () => this.settle());
        // A panel or a dock appearing, growing or going moves the edges she keeps inside.
        this.workAreasHandlerId = global.display.connect('workareas-changed', () => this.settle());
    }

    /** Hiding or on her way to hide: what the menu offers is to come back. */
    get isHidden(): boolean {
        return this.state === 'leaving' || this.state === 'away';
    }

    /** Off-screen or on the way there or back: notifications go unnoticed. */
    get isAway(): boolean {
        return this.isHidden || this.state === 'returning';
    }

    /** At her own spot and staying there: no trip under way. */
    get isHome(): boolean {
        return this.state === 'home' && !this.travelling;
    }

    /** At her own spot or settled on a visit, on the floor, no trip under way: free to move aside or go somewhere. */
    get isSettled(): boolean {
        return (this.state === 'home' || this.state === 'visiting') && !this.travelling;
    }

    /** Gone to see another room and not sent home yet, perched or out of a window's way there included. */
    get isVisiting(): boolean {
        return this.visitedRoom !== null;
    }

    get isPerched(): boolean {
        return this.state === 'perched';
    }

    /** Out of a window's way, or on her way there. */
    get isDodged(): boolean {
        return this.state === 'dodged';
    }

    /** Where she left to get out of a window's way, her spot or her place on a visit; null when she is not out of one's way. */
    get dodgeOrigin(): Point | null {
        return this.state === 'dodged' ? this.dodgedFrom ?? this.positioner.homePosition() : null;
    }

    /** Stormed off in a fury: neither the menu, a click nor the shortcut brings her back. */
    get isStorming(): boolean {
        return this.storming;
    }

    /** Call once the behaviour runs. */
    start(): void {
        this.refresh();
    }

    /** Back home at once, nothing followed. */
    stop(): void {
        this.unfollowFocus();
        this.releaseWindow();
        this.endVisitHere();
        this.state = 'home';
        this.storming = false;
        this.showAndReach(true);
        this.travelling = false;
        this.behaviour.allowCrawling(true);
        this.positioner.attach();
    }

    destroy(): void {
        this.stop();
        Main.layoutManager.disconnect(this.monitorsHandlerId);
        global.display.disconnect(this.workAreasHandlerId);
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

    /**
     * She crawls to the nearest wall, an edge of the screen with no
     * monitor past it, then past it until only a sliver shows. Halfway
     * back, she turns around.
     */
    hide(): void {
        this.leave(true, () => this.comeBack());
    }

    /**
     * Furious: past the nearest wall with nothing of her left to click or
     * see, and deaf to everything until `stormBack()`. Waking up out there
     * does not bring her back either. False when she could not set off.
     */
    stormOff(): boolean {
        if (this.isAway)
            return false;
        this.storming = true;
        this.hitbox.setReachable(false);
        if (this.leave(false, () => {}))
            return true;
        this.storming = false;
        this.hitbox.setReachable(true);
        return false;
    }

    /** The fury is spent: back to her spot by the side she left, `onHome` once there. */
    stormBack(onHome: () => void): void {
        if (!this.storming)
            return;
        this.storming = false;
        this.sprite.actor.opacity = 255;
        // Within reach again once home: on the way she is still not taking anything from anyone.
        this.comeBack(() => {
            this.hitbox.setReachable(true);
            onHome();
        });
    }

    /** `peek` leaves a sliver of her to click; `onWake` is what waking up out there does. */
    private leave(peek: boolean, onWake: () => void): boolean {
        if (this.isHidden)
            return false;
        const side = this.positioner.nearestSide();
        const edgeX = this.positioner.edgeX(side);
        if (edgeX === null)
            return false;
        const speed = this.speed();
        const x = this.sprite.actor.x;
        const pastEdge = side === 'right' ? x >= edgeX : x <= edgeX;
        const slideOff = (done: () => void) => this.positioner.moveOffscreen(side, speed, done, peek);
        const previous = this.state;
        this.state = 'leaving';
        this.hidingSide = side;
        this.positioner.detach();
        this.behaviour.suspend(onWake);
        const started = this.errand(side === 'right', done => {
            if (pastEdge)
                slideOff(done);
            else
                this.positioner.moveTo(edgeX, speed, () => slideOff(done));
        }, () => {
            this.state = 'away';
            // Past a wall may still lie a monitor that does not quite touch it; a fury is not something to watch.
            if (this.storming)
                this.showAndReach(false);
        });
        if (started) {
            this.releaseWindow();
            // Back from the wall she goes home: whatever she was visiting is behind her.
            this.endVisitHere();
            return true;
        }
        this.state = previous;
        this.behaviour.resume();
        if (previous === 'home')
            this.positioner.attach();
        return false;
    }

    /**
     * From the edge of the screen, or halfway there, back to her remembered
     * spot: the menu, a click on her or a nap out there. Not while she
     * storms off: only `stormBack()` ends that.
     */
    comeBack(onHome: () => void = () => {}): void {
        const home = this.positioner.homePosition();
        if (!this.isHidden || !home || this.storming)
            return;
        this.state = 'returning';
        const started = this.errand(home.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(home, this.speed(), done), () => this.arriveHome(onHome));
        if (!started)
            this.arriveHome(onHome);
    }

    /**
     * Crawls to `spot` to get out of the focused window's way, from her
     * spot, from her place on a visit or from where she already dodged
     * to; where she left stays hers, for `undodge()`. No crawls of her own
     * meanwhile: they would land her anywhere, back under the window
     * included. False when she could not set off.
     */
    dodge(spot: Point): boolean {
        if (this.state !== 'home' && this.state !== 'visiting' && this.state !== 'dodged')
            return false;
        const here = this.positioner.position;
        this.positioner.detach();
        const started = this.errand(spot.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(spot, this.speed(), done), () => {});
        if (!started) {
            if (this.state === 'home')
                this.positioner.attach();
            return false;
        }
        if (this.state === 'visiting')
            this.dodgedFrom = here;
        this.state = 'dodged';
        this.behaviour.allowCrawling(false);
        return true;
    }

    /**
     * Back to her remembered spot, the one `attach()` puts her on, so the
     * trip ends where she stands instead of with a jump; or, out of a
     * window's way on a visit, back to where she stood on it. `onHome` once there.
     */
    undodge(onHome: () => void = () => {}): void {
        if (this.state !== 'dodged')
            return;
        const visitSpot = this.dodgedFrom;
        const back = visitSpot ?? this.positioner.homePosition();
        this.dodgedFrom = null;
        this.state = visitSpot ? 'visiting' : 'home';
        this.behaviour.allowCrawling(true);
        const arrive = () => {
            // Still on the visit: her spot is not where she stands.
            if (!visitSpot)
                this.positioner.attach();
            onHome();
        };
        if (!back) {
            arrive();
            return;
        }
        if (!this.errand(back.x > this.sprite.actor.x, done => this.positioner.travelTo(back, this.speed(), done), arrive))
            arrive();
    }

    /**
     * Off to see another room: crawls to `spot` on monitor `room`, room to
     * room, her spot left as it is; `onArrived` once there. Settled there,
     * that room is the one she is in for everything, perching included,
     * until `endVisit()`. Only from home. False when she could not set off.
     */
    visit(spot: Point, room: number, onArrived: () => void): boolean {
        if (!this.isHome)
            return false;
        this.positioner.detach();
        const started = this.errand(spot.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(spot, this.speed(), done), () => {
            onArrived();
            // In the window's room now: with the perch on, its title bar is where the visit ends.
            if (this.focusHandlerId !== null)
                this.onFocusChanged();
        });
        if (!started) {
            this.positioner.attach();
            return false;
        }
        this.state = 'visiting';
        this.visitedRoom = room;
        return true;
    }

    /**
     * Home from a visit, from wherever in the visited room she is: its
     * floor, a window's title bar or out of a window's way. A visit is not
     * a move, so her spot is where it was. False when she is on no visit
     * or cannot set off (asleep, carried).
     */
    endVisit(): boolean {
        const home = this.positioner.homePosition();
        if (this.visitedRoom === null || !home)
            return false;
        const started = this.errand(home.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(home, this.speed(), done), () => this.positioner.attach());
        if (!started)
            return false;
        this.releaseWindow();
        this.endVisitHere();
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        return true;
    }

    /**
     * Creeps up on the pointer, to `spot` in the room she is in, from her
     * spot or her place on a visit; `onArrived` once there. From her spot
     * it is a visit to her own room: that is not where she lives, and her
     * next stroll takes her back. False when she could not set off.
     */
    approach(spot: Point, onArrived: () => void): boolean {
        const room = this.positioner.roomIndex;
        if (!this.isSettled || room === null)
            return false;
        const from = this.positioner.position;
        const wasVisiting = this.state === 'visiting';
        this.positioner.detach();
        const started = this.errand(spot.x > from.x, done => this.positioner.travelTo(spot, this.speed(), done), () => {
            this.approachFrom = null;
            onArrived();
        });
        if (!started) {
            if (!wasVisiting)
                this.positioner.attach();
            return false;
        }
        if (!wasVisiting) {
            this.visitedRoom = room;
            this.strollEndsVisit = true;
        }
        this.state = 'visiting';
        this.approachFrom = {spot: from, wasVisiting};
        return true;
    }

    /**
     * The pointer moved while she crept up on it: she stops, looks away,
     * and crawls back to where she set off from, her spot or her place on
     * the visit she was on.
     */
    recoil(): void {
        const approach = this.approachFrom;
        if (!approach)
            return;
        this.approachFrom = null;
        // The flinch stops the trip, and with it the arrival that would have said so.
        this.travelling = false;
        this.behaviour.flinch(() => {
            const backHome = () => {
                if (approach.wasVisiting)
                    return;
                this.endVisitHere();
                this.state = 'home';
                this.positioner.attach();
            };
            // Asleep by then, she stays where she stopped; her next stroll or the end of the visit takes her back.
            this.errand(approach.spot.x > this.sprite.actor.x, done =>
                this.positioner.travelTo(approach.spot, this.speed(), done), backHome);
        });
    }

    /** She is picked up: whatever trip or perch she was on is over, and where she is dropped is her spot. */
    releaseForDrag(): void {
        const wasAway = this.isAway;
        this.releaseWindow();
        this.endVisitHere();
        this.travelling = false;
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        if (wasAway)
            this.behaviour.resume();
    }

    /**
     * The sprite was rescaled, or the monitors or their work areas changed:
     * put her back where her state says. Her room plugged in again, she
     * crawls back to it from the primary rather than jumping there.
     */
    settle(): void {
        // The room she went to see is unplugged: nothing left to visit, wherever she is on the way.
        if (this.visitedRoom !== null && !this.positioner.hasRoom(this.visitedRoom)) {
            this.cancelVisit();
            return;
        }
        // A trip in progress ends where it was headed; a perch trip snaps to the window on arrival.
        // Her own crawl too: snapping her home mid-way would cut its slide, and with it the end of the crawl.
        // Her room coming back meanwhile is noticed at the next settle.
        if (this.travelling || this.behaviour.isCrawling)
            return;
        const homeWasMissing = this.homeMissing;
        this.homeMissing = this.positioner.isHomeRoomMissing();
        if (this.state === 'home' && homeWasMissing && !this.homeMissing) {
            this.moveBackIn();
            return;
        }
        switch (this.state) {
        case 'away':
            this.positioner.putOffscreen(this.hidingSide, !this.storming);
            break;
        case 'perched':
            this.snapToPerch();
            break;
        case 'visiting':
            // Not at her spot, so not put back there: only kept inside the room, whose work area may have shrunk.
            this.positioner.keepInsideRoom();
            break;
        default:
            this.positioner.place();
        }
    }

    /**
     * From the primary to her room, plugged in again, as a trip. Only from
     * home: hiding, perched or out of a window's way, her way back ends
     * there anyway.
     */
    private moveBackIn(): void {
        const home = this.positioner.homePosition();
        if (!home)
            return;
        // A trip cut short on the way must not leave her remembered room behind on the primary.
        this.positioner.detach();
        const started = this.errand(home.x > this.sprite.actor.x, done =>
            this.positioner.travelTo(home, this.speed(), done), () => this.positioner.attach());
        // Carried, the drop decides where she lives and gives her spot back; asleep or not shown, she is put there.
        if (!started && !this.behaviour.isDragging)
            this.positioner.attach();
    }

    /** The visit is over at once: home by a trip, or put there when she cannot set off. */
    private cancelVisit(): void {
        if (this.endVisit())
            return;
        this.releaseWindow();
        this.endVisitHere();
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        this.positioner.attach();
    }

    /** Forgets the visit without moving her: whoever ends it says where she goes. */
    private endVisitHere(): void {
        this.visitedRoom = null;
        this.dodgedFrom = null;
        this.strollEndsVisit = false;
        this.approachFrom = null;
    }

    /** Next to the pointer on a whim, the stroll that comes is her way home. */
    private strollHome(): boolean {
        return this.strollEndsVisit && this.state === 'visiting' && !this.travelling && this.endVisit();
    }

    private arriveHome(onHome: () => void): void {
        this.state = 'home';
        this.behaviour.allowCrawling(true);
        this.positioner.attach();
        this.behaviour.resume();
        onHome();
    }

    private showAndReach(shown: boolean): void {
        this.sprite.actor.opacity = shown ? 255 : 0;
        this.hitbox.setReachable(shown);
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
        // Dialogs, popups, fullscreen windows, windows in another room: she stays where she is.
        if (window === this.perchWindow || !canPerchOn(window, this.positioner.roomIndex))
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
        // Perched at the end of a visit, off the window is home too.
        this.endVisitHere();
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
     * title bar. Kept inside the work area of the window's monitor, so on
     * a maximized window she sits over the right end of the title bar
     * instead of above it, and follows it when it goes to another room.
     */
    private perchSpot(): Point | null {
        if (!this.perchWindow)
            return null;
        const area = this.positioner.placementAreaOfMonitor(this.perchWindow.get_monitor());
        if (!area)
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
export function isDesktop(window: Meta.Window): boolean {
    return window.get_window_type() === Meta.WindowType.DESKTOP || window.is_skip_taskbar();
}

/** A window in the room she is in, `roomIndex` being its monitor. */
function canPerchOn(window: Meta.Window, roomIndex: number | null): boolean {
    return window.get_window_type() === Meta.WindowType.NORMAL &&
        !window.is_fullscreen() &&
        !window.minimized &&
        window.get_monitor() === roomIndex;
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
