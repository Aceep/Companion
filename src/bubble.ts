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

/** Wraps on words, and never ellipsizes: a bubble line is read whole. */
function wrappingLabel(styleClass: string): St.Label {
    const label = new St.Label({style_class: styleClass});
    label.clutter_text.line_wrap = true;
    label.clutter_text.line_wrap_mode = Pango.WrapMode.WORD_CHAR as number as WrapMode;
    // St.Label ellipsizes by default, which wins over wrapping.
    label.clutter_text.ellipsize = Pango.EllipsizeMode.NONE as number as EllipsizeMode;
    return label;
}

/** What she shows while the daemon thinks; no reading time, it stays until the answer replaces it. */
const PONDERING = '…';

/**
 * The speech bubble above Crêpe's head. It follows her while she crawls
 * and fades out on its own once the line has had time to be read. While
 * something else sits over her head (the box to talk to her), the bubble
 * goes over that instead.
 */
export class SpeechBubble {
    readonly actor: St.BoxLayout;
    private readonly label: St.Label;
    /** The line in clear, in small print under a line said in Crêpe. */
    private readonly translationLabel: St.Label;
    private readonly sprite: CrepeSprite;
    private readonly timers: TimerPool;
    private readonly spriteHandlerIds: number[];
    private cancelHide: (() => void) | null = null;
    private showing = false;
    private anchor: Clutter.Actor | null = null;
    private anchorHandlerIds: number[] = [];

    constructor(sprite: CrepeSprite, timers: TimerPool) {
        this.sprite = sprite;
        this.timers = timers;

        this.label = wrappingLabel('crepe-bubble-text');
        this.translationLabel = wrappingLabel('crepe-bubble-translation');
        this.translationLabel.visible = false;

        // Hidden through opacity only: the layout manager owns `visible` for
        // chrome that tracks fullscreen, and flips it back on whenever a
        // fullscreen window goes away.
        this.actor = new St.BoxLayout({style_class: 'crepe-bubble', opacity: 0, vertical: true});
        // Asked for its height first, for no width in particular, the box gave
        // a wrapped line one row of background and let it spill out below.
        this.actor.request_mode = Clutter.RequestMode.HEIGHT_FOR_WIDTH;
        this.actor.add_child(this.label);
        this.actor.add_child(this.translationLabel);
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

    /**
     * Shows `text`, replacing whatever she was saying, and restarts the
     * reading time. A `translation` goes in small print under it; the
     * reading time follows it then, since that is the line being read.
     */
    say(text: string, translation: string | null = null): void {
        this.show(text, translation);
        const read = translation ?? text;
        this.cancelHide = this.timers.schedule(BASE_DISPLAY_MS + DISPLAY_MS_PER_CHARACTER * read.length, () => {
            this.cancelHide = null;
            this.fadeOut();
        });
    }

    /** Shows `text` and keeps it there until `dismiss()`, `hide()` or another line: a reminder waits for her to be clicked. */
    stay(text: string): void {
        this.show(text);
    }

    /** Fades the line out now, whatever its reading time. */
    dismiss(): void {
        this.cancelHide?.();
        this.cancelHide = null;
        this.fadeOut();
    }

    /** "…" until the next `say()` or `hide()`: she is waiting for the daemon's answer. */
    ponder(): void {
        this.show(PONDERING);
    }

    /** Sits over `actor` rather than her head while it is there; null puts it back over her head. */
    setAnchor(actor: Clutter.Actor | null): void {
        this.dropAnchor();
        this.anchor = actor;
        if (actor) {
            this.anchorHandlerIds = [
                actor.connect('notify::x', () => this.follow()),
                actor.connect('notify::y', () => this.follow()),
                actor.connect('notify::height', () => this.follow()),
            ];
        }
        this.follow();
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
        this.dropAnchor();
        for (const id of this.spriteHandlerIds)
            this.sprite.actor.disconnect(id);
        this.spriteHandlerIds.length = 0;
        this.cancelHide?.();
        this.cancelHide = null;
        Main.layoutManager.removeChrome(this.actor);
        this.actor.destroy();
    }

    private show(text: string, translation: string | null = null): void {
        this.cancelHide?.();
        this.cancelHide = null;
        this.label.text = text;
        this.translationLabel.text = translation ?? '';
        this.translationLabel.visible = translation !== null;
        this.actor.remove_all_transitions();
        this.showing = true;
        this.reposition();
        (this.actor as EaseableBoxLayout).ease({opacity: 255, duration: FADE_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
    }

    private dropAnchor(): void {
        if (this.anchor) {
            for (const id of this.anchorHandlerIds)
                this.anchor.disconnect(id);
        }
        this.anchorHandlerIds = [];
        this.anchor = null;
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

    /** Centred above her head (or the anchor), kept on the primary monitor; below when the top edge is too close. */
    private reposition(): void {
        const monitor = Main.layoutManager.primaryMonitor;
        if (!monitor)
            return;
        const [, , width, height] = this.actor.get_preferred_size();
        const sprite = this.sprite.actor;
        const scale = this.sprite.currentScale;

        // Against her head and tentacles, not the empty rows of the frame around them.
        const [centreX, top, bottom] = this.anchor
            ? [this.anchor.x + this.anchor.width / 2, this.anchor.y, this.anchor.y + this.anchor.height]
            : [sprite.x + this.sprite.size / 2, sprite.y + HEAD_PADDING * scale, sprite.y + this.sprite.size - FEET_PADDING * scale];

        const centredX = centreX - width / 2;
        const minX = monitor.x + SCREEN_MARGIN;
        const maxX = monitor.x + monitor.width - width - SCREEN_MARGIN;
        const x = Math.max(minX, Math.min(maxX, centredX));

        const above = top - GAP - height;
        const below = bottom + GAP;
        const y = above >= monitor.y ? above : below;
        this.actor.set_position(Math.round(x), Math.round(y));
    }
}
