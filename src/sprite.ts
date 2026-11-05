import Clutter from 'gi://Clutter';
import Cogl from 'gi://Cogl';
import GdkPixbuf from 'gi://GdkPixbuf';

import {FRAME_SIZE, type AnimationDef} from './animations.js';

/** Transparent sprite pixels above her head in the resting pose. */
export const HEAD_PADDING = 20;
/** Same below her tentacles. */
export const FEET_PADDING = 12;
/** Same on either side of her outer tentacles; the same width on both sides, so a mirrored frame lines up. */
export const SIDE_PADDING = 12;

/**
 * The on-screen Crêpe: a single Clutter actor whose content is swapped
 * frame by frame. Frames are decoded once and cached per file path and
 * orientation. It takes no input: `Hitbox` does, over her body only.
 */
export class CrepeSprite {
    readonly actor: Clutter.Actor;
    private readonly frameCache = new Map<string, Clutter.Image>();
    private scale: number;

    constructor(scale: number) {
        this.scale = scale;
        this.actor = new Clutter.Actor({
            name: 'crepe-sprite',
            width: FRAME_SIZE * scale,
            height: FRAME_SIZE * scale,
            reactive: false,
        });
        // Pixel art: never let the GPU blur the upscale.
        this.actor.set_content_scaling_filters(Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
        this.actor.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
    }

    get size(): number {
        return FRAME_SIZE * this.scale;
    }

    get currentScale(): number {
        return this.scale;
    }

    setScale(scale: number): void {
        this.scale = scale;
        this.actor.set_size(this.size, this.size);
    }

    showFrame(animation: AnimationDef, frameIndex: number): void {
        const path = animation.frames[frameIndex];
        if (!path)
            return;
        this.actor.set_content(this.imageFor(path, animation.mirrored));
    }

    /** Decodes every frame of the given animations so playback never stutters. */
    preload(animations: Iterable<AnimationDef>): void {
        for (const animation of animations) {
            for (const path of animation.frames)
                this.imageFor(path, animation.mirrored);
        }
    }

    destroy(): void {
        this.actor.destroy();
        this.frameCache.clear();
    }

    private imageFor(path: string, mirrored: boolean): Clutter.Image {
        const key = mirrored ? `${path}#mirrored` : path;
        const cached = this.frameCache.get(key);
        if (cached)
            return cached;

        // Flipping the pixels rather than the actor keeps her position, hitbox and bubble untouched.
        const decoded = GdkPixbuf.Pixbuf.new_from_file(path);
        const pixbuf = mirrored ? decoded.flip(true) : decoded;
        if (!pixbuf)
            throw new Error(`could not mirror ${path}`);
        const format = pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
        const image = new Clutter.Image();
        image.set_data(
            pixbuf.get_pixels(),
            format,
            pixbuf.get_width(),
            pixbuf.get_height(),
            pixbuf.get_rowstride(),
        );
        this.frameCache.set(key, image);
        return image;
    }
}
