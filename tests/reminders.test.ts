import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    LATE_AFTER_MS, MAX_NAGS, NAG_EVERY_MS, REMINDER_TEXT_MAX, ReminderCenter, parseReminder, parseReminders,
    type DeliveryKind, type ParsedReminder, type Reminder,
} from '../src/reminders.js';

const MINUTE = 60 * 1000;
const HOUR = 60 * MINUTE;
// A Monday, 14:00 local time.
const NOW = new Date(2026, 10, 9, 14, 0, 0, 0);

function parsedAt(result: ParsedReminder): {at: number; text: string} {
    assert.ok(result.ok, result.ok ? '' : result.reason);
    return {at: result.at.getTime(), text: result.text};
}

function localTime(dayOffset: number, hours: number, minutes = 0): number {
    return new Date(2026, 10, 9 + dayOffset, hours, minutes, 0, 0).getTime();
}

describe('parseReminder', () => {
    const cases: {input: string; at: number; text: string}[] = [
        {input: '15h30 appeler Paul', at: localTime(0, 15, 30), text: 'appeler Paul'},
        {input: '13h appeler Paul', at: localTime(1, 13), text: 'appeler Paul'},
        {input: '14h appeler Paul', at: localTime(1, 14), text: 'appeler Paul'},
        {input: 'demain 15h rendez-vous', at: localTime(1, 15), text: 'rendez-vous'},
        {input: 'demain à 9h15 rendez-vous', at: localTime(1, 9, 15), text: 'rendez-vous'},
        {input: '15:30 : appeler Paul', at: localTime(0, 15, 30), text: 'appeler Paul'},
        {input: 'à 15h - appeler Paul', at: localTime(0, 15), text: 'appeler Paul'},
        {input: 'midi déjeuner', at: localTime(1, 12), text: 'déjeuner'},
        {input: 'à minuit dormir', at: localTime(1, 0), text: 'dormir'},
        {input: 'demain midi déjeuner', at: localTime(1, 12), text: 'déjeuner'},
        {input: 'dans 20 min sortir le pain', at: NOW.getTime() + 20 * MINUTE, text: 'sortir le pain'},
        {input: 'dans 1h30 pause', at: NOW.getTime() + 90 * MINUTE, text: 'pause'},
        {input: 'dans 1h 15 min pause', at: NOW.getTime() + 75 * MINUTE, text: 'pause'},
        {input: 'dans 2 heures pause', at: NOW.getTime() + 2 * HOUR, text: 'pause'},
        {input: 'dans 1h 2 courses', at: NOW.getTime() + HOUR, text: '2 courses'},
        {input: 'dans 48h fin', at: NOW.getTime() + 48 * HOUR, text: 'fin'},
    ];
    for (const {input, at, text} of cases) {
        it(`reads "${input}"`, () => {
            assert.deepEqual(parsedAt(parseReminder(input, NOW)), {at, text});
        });
    }

    const refused = ['24h trop tard', '15h75 trop tard', 'dans 1h75 trop tard', 'dans 0 min rien', 'dans 49h trop loin',
        '15h30', 'demain rendez-vous', 'appeler Paul', ''];
    for (const input of refused) {
        it(`refuses "${input}"`, () => {
            assert.equal(parseReminder(input, NOW).ok, false);
        });
    }

    it('cuts a long text to the stored maximum', () => {
        const {text} = parsedAt(parseReminder(`15h30 ${'a'.repeat(300)}`, NOW));
        assert.equal([...text].length, REMINDER_TEXT_MAX);
    });

    it('puts the text on one line', () => {
        assert.equal(parsedAt(parseReminder('15h30 appeler\nPaul', NOW)).text, 'appeler Paul');
    });
});

describe('parseReminders', () => {
    it('gives a repeated id a suffix instead of dropping the reminder', () => {
        const json = JSON.stringify([{id: 'a', at: 1, text: 'un'}, {id: 'a', at: 2, text: 'deux'}]);
        assert.deepEqual(parseReminders(json).map(reminder => reminder.id), ['a', 'a-2']);
    });

    it('drops an entry without text', () => {
        assert.deepEqual(parseReminders(JSON.stringify([{id: 'a', at: 1, text: ''}])), []);
    });

    it('reads unreadable JSON as no reminder', () => {
        assert.deepEqual(parseReminders('{'), []);
    });
});

interface Harness {
    center: ReminderCenter;
    deliveries: {text: string; kind: DeliveryKind}[];
    ignored: string[];
    stored: () => string;
    advance: (ms: number) => void;
    setCanDeliver: (value: boolean) => void;
}

function harness(options: {stored?: string; newId?: () => string} = {}): Harness {
    let now = NOW.getTime();
    let canDeliver = true;
    let stored = options.stored ?? '[]';
    const deliveries: {text: string; kind: DeliveryKind}[] = [];
    const ignored: string[] = [];
    const center = new ReminderCenter({
        read: () => stored,
        write: json => {
            stored = json;
        },
        // Ticks are driven by hand.
        schedule: () => () => {},
        now: () => now,
        newId: options.newId,
        canDeliver: () => canDeliver,
        deliver: (reminder: Reminder, kind) => deliveries.push({text: reminder.text, kind}),
        ignored: reminder => ignored.push(reminder.text),
        changed: () => {},
    });
    center.start();
    return {
        center,
        deliveries,
        ignored,
        stored: () => stored,
        advance: ms => {
            now += ms;
        },
        setCanDeliver: value => {
            canDeliver = value;
        },
    };
}

