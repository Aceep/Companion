import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {
    BODY_BOX, EYE_DIRECTIONS, KNOWN_ANIMATIONS, MENACE_GROUP, PACK_FRAME_SIZE, parseManifest, pixelsOutsideBody,
    reviewAnimations,
} from '../src/pack.js';

/** Every animation Crêpe ships. */
const CREPE_ANIMATIONS = [
    'respiration', 'soupir', 'endormie', 'baillement', 'regard_droite', 'regard_gauche', 'pouce', 'facepalm',
    'sursaut', 'coucou', 'menace', 'marche_droite', 'marche_gauche', 'attente', 'clignement', 'applaudissement',
    'tapote', 'chut', 'pointer', 'gratter', 'menace_tenue', 'menace_clignement', 'menace_rangee',
    ...EYE_DIRECTIONS.map(direction => `yeux_${direction}`),
    ...EYE_DIRECTIONS.map(direction => `menace_yeux_${direction}`),
];

const MINIMAL = ['attente', 'clignement', 'marche_droite'];

describe('parseManifest', () => {
    it('reads the name, the word and the optional fields', () => {
        const manifest = parseManifest('poireau', {nom: 'Poireau', mot: 'poireau', auteur: ' Léa ', description: ''});
        assert.deepEqual(manifest, {id: 'poireau', name: 'Poireau', word: 'poireau', author: 'Léa', description: null});
    });

    it('refuses a folder name with a path or capitals in it', () => {
        assert.throws(() => parseManifest('Mon Pack', {nom: 'x', mot: 'x'}), /pack folder/);
        assert.throws(() => parseManifest('../x', {nom: 'x', mot: 'x'}), /pack folder/);
    });

    it('needs a non-empty name', () => {
        assert.throws(() => parseManifest('p', {mot: 'poireau'}), /"nom"/);
        assert.throws(() => parseManifest('p', {nom: '  ', mot: 'poireau'}), /"nom"/);
    });

    it('needs one lowercase word, accents allowed', () => {
        assert.equal(parseManifest('p', {nom: 'Crêpe', mot: 'crêpe'}).word, 'crêpe');
        assert.throws(() => parseManifest('p', {nom: 'x', mot: 'Poireau'}), /"mot"/);
        assert.throws(() => parseManifest('p', {nom: 'x', mot: 'deux mots'}), /"mot"/);
        assert.throws(() => parseManifest('p', {nom: 'x', mot: ''}), /"mot"/);
    });

    it('refuses anything that is not an object', () => {
        assert.throws(() => parseManifest('p', null), /expected an object/);
        assert.throws(() => parseManifest('p', []), /expected an object/);
    });
});

