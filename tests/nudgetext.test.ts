import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {NudgeLimiter, isNudgeKind, oneLine, ticketCount} from '../src/nudgetext.js';

describe('oneLine', () => {
    it('collapses whitespace runs, newlines and tabs included, and trims', () => {
        assert.equal(oneLine('  build\n\tfailed   twice  ', 60), 'build failed twice');
    });

    it('drops bidi overrides and isolates', () => {
        assert.equal(oneLine('abc‮def⁦ghi⁩⁧j⁨k', 60), 'abcdefghijk');
    });

    it('drops zero-width spaces', () => {
        assert.equal(oneLine('pi​pe​line', 60), 'pipeline');
    });

    it('keeps the zero-width joiner and variation selector of an emoji sequence', () => {
        assert.equal(oneLine('👩\u200D💻 ❤\uFE0F', 60), '👩\u200D💻 ❤\uFE0F');
    });

    it('drops escape, bell and delete characters', () => {
        assert.equal(oneLine('\u001B[31mred\u0007\u007F', 60), '[31mred');
    });

    it('does not leave a double space where an invisible character sat between spaces', () => {
        assert.equal(oneLine('a ​ b', 60), 'a b');
    });

    it('leaves text within the limit as is', () => {
        assert.equal(oneLine('exactly five', 12), 'exactly five');
    });

    it('cuts past the limit with an ellipsis, the ellipsis counted in', () => {
        assert.equal(oneLine('abcdefghij', 5), 'abcd…');
    });

    it('counts code points, not UTF-16 units', () => {
        assert.equal(oneLine('😀😀😀😀😀😀', 4), '😀😀😀…');
    });

    it('trims the end before the ellipsis', () => {
        assert.equal(oneLine('abc   defgh', 5), 'abc…');
    });

    it('counts the limit after invisible characters are dropped', () => {
        assert.equal(oneLine('​​​abc', 3), 'abc');
    });
});

describe('NudgeLimiter', () => {
    it('lets the first nudge of a kind through', () => {
        assert.equal(new NudgeLimiter().allow('info', 0), true);
    });

    it('drops a second nudge of the same kind within five seconds', () => {
        const limiter = new NudgeLimiter();
        limiter.allow('info', 0);
        assert.equal(limiter.allow('info', 4999), false);
    });

    it('lets the same kind through again after five seconds', () => {
        const limiter = new NudgeLimiter();
        limiter.allow('info', 0);
        assert.equal(limiter.allow('info', 5000), true);
    });

    it('keeps each kind on its own clock', () => {
        const limiter = new NudgeLimiter();
        limiter.allow('info', 0);
        assert.equal(limiter.allow('attention', 1), true);
    });

    it('does not restart the clock with a dropped nudge', () => {
        const limiter = new NudgeLimiter();
        limiter.allow('info', 0);
        limiter.allow('info', 3000);
        assert.equal(limiter.allow('info', 5000), true);
    });
});

describe('isNudgeKind', () => {
    it('accepts a known kind', () => {
        assert.equal(isNudgeKind('pipeline_echec'), true);
    });

    it('refuses an unknown kind', () => {
        assert.equal(isNudgeKind('pipeline'), false);
    });
});

describe('ticketCount', () => {
    it('reads a plain number, surrounding spaces aside', () => {
        assert.equal(ticketCount(' 12 '), 12);
    });

    it('is null for text with anything else than digits', () => {
        assert.equal(ticketCount('12 tickets'), null);
    });

    it('is null for a negative number', () => {
        assert.equal(ticketCount('-3'), null);
    });

    it('is null for empty text', () => {
        assert.equal(ticketCount(''), null);
    });
});
