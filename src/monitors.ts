import type {Point, Rect} from './geometry.js';

/** Stage pixels kept between her frame and the side edges of a work area. */
export const EDGE_MARGIN = 24;
/** Share of her own strolls that stay in the room she is in, so she is not always in transit. */
const STAY_CHANCE = 2 / 3;
/** Tries at a spot far enough from her before she gives the stroll up. */
const DESTINATION_TRIES = 10;

export type Side = 'left' | 'right';

/** Where a room is from the primary monitor's; the primary itself is `primary`. */
export type RoomDirection = 'primary' | 'left' | 'right' | 'up' | 'down';

const ROOM_DIRECTIONS: readonly string[] = ['primary', 'left', 'right', 'up', 'down'] satisfies RoomDirection[];

export function isRoomDirection(value: string): value is RoomDirection {
    return ROOM_DIRECTIONS.includes(value);
}

/**
 * One monitor of the desktop. Its whole rectangle says which monitors
 * touch, since a dock or a panel on a shared edge does not make it a
 * wall; its work area says where she may sit.
 */
export interface Room {
    index: number;
    monitor: Rect;
    area: Rect;
}

/** Where her top-left corner may go, in stage pixels. */
export interface Bounds {
    minX: number;
    maxX: number;
    minY: number;
    maxY: number;
}

/** Leaving a room by one side: where she stands at its edge, and where she comes in next door. */
interface Crossing {
    exit: Point;
    entry: Point;
    next: Room;
}

/**
 * The desktop as one home and its monitors as rooms: which room she is
 * in, which ones touch and where, and the walls, the edges with nothing
 * past them. A snapshot: built again whenever the monitors, their work
 * areas or her size may have changed. All points are her top-left corner
 * unless said otherwise, `size` being her frame's side.
 */
export class House {
    readonly rooms: readonly Room[];
    /** The primary monitor's room, or the first one when the primary index is unknown. */
    readonly primary: Room | null;
    private readonly size: number;

    constructor(rooms: readonly Room[], primaryIndex: number, size: number) {
        this.rooms = rooms;
        this.primary = rooms.find(room => room.index === primaryIndex) ?? rooms[0] ?? null;
        this.size = size;
    }

    /** The room whose monitor holds `point`, or null between or outside them. */
    roomAt(point: Point): Room | null {
        return this.rooms.find(room => contains(room.monitor, point)) ?? null;
    }

    /** The room holding `point`, or else the closest one: hiding past a wall, she is outside every monitor. */
    nearestRoom(point: Point): Room | null {
        const inside = this.roomAt(point);
        if (inside)
            return inside;
        let nearest: Room | null = null;
        let nearestDistance = Number.POSITIVE_INFINITY;
        for (const room of this.rooms) {
            const distance = distanceTo(room.monitor, point);
            if (distance < nearestDistance) {
                nearest = room;
                nearestDistance = distance;
            }
        }
        return nearest;
    }

    /** The room she is in, from her centre. */
    roomOf(position: Point): Room | null {
        return this.nearestRoom(this.centreOf(position));
    }

    roomByIndex(index: number): Room | null {
        return this.rooms.find(room => room.index === index) ?? null;
    }

    /** Where her top-left corner may go in `room`: inside its work area, off its side edges by a margin. */
    bounds(room: Room): Bounds {
        const area = room.area;
        return {
            minX: area.x + EDGE_MARGIN,
            maxX: area.x + area.width - this.size - EDGE_MARGIN,
            minY: area.y,
            maxY: area.y + area.height - this.size,
        };
    }

    /** Whether her top-left corner may sit at `point` in some room without being snapped back. */
    isInside(point: Point): boolean {
        return this.rooms.some(room => {
            const bounds = this.bounds(room);
            return point.x >= bounds.minX && point.x <= bounds.maxX && point.y >= bounds.minY && point.y <= bounds.maxY;
        });
    }

    clampInto(point: Point, room: Room): Point {
        const bounds = this.bounds(room);
        return {x: clamp(point.x, bounds.minX, bounds.maxX), y: clamp(point.y, bounds.minY, bounds.maxY)};
    }

    /**
     * The room whose monitor shares that side edge of `room`'s at height
     * `y`, or, given an `extent`, somewhere between `y` and `y + extent`
     * (the most of it when two do); null when the edge touches nothing
     * there: a wall.
     */
    neighbourAcross(room: Room, side: Side, y: number, extent = 0): Room | null {
        const edge = side === 'right' ? room.monitor.x + room.monitor.width : room.monitor.x;
        let best: Room | null = null;
        let bestShared = Number.NEGATIVE_INFINITY;
        for (const other of this.rooms) {
            const touches = side === 'right' ? other.monitor.x === edge : other.monitor.x + other.monitor.width === edge;
            if (other === room || !touches || !spans(room.monitor, y, extent) || !spans(other.monitor, y, extent))
                continue;
            const shared = Math.min(other.monitor.y + other.monitor.height, y + extent) - Math.max(other.monitor.y, y);
            if (shared > bestShared) {
                best = other;
                bestShared = shared;
            }
        }
        return best;
    }

