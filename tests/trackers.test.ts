import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    ContinuousActivity,
    ErrorHistory,
    LongTasks,
    NotificationTally,
    RollingCount,
    errorKey,
    isPastBedtime,
} from '../src/trackers.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;

describe('NotificationTally', () => {
    it('stays quiet up to the ninth notification of the hour', () => {
        const tally = new NotificationTally();
        const alerts = Array.from({length: 9}, (_, index) => tally.add(index * SECOND));
        assert.deepEqual(alerts.filter(Boolean), []);
    });

    it('alerts on the tenth notification of the hour', () => {
        const tally = new NotificationTally();
        for (let index = 0; index < 9; index++)
            tally.add(index * SECOND);
        assert.equal(tally.add(9 * SECOND), true);
    });

    it('alerts again on the twentieth, not the eleventh', () => {
        const tally = new NotificationTally();
        const alerts = Array.from({length: 20}, (_, index) => tally.add(index * SECOND));
        assert.deepEqual(alerts.flatMap((alert, index) => alert ? [index + 1] : []), [10, 20]);
    });

    it('forgets notifications older than an hour', () => {
        const tally = new NotificationTally();
        tally.add(0);
        tally.add(HOUR);
        assert.equal(tally.count, 1);
    });
});

describe('LongTasks', () => {
    it('reports a busy title that lasted two minutes once it stops', () => {
        const tasks = new LongTasks();
        tasks.update(1, true, 0);
        assert.equal(tasks.update(1, false, 2 * MINUTE), true);
    });

    it('does not report a busy title shorter than two minutes', () => {
        const tasks = new LongTasks();
        tasks.update(1, true, 0);
        assert.equal(tasks.update(1, false, 2 * MINUTE - 1), false);
    });

    it('keeps each window apart', () => {
        const tasks = new LongTasks();
        tasks.update(1, true, 0);
        assert.equal(tasks.update(2, false, 5 * MINUTE), false);
    });

    it('does not report a forgotten task', () => {
        const tasks = new LongTasks();
        tasks.update(1, true, 0);
        tasks.forget(1);
        assert.equal(tasks.update(1, false, 5 * MINUTE), false);
    });

    it('counts down to impatience from the start of the wait', () => {
        const tasks = new LongTasks();
        tasks.wait(1, true, 0);
        tasks.wait(1, true, 10 * SECOND);
        assert.equal(tasks.impatienceIn(1, 10 * SECOND), 20 * SECOND);
    });

    it('has no impatience for a window that stopped waiting', () => {
        const tasks = new LongTasks();
        tasks.wait(1, true, 0);
        tasks.wait(1, false, SECOND);
        assert.equal(tasks.impatienceIn(1, SECOND), null);
    });
});

describe('RollingCount', () => {
    it('drops events once they are as old as the window', () => {
        const count = new RollingCount(MINUTE);
        count.add(0);
        count.add(30 * SECOND);
        assert.equal(count.count(MINUTE), 1);
    });
});

describe('ErrorHistory', () => {
    it('counts the same error apart from the others', () => {
        const history = new ErrorHistory();
        history.add(errorKey(1, 'make: failed'), 0);
        history.add(errorKey(1, 'make: failed'), SECOND);
        history.add(errorKey(2, 'make: failed'), 2 * SECOND);
        history.add(null, 3 * SECOND);
        assert.equal(history.countOf(errorKey(1, 'make: failed'), 3 * SECOND), 2);
        assert.equal(history.count(3 * SECOND), 4);
    });

    it('starts the streak over after clearStreak', () => {
        const history = new ErrorHistory();
        history.add(null, 0);
        history.clearStreak();
        assert.equal(history.count(SECOND), 0);
    });
});

describe('ContinuousActivity', () => {
    it('is due once the stretch reaches the limit', () => {
        const activity = new ContinuousActivity();
        activity.isDue(0, 0, 50 * MINUTE);
        assert.equal(activity.isDue(0, 50 * MINUTE, 50 * MINUTE), true);
    });

    it('starts over after three idle minutes', () => {
        const activity = new ContinuousActivity();
        activity.isDue(0, 0, 50 * MINUTE);
        activity.isDue(3 * MINUTE, 40 * MINUTE, 50 * MINUTE);
        assert.equal(activity.isDue(0, 50 * MINUTE, 50 * MINUTE), false);
    });

    it('is never due with a limit of 0', () => {
        const activity = new ContinuousActivity();
        activity.isDue(0, 0, 0);
        assert.equal(activity.isDue(0, 10 * HOUR, 0), false);
    });
});

describe('isPastBedtime', () => {
    it('is past a 20:00 bedtime at 1 a.m.', () => {
        assert.equal(isPastBedtime(new Date(2026, 6, 31, 1), 20), true);
    });

    it('is not past a 20:00 bedtime at 6 a.m.', () => {
        assert.equal(isPastBedtime(new Date(2026, 6, 31, 6), 20), false);
    });

    it('is never past a bedtime of 0', () => {
        assert.equal(isPastBedtime(new Date(2026, 6, 31, 23), 0), false);
    });

    it('handles a bedtime after midnight', () => {
        assert.equal(isPastBedtime(new Date(2026, 6, 31, 23), 2), false);
        assert.equal(isPastBedtime(new Date(2026, 6, 31, 3), 2), true);
    });
});
