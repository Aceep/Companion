import Clutter from 'gi://Clutter';
import type Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import type {AnimationDef} from './animations.js';
import {decodePixbuf, imageOf, setUpPixelArt, type CrepeSprite, type LayerDepth} from './sprite.js';
import {OUTFIT_IDS, type OutfitId} from './wardrobe.js';

/** Over her (a hat) or under her (a deckchair), as `assets/tenues.json` says it. */
type RawDepth = 'devant' | 'derriere';

const DEPTHS: Record<RawDepth, LayerDepth> = {
    devant: 'front',
    derriere: 'back',
};

interface RawLayer {
    fichier: string;
    z: RawDepth;
    suit_la_tete?: boolean;
}

interface RawOutfit {
    usage: string;
    calques: RawLayer[];
    visible_pendant?: string[];
    cache_pendant?: string[];
}

export interface OutfitLayerDef {
    /** Absolute path of the 80×80 PNG, drawn at the frame's origin. */
    readonly path: string;
    readonly depth: LayerDepth;
    /** Moves up and down with her head, frame by frame; otherwise stays where it is drawn. */
    readonly followsHead: boolean;
}

export interface OutfitDef {
    readonly id: OutfitId;
    readonly usage: string;
    readonly layers: readonly OutfitLayerDef[];
    /** Animation names or `prefix*` patterns it shows during; null means all of them. */
    readonly visibleDuring: readonly string[] | null;
    /** Animation names or `prefix*` patterns it hides during, whatever `visibleDuring` says. */
    readonly hiddenDuring: readonly string[];
}

const decoder = new TextDecoder('utf-8');

/**
 * The outfits described in `assets/tenues.json`, checked against the
 * animations so a typo in a name is caught at load rather than silently
 * leaving a hat on during a crawl.
 */
export class OutfitCatalog {
    private readonly outfits: ReadonlyMap<OutfitId, OutfitDef>;

    constructor(outfits: ReadonlyMap<OutfitId, OutfitDef>) {
        this.outfits = outfits;
    }

    get all(): Iterable<OutfitDef> {
        return this.outfits.values();
    }

    /** Whether the outfit shows while `animation` plays; nothing shows once the player stopped. */
    isVisibleDuring(id: OutfitId, animation: string | null): boolean {
        const outfit = this.outfits.get(id);
        if (!outfit || animation === null)
            return false;
        if (outfit.hiddenDuring.some(pattern => matches(pattern, animation)))
            return false;
        return outfit.visibleDuring === null || outfit.visibleDuring.some(pattern => matches(pattern, animation));
    }
}

export function loadOutfits(assetsDir: Gio.File, animationNames: Iterable<string>): OutfitCatalog {
    const file = assetsDir.get_child('tenues.json');
    const [, contents] = file.load_contents(null);
    const raw = JSON.parse(decoder.decode(contents)) as Record<string, RawOutfit>;
    const names = [...animationNames];

    const outfits = new Map<OutfitId, OutfitDef>();
    for (const id of OUTFIT_IDS) {
        const outfit = raw[id];
        if (!outfit)
            throw new Error(`tenues.json has no "${id}" outfit`);
        outfits.set(id, toOutfitDef(id, outfit, assetsDir, names));
    }
    return new OutfitCatalog(outfits);
}

function toOutfitDef(id: OutfitId, raw: RawOutfit, assetsDir: Gio.File, animationNames: readonly string[]): OutfitDef {
    if (!Array.isArray(raw.calques) || raw.calques.length === 0)
        throw new Error(`${id}: no layer`);
    const layers = raw.calques.map(layer => {
        const depth = DEPTHS[layer.z];
        if (!depth)
            throw new Error(`${id}: unknown z "${String(layer.z)}", expected "devant" or "derriere"`);
        const path = GLib.build_filenamev([assetsDir.get_path() ?? '', layer.fichier]);
        if (!GLib.file_test(path, GLib.FileTest.EXISTS))
            throw new Error(`${id}: missing layer ${path}`);
        return {path, depth, followsHead: layer.suit_la_tete === true};
    });
    const visibleDuring = raw.visible_pendant ?? null;
    const hiddenDuring = raw.cache_pendant ?? [];
    for (const pattern of [...visibleDuring ?? [], ...hiddenDuring]) {
        if (!animationNames.some(name => matches(pattern, name)))
            throw new Error(`${id}: "${pattern}" matches no animation`);
    }
    return {id, usage: raw.usage, layers, visibleDuring, hiddenDuring};
}

