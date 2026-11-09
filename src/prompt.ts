import Clutter from 'gi://Clutter';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {HEAD_PADDING, SIDE_PADDING, type CrepeSprite} from './sprite.js';

const GAP = 6;
const SCREEN_MARGIN = 8;
/** Kept free above the box for the bubble that answers, two lines of it; without it the bubble would land on her. */
const BUBBLE_ROOM = 64;
const HINT = 'Dis-lui quelque chose…';

export interface PromptHandlers {
    /** Enter with something typed; the text is trimmed and never empty. */
    onSubmit: (text: string) => void;
    /** Escape, a click elsewhere, or `close()`. */
    onClosed: () => void;
}

/**
 * The box to type something to her, over her head where the speech bubble
 * usually sits (the bubble moves over the box while it is open). It takes
 * a modal grab while open: under Wayland that is the only way for shell
 * chrome to get the keyboard, the way the shell's own popup menus do it.
 * Escape or a click anywhere else closes it.
 */
export class PromptBox {
    readonly actor: St.BoxLayout;
    readonly entry: St.Entry;
    private readonly sprite: CrepeSprite;
    private readonly handlers: PromptHandlers;
    private readonly spriteHandlerIds: number[];
    private readonly activateHandlerId: number;
    private grab: Clutter.Grab | null = null;
    private capturedEventId: number | null = null;
    private pending = false;

    constructor(sprite: CrepeSprite, handlers: PromptHandlers) {
        this.sprite = sprite;
        this.handlers = handlers;

        this.entry = new St.Entry({style_class: 'crepe-prompt-entry', hint_text: HINT, can_focus: true, x_expand: true});
        this.actor = new St.BoxLayout({style_class: 'crepe-prompt', reactive: true});
        this.actor.add_child(this.entry);

        this.activateHandlerId = this.entry.clutter_text.connect('activate', () => this.submit());
        this.spriteHandlerIds = [
            sprite.actor.connect('notify::x', () => this.follow()),
            sprite.actor.connect('notify::y', () => this.follow()),
        ];
    }

    get isOpen(): boolean {
        return this.grab !== null;
    }

    /** False when the shell would not hand over the keyboard (another grab, a locked screen). */
    open(): boolean {
        if (this.isOpen)
            return true;
        Main.layoutManager.addTopChrome(this.actor, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: false,
        });
        this.reposition();
        // The menus' action mode: screenshots and media keys keep working, the rest of the shell waits.
        const grab = Main.pushModal(this.actor, {actionMode: Shell.ActionMode.POPUP});
        if (grab.get_seat_state() !== Clutter.GrabState.ALL) {
            Main.popModal(grab);
            Main.layoutManager.removeChrome(this.actor);
            return false;
        }
        this.grab = grab;
        this.capturedEventId = this.actor.connect('captured-event',
            (_actor: Clutter.Actor, event: Clutter.Event) => this.onCapturedEvent(event));
        this.setPending(false);
        this.entry.text = '';
        this.entry.grab_key_focus();
        return true;
    }

    close(): void {
        if (!this.grab)
            return;
        if (this.capturedEventId !== null)
            this.actor.disconnect(this.capturedEventId);
        this.capturedEventId = null;
        Main.popModal(this.grab);
        this.grab = null;
        Main.layoutManager.removeChrome(this.actor);
        this.handlers.onClosed();
    }

    /** While the answer is on its way the entry takes no typing, so two questions never cross. */
    setPending(pending: boolean): void {
        this.pending = pending;
        this.entry.clutter_text.editable = !pending;
        if (pending) {
            this.entry.add_style_pseudo_class('insensitive');
            return;
        }
        this.entry.remove_style_pseudo_class('insensitive');
        if (this.isOpen)
            this.entry.grab_key_focus();
    }

    /** Clears the entry for the next question, the box staying open. */
    clear(): void {
        this.entry.text = '';
    }

    /** Its own method, rather than only the Enter handler, so Eval can drive it without synthesizing keys. */
    submit(): void {
        if (this.pending || !this.isOpen)
            return;
        const text = this.entry.text.trim();
        if (text.length === 0)
            return;
        this.handlers.onSubmit(text);
    }

    destroy(): void {
        this.close();
        for (const id of this.spriteHandlerIds)
            this.sprite.actor.disconnect(id);
        this.spriteHandlerIds.length = 0;
        this.entry.clutter_text.disconnect(this.activateHandlerId);
        this.actor.destroy();
    }

    private onCapturedEvent(event: Clutter.Event): boolean {
        const type = event.type();
        if (type === Clutter.EventType.KEY_PRESS && event.get_key_symbol() === Clutter.KEY_Escape) {
            this.close();
            return Clutter.EVENT_STOP;
        }
        if (type !== Clutter.EventType.BUTTON_PRESS && type !== Clutter.EventType.TOUCH_BEGIN)
            return Clutter.EVENT_PROPAGATE;
        const target = (global.stage as Clutter.Stage).get_event_actor(event);
        if (target && this.actor.contains(target))
            return Clutter.EVENT_PROPAGATE;
        // The click only closes the box; letting it through would land on whatever was under it, unannounced.
        this.close();
        return Clutter.EVENT_STOP;
    }

    private follow(): void {
        if (this.isOpen)
            this.reposition();
    }

    /**
     * Centred over her head and kept inside the work area of the monitor
     * she is on, so near a side edge it slides inwards. With no room above
     * her for the box and the bubble over it, it goes beside her head
     * instead, on the side with the more room.
     */
    private reposition(): void {
        const layout = Main.layoutManager;
        const monitor = layout.monitors[layout.findIndexForActor(this.sprite.actor)] ?? layout.primaryMonitor;
        if (!monitor)
            return;
        const area = layout.getWorkAreaForMonitor(monitor.index);
        const [, , width, height] = this.actor.get_preferred_size();
        const sprite = this.sprite.actor;
        const scale = this.sprite.currentScale;
        const headY = sprite.y + HEAD_PADDING * scale;
        const centreX = sprite.x + this.sprite.size / 2;

        let x = centreX - width / 2;
        let y = headY - GAP - height;
        if (y - BUBBLE_ROOM < area.y + SCREEN_MARGIN) {
            const roomLeft = sprite.x + SIDE_PADDING * scale - area.x;
            const roomRight = area.x + area.width - (sprite.x + this.sprite.size - SIDE_PADDING * scale);
            x = roomLeft > roomRight
                ? sprite.x + SIDE_PADDING * scale - GAP - width
                : sprite.x + this.sprite.size - SIDE_PADDING * scale + GAP;
            y = headY;
        }
        x = clamp(x, area.x + SCREEN_MARGIN, area.x + area.width - width - SCREEN_MARGIN);
        y = clamp(y, area.y + SCREEN_MARGIN, area.y + area.height - height - SCREEN_MARGIN);
        this.actor.set_position(Math.round(x), Math.round(y));
    }
}

function clamp(value: number, min: number, max: number): number {
    return Math.max(min, Math.min(max, value));
}
