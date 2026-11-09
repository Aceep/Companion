import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {dayKey, emptyCounts, parseStats, serializeStats, sumDays, type DayCounts, type StatsDays} from '../src/stats.js';

// A Friday in July, far from any clock change.
const TODAY = new Date(2026, 6, 31, 12);

function daysAgo(back: number): Date {
    return new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - back, 12);
}

function counts(values: Partial<DayCounts>): DayCounts {
    return {...emptyCounts(), ...values};
}

describe('dayKey', () => {
    it('pads month and day to two digits', () => {
        assert.equal(dayKey(new Date(2026, 0, 5)), '2026-01-05');
    });
});

describe('parseStats', () => {
    it('returns no days for JSON that does not parse', () => {
        assert.equal(parseStats('{"2026-07-31": {"clicks": 3').size, 0);
    });

    it('returns no days for a JSON array', () => {
        assert.equal(parseStats('[1, 2]').size, 0);
    });

    it('drops keys that are not dates', () => {
        const days = parseStats('{"yesterday": {"clicks": 1}, "2026-07-31": {"clicks": 2}}');
        assert.deepEqual([...days.keys()], ['2026-07-31']);
    });

    it('reads negative, non-numeric and missing counters as 0', () => {
        const days = parseStats('{"2026-07-31": {"clicks": -4, "errors": "7", "talks": null}}');
        assert.deepEqual(days.get('2026-07-31'), emptyCounts());
    });

    it('floors fractional counters', () => {
        const days = parseStats('{"2026-07-31": {"clicks": 2.9}}');
        assert.equal(days.get('2026-07-31')?.clicks, 2);
    });

    it('ignores unknown counters', () => {
        const days = parseStats('{"2026-07-31": {"bogus": 5, "drags": 1}}');
        assert.deepEqual(days.get('2026-07-31'), counts({drags: 1}));
    });
});

describe('serializeStats', () => {
    it('keeps the day 29 days back and drops the one 30 days back', () => {
        const days: StatsDays = new Map([
            [dayKey(daysAgo(30)), counts({clicks: 1})],
            [dayKey(daysAgo(29)), counts({clicks: 2})],
            [dayKey(TODAY), counts({clicks: 3})],
        ]);
        const kept = Object.keys(JSON.parse(serializeStats(days, TODAY)) as Record<string, unknown>);
        assert.deepEqual(kept, [dayKey(daysAgo(29)), dayKey(TODAY)]);
    });

    it('writes the days in date order', () => {
        const days: StatsDays = new Map([
            [dayKey(TODAY), counts({})],
            [dayKey(daysAgo(3)), counts({})],
        ]);
        const kept = Object.keys(JSON.parse(serializeStats(days, TODAY)) as Record<string, unknown>);
        assert.deepEqual(kept, [dayKey(daysAgo(3)), dayKey(TODAY)]);
    });

    it('round-trips through parseStats', () => {
        const days: StatsDays = new Map([[dayKey(TODAY), counts({errors: 4, focus: 1})]]);
        assert.deepEqual(parseStats(serializeStats(days, TODAY)), days);
    });
});

describe('sumDays', () => {
    it('adds up the days ending with today, today included', () => {
        const days: StatsDays = new Map([
            [dayKey(TODAY), counts({clicks: 1})],
            [dayKey(daysAgo(6)), counts({clicks: 2})],
            [dayKey(daysAgo(7)), counts({clicks: 4})],
        ]);
        assert.equal(sumDays(days, TODAY, 7).clicks, 3);
    });

    it('returns zeroes when no day is stored', () => {
        assert.deepEqual(sumDays(new Map(), TODAY, 30), emptyCounts());
    });
});
