/**
 * What a sprite pack is: a folder with a `pack.json`, an `animations.json`
 * and the frames it names, drawn 80×80 with the body inside a fixed box.
 * Crêpe herself is the built-in pack. This module checks a pack's
 * manifest and works out what the extension does about the animations it
 * lacks; it reads no file, so it runs under node and in the preferences.
 */

export const PACK_FRAME_SIZE = 80;

/**
 * Transparent sprite pixels around the body in the resting pose: above the
 * head, below the feet and on either side. The hitbox, the speech bubble
 * and the way she hides past a screen edge all count on it, so a pack
 * draws inside this box rather than describing its own.
 */
export const BODY_BOX = {
    top: 20,
    bottom: 12,
    /** The same width on both sides, so a mirrored frame lines up. */
    side: 12,
} as const;

export interface PackManifest {
    /** The folder's name, and the value of the `sprite-pack` setting. */
    readonly id: string;
    /** Shown in the menu, the quick settings toggle and the preferences instead of "Crêpe". */
    readonly name: string;
    /** The one word every word of a line becomes when spoken in her own language. */
    readonly word: string;
    readonly author: string | null;
    readonly description: string | null;
}

const MAX_NAME_LENGTH = 30;
/** One lowercase word, accents allowed: "crêpe", "poireau". It is repeated for every word of a line. */
const WORD_PATTERN = /^\p{Ll}+$/u;
/** A folder name that is safe in a path and in a GSettings string. */
const ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/;

/** Reads a parsed `pack.json`; throws with the first thing wrong with it. */
export function parseManifest(id: string, raw: unknown): PackManifest {
    if (!ID_PATTERN.test(id))
        throw new Error(`pack folder "${id}": lowercase letters, digits, "-" and "_" only`);
    if (typeof raw !== 'object' || raw === null || Array.isArray(raw))
        throw new Error('pack.json: expected an object');
    const fields = raw as Record<string, unknown>;

    const name = requiredString(fields, 'nom');
    if (name.length > MAX_NAME_LENGTH)
        throw new Error(`pack.json: "nom" is longer than ${MAX_NAME_LENGTH} characters`);
    const word = requiredString(fields, 'mot');
    if (!WORD_PATTERN.test(word))
        throw new Error('pack.json: "mot" must be one lowercase word, like "crêpe"');

    return {
        id,
        name,
        word,
        author: optionalString(fields, 'auteur'),
        description: optionalString(fields, 'description'),
    };
}

function requiredString(fields: Record<string, unknown>, key: string): string {
    const value = fields[key];
    if (typeof value !== 'string' || value.trim() === '')
        throw new Error(`pack.json: "${key}" must be a non-empty string`);
    return value.trim();
}

function optionalString(fields: Record<string, unknown>, key: string): string | null {
    const value = fields[key];
    if (value === undefined || value === null)
        return null;
    if (typeof value !== 'string')
        throw new Error(`pack.json: "${key}" must be a string`);
    return value.trim() === '' ? null : value.trim();
}

/** The directions the eyes can turn, as the pose names spell them. */
export const EYE_DIRECTIONS = ['nord', 'nord_est', 'est', 'sud_est', 'sud', 'sud_ouest', 'ouest', 'nord_ouest'] as const;

/** Without these there is nothing to show: a resting pose, a blink on it, and a way to move. */
export const REQUIRED_ANIMATIONS = ['attente', 'clignement', 'marche_droite'] as const;

/**
 * Missing from a pack, an animation plays another one's frames under its
 * own name, so the rest of the extension (outfit rules, reaction lines)
 * still sees the name it expects. In order: a substitute may itself be
 * one, so "gratter" without "facepalm" nor "sursaut" ends up as a blink.
 */
export const SUBSTITUTES: ReadonlyArray<readonly [animation: string, playedAs: string]> = [
    ['sursaut', 'clignement'],
    ['pointer', 'sursaut'],
    ['facepalm', 'sursaut'],
    ['pouce', 'sursaut'],
    ['gratter', 'facepalm'],
    ['applaudissement', 'pouce'],
    ['endormie', 'attente'],
];

/** Drawn one way only when the pack has no frames the other way: the other direction is the mirror. */
export const MIRRORED_WHEN_MISSING: ReadonlyArray<readonly [animation: string, mirrorOf: string]> = [
    ['marche_gauche', 'marche_droite'],
];

/** Gestures she does without when they are missing: the line comes alone, or nothing happens. */
export const OPTIONAL_GESTURES = [
    'respiration', 'soupir', 'baillement', 'coucou', 'chut', 'tapote', 'regard_droite', 'regard_gauche',
] as const;

/** The sulk with something held: all four or none, a half-drawn sulk would mix two poses. */
export const MENACE_GROUP = ['menace', 'menace_tenue', 'menace_clignement', 'menace_rangee'] as const;

/** The resting poses with the eyes turned: every direction or none, or the eyes would jump back for some. */
export const EYE_POSE_GROUPS: ReadonlyArray<readonly [restPose: string, prefix: string]> = [
    ['attente', 'yeux'],
    ['menace_tenue', 'menace_yeux'],
];

function eyePoses(prefix: string): string[] {
    return EYE_DIRECTIONS.map(direction => `${prefix}_${direction}`);
}