    /** Beside the primary when they share some height, left or right of it; otherwise above or below. */
    directionOf(room: Room): RoomDirection {
        const primary = this.primary;
        if (!primary || room === primary)
            return 'primary';
        const beside = room.monitor.y < primary.monitor.y + primary.monitor.height &&
            primary.monitor.y < room.monitor.y + room.monitor.height;
        const centre = centreOfRect(room.monitor);
        const primaryCentre = centreOfRect(primary.monitor);
        if (beside)
            return centre.x < primaryCentre.x ? 'left' : 'right';
        return centre.y < primaryCentre.y ? 'up' : 'down';
    }

    /** The room that way from the primary, the closest one if several are; null when there is none. */
    roomInDirection(direction: RoomDirection): Room | null {
        const primary = this.primary;
        if (!primary)
            return null;
        if (direction === 'primary')
            return primary;
        const primaryCentre = centreOfRect(primary.monitor);
        let closest: Room | null = null;
        let closestDistance = Number.POSITIVE_INFINITY;
        for (const room of this.rooms) {
            if (this.directionOf(room) !== direction)
                continue;
            const centre = centreOfRect(room.monitor);
            const distance = Math.hypot(centre.x - primaryCentre.x, centre.y - primaryCentre.y);
            if (distance < closestDistance) {
                closest = room;
                closestDistance = distance;
            }
        }
        return closest;
    }

    /** The room where crawling that way from `position`, room after room at her height, ends against a wall. */
    wallRoom(position: Point, side: Side): Room | null {
        let room = this.roomOf(position);
        let here = position;
        for (let crossed = 0; room && crossed < this.rooms.length; crossed++) {
            const crossing = this.cross(room, here, side);
            if (!crossing)
                return room;
            room = crossing.next;
            here = crossing.entry;
        }
        return room;
    }

    /**
     * The wall she hides or storms off by: the nearer side of her room
     * among those with nothing past them, or, in a room with neighbours
     * on both sides, the nearer wall of the whole home on her row.
     */
    nearestWall(position: Point): Side | null {
        const room = this.roomOf(position);
        if (!room)
            return null;
        const leftOpen = this.neighbourAcross(room, 'left', position.y, this.size) !== null;
        const rightOpen = this.neighbourAcross(room, 'right', position.y, this.size) !== null;
        if (leftOpen !== rightOpen)
            return leftOpen ? 'right' : 'left';
        if (!leftOpen) {
            const bounds = this.bounds(room);
            return position.x < (bounds.minX + bounds.maxX) / 2 ? 'left' : 'right';
        }
        const leftWall = this.wallRoom(position, 'left');
        const rightWall = this.wallRoom(position, 'right');
        if (!leftWall || !rightWall)
            return null;
        const toLeft = position.x - this.bounds(leftWall).minX;
        const toRight = this.bounds(rightWall).maxX - position.x;
        return toLeft <= toRight ? 'left' : 'right';
    }

    /**
     * The stops of a sideways crawl from `from` to `toX`: the edge of
     * each room she leaves and where she comes into the next, at her
     * height or clamped into a smaller room's, then `toX` itself. A wall
     * on the way stops her against it. Never empty.
     */
    crawlRoute(from: Point, toX: number): Point[] {
        let room = this.roomOf(from);
        if (!room)
            return [{x: toX, y: from.y}];
        const side: Side = toX > from.x ? 'right' : 'left';
        const stops: Point[] = [];
        let here = from;
        for (let crossed = 0; crossed < this.rooms.length; crossed++) {
            const bounds = this.bounds(room);
            const edge = side === 'right' ? bounds.maxX : bounds.minX;
            if (side === 'right' ? toX <= edge : toX >= edge)
                break;
            const crossing = this.cross(room, here, side);
            if (!crossing)
                break;
            stops.push(crossing.exit, crossing.entry);
            here = crossing.entry;
            room = crossing.next;
        }
        stops.push(this.clampInto({x: toX, y: here.y}, room));
        return withoutRepeats(from, stops);
    }

    /**
     * The stops of a trip from `from` to anywhere, off-screen included:
     * through the edges of the rooms in between when `to` is in a room
     * beside hers, straight there otherwise. Never empty.
     */
    travelRoute(from: Point, to: Point): Point[] {
        let room = this.roomOf(from);
        const target = this.roomOf(to);
        if (!room || !target)
            return [to];
        const stops: Point[] = [];
        let here = from;
        for (let crossed = 0; room !== target; crossed++) {
            const side = sideTowards(room, target);
            if (side === null || crossed >= this.rooms.length)
                return [to];
            const crossing = this.cross(room, here, side);
            if (!crossing)
                return [to];
            stops.push(crossing.exit, crossing.entry);
            here = crossing.entry;
            room = crossing.next;
        }
        stops.push(to);
        return withoutRepeats(from, stops);
    }

