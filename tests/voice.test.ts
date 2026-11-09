import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type Gio from 'gi://Gio';

import {VOICE_EVENTS, Voice, type VoiceEvent} from '../src/voice.js';

const PLAIN_LINE = 'Je bosse, là.';
const LINES: Partial<Record<VoiceEvent, string[]>> = {
    tache_terminee: ['Fini : {texte}.'],
    pense_bete: ['Tu voulais {texte}.'],
};

/** Stands in for the assets directory: only what `loadLines()` calls on it. */
function assetsWithLines(): Gio.File {
    const raw = Object.fromEntries(VOICE_EVENTS.map(event => [event, LINES[event] ?? [PLAIN_LINE]]));
    const contents = new TextEncoder().encode(JSON.stringify(raw));
    const file = {load_contents: () => [true, contents, null]};
    return {get_child: () => file} as unknown as Gio.File;
}

/** Every draw at 0: every odds pass and the first line is picked. */
function voiceSpeaking(crepeSpeech: number): Voice {
    const voice = new Voice({talk: true, crepeSpeech}, () => false, () => 0);
    voice.loadLines(assetsWithLines());
    return voice;
}

describe('Voice in Crêpe', () => {
    it('says every line in clear at 0 %', () => {
        assert.deepEqual(voiceSpeaking(0).speak('notification'), {text: PLAIN_LINE, translation: null});
    });

    it('says a line in Crêpe at 100 %, with the line in clear as its translation', () => {
        assert.deepEqual(voiceSpeaking(100).speak('notification'), {text: 'Crêpe crêpe, crêpe.', translation: PLAIN_LINE});
    });

    it('keeps the filled values as they are in a line said in Crêpe', () => {
        const said = voiceSpeaking(100).speak('tache_terminee', {texte: 'build 14 vert'});
        assert.deepEqual(said, {text: 'Crêpe : build 14 vert.', translation: 'Fini : build 14 vert.'});
    });

    it('says a reminder in clear whatever the share', () => {
        const said = voiceSpeaking(100).pick('pense_bete', {texte: 'appeler Léa', heure: '15:00'});
        assert.deepEqual(said, {text: 'Tu voulais appeler Léa.', translation: null});
    });

    it('relays a script message as is at 100 %', () => {
        assert.equal(voiceSpeaking(100).relay('Le build est vert.'), 'Le build est vert.');
    });

    it('utters a remark written elsewhere as is at 100 %', () => {
        assert.equal(voiceSpeaking(100).utter('Tu bosses encore ?'), 'Tu bosses encore ?');
    });
});