function inMinutes(minutes: number): Date {
    return new Date(NOW.getTime() + minutes * MINUTE);
}

describe('ReminderCenter', () => {
    it('does not deliver a reminder before its time', () => {
        const {center, deliveries, advance} = harness();
        center.add(inMinutes(10), 'pain');
        advance(9 * MINUTE);
        center.tick();
        assert.deepEqual(deliveries, []);
    });

    it('delivers a reminder at its time as a first delivery', () => {
        const {center, deliveries, advance} = harness();
        center.add(inMinutes(10), 'pain');
        advance(10 * MINUTE);
        center.tick();
        assert.deepEqual(deliveries, [{text: 'pain', kind: 'first'}]);
    });

    it('delivers a reminder found overdue as a late one', () => {
        const {center, deliveries, advance} = harness();
        center.add(inMinutes(10), 'pain');
        advance(10 * MINUTE + LATE_AFTER_MS + 1);
        center.tick();
        assert.deepEqual(deliveries, [{text: 'pain', kind: 'late'}]);
    });

    it('nags three times, then drops the reminder', () => {
        const {center, deliveries, ignored, advance} = harness();
        center.add(inMinutes(1), 'pain');
        advance(MINUTE);
        center.tick();
        for (let nag = 0; nag <= MAX_NAGS; nag++) {
            advance(NAG_EVERY_MS);
            center.tick();
        }
        assert.deepEqual(deliveries.map(delivery => delivery.kind), ['first', 'nag', 'nag', 'nag']);
        assert.equal(ignored.length, MAX_NAGS + 1);
        assert.deepEqual(center.list(), []);
        assert.equal(center.isShowing, false);
    });

    it('does not nag before the nag delay', () => {
        const {center, deliveries, advance} = harness();
        center.add(inMinutes(1), 'pain');
        advance(MINUTE);
        center.tick();
        advance(NAG_EVERY_MS - 1);
        center.tick();
        assert.equal(deliveries.length, 1);
    });

    it('removes the shown reminder when acknowledged', () => {
        const {center, advance} = harness();
        center.add(inMinutes(1), 'pain');
        advance(MINUTE);
        center.tick();
        assert.equal(center.acknowledge(), true);
        assert.deepEqual(center.list(), []);
        assert.equal(center.isShowing, false);
    });

    it('has nothing to acknowledge when nothing is shown', () => {
        const {center} = harness();
        center.add(inMinutes(1), 'pain');
        assert.equal(center.acknowledge(), false);
        assert.equal(center.list().length, 1);
    });

    it('waits while she cannot deliver, then delivers', () => {
        const {center, deliveries, advance, setCanDeliver} = harness();
        center.add(inMinutes(1), 'pain');
        setCanDeliver(false);
        advance(MINUTE);
        center.tick();
        assert.deepEqual(deliveries, []);
        setCanDeliver(true);
        advance(MINUTE);
        center.tick();
        assert.deepEqual(deliveries, [{text: 'pain', kind: 'first'}]);
    });

    it('holds a second due reminder until the first is acknowledged', () => {
        const {center, deliveries, advance} = harness();
        center.add(inMinutes(1), 'pain');
        center.add(inMinutes(1), 'linge');
        advance(MINUTE);
        center.tick();
        center.tick();
        assert.deepEqual(deliveries.map(delivery => delivery.text), ['pain']);
        center.acknowledge();
        center.tick();
        assert.deepEqual(deliveries.map(delivery => delivery.text), ['pain', 'linge']);
    });

    it('acknowledges only the shown reminder of two due together', () => {
        const {center, advance} = harness();
        center.add(inMinutes(1), 'pain');
        center.add(inMinutes(1), 'linge');
        advance(MINUTE);
        center.tick();
        center.acknowledge();
        assert.deepEqual(center.list().map(reminder => reminder.text), ['linge']);
    });

    it('stores the text cut to the maximum', () => {
        const {center} = harness();
        const added = center.add(inMinutes(1), 'a'.repeat(300));
        assert.ok(added.ok);
        assert.equal([...added.reminder.text].length, REMINDER_TEXT_MAX);
    });

    it('gives distinct ids to reminders added by two sessions at the same time', () => {
        const first = harness({newId: () => 'same'});
        first.center.add(inMinutes(5), 'pain');
        const second = harness({stored: first.stored(), newId: () => 'same'});
        second.center.add(inMinutes(5), 'linge');
        const ids = second.center.list().map(reminder => reminder.id);
        assert.equal(new Set(ids).size, 2);
    });

    it('cancels only the reminder whose id is given', () => {
        const first = harness({newId: () => 'same'});
        first.center.add(inMinutes(5), 'pain');
        const second = harness({stored: first.stored(), newId: () => 'same'});
        const added = second.center.add(inMinutes(5), 'linge');
        assert.ok(added.ok);
        second.center.cancel(added.reminder.id);
        assert.deepEqual(second.center.list().map(reminder => reminder.text), ['pain']);
    });

    it('makes distinct default ids in two instances', () => {
        const first = harness();
        const second = harness();
        const one = first.center.add(inMinutes(5), 'pain');
        const other = second.center.add(inMinutes(5), 'pain');
        assert.ok(one.ok && other.ok);
        assert.notEqual(one.reminder.id, other.reminder.id);
    });
});
