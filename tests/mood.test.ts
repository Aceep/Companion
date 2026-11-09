import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Annoyance} from '../src/mood.js';

const SECOND = 1000;

function annoyanceAt(start = 0): {mood: Annoyance; advance: (ms: number) => void} {
    let now = start;
    return {mood: new Annoyance(() => now), advance: ms => { now += ms; }};
}

function pokeTimes(mood: Annoyance, count: number): void {
    for (let index = 0; index < count; index++)
        mood.poke('click');
}

describe('Annoyance', () => {
    it('is annoyed from 4 points', () => {
        const {mood} = annoyanceAt();
        pokeTimes(mood, 3);
        assert.equal(mood.level, 'calm');
        mood.poke('click');
        assert.equal(mood.level, 'annoyed');
    });

    it('counts a drag double', () => {
        const {mood} = annoyanceAt();
        mood.poke('drag');
        assert.equal(mood.score, 2);
    });

    it('becomes angry and starts sulking at 8 points, once', () => {
        const {mood} = annoyanceAt();
        pokeTimes(mood, 7);
        const tipping = mood.poke('click');
        const next = mood.poke('click');
        assert.equal(tipping.becameAngry, true);
        assert.equal(next.becameAngry, false);
        assert.equal(mood.isSulking, true);
    });

    it('forgives one point every 20 seconds', () => {
        const {mood, advance} = annoyanceAt();
        pokeTimes(mood, 5);
        advance(40 * SECOND);
        assert.equal(mood.score, 3);
    });

    it('stops sulking after a minute and a half', () => {
        const {mood, advance} = annoyanceAt();
        pokeTimes(mood, 8);
        advance(90 * SECOND);
        assert.equal(mood.isSulking, false);
    });

    it('never storms off without a sulk first, even at the cap', () => {
        const {mood} = annoyanceAt();
        mood.poke('drag');
        mood.poke('drag');
        mood.poke('drag');
        const result = mood.poke('drag');
        assert.equal(result.becameFurious, false);
        assert.equal(result.level, 'angry');
    });

    it('storms off when pestered to the cap mid-sulk', () => {
        const {mood} = annoyanceAt();
        pokeTimes(mood, 8);
        pokeTimes(mood, 3);
        const result = mood.poke('click');
        assert.equal(result.becameFurious, true);
        assert.equal(mood.level, 'furious');
    });

    it('comes back angry and still sulking for at least a minute', () => {
        const {mood, advance} = annoyanceAt();
        pokeTimes(mood, 12);
        mood.cameBack();
        assert.equal(mood.level, 'angry');
        advance(60 * SECOND - 1);
        assert.equal(mood.isSulking, true);
    });

    it('never tips into anger by irritation alone', () => {
        const {mood} = annoyanceAt();
        for (let index = 0; index < 20; index++)
            mood.irritate();
        assert.equal(mood.score, 7);
        assert.equal(mood.isSulking, false);
    });
});
