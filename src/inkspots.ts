export interface Rect {
    x: number;
    y: number;
    width: number;
    height: number;
}

export interface InkSpot {
    /** Which splat drawing, an index into the sizes given. */
    variant: number;
    x: number;
    y: number;
}

const TRIES_PER_SPLAT = 20;

/**
 * Where up to `count` splats go inside `area` (the work area, so below
 * the top bar). `sizes` are the on-screen sizes of the drawings, one
 * per variant. A splat never overlaps another one or anything in
 * `avoid` (her body); one that finds no room is given up on, so fewer
 * come back than asked for on a crowded screen. `random` is in [0, 1).
 */
export function pickInkSpots(area: Rect, count: number, sizes: readonly number[], avoid: readonly Rect[], random: () => number): InkSpot[] {
    const taken: Rect[] = [...avoid];
    const spots: InkSpot[] = [];
    for (let placed = 0; placed < count; placed++) {
        const variant = Math.floor(random() * sizes.length);
        const size = sizes[variant];
        if (size === undefined || size > area.width || size > area.height)
            continue;
        for (let attempt = 0; attempt < TRIES_PER_SPLAT; attempt++) {
            const x = Math.round(area.x + random() * (area.width - size));
            const y = Math.round(area.y + random() * (area.height - size));
            const rect = {x, y, width: size, height: size};
            if (taken.some(other => overlap(rect, other)))
                continue;
            taken.push(rect);
            spots.push({variant, x, y});
            break;
        }
    }
    return spots;
}

function overlap(first: Rect, second: Rect): boolean {
    return first.x < second.x + second.width && second.x < first.x + first.width &&
        first.y < second.y + second.height && second.y < first.y + first.height;
}
