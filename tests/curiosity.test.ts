import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Curiosity, type CuriosityInput} from '../src/curiosity.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOME = 0;
const OTHER = 1;

/** Her at home on monitor 0, the user at work, nothing in her way, at `now`. */
function look(now: number, overrides: Partial<CuriosityInput> = {}): CuriosityInput {
    return {now, focusedRoom: OTHER, homeRoom: HOME, visiting: false, userActive: true, blockers: [], ...overrides};
}

describe('Curiosity', () => {
    it('visits after two minutes of focus in another room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        assert.equal(curiosity.update(look(2 * MINUTE)), 'visit');
    });

    it('does not visit before two minutes', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        assert.equal(curiosity.update(look(2 * MINUTE - SECOND)), 'none');
    });

    it('starts counting again when focus moves to yet another room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.update(look(MINUTE, {focusedRoom: 2}));
        assert.equal(curiosity.update(look(2 * MINUTE, {focusedRoom: 2})), 'none');
    });

    it('starts counting again when focus comes back to her room meanwhile', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.update(look(MINUTE, {focusedRoom: HOME}));
        curiosity.update(look(MINUTE + SECOND));
        assert.equal(curiosity.update(look(2 * MINUTE + SECOND)), 'none');
    });

    it('never visits her own room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {focusedRoom: HOME}));
        assert.equal(curiosity.update(look(10 * MINUTE, {focusedRoom: HOME})), 'none');
    });

    it('does not visit while the user is away', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        assert.equal(curiosity.update(look(2 * MINUTE, {userActive: false})), 'none');
    });

    it('starts counting again once the user is back', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.update(look(5 * MINUTE, {userActive: false}));
        assert.equal(curiosity.update(look(5 * MINUTE + SECOND)), 'none');
    });

    it('does not visit while something holds her back', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        assert.equal(curiosity.update(look(2 * MINUTE, {blockers: ['perched']})), 'none');
    });

    it('visits as soon as what held her back is over', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.update(look(2 * MINUTE, {blockers: ['dodging']}));
        assert.equal(curiosity.update(look(3 * MINUTE)), 'visit');
    });

    it('visits once every ten minutes at most', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.update(look(2 * MINUTE));
        assert.equal(curiosity.update(look(11 * MINUTE)), 'none');
    });

    it('visits again ten minutes after the last visit', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.update(look(2 * MINUTE));
        assert.equal(curiosity.update(look(12 * MINUTE)), 'visit');
    });

    it('comes back after three minutes of focus back in her room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {visiting: true}));
        curiosity.update(look(MINUTE, {visiting: true, focusedRoom: HOME}));
        assert.equal(curiosity.update(look(4 * MINUTE, {visiting: true, focusedRoom: HOME})), 'return');
    });

    it('stays on the visit before three minutes of focus back in her room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {visiting: true, focusedRoom: HOME}));
        assert.equal(curiosity.update(look(3 * MINUTE - SECOND, {visiting: true, focusedRoom: HOME})), 'none');
    });

    it('stays on the visit while focus stays in the visited room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {visiting: true}));
        assert.equal(curiosity.update(look(30 * MINUTE, {visiting: true})), 'none');
    });

    it('counts the desktop focused as focus back in her room', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {visiting: true, focusedRoom: null}));
        assert.equal(curiosity.update(look(3 * MINUTE, {visiting: true, focusedRoom: null})), 'return');
    });

    it('comes back whatever holds her back otherwise', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {visiting: true, focusedRoom: HOME}));
        assert.equal(curiosity.update(look(3 * MINUTE, {visiting: true, focusedRoom: HOME, blockers: ['focus']})), 'return');
    });

    it('forgets how long focus stayed elsewhere once reset', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0));
        curiosity.reset();
        curiosity.update(look(MINUTE));
        assert.equal(curiosity.update(look(2 * MINUTE)), 'none');
    });

    it('does nothing with no room of her own', () => {
        const curiosity = new Curiosity();
        curiosity.update(look(0, {homeRoom: null}));
        assert.equal(curiosity.update(look(5 * MINUTE, {homeRoom: null})), 'none');
    });
});
