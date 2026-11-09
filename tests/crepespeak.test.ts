import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {crepify, drawOut, shouldCrepify} from '../src/crepespeak.js';

/** Never under the one-in-three odds: no word is drawn out. */
const PLAIN = (): number => 0.99;
/** Always under them: every word that may be drawn out is. */
const DRAWN_OUT = (): number => 0;

describe('crepify', () => {
    it('turns every word into a crêpe, the comma and full stop kept', () => {
        assert.equal(crepify('Je bosse, là.', [], PLAIN), 'Crêpe crêpe, crêpe.');
    });

    it('keeps the spaces before a question mark', () => {
        assert.equal(crepify('Ça peut attendre, non ?', [], PLAIN), 'Crêpe crêpe crêpe, crêpe ?');
    });

    it('gives a capital to a word that starts with one', () => {
        assert.equal(crepify('bonjour Paris', [], PLAIN), 'crêpe Crêpe');
    });

    it('shouts an all-caps word', () => {
        assert.equal(crepify('Tu vois ÇA ?', [], PLAIN), 'Crêpe crêpe CRÊPE ?');
    });

    it('takes a lone capital letter for a capital, not for shouting', () => {
        assert.equal(crepify('À toi.', [], PLAIN), 'Crêpe crêpe.');
    });

    it('draws out every word of an exclamation when the odds say so', () => {
        assert.equal(crepify('Ah non !', [], DRAWN_OUT), 'Crêêêpe crêêêpe !');
    });

    it('draws out a long word when the odds say so', () => {
        assert.equal(crepify('Vraiment pas.', [], DRAWN_OUT), 'Crêêêpe crêpe.');
    });

    it('shouts a drawn-out word in all caps', () => {
        assert.equal(crepify('NON !', [], DRAWN_OUT), 'CRÊÊÊPE !');
    });

    it('draws out only the words of the sentence that exclaims', () => {
        assert.equal(crepify('Bon. Ah !', [], DRAWN_OUT), 'Crêpe. Crêêêpe !');
    });

    it('keeps a word with an apostrophe or a hyphen as one crêpe', () => {
        assert.equal(crepify("C'est peut-être.", [], PLAIN), 'Crêpe crêpe.');
    });

    it('leaves a kept value untouched', () => {
        assert.equal(crepify('Pipeline cassé sur mon-projet.', ['mon-projet'], PLAIN), 'Crêpe crêpe crêpe mon-projet.');
    });

    it('leaves a kept value of several words untouched', () => {
        assert.equal(crepify('Ça joue Les Choses de la vie.', ['Les Choses de la vie'], PLAIN), 'Crêpe crêpe Les Choses de la vie.');
    });

    it('keeps numbers that are not in the kept values', () => {
        assert.equal(crepify('Batterie à 92 %, il est 14:30.', [], PLAIN), 'Crêpe crêpe 92 %, crêpe crêpe 14:30.');
    });

    it('keeps an ellipsis', () => {
        assert.equal(crepify('Bon… on verra.', [], PLAIN), 'Crêpe… crêpe crêpe.');
    });

    it('leaves a sentence that is only a kept value as it is', () => {
        assert.equal(crepify('Déploiement fini', ['Déploiement fini'], PLAIN), 'Déploiement fini');
    });

    it('does not count an exclamation inside a kept value', () => {
        assert.equal(crepify('Reçu : Build cassé ! Bon.', ['Build cassé !'], DRAWN_OUT), 'Crêpe : Build cassé ! Crêpe.');
    });

    it('returns an empty string for an empty one', () => {
        assert.equal(crepify('', [], PLAIN), '');
    });
});

describe('shouldCrepify', () => {
    it('never says a line in Crêpe at 0 %', () => {
        assert.equal(shouldCrepify(0, () => 0), false);
    });

    it('always says a line in Crêpe at 100 %', () => {
        assert.equal(shouldCrepify(100, () => 0.999), true);
    });

    it('says a line in Crêpe when the draw falls under the share', () => {
        assert.equal(shouldCrepify(70, () => 0.69), true);
    });

    it('says a line in clear when the draw falls at or over the share', () => {
        assert.equal(shouldCrepify(70, () => 0.7), false);
    });
});

describe('crepify with another word', () => {
    it('says the pack\'s word instead, with the same capitals', () => {
        assert.equal(crepify('Je bosse, là.', [], PLAIN, 'poireau'), 'Poireau poireau, poireau.');
        assert.equal(crepify('NON !', [], PLAIN, 'poireau'), 'POIREAU !');
    });

    it('draws the first vowel out', () => {
        assert.equal(drawOut('crêpe'), 'crêêêpe');
        assert.equal(drawOut('poireau'), 'poooireau');
        assert.equal(drawOut('brrr'), 'brrr');
        assert.equal(crepify('Ah non !', [], DRAWN_OUT, 'poireau'), 'Poooireau poooireau !');
    });
});