    /**
     * Where a stroll of hers from `from` ends, as an x: in her room two
     * times out of three, at least a quarter of it away; otherwise in
     * one of the rooms she can crawl to at her height. Null when there
     * is no room for a stroll. `random` is in [0, 1).
     */
    pickDestination(from: Point, random: () => number): number | null {
        const room = this.roomOf(from);
        if (!room)
            return null;
        if (random() >= STAY_CHANCE) {
            const others = this.roomsOnRow(from);
            const other = others[Math.floor(random() * others.length)];
            if (other) {
                const bounds = this.bounds(other);
                return Math.round(bounds.minX + random() * Math.max(0, bounds.maxX - bounds.minX));
            }
        }
        const bounds = this.bounds(room);
        const width = bounds.maxX - bounds.minX;
        if (width < this.size)
            return null;
        for (let attempt = 0; attempt < DESTINATION_TRIES; attempt++) {
            const candidate = bounds.minX + random() * width;
            if (Math.abs(candidate - from.x) >= width / 4)
                return Math.round(candidate);
        }
        return null;
    }

    /** The other rooms she can crawl into sideways from `from`, room after room. */
    private roomsOnRow(from: Point): Room[] {
        const start = this.roomOf(from);
        const found: Room[] = [];
        for (const side of ['left', 'right'] as const) {
            let room = start;
            let here = from;
            for (let crossed = 0; room && crossed < this.rooms.length; crossed++) {
                const crossing = this.cross(room, here, side);
                if (!crossing || crossing.next === start || found.includes(crossing.next))
                    break;
                found.push(crossing.next);
                room = crossing.next;
                here = crossing.entry;
            }
        }
        return found;
    }

    /** Leaving `room` by `side` from `here`, or null against a wall. Already past that edge, she exits where she is. */
    private cross(room: Room, here: Point, side: Side): Crossing | null {
        // Any of her body along the shared part of the edge is enough: the clamp into the next room does the rest.
        const next = this.neighbourAcross(room, side, here.y, this.size);
        if (!next)
            return null;
        const bounds = this.bounds(room);
        const edge = side === 'right' ? Math.max(here.x, bounds.maxX) : Math.min(here.x, bounds.minX);
        const nextBounds = this.bounds(next);
        const entry = this.clampInto({x: side === 'right' ? nextBounds.minX : nextBounds.maxX, y: here.y}, next);
        return {exit: {x: edge, y: here.y}, entry, next};
    }

    private centreOf(position: Point): Point {
        return {x: position.x + this.size / 2, y: position.y + this.size / 2};
    }
}

/** The side `target` lies on from `room`, or null when they are above or below each other. */
function sideTowards(room: Room, target: Room): Side | null {
    if (target.monitor.x >= room.monitor.x + room.monitor.width)
        return 'right';
    if (target.monitor.x + target.monitor.width <= room.monitor.x)
        return 'left';
    return null;
}

/** Stops that would not move her are dropped, but the last one stays: a trip always has somewhere to end. */
function withoutRepeats(from: Point, stops: readonly Point[]): Point[] {
    const kept: Point[] = [];
    let previous = from;
    stops.forEach((stop, index) => {
        const last = index === stops.length - 1;
        if (!last && stop.x === previous.x && stop.y === previous.y)
            return;
        kept.push(stop);
        previous = stop;
    });
    return kept;
}

function contains(rect: Rect, point: Point): boolean {
    return point.x >= rect.x && point.x < rect.x + rect.width && point.y >= rect.y && point.y < rect.y + rect.height;
}

/** Whether `rect` covers height `y`, or some of the heights from `y` to `y + extent`. */
function spans(rect: Rect, y: number, extent: number): boolean {
    if (extent <= 0)
        return y >= rect.y && y < rect.y + rect.height;
    return y < rect.y + rect.height && rect.y < y + extent;
}

function distanceTo(rect: Rect, point: Point): number {
    const dx = Math.max(rect.x - point.x, 0, point.x - (rect.x + rect.width));
    const dy = Math.max(rect.y - point.y, 0, point.y - (rect.y + rect.height));
    return Math.hypot(dx, dy);
}

function centreOfRect(rect: Rect): Point {
    return {x: rect.x + rect.width / 2, y: rect.y + rect.height / 2};
}

function clamp(value: number, min: number, max: number): number {
    return Math.min(max, Math.max(min, value));
}
