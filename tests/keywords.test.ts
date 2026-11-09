import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {KeywordMatcher, looksLikeWaiting} from '../src/keywords.js';

// The schema's defaults.
const DEFAULTS = new KeywordMatcher({
    error: ['error', 'erreur', 'failed', 'failure', 'échec', 'exception', 'crash', 'fatal'],
    success: ['success', 'succeeded', 'réussi', 'passed', 'completed', 'terminé', 'finished', 'done'],
    busy: ['building', 'compiling', 'running', 'installing', 'npm run', 'cargo', 'make', 'pytest', 'test', 'loading', 'chargement', 'en cours'],
});

describe('KeywordMatcher.classify', () => {
    it('facepalms at an error keyword', () => {
        assert.equal(DEFAULTS.classify('Build failed'), 'facepalm');
    });

    it('gives a thumbs up at a success keyword', () => {
        assert.equal(DEFAULTS.classify('Pipeline passed'), 'pouce');
    });

    it('lets errors win over successes', () => {
        assert.equal(DEFAULTS.classify('finished with error'), 'facepalm');
    });

    it('ignores case', () => {
        assert.equal(DEFAULTS.classify('FATAL: out of memory'), 'facepalm');
    });

    it('does not find "done" inside "Abandoned cart"', () => {
        assert.equal(DEFAULTS.classify('Abandoned cart'), null);
    });

    it('does not find "error" inside "Terrorist"', () => {
        assert.equal(DEFAULTS.classify('Terrorist movie night'), null);
    });

    it('matches a keyword starting with an accented letter', () => {
        assert.equal(DEFAULTS.classify('Déploiement : échec'), 'facepalm');
    });

    it('matches a keyword ending with an accented letter', () => {
        assert.equal(DEFAULTS.classify('Tout a réussi'), 'pouce');
    });

    it('does not match an accented keyword followed by more letters', () => {
        assert.equal(DEFAULTS.classify('Une réussite'), null);
    });

    it('matches the plural of a keyword', () => {
        assert.equal(DEFAULTS.classify('3 errors'), 'facepalm');
        assert.equal(DEFAULTS.classify('Tests réussis'), 'pouce');
    });

    it('does not match a keyword followed by an s and more letters', () => {
        const matcher = new KeywordMatcher({error: ['error'], success: [], busy: []});
        assert.equal(matcher.classify('errorsome'), null);
    });

    it('does not end a word at an accented letter', () => {
        const matcher = new KeywordMatcher({error: ['chec'], success: [], busy: []});
        assert.equal(matcher.classify('échec'), null);
    });

    it('takes punctuation as a word boundary', () => {
        assert.equal(DEFAULTS.classify('error: no such file'), 'facepalm');
        assert.equal(DEFAULTS.classify('[failed] 3 tests'), 'facepalm');
        assert.equal(DEFAULTS.classify('job-done.'), 'pouce');
    });

    it('takes a digit as part of the word', () => {
        assert.equal(DEFAULTS.classify('error404'), null);
    });

    it('ignores empty and blank keywords', () => {
        const matcher = new KeywordMatcher({error: ['', '   '], success: [], busy: []});
        assert.equal(matcher.classify('anything at all'), null);
    });

    it('trims keywords before matching', () => {
        const matcher = new KeywordMatcher({error: ['  boom '], success: [], busy: []});
        assert.equal(matcher.classify('it went boom'), 'facepalm');
    });

    it('treats regular expression characters in keywords literally', () => {
        const matcher = new KeywordMatcher({error: ['c++'], success: [], busy: []});
        assert.equal(matcher.classify('c++ build'), 'facepalm');
        assert.equal(matcher.classify('cc build'), null);
    });
});

describe('KeywordMatcher.looksBusy', () => {
    it('does not find "test" inside "Latest commits"', () => {
        assert.equal(DEFAULTS.looksBusy('Latest commits'), false);
    });

    it('does not find "make" inside "makefile"', () => {
        assert.equal(DEFAULTS.looksBusy('makefile'), false);
    });

    it('matches a multi-word keyword', () => {
        assert.equal(DEFAULTS.looksBusy('~/crepe: npm run build'), true);
        assert.equal(DEFAULTS.looksBusy('Import en cours'), true);
    });

    it('does not match a multi-word keyword written without its space', () => {
        assert.equal(DEFAULTS.looksBusy('npmrun'), false);
    });

    it('matches a whole word', () => {
        assert.equal(DEFAULTS.looksBusy('make all'), true);
    });

    it('matches the plural of a busy keyword', () => {
        assert.equal(DEFAULTS.looksBusy('running tests'), true);
        assert.equal(DEFAULTS.looksBusy('3 tests left'), true);
    });
});

describe('looksLikeWaiting', () => {
    it('is true for a waiting word', () => {
        assert.equal(looksLikeWaiting('Chargement de la page'), true);
    });

    it('is false for a waiting word inside another word', () => {
        assert.equal(looksLikeWaiting('Rebuildings plan'), false);
    });

    it('is true for a multi-word waiting word', () => {
        assert.equal(looksLikeWaiting('Synchronisation en cours'), true);
    });

    it('is true for a title ending in an ellipsis, trailing spaces aside', () => {
        assert.equal(looksLikeWaiting('Please wait…  '), true);
        assert.equal(looksLikeWaiting('Please wait...'), true);
    });

    it('is false for a plain title', () => {
        assert.equal(looksLikeWaiting('README.md - crepe'), false);
    });
});
