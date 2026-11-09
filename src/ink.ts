import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Rect} from './geometry.js';
import {pickInkSpots} from './inkspots.js';
import {decodePixbuf, imageOf, setUpPixelArt} from './sprite.js';
import type {TimerPool} from './timers.js';

/** The drawings in `assets/encre/`, `encre_0.png` to `encre_3.png`, and their size in pixels. */
const VARIANT_SIZES = [48, 64, 80, 96] as const;
/** Screen pixels per drawing pixel, before the HiDPI factor. */
const INK_SCALE = 2;
/** More splats than this on the screen at once would be a mess, not a gag. */
export const MAX_SPLATS = 3;
const APPEAR_MS = 150;
const HOLD_MS = 2000;
const FADE_MS = 18000;
const OPACITY = 235;

/** The shell adds `ease()` to every actor at runtime; the typings only see it on some import paths. */
interface EaseableActor extends Clutter.Actor {
    ease(params: {opacity: number; duration: number; mode: Clutter.AnimationMode; onComplete?: () => void}): void;
}

interface Splat {
    actor: Clutter.Actor;
    cancelHold: () => void;
}

/**
 * The ink she spits when she has had enough: dark splats on the monitor
 * she is on, over the windows, that take no clicks and fade away by
 * themselves in about twenty seconds. Fullscreen-tracked chrome like her
 * bubble, so a fullscreen window covers it rather than the layout manager
 * fighting over its visibility.
 */
export class InkSplatter {
    private readonly timers: TimerPool;
    private readonly images: Clutter.Image[];
    private readonly themeScale: () => number;
    private readonly splats = new Set<Splat>();

    constructor(assetsDir: Gio.File, timers: TimerPool, themeScale: () => number) {
        this.timers = timers;
        this.themeScale = themeScale;
        const directory = assetsDir.get_child('encre');
        // A pack without the drawings has no ink to spit: `splash` then brings none.
        this.images = directory.query_exists(null)
            ? VARIANT_SIZES.map((_size, variant) => {
                const path = directory.get_child(`encre_${variant}.png`).get_path();
                if (path === null)
                    throw new Error(`no path for ink splat ${variant}`);
                return imageOf(decodePixbuf(path, false));
            })
            : [];
    }

    /** Whether the pack drew any ink. */
    get hasInk(): boolean {
        return this.images.length > 0;
    }

    get count(): number {
        return this.splats.size;
    }

    /**
     * Up to `count` new splats inside `area`, never past `MAX_SPLATS` on
     * the screen and never over `avoid`; `below` is an actor they go under
     * when it sits among the chrome (her sprite). Returns how many came.
     */
    splash(count: number, area: Rect, avoid: readonly Rect[], below: Clutter.Actor | null): number {
        const room = Math.min(count, MAX_SPLATS - this.splats.size);
        if (room <= 0 || !this.hasInk)
            return 0;
        const factor = INK_SCALE * this.themeScale();
        const sizes = VARIANT_SIZES.map(size => size * factor);
        const spots = pickInkSpots(area, room, sizes, avoid, Math.random);
        for (const spot of spots)
            this.add(spot.variant, spot.x, spot.y, sizes[spot.variant] ?? 0, below);
        return spots.length;
    }

    clear(): void {
        for (const splat of [...this.splats])
            this.remove(splat);
    }

    destroy(): void {
        this.clear();
        this.images.length = 0;
    }

    private add(variant: number, x: number, y: number, size: number, below: Clutter.Actor | null): void {
        const actor = new Clutter.Actor({name: 'crepe-ink', reactive: false, opacity: 0, width: size, height: size});
        setUpPixelArt(actor);
        actor.set_content(this.images[variant] ?? null);
        Main.layoutManager.addTopChrome(actor, {
            affectsInputRegion: false,
            affectsStruts: false,
            trackFullscreen: true,
        });
        actor.set_position(x, y);
        // Under her sprite, so she does not vanish behind her own splat.
        if (below && below.get_parent() === actor.get_parent())
            actor.get_parent()?.set_child_below_sibling(actor, below);

        const splat: Splat = {actor, cancelHold: () => {}};
        this.splats.add(splat);
        (actor as EaseableActor).ease({opacity: OPACITY, duration: APPEAR_MS, mode: Clutter.AnimationMode.EASE_OUT_QUAD});
        splat.cancelHold = this.timers.schedule(HOLD_MS, () => {
            (actor as EaseableActor).ease({
                opacity: 0,
                duration: FADE_MS,
                mode: Clutter.AnimationMode.LINEAR,
                onComplete: () => this.remove(splat),
            });
        });
    }

    private remove(splat: Splat): void {
        if (!this.splats.delete(splat))
            return;
        splat.cancelHold();
        // A transition's completion callback must not fire on a destroyed actor.
        splat.actor.remove_all_transitions();
        Main.layoutManager.removeChrome(splat.actor);
        splat.actor.destroy();
    }
}