/** Every animation name the extension knows what to do with. Anything else in a pack is ignored. */
export const KNOWN_ANIMATIONS: readonly string[] = [
    ...REQUIRED_ANIMATIONS,
    ...SUBSTITUTES.map(([animation]) => animation),
    ...MIRRORED_WHEN_MISSING.map(([animation]) => animation),
    ...OPTIONAL_GESTURES,
    ...MENACE_GROUP,
    ...EYE_POSE_GROUPS.flatMap(([, prefix]) => eyePoses(prefix)),
];

export interface AnimationReview {
    /** Animation → the existing animation whose frames it plays. */
    readonly substitutes: ReadonlyMap<string, string>;
    /** Animation → the existing animation it is the mirror of. */
    readonly mirrored: ReadonlyMap<string, string>;
    /** Present in the pack but set aside: part of a group the pack does not complete. */
    readonly dropped: readonly string[];
    /** Known animations the pack does not have and nothing stands in for. */
    readonly missing: readonly string[];
    /** Names in the pack the extension does nothing with. */
    readonly unknown: readonly string[];
    /** One French sentence per thing she does differently with this pack, for the preferences. */
    readonly notes: readonly string[];
}

/**
 * What the extension makes of a pack's animation names: which stand in for
 * which, which are set aside, which she does without. Throws when a
 * required one is missing.
 */
export function reviewAnimations(names: Iterable<string>): AnimationReview {
    const present = new Set(names);
    for (const name of REQUIRED_ANIMATIONS) {
        if (!present.has(name))
            throw new Error(`animations.json has no "${name}": it is one of the ${REQUIRED_ANIMATIONS.length} every pack needs`);
    }

    const unknown = [...present].filter(name => !KNOWN_ANIMATIONS.includes(name)).sort();
    const dropped: string[] = [];
    const notes: string[] = [];

    const dropGroup = (group: readonly string[], note: string): void => {
        const have = group.filter(name => present.has(name));
        if (have.length === 0 || have.length === group.length)
            return;
        for (const name of have) {
            present.delete(name);
            dropped.push(name);
        }
        notes.push(note);
    };
    dropGroup(MENACE_GROUP, `Menace incomplète (${MENACE_GROUP.join(', ')} vont ensemble) : elle boude sans rien tenir.`);
    for (const [restPose, prefix] of EYE_POSE_GROUPS) {
        const poses = eyePoses(prefix);
        dropGroup(poses, `Poses ${prefix}_* incomplètes (les huit directions vont ensemble) : les yeux ne bougent pas en ${restPose}.`);
        // Eyes turned on a pose she never takes are of no use.
        if (!present.has(restPose) && poses.some(name => present.has(name))) {
            for (const name of poses.filter(name => present.has(name))) {
                present.delete(name);
                dropped.push(name);
            }
        }
    }

    const mirrored = new Map<string, string>();
    for (const [animation, mirrorOf] of MIRRORED_WHEN_MISSING) {
        if (present.has(animation) || !present.has(mirrorOf))
            continue;
        mirrored.set(animation, mirrorOf);
        present.add(animation);
        notes.push(`Sans « ${animation} », elle joue « ${mirrorOf} » en miroir.`);
    }

    const substitutes = new Map<string, string>();
    for (const [animation, playedAs] of SUBSTITUTES) {
        if (present.has(animation))
            continue;
        // The stand-in may be a stand-in itself: follow it to real frames.
        const source = substitutes.get(playedAs) ?? playedAs;
        if (!present.has(source))
            continue;
        substitutes.set(animation, source);
        present.add(animation);
        notes.push(`Sans « ${animation} », elle joue « ${source} » à la place.`);
    }

    const missing = KNOWN_ANIMATIONS.filter(name => !present.has(name));
    const gesturesMissing = missing.filter(name => (OPTIONAL_GESTURES as readonly string[]).includes(name));
    if (gesturesMissing.length > 0)
        notes.push(`Sans ${gesturesMissing.map(name => `« ${name} »`).join(', ')} : pas de geste, la réplique seule.`);
    if (MENACE_GROUP.every(name => missing.includes(name)))
        notes.push('Sans « menace » : elle boude en pose d\'attente.');
    for (const [restPose, prefix] of EYE_POSE_GROUPS) {
        if (present.has(restPose) && eyePoses(prefix).every(name => missing.includes(name)))
            notes.push(`Sans « ${prefix}_* » : les yeux ne suivent pas la souris en ${restPose}.`);
    }

    return {substitutes, mirrored, dropped, missing, unknown, notes};
}

/**
 * Opaque pixels of a decoded frame outside the body box, for the resting
 * pose: more than none, and the hitbox and the bubble will be off. The
 * buffer is RGBA or RGB, `stride` bytes per row.
 */
export function pixelsOutsideBody(width: number, height: number, channels: number, stride: number, pixels: Uint8Array): number {
    if (channels < 4)
        return width * height - (width - 2 * BODY_BOX.side) * (height - BODY_BOX.top - BODY_BOX.bottom);
    let count = 0;
    for (let y = 0; y < height; y++) {
        const outsideRow = y < BODY_BOX.top || y >= height - BODY_BOX.bottom;
        for (let x = 0; x < width; x++) {
            if (!outsideRow && x >= BODY_BOX.side && x < width - BODY_BOX.side)
                continue;
            if ((pixels[y * stride + x * channels + 3] ?? 0) > 0)
                count++;
        }
    }
    return count;
}
