import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {PACK_FRAME_SIZE} from './pack.js';
import {IDLE_ANIMATION} from './player.js';

export const FRAME_SIZE = PACK_FRAME_SIZE;

/**
 * Animations drawn facing one way only, played the other way with their
 * frames flipped: the mirrored name maps to the drawn one.
 */
const MIRRORED: Record<string, string> = {
    pointer_gauche: 'pointer',
};

export interface AnimationDef {
    readonly name: string;
    /** Absolute paths of the frame PNGs, in playback order. */
    readonly frames: readonly string[];
    readonly durationsMs: readonly number[];
    readonly loop: boolean;
    /**
     * Frame range (0-based, inclusive) to loop forever once the animation
     * has played through once. Used by "endormie": she falls asleep, then
     * keeps breathing in her sleep.
     */
    readonly tailLoop: readonly [number, number] | null;
    readonly usage: string;
    /** Frames are flipped horizontally when shown. */
    readonly mirrored: boolean;
}

interface RawAnimation {
    images: number;
    taille: string;
    durees_ms: number[];
    boucle: boolean;
    boucle_fin?: [number, number];
    usage: string;
}

const decoder = new TextDecoder('utf-8');

export function loadAnimations(assetsDir: Gio.File): Map<string, AnimationDef> {
    const file = assetsDir.get_child('animations.json');
    const [, contents] = file.load_contents(null);
    const raw = JSON.parse(decoder.decode(contents)) as Record<string, RawAnimation>;

    const animations = new Map<string, AnimationDef>();
    for (const [name, def] of Object.entries(raw))
        animations.set(name, toAnimationDef(name, def, assetsDir));

    for (const [name, drawn] of Object.entries(MIRRORED)) {
        const original = animations.get(drawn);
        if (!original)
            throw new Error(`animations.json has no "${drawn}" animation to mirror`);
        animations.set(name, {...original, name, mirrored: true});
    }

    if (!animations.has(IDLE_ANIMATION))
        throw new Error(`animations.json has no "${IDLE_ANIMATION}" animation`);
    return animations;
}

function toAnimationDef(name: string, raw: RawAnimation, assetsDir: Gio.File): AnimationDef {
    if (raw.durees_ms.length !== raw.images)
        throw new Error(`${name}: ${raw.images} images but ${raw.durees_ms.length} durations`);
    if (raw.taille !== `${FRAME_SIZE}x${FRAME_SIZE}`)
        throw new Error(`${name}: unexpected frame size ${raw.taille}`);

    const frames: string[] = [];
    for (let index = 0; index < raw.images; index++) {
        const fileName = `${name}_${String(index).padStart(2, '0')}.png`;
        const path = GLib.build_filenamev([assetsDir.get_path() ?? '', name, fileName]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            throw new Error(`${name}: missing frame ${path}`);
        frames.push(path);
    }

    // animations.json counts frames from 1, the player from 0.
    const tailLoop = raw.boucle_fin
        ? ([raw.boucle_fin[0] - 1, raw.boucle_fin[1] - 1] as const)
        : null;

    return {name, frames, durationsMs: raw.durees_ms, loop: raw.boucle, tailLoop, usage: raw.usage, mirrored: false};
}
