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

/** Where an extra layer goes, relative to her frame: drawn over her, or under her. */
export type LayerDepth = 'front' | 'back';

/**
 * The on-screen Crêpe: a container actor whose `frame` child shows the
 * current frame, swapped frame by frame. Frames are decoded once and
 * cached per file path and orientation. Extra layers (her outfits) are
 * children drawn above or below the frame at the same origin and size.
 * It takes no input: `Hitbox` does, over her body only.
 */
export class CrepeSprite {
    readonly actor: Clutter.Actor;
    private readonly frame: Clutter.Actor;
    private readonly layers: Clutter.Actor[] = [];
    private readonly frameCache = new Map<string, Clutter.Image>();
    private readonly headTops = new Map<string, number>();
    private scale: number;

    constructor(scale: number) {
        this.scale = scale;
        this.actor = new Clutter.Actor({
            name: 'crepe-sprite',
            width: FRAME_SIZE * scale,
            height: FRAME_SIZE * scale,
            reactive: false,
        });
        this.frame = new Clutter.Actor({name: 'crepe-frame', reactive: false});
        setUpPixelArt(this.frame);
        this.actor.add_child(this.frame);
        this.resizeChildren();
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
        this.resizeChildren();
    }

    showFrame(animation: AnimationDef, frameIndex: number): void {
        const path = animation.frames[frameIndex];
        if (!path)
            return;
        this.frame.set_content(this.imageFor(path, animation.mirrored));
    }

    /**
     * Rows her head's top sits below where it is in the resting pose, in
     * sprite pixels, for that frame: negative when she stretches up. What
     * she wears on her head follows it, so a breath or a jump keeps her hat on.
     */
    headOffset(animation: AnimationDef, frameIndex: number): number {
        const path = animation.frames[frameIndex];
        if (!path)
            return 0;
        if (!this.headTops.has(path))
            this.imageFor(path, animation.mirrored);
        return (this.headTops.get(path) ?? HEAD_PADDING) - HEAD_PADDING;
    }

    /** Adds an actor drawn over or under her frame, kept at its size; it is destroyed with the sprite. */
    addLayer(layer: Clutter.Actor, depth: LayerDepth): void {
        if (depth === 'front')
            this.actor.insert_child_above(layer, this.frame);
        else
            this.actor.insert_child_below(layer, this.frame);
        this.layers.push(layer);
        layer.set_size(this.size, this.size);
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
        this.layers.length = 0;
        this.frameCache.clear();
        this.headTops.clear();
    }

    private resizeChildren(): void {
        this.frame.set_size(this.size, this.size);
        for (const layer of this.layers)
            layer.set_size(this.size, this.size);
    }

    private imageFor(path: string, mirrored: boolean): Clutter.Image {
        const key = mirrored ? `${path}#mirrored` : path;
        const cached = this.frameCache.get(key);
        if (cached)
            return cached;

        // Flipping the pixels rather than the actor keeps her position, hitbox and bubble untouched.
        const pixbuf = decodePixbuf(path, mirrored);
        // Her head is centred, so a mirrored frame has it at the same height.
        if (!this.headTops.has(path))
            this.headTops.set(path, headTopOf(pixbuf));
        const image = imageOf(pixbuf);
        this.frameCache.set(key, image);
        return image;
    }
}

/** Pixel art: never let the GPU blur the upscale, and stretch the content over the whole actor. */
export function setUpPixelArt(actor: Clutter.Actor): void {
    actor.set_content_scaling_filters(Clutter.ScalingFilter.NEAREST, Clutter.ScalingFilter.NEAREST);
    actor.set_content_gravity(Clutter.ContentGravity.RESIZE_FILL);
}

/** A PNG, flipped horizontally when `mirrored`. */
export function decodePixbuf(path: string, mirrored: boolean): GdkPixbuf.Pixbuf {
    const decoded = GdkPixbuf.Pixbuf.new_from_file(path);
    const pixbuf = mirrored ? decoded.flip(true) : decoded;
    if (!pixbuf)
        throw new Error(`could not mirror ${path}`);
    return pixbuf;
}

export function imageOf(pixbuf: GdkPixbuf.Pixbuf): Clutter.Image {
    const format = pixbuf.get_has_alpha() ? Cogl.PixelFormat.RGBA_8888 : Cogl.PixelFormat.RGB_888;
    const image = new Clutter.Image();
    image.set_data(
        pixbuf.get_pixels(),
        format,
        pixbuf.get_width(),
        pixbuf.get_height(),
        pixbuf.get_rowstride(),
    );
    return image;
}

/** Columns around the middle of the frame where her head is, whatever she does with her tentacles. */
const HEAD_COLUMNS: readonly [number, number] = [25, 55];
/** Opaque pixels a row needs across those columns to be her head rather than a stray "z" of her sleep. */
const HEAD_ROW_MIN_PIXELS = 6;
/** Near-white pixels are the "z"s she snores, drawn above her head. */
const SNORE_MIN_CHANNEL = 236;

/** The first row of the frame with her head in it; the resting pose's own when there is none. */
function headTopOf(pixbuf: GdkPixbuf.Pixbuf): number {
    if (!pixbuf.get_has_alpha())
        return HEAD_PADDING;
    const pixels = pixbuf.get_pixels();
    const stride = pixbuf.get_rowstride();
    const channels = pixbuf.get_n_channels();
    const [left, right] = HEAD_COLUMNS;
    for (let y = 0; y < pixbuf.get_height(); y++) {
        let count = 0;
        for (let x = left; x < Math.min(right, pixbuf.get_width()); x++) {
            const at = y * stride + x * channels;
            const [red = 0, green = 0, blue = 0, alpha = 0] = pixels.subarray(at, at + 4);
            if (alpha > 0 && Math.min(red, green, blue) < SNORE_MIN_CHANNEL)
                count++;
        }
        if (count >= HEAD_ROW_MIN_PIXELS)
            return y;
    }
    return HEAD_PADDING;
}