/** An animation name, or a prefix ending in `*`: "ramper_*" covers both crawls. */
function matches(pattern: string, name: string): boolean {
    return pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern;
}

interface ShownLayer {
    readonly outfit: OutfitId;
    readonly def: OutfitLayerDef;
    readonly actor: Clutter.Actor;
}

/**
 * What she wears, on screen: two actors on the sprite, one over her frame
 * and one under it, each holding one child per layer of every outfit.
 * Children show while their outfit is worn and allowed during the current
 * animation; those following her head move with it frame by frame. They
 * live inside the sprite, so they follow her across the stage, both
 * layers of it, and scale with her. Clicks still only go to the hitbox.
 */
export class OutfitLayer {
    private readonly catalog: OutfitCatalog;
    private readonly sprite: CrepeSprite;
    private readonly front: Clutter.Actor;
    private readonly back: Clutter.Actor;
    private readonly shown: ShownLayer[] = [];
    private readonly images = new Map<string, Clutter.Image>();
    private readonly resizeHandlerId: number;
    private worn: ReadonlySet<OutfitId> = new Set();
    private animation: AnimationDef | null = null;
    private frameIndex = 0;

    constructor(sprite: CrepeSprite, catalog: OutfitCatalog) {
        this.sprite = sprite;
        this.catalog = catalog;
        this.front = new Clutter.Actor({name: 'crepe-outfit-front', reactive: false});
        this.back = new Clutter.Actor({name: 'crepe-outfit-back', reactive: false});
        sprite.addLayer(this.front, 'front');
        sprite.addLayer(this.back, 'back');

        for (const outfit of catalog.all) {
            for (const def of outfit.layers) {
                const actor = new Clutter.Actor({reactive: false, visible: false});
                setUpPixelArt(actor);
                actor.set_content(this.imageFor(def.path, false));
                (def.depth === 'front' ? this.front : this.back).add_child(actor);
                this.shown.push({outfit: outfit.id, def, actor});
            }
        }
        this.resizeHandlerId = this.front.connect('notify::width', () => this.resize());
        this.resize();
    }

    get wearing(): ReadonlySet<OutfitId> {
        return this.worn;
    }

    /** Puts these on and takes everything else off. */
    wear(outfits: ReadonlySet<OutfitId>): void {
        this.worn = new Set(outfits);
        this.sync();
    }

    /** A new animation started, or the player stopped (null). */
    animationChanged(animation: AnimationDef | null): void {
        this.animation = animation;
        this.sync();
    }

    /** A new frame shows: what follows her head goes where her head is. */
    frameShown(animation: AnimationDef, frameIndex: number): void {
        this.frameIndex = frameIndex;
        const offset = this.sprite.headOffset(animation, frameIndex) * this.sprite.currentScale;
        for (const layer of this.shown) {
            if (layer.def.followsHead)
                layer.actor.translation_y = offset;
        }
    }

    /** The front and back actors go with the sprite; only the decoded images are left to drop. */
    destroy(): void {
        this.front.disconnect(this.resizeHandlerId);
        this.shown.length = 0;
        this.images.clear();
    }

    private sync(): void {
        const name = this.animation?.name ?? null;
        const mirrored = this.animation?.mirrored ?? false;
        for (const layer of this.shown) {
            const visible = this.worn.has(layer.outfit) && this.catalog.isVisibleDuring(layer.outfit, name);
            // Her frame is mirrored for some gestures: what she holds goes to the other side with it.
            if (visible)
                layer.actor.set_content(this.imageFor(layer.def.path, mirrored));
            layer.actor.visible = visible;
        }
    }

    private resize(): void {
        const width = this.front.width;
        for (const layer of this.shown)
            layer.actor.set_size(width, width);
        // The head offset is in screen pixels: a rescale has to redo it.
        if (this.animation)
            this.frameShown(this.animation, this.frameIndex);
    }

    private imageFor(path: string, mirrored: boolean): Clutter.Image {
        const key = mirrored ? `${path}#mirrored` : path;
        const cached = this.images.get(key);
        if (cached)
            return cached;
        const image = imageOf(decodePixbuf(path, mirrored));
        this.images.set(key, image);
        return image;
    }
}