describe('reviewAnimations', () => {
    it('has nothing to say about Crêpe', () => {
        const review = reviewAnimations(CREPE_ANIMATIONS);
        assert.deepEqual(review.notes, []);
        assert.deepEqual(review.missing, []);
        assert.deepEqual(review.dropped, []);
        assert.deepEqual(review.unknown, []);
        assert.equal(review.substitutes.size, 0);
        assert.equal(review.mirrored.size, 0);
    });

    it('knows every animation Crêpe ships, and nothing else', () => {
        assert.deepEqual([...KNOWN_ANIMATIONS].sort(), [...CREPE_ANIMATIONS].sort());
    });

    it('refuses a pack without the resting pose, the blink or a walk', () => {
        assert.throws(() => reviewAnimations(['attente', 'clignement']), /"marche_droite"/);
        assert.throws(() => reviewAnimations(['attente', 'marche_droite']), /"clignement"/);
        assert.throws(() => reviewAnimations(['clignement', 'marche_droite']), /"attente"/);
    });

    it('fills a minimal pack in with mirrors and stand-ins', () => {
        const review = reviewAnimations(MINIMAL);
        assert.equal(review.mirrored.get('marche_gauche'), 'marche_droite');
        assert.equal(review.substitutes.get('sursaut'), 'clignement');
        assert.equal(review.substitutes.get('pointer'), 'clignement', 'pointer stands in for sursaut, itself a blink');
        assert.equal(review.substitutes.get('facepalm'), 'clignement');
        assert.equal(review.substitutes.get('gratter'), 'clignement');
        assert.equal(review.substitutes.get('endormie'), 'attente');
        assert.ok(review.missing.includes('coucou'));
        assert.ok(review.missing.includes('tapote'));
        assert.ok(review.missing.includes('menace'));
        assert.ok(review.missing.includes('yeux_nord'));
        assert.ok(review.notes.some(note => note.includes('« menace »')));
        assert.ok(review.notes.some(note => note.includes('yeux_*')));
    });

    it('stands in with the real thing when it is there', () => {
        const review = reviewAnimations([...MINIMAL, 'sursaut', 'facepalm']);
        assert.equal(review.substitutes.get('pointer'), 'sursaut');
        assert.equal(review.substitutes.get('gratter'), 'facepalm');
        assert.equal(review.substitutes.get('pouce'), 'sursaut');
        assert.equal(review.substitutes.has('facepalm'), false);
    });

    it('sets a half-drawn menace aside', () => {
        const review = reviewAnimations([...MINIMAL, 'menace', 'menace_tenue']);
        assert.deepEqual([...review.dropped].sort(), ['menace', 'menace_tenue']);
        assert.ok(MENACE_GROUP.every(name => review.missing.includes(name)));
        assert.ok(review.notes.some(note => note.includes('Menace incomplète')));
    });

    it('sets eye poses aside when a direction is missing', () => {
        const poses = EYE_DIRECTIONS.slice(0, 7).map(direction => `yeux_${direction}`);
        const review = reviewAnimations([...MINIMAL, ...poses]);
        assert.deepEqual([...review.dropped].sort(), [...poses].sort());
        assert.ok(review.notes.some(note => note.includes('yeux_* incomplètes')));
    });

    it('sets eye poses aside when their resting pose is not there', () => {
        const poses = EYE_DIRECTIONS.map(direction => `menace_yeux_${direction}`);
        const review = reviewAnimations([...MINIMAL, ...poses]);
        assert.deepEqual([...review.dropped].sort(), [...poses].sort());
    });

    it('keeps complete eye poses', () => {
        const poses = EYE_DIRECTIONS.map(direction => `yeux_${direction}`);
        const review = reviewAnimations([...MINIMAL, ...poses]);
        assert.deepEqual(review.dropped, []);
        assert.equal(review.notes.some(note => note.includes('yeux_*')), false);
    });

    it('lists what it does not know and ignores it', () => {
        const review = reviewAnimations([...MINIMAL, 'danse', 'attente_bis']);
        assert.deepEqual(review.unknown, ['attente_bis', 'danse']);
    });

    it('does not mirror a walk the pack drew', () => {
        const review = reviewAnimations([...MINIMAL, 'marche_gauche']);
        assert.equal(review.mirrored.size, 0);
    });
});

describe('pixelsOutsideBody', () => {
    const size = PACK_FRAME_SIZE;
    const channels = 4;
    const stride = size * channels;

    function frame(opaque: Array<[x: number, y: number]>): Uint8Array {
        const pixels = new Uint8Array(size * stride);
        for (const [x, y] of opaque)
            pixels[y * stride + x * channels + 3] = 255;
        return pixels;
    }

    it('counts nothing inside the box', () => {
        const inside = frame([[BODY_BOX.side, BODY_BOX.top], [size - BODY_BOX.side - 1, size - BODY_BOX.bottom - 1], [40, 40]]);
        assert.equal(pixelsOutsideBody(size, size, channels, stride, inside), 0);
    });

    it('counts every opaque pixel in the margins', () => {
        const outside = frame([[BODY_BOX.side - 1, 40], [size - BODY_BOX.side, 40], [40, BODY_BOX.top - 1], [40, size - BODY_BOX.bottom], [0, 0]]);
        assert.equal(pixelsOutsideBody(size, size, channels, stride, outside), 5);
    });

    it('ignores transparent pixels in the margins', () => {
        const pixels = frame([]);
        pixels[0] = 255;
        assert.equal(pixelsOutsideBody(size, size, channels, stride, pixels), 0);
    });

    it('treats a frame without alpha as filling the margins', () => {
        const expected = size * size - (size - 2 * BODY_BOX.side) * (size - BODY_BOX.top - BODY_BOX.bottom);
        assert.equal(pixelsOutsideBody(size, size, 3, size * 3, new Uint8Array(size * size * 3)), expected);
    });
});
