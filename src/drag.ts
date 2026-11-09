import Clutter from 'gi://Clutter';

/** Pointer travel, in pixels, past which a press becomes a drag instead of a click. */
const DRAG_THRESHOLD = 8;

/** Allowed range for the actor's top-left corner while dragging. */
export interface DragBounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

export interface DragCallbacks {
    onClick: () => void;
    onSecondaryClick: () => void;
    onDragStart: () => void;
    onDrop: (x: number, y: number) => void;
    /** Where the actor may go were it moved to `x`, `y`: the range can change with where it is carried. */
    bounds: (x: number, y: number) => DragBounds | null;
}

/**
 * Lets the primary mouse button pick an actor up by a handle and drop it
 * elsewhere; the handle is expected to follow the actor. A press that
 * barely moves is reported as a click instead, and a secondary press is
 * reported right away without grabbing anything.
 */
export class DragHandler {
    private readonly handle: Clutter.Actor;
    private readonly actor: Clutter.Actor;
    private readonly callbacks: DragCallbacks;
    private readonly pressHandlerId: number;

    private grab: Clutter.Grab | null = null;
    private revokedHandlerId: number | null = null;
    private motionHandlerId: number | null = null;
    private releaseHandlerId: number | null = null;
    private pressX = 0;
    private pressY = 0;
    /** Where inside the actor she was grabbed, so she does not jump to the pointer. */
    private grabOffsetX = 0;
    private grabOffsetY = 0;
    private dragging = false;

    constructor(handle: Clutter.Actor, actor: Clutter.Actor, callbacks: DragCallbacks) {
        this.handle = handle;
        this.actor = actor;
        this.callbacks = callbacks;
        this.pressHandlerId = handle.connect('button-press-event',
            (_actor: Clutter.Actor, event: Clutter.Event) => this.onPress(event));
    }

    destroy(): void {
        this.endGesture();
        this.handle.disconnect(this.pressHandlerId);
    }

    private onPress(event: Clutter.Event): boolean {
        if (event.get_button() === Clutter.BUTTON_SECONDARY) {
            this.callbacks.onSecondaryClick();
            return Clutter.EVENT_STOP;
        }
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_PROPAGATE;
        if (this.grab)
            return Clutter.EVENT_STOP;

        const [x, y] = event.get_coords();
        this.pressX = x;
        this.pressY = y;
        this.grabOffsetX = x - this.actor.x;
        this.grabOffsetY = y - this.actor.y;
        this.dragging = false;

        // The grab keeps motion and release coming to the handle even once the pointer leaves it.
        const grab = (global.stage as Clutter.Stage).grab(this.handle);
        this.grab = grab;
        this.revokedHandlerId = grab.connect('notify::revoked', () => this.onRevoked());
        this.motionHandlerId = this.handle.connect('motion-event',
            (_actor: Clutter.Actor, motion: Clutter.Event) => this.onMotion(motion));
        this.releaseHandlerId = this.handle.connect('button-release-event',
            (_actor: Clutter.Actor, release: Clutter.Event) => this.onRelease(release));
        return Clutter.EVENT_STOP;
    }

    private onMotion(event: Clutter.Event): boolean {
        const [x, y] = event.get_coords();
        if (!this.dragging) {
            if (Math.hypot(x - this.pressX, y - this.pressY) < DRAG_THRESHOLD)
                return Clutter.EVENT_STOP;
            this.dragging = true;
            this.callbacks.onDragStart();
        }
        this.moveActor(x - this.grabOffsetX, y - this.grabOffsetY);
        return Clutter.EVENT_STOP;
    }

    private onRelease(event: Clutter.Event): boolean {
        if (event.get_button() !== Clutter.BUTTON_PRIMARY)
            return Clutter.EVENT_STOP;
        this.finishGesture(true);
        return Clutter.EVENT_STOP;
    }

    /** Another grab (overview, lock screen...) stole the pointer: settle her where she is. */
    private onRevoked(): void {
        if (!this.grab?.revoked)
            return;
        this.finishGesture(false);
    }

    /** A revoked press never counts as a click, but a drag still has to land. */
    private finishGesture(released: boolean): void {
        const wasDragging = this.dragging;
        this.endGesture();
        if (wasDragging)
            this.callbacks.onDrop(this.actor.x, this.actor.y);
        else if (released)
            this.callbacks.onClick();
    }

    private moveActor(x: number, y: number): void {
        const bounds = this.callbacks.bounds(x, y);
        if (!bounds) {
            this.actor.set_position(x, y);
            return;
        }
        this.actor.set_position(
            Math.min(bounds.maxX, Math.max(bounds.minX, x)),
            Math.min(bounds.maxY, Math.max(bounds.minY, y)),
        );
    }

    private endGesture(): void {
        if (this.motionHandlerId !== null) {
            this.handle.disconnect(this.motionHandlerId);
            this.motionHandlerId = null;
        }
        if (this.releaseHandlerId !== null) {
            this.handle.disconnect(this.releaseHandlerId);
            this.releaseHandlerId = null;
        }
        if (this.grab) {
            if (this.revokedHandlerId !== null)
                this.grab.disconnect(this.revokedHandlerId);
            this.grab.dismiss();
            this.grab = null;
        }
        this.revokedHandlerId = null;
        this.dragging = false;
    }
}
