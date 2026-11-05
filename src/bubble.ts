import Clutter from 'gi://Clutter';
import Pango from 'gi://Pango';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import {FEET_PADDING, HEAD_PADDING, type CrepeSprite} from './sprite.js';
import type {TimerPool} from './timers.js';

const GAP = 6;
const SCREEN_MARGIN = 8;
const FADE_MS = 150;
/** Long enough to read: a base delay plus time per character. */
const BASE_DISPLAY_MS = 1800;
const DISPLAY_MS_PER_CHARACTER = 45;

/** The shell adds `ease()` to every actor at runtime; the typings only see it on some import paths. */
interface EaseableBoxLayout extends St.BoxLayout {
    ease(params: {opacity: number; duration: number; mode: Clutter.AnimationMode; onComplete?: () => void}): void;
}

/** The typings ship several copies of Pango, and ClutterText's enums come from another one than `gi://Pango`. */
type WrapMode = Clutter.Text['line_wrap_mode'];
type EllipsizeMode = Clutter.Text['ellipsize'];

/**
 * The speech bubble above Crêpe's head. It follows her while she crawls
 * and fades out on its own once the line has had time to be read.
 */
export class SpeechBubble {
    readonly actor: St.BoxLayout;
    private readonly label: St.Label;
    private readonly sprite: CrepeSprite;
    private readonly timers: TimerPool;
    private readonly spriteHandlerIds: number[];
    private cancelHide: (() => void) | null = null;
    private showing = false;

    constructor(sprite: CrepeSprite, timers: TimerPool) {
        this.sprite = sprite;
        this.timers = timers;

        this.label = new St.Label({style_class: 'crepe-bubble-text'});
        this.label.clutter_text.line_wrap = true;
        this.label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR as number as WrapMode;
        // St.Label ellipsizes by default, which wins over wrapping.
        this.label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE as number as EllipsizeMode;

        // Hidden through opacity only: the layout manager owns `visible` for
        // chrome that tracks fullscreen, and flips it back on whenever a
        // fullscreen window goes away.
        this.actor = new St.BoxLayout({style_class: 'crepe-bubble', opacity: 0});
        this.actor.add_child(this.label);
        Main.layoutManager.addTopChrome(this.actor, {
            affectsInputRegion: false,
            affectsStruts: false,
            trackFullscreen: true,
        });

        this.spriteHandlerIds = [
            sprite.actor.connect('notify::x', () => this.follow()),
            sprite.actor.connect('notify::y', () => this.follow()),
        ];
    }

    get isShowing(): boolean {
        return this.showing;
    }

    /** Shows `text`, replacing whatever she was saying, and restarts the reading time. */
    say(text: string): void {
        this.cancelHide?.();
        this.label.text = text;
        this.actor.remove_all_transitions();
        this.showing = true;
        this.reposition();
        (this.actor as EaseableBoxLayout).ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        this.cancelHide = this.timers.schedule(BASE_DISPLAY_MS + DISPLAY_MS_PER_CHARACTER * text.length, () => {
            this.cancelHide = null;
            this.fadeOut();
        });
    }

    follow(): void {
        if (this.showing)
            this.reposition();
    }

    hide(): void {
        this.cancelHide?.();
        this.cancelHide = null;
        this.actor.remove_all_transitions();
        this.actor.opacity = 0;
        this.showing = false;
    }

    destroy(): void {
        for (const id of this.spriteHandlerIds)
            this.sprite.actor.disconnect(id);
        this.spriteHandlerIds.length = 0;
        this.cancelHide?.();
        this.cancelHide = null;
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }

    private fadeOut(): void {
        (this.actor as EaseableBoxLayout).ease({
            opacity: 0,
            duration: FADE_MS,
            mode: Clutter.AnimationMode.EASE_IN_QUAD,
            onComplete: () => {
                this.showing = false;
            },
        });
    }

    /** Centred above her head, kept on the primary monitor; below her when the top edge is too close. */
    private reposition(): void {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [, , width, height] = this.actor.get_preferred_size();
        const sprite = this.sprite.actor;
        const scale = this.sprite.currentScale;

        const centredX = sprite.x + this.sprite.size / 2 - width / 2;
        const minX = monitor.x + SCREEN_MARGIN;
        const maxX = monitor.x + monitor.width - width - SCREEN_MARGIN;
        const x = Math.max(minX, Math.min(maxX, centredX));

        // Against her head and tentacles, not the empty rows of the frame around them.
        const above = sprite.y + HEAD_PADDING * scale - GAP - height;
        const below = sprite.y + this.sprite.size - FEET_PADDING * scale + GAP;
        const y = above >= monitor.y ? above : below;
        this.actor.set_position(Math.round(x), Math.round(y));
    }
}
