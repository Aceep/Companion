import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {pickGag, weekBilanDue} from '../src/memory.js';
import {dayKey, emptyCounts, type DayCounts, type StatsDays} from '../src/stats.js';

// A Friday in July, far from any clock change.
const TODAY = new Date(2026, 6, 31, 12);

function daysAgo(back: number): Date {
    return new Date(TODAY.getFullYear(), TODAY.getMonth(), TODAY.getDate() - back, 12);
}

function oneDay(back: number, values: Partial<DayCounts>): StatsDays {
    return new Map([[dayKey(daysAgo(back)), {...emptyCounts(), ...values}]]);
}

describe('pickGag', () => {
    it('ignores a day below its threshold', () => {
        assert.equal(pickGag(oneDay(2, {pipelines: 2}), TODAY), null);
    });

    it('brings up a day at its threshold', () => {
        assert.deepEqual(pickGag(oneDay(2, {pipelines: 3}), TODAY), {
            event: 'rappel_pipeline',
            values: {jour: 'mercredi', nombre: '3'},
        });
    });

    it('counts storms with sulks', () => {
        assert.equal(pickGag(oneDay(2, {sulks: 1, storms: 1}), TODAY)?.event, 'rappel_bouderie');
    });

    it('leaves today out', () => {
        assert.equal(pickGag(oneDay(0, {pipelines: 10}), TODAY), null);
    });

    it('leaves out the day eight days back', () => {
        assert.equal(pickGag(oneDay(8, {pipelines: 10}), TODAY), null);
    });

    it('names yesterday "hier"', () => {
        assert.equal(pickGag(oneDay(1, {focus: 3}), TODAY)?.values.jour, 'hier');
    });

    it('names the same weekday last week with "dernier"', () => {
        assert.equal(pickGag(oneDay(7, {focus: 3}), TODAY)?.values.jour, 'vendredi dernier');
    });

    it('prefers the fact furthest past its threshold', () => {
        const days: StatsDays = new Map([
            [dayKey(daysAgo(1)), {...emptyCounts(), pipelines: 3}],
            [dayKey(daysAgo(4)), {...emptyCounts(), commands: 9}],
        ]);
        assert.equal(pickGag(days, TODAY)?.event, 'rappel_commandes');
    });

    it('breaks a tie in favour of the more recent day', () => {
        const days: StatsDays = new Map([
            [dayKey(daysAgo(1)), {...emptyCounts(), pipelines: 3}],
            [dayKey(daysAgo(4)), {...emptyCounts(), focus: 3}],
        ]);
        assert.equal(pickGag(days, TODAY)?.event, 'rappel_pipeline');
    });
});

describe('weekBilanDue', () => {
    const fridayAtFive = new Date(2026, 6, 31, 17, 0);

    it('is due on Friday from 17:00', () => {
        assert.equal(weekBilanDue(fridayAtFive, '', true), true);
    });

    it('is not due on Friday before 17:00', () => {
        assert.equal(weekBilanDue(new Date(2026, 6, 31, 16, 59), '', true), false);
    });

    it('is not due on another day', () => {
        assert.equal(weekBilanDue(new Date(2026, 6, 30, 18, 0), '', true), false);
    });

    it('is not due twice the same day', () => {
        assert.equal(weekBilanDue(fridayAtFive, dayKey(fridayAtFive), true), false);
    });

    it('is not due with the recap off', () => {
        assert.equal(weekBilanDue(fridayAtFive, '', false), false);
    });
});
