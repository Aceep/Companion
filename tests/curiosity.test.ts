import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import {Curiosity, PointerPlay, type CuriosityInput, type PlayInput} from '../src/curiosity.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOME = 0;
const OTHER = 1;

const POINTER = {x: 500, y: 300};

/** Her at home on monitor 0, the user at work, nothing in her way, at `now`. */
function look(now: number, overrides: Partial<CuriosityInput> = {}): CuriosityInput {
    return {now, focusedRoom: OTHER, homeRoom: HOME, visiting: false, userActive: true, blockers: [], ...overrides};
}

/** The pointer still since 0 at `POINTER`, far from her, the user typing, at `now`. */
function poll(now: number, overrides: Partial<PlayInput> = {}): PlayInput {
    return {now, pointer: POINTER, stillSince: 0, distance: 400, blockers: [], ...overrides};
}

/** A game that has just reached the approach, at two minutes and three seconds. */
function approaching(): PointerPlay {
    const play = new PointerPlay();
    play.update(poll(2 * MINUTE));
    play.update(poll(2 * MINUTE + 3 * SECOND));
    return play;
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

describe('PointerPlay', () => {
    it('stares at a pointer left alone for two minutes', () => {
        assert.equal(new PointerPlay().update(poll(2 * MINUTE)), 'stare');
    });

    it('does not stare before two minutes', () => {
        assert.equal(new PointerPlay().update(poll(2 * MINUTE - SECOND)), 'none');
    });

    it('does not stare at a pointer closer than 150 pixels', () => {
        assert.equal(new PointerPlay().update(poll(2 * MINUTE, {distance: 149})), 'none');
    });

    it('does not stare while something holds her back', () => {
        assert.equal(new PointerPlay().update(poll(2 * MINUTE, {blockers: ['absent']})), 'none');
    });

    it('creeps up on it after three seconds of staring', () => {
        const play = new PointerPlay();
        play.update(poll(2 * MINUTE));
        assert.equal(play.update(poll(2 * MINUTE + 3 * SECOND)), 'approach');
    });

    it('keeps staring before three seconds', () => {
        const play = new PointerPlay();
        play.update(poll(2 * MINUTE));
        assert.equal(play.update(poll(2 * MINUTE + 2 * SECOND)), 'none');
    });

    it('stops staring without a fuss when the pointer moves', () => {
        const play = new PointerPlay();
        play.update(poll(2 * MINUTE));
        play.update(poll(2 * MINUTE + SECOND, {pointer: {x: 530, y: 300}}));
        assert.equal(play.phase, 'idle');
    });

    it('recoils when the pointer moves more than 20 pixels while she creeps up', () => {
        const play = approaching();
        assert.equal(play.update(poll(2 * MINUTE + 4 * SECOND, {pointer: {x: 521, y: 300}})), 'recoil');
    });

    it('keeps creeping up when the pointer twitches by 20 pixels or less', () => {
        const play = approaching();
        assert.equal(play.update(poll(2 * MINUTE + 4 * SECOND, {pointer: {x: 512, y: 316}})), 'none');
    });

    it('gives up the game without recoiling when something stops her on the way', () => {
        const play = approaching();
        const step = play.update(poll(2 * MINUTE + 4 * SECOND, {pointer: {x: 600, y: 300}, blockers: ['carried']}));
        assert.deepEqual([step, play.phase], ['none', 'idle']);
    });

    it('stays by the pointer once arrived with it still in place', () => {
        const play = approaching();
        assert.deepEqual([play.arrived(), play.phase], [true, 'arrived']);
    });

    it('does not count an arrival once the game is over', () => {
        const play = approaching();
        play.update(poll(2 * MINUTE + 4 * SECOND, {pointer: {x: 600, y: 300}}));
        assert.equal(play.arrived(), false);
    });

    it('plays once every fifteen minutes at most', () => {
        const play = new PointerPlay();
        play.update(poll(2 * MINUTE));
        play.cancel();
        assert.equal(play.update(poll(16 * MINUTE)), 'none');
    });

    it('plays again fifteen minutes after the last game', () => {
        const play = new PointerPlay();
        play.update(poll(2 * MINUTE));
        play.cancel();
        assert.equal(play.update(poll(17 * MINUTE)), 'stare');
    });
});
