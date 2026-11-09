import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {EDGE_MARGIN, House, isRoomDirection, type Room} from '../src/monitors.js';

const SIZE = 100;

/** A monitor with a 32-pixel top bar on the primary, none elsewhere. */
function room(index: number, x: number, y: number, width: number, height: number, topBar = 0): Room {
    return {
        index,
        monitor: {x, y, width, height},
        area: {x, y: y + topBar, width, height: height - topBar},
    };
}

const PRIMARY = room(0, 0, 0, 1920, 1080, 32);
/** Smaller, beside the primary, tops aligned. */
const SMALL_RIGHT = room(1, 1920, 0, 1280, 720);
/** Beside the primary but lower: they share heights 600 to 1080 only. */
const LOW_RIGHT = room(1, 1920, 600, 1280, 1024);
const ABOVE = room(1, 0, -1080, 1920, 1080);
const LEFT = room(2, -1920, 0, 1920, 1080);

/** Plays back `values` one call at a time, then 0. */
function sequence(...values: number[]): () => number {
    let next = 0;
    return () => values[next++] ?? 0;
}

describe('House.roomAt', () => {
    it('finds the room whose monitor holds the point', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.roomAt({x: 2500, y: 300})?.index, 1);
    });

    it('finds no room in the gap beside a lower monitor', () => {
        const house = new House([PRIMARY, LOW_RIGHT], 0, SIZE);
        assert.equal(house.roomAt({x: 2500, y: 300}), null);
    });
});

describe('House.nearestRoom', () => {
    it('gives the closest room for a point past every monitor', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.nearestRoom({x: 3300, y: 200})?.index, 1);
    });
});

describe('House.neighbourAcross', () => {
    it('finds the monitor beside at a height both share', () => {
        const house = new House([PRIMARY, LOW_RIGHT], 0, SIZE);
        assert.equal(house.neighbourAcross(PRIMARY, 'right', 900)?.index, 1);
    });

    it('finds nothing at a height only one of them has', () => {
        const house = new House([PRIMARY, LOW_RIGHT], 0, SIZE);
        assert.equal(house.neighbourAcross(PRIMARY, 'right', 300), null);
    });

    it('finds the monitor beside when only the bottom of her frame is along the shared edge', () => {
        const house = new House([PRIMARY, LOW_RIGHT], 0, SIZE);
        assert.equal(house.neighbourAcross(PRIMARY, 'right', 550, SIZE)?.index, 1);
    });

    it('finds nothing on a side with no monitor', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.neighbourAcross(PRIMARY, 'left', 500), null);
    });

    it('finds no neighbour anywhere in a single-monitor home', () => {
        const house = new House([PRIMARY], 0, SIZE);
        const neighbours = [0, 500, 1079].flatMap(y => [
            house.neighbourAcross(PRIMARY, 'left', y),
            house.neighbourAcross(PRIMARY, 'right', y),
        ]);
        assert.deepEqual(neighbours, [null, null, null, null, null, null]);
    });
});

describe('House.directionOf', () => {
    it('calls the primary itself primary', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.directionOf(PRIMARY), 'primary');
    });

    it('calls a monitor beside the primary right, even a lower one', () => {
        const house = new House([PRIMARY, LOW_RIGHT], 0, SIZE);
        assert.equal(house.directionOf(LOW_RIGHT), 'right');
    });

    it('calls a monitor above the primary up', () => {
        const house = new House([PRIMARY, ABOVE], 0, SIZE);
        assert.equal(house.directionOf(ABOVE), 'up');
    });
});

describe('House.roomInDirection', () => {
    it('finds the monitor that way from the primary', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.roomInDirection('right')?.index, 1);
    });

    it('finds nothing when no monitor is that way', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.roomInDirection('left'), null);
    });
});

describe('House.clampInto', () => {
    it('brings a height the smaller monitor lacks down to its bottom', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.deepEqual(house.clampInto({x: 2500, y: 900}, SMALL_RIGHT), {x: 2500, y: 720 - SIZE});
    });
});

describe('House.crawlRoute', () => {
    it('stops at the edge, drops to the smaller room at the entry, then goes on', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.deepEqual(house.crawlRoute({x: 1000, y: 650}, 2500), [
            {x: 1920 - SIZE - EDGE_MARGIN, y: 650},
            {x: 1920 + EDGE_MARGIN, y: 720 - SIZE},
            {x: 2500, y: 720 - SIZE},
        ]);
    });

    it('stops against the edge where it touches nothing at her height', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.deepEqual(house.crawlRoute({x: 1000, y: 900}, 2500), [{x: 1920 - SIZE - EDGE_MARGIN, y: 900}]);
    });

    it('stops against a wall', () => {
        const house = new House([PRIMARY], 0, SIZE);
        assert.deepEqual(house.crawlRoute({x: 1000, y: 900}, 5000), [{x: 1920 - SIZE - EDGE_MARGIN, y: 900}]);
    });

    it('goes straight there inside one room', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.deepEqual(house.crawlRoute({x: 1000, y: 900}, 400), [{x: 400, y: 900}]);
    });
});

describe('House.travelRoute', () => {
    it('goes straight to a room above', () => {
        const house = new House([PRIMARY, ABOVE], 0, SIZE);
        assert.deepEqual(house.travelRoute({x: 1000, y: 900}, {x: 500, y: -500}), [{x: 500, y: -500}]);
    });

    it('crosses the edge to a room beside', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.deepEqual(house.travelRoute({x: 1000, y: 300}, {x: 2500, y: 100}), [
            {x: 1920 - SIZE - EDGE_MARGIN, y: 300},
            {x: 1920 + EDGE_MARGIN, y: 300},
            {x: 2500, y: 100},
        ]);
    });
});

describe('House.pickDestination', () => {
    it('stays in her room when the draw falls in the first two thirds', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.pickDestination({x: 1700, y: 300}, sequence(0.5, 0.1)), Math.round(EDGE_MARGIN + 0.1 * (1920 - SIZE - 2 * EDGE_MARGIN)));
    });

    it('goes to the room next door when the draw falls in the last third', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        const minX = 1920 + EDGE_MARGIN;
        const maxX = 1920 + 1280 - SIZE - EDGE_MARGIN;
        assert.equal(house.pickDestination({x: 1700, y: 300}, sequence(0.9, 0, 0.5)), Math.round(minX + 0.5 * (maxX - minX)));
    });

    it('never picks a room above by herself', () => {
        const house = new House([PRIMARY, ABOVE], 0, SIZE);
        const destination = house.pickDestination({x: 1700, y: 900}, sequence(0.9, 0, 0.1));
        assert.ok(destination !== null && destination <= 1920 - SIZE - EDGE_MARGIN);
    });
});

describe('House.nearestWall', () => {
    it('picks the outer edge of a room with a neighbour on one side, however close the other', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.nearestWall({x: 1790, y: 300}), 'left');
    });

    it('picks the nearer wall of the whole row from a middle room', () => {
        const house = new House([LEFT, PRIMARY, room(1, 1920, 0, 1920, 1080)], 0, SIZE);
        assert.equal(house.nearestWall({x: 1700, y: 300}), 'right');
    });
});

describe('House.wallRoom', () => {
    it('ends in the last room on that side', () => {
        const house = new House([PRIMARY, SMALL_RIGHT], 0, SIZE);
        assert.equal(house.wallRoom({x: 1000, y: 300}, 'right')?.index, 1);
    });
});

describe('isRoomDirection', () => {
    it('refuses a value outside the five', () => {
        assert.equal(isRoomDirection('diagonal'), false);
    });
});
