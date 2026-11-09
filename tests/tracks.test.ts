import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {TITLE_MAX_LENGTH, TrackGate, titleOf, truncateTitle} from '../src/tracks.js';

const MINUTE = 60 * 1000;

describe('truncateTitle', () => {
    it('leaves a short title as is', () => {
        assert.equal(truncateTitle('Clair de lune'), 'Clair de lune');
    });

    it('cuts a long title to the limit with an ellipsis', () => {
        const cut = truncateTitle('a'.repeat(40));
        assert.equal([...cut].length, TITLE_MAX_LENGTH);
        assert.ok(cut.endsWith('…'));
    });

    it('does not split an emoji at the cut', () => {
        // The emoji is the 29th code point: the last one kept before the ellipsis.
        const title = `${'a'.repeat(TITLE_MAX_LENGTH - 2)}🎵${'b'.repeat(10)}`;
        assert.equal(truncateTitle(title), `${'a'.repeat(TITLE_MAX_LENGTH - 2)}🎵…`);
    });

    it('drops bidi overrides from a title', () => {
        assert.equal(truncateTitle('Song‮'), 'Song');
    });
});

describe('titleOf', () => {
    it('keeps the title of "Titre — Artiste"', () => {
        assert.equal(titleOf('Clair de lune — Debussy'), 'Clair de lune');
    });

    it('keeps the whole text when there is no artist', () => {
        assert.equal(titleOf('  Clair de lune '), 'Clair de lune');
    });
});

describe('TrackGate', () => {
    it('remarks on the same track only once within ten minutes, whichever source tells', () => {
        const gate = new TrackGate(() => false);
        gate.localTrack('Clair de lune', 0);
        assert.equal(gate.remoteTrack('clair  de LUNE — Debussy', MINUTE), null);
    });

    it('remarks on the same track again after ten minutes', () => {
        const gate = new TrackGate(() => false);
        gate.localTrack('Clair de lune', 0);
        assert.equal(gate.remoteTrack('Clair de lune — Debussy', 10 * MINUTE), 'Clair de lune');
    });

    it('ignores the daemon while a local player plays', () => {
        const gate = new TrackGate(() => true);
        assert.equal(gate.remoteTrack('Clair de lune — Debussy', 0), null);
    });

    it('counts two ends of music within two minutes as one silence', () => {
        const gate = new TrackGate(() => false);
        gate.localSilence(0);
        assert.equal(gate.remoteSilence(MINUTE), false);
    });
});
