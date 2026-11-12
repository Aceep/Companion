import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {loadAnimations, type LoadedAnimations} from './animations.js';
import {parseManifest, type PackManifest} from './pack.js';

/** The `sprite-pack` setting's value for the built-in pack, Crêpe. */
export const BUILTIN_PACK_ID = '';
/** The id the built-in manifest is read under; a user pack folder may not take it. */
const BUILTIN_MANIFEST_ID = 'crepe';

const decoder = new TextDecoder('utf-8');

/** Where the user's packs live: one folder each, under the XDG data directory. */
export function packsDirectory(): Gio.File {
    return Gio.File.new_for_path(GLib.build_filenamev([GLib.get_user_data_dir(), 'crepe', 'packs']));
}

/** Reads and checks `pack.json` in `dir`; throws with what is wrong. */
export function readManifest(id: string, dir: Gio.File): PackManifest {
    const file = dir.get_child('pack.json');
    if (!file.query_exists(null))
        throw new Error('no pack.json');
    const [, contents] = file.load_contents(null);
    return parseManifest(id, JSON.parse(decoder.decode(contents)) as unknown);
}

export interface PackEntry {
    readonly id: string;
    readonly dir: Gio.File;
    /** Null when the folder is not a usable pack; `error` then says why. */
    readonly manifest: PackManifest | null;
    readonly error: string | null;
}

/** Every folder in the packs directory, usable or not, by id. */
export function listPacks(): PackEntry[] {
    const directory = packsDirectory();
    if (!directory.query_exists(null))
        return [];
    const entries: PackEntry[] = [];
    const children = directory.enumerate_children('standard::name,standard::type', Gio.FileQueryInfoFlags.NONE, null);
    for (let info = children.next_file(null); info; info = children.next_file(null)) {
        if (info.get_file_type() !== Gio.FileType.DIRECTORY)
            continue;
        const id = info.get_name();
        const dir = directory.get_child(id);
        try {
            entries.push({id, dir, manifest: readManifest(id, dir), error: null});
        } catch (error) {
            entries.push({id, dir, manifest: null, error: describe(error)});
        }
    }
    children.close(null);
    return entries.sort((left, right) => left.id.localeCompare(right.id));
}

export interface LoadedPack extends LoadedAnimations {
    readonly id: string;
    readonly manifest: PackManifest;
    /** Where its frames, outfits, ink and icon are read from. */
    readonly dir: Gio.File;
    readonly builtIn: boolean;
    /** When the chosen pack could not be used and Crêpe took its place: why. */
    readonly fallbackReason: string | null;
}

/**
 * The pack `id` names, loaded, or the built-in one when `id` is empty.
 * A user pack that cannot be read or lacks a required animation never
 * keeps her off the screen: Crêpe loads instead, with the reason kept
 * for the journal and the preferences. Only the built-in pack may throw.
 */
export function loadPack(id: string, builtinDir: Gio.File): LoadedPack {
    if (id === BUILTIN_PACK_ID)
        return loadBuiltin(builtinDir, null);
    const dir = packsDirectory().get_child(id);
    try {
        const manifest = readManifest(id, dir);
        return {id, manifest, dir, builtIn: false, fallbackReason: null, ...loadAnimations(dir)};
    } catch (error) {
        return loadBuiltin(builtinDir, describe(error));
    }
}

function loadBuiltin(builtinDir: Gio.File, fallbackReason: string | null): LoadedPack {
    const manifest = readManifest(BUILTIN_MANIFEST_ID, builtinDir);
    return {id: BUILTIN_PACK_ID, manifest, dir: builtinDir, builtIn: true, fallbackReason, ...loadAnimations(builtinDir)};
}

function describe(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
}
