import assert from 'node:assert/strict';
import {describe, it} from 'node:test';

import type {AnimationDef} from '../src/animations.js';
import {AnimationPlayer, IDLE_ANIMATION, type Scheduler} from '../src/player.js';

function animation(name: string, frameCount: number, options: Partial<AnimationDef> = {}): AnimationDef {
    return {
        name,
        frames: Array.from({length: frameCount}, (_, index) => `${name}_${index}.png`),
        durationsMs: Array.from({length: frameCount}, () => 100),
        loop: false,
        tailLoop: null,
        usage: '',
        mirrored: false,
        ...options,
    };
}

/** A scheduler that only runs callbacks when told to, one pending at a time like the player uses it. */
class ManualClock {
    private pending: (() => void) | null = null;

    readonly schedule: Scheduler = (_delayMs, callback) => {
        this.pending = callback;
        return () => {
            if (this.pending === callback)
                this.pending = null;
        };
    };

    get hasPending(): boolean {
        return this.pending !== null;
    }

    tick(times = 1): void {
        for (let count = 0; count < times; count++) {
            const callback = this.pending;
            this.pending = null;
            callback?.();
        }
    }
}

function setup(defs: AnimationDef[]): {player: AnimationPlayer; clock: ManualClock; shown: string[]} {
    const clock = new ManualClock();
    const shown: string[] = [];
    const animations = new Map(defs.map(def => [def.name, def]));
    const player = new AnimationPlayer(animations, clock.schedule, (def, index) => shown.push(`${def.name}:${index}`));
    return {player, clock, shown};
}

describe('AnimationPlayer', () => {
    it('loops a looping animation back to its first frame', () => {
        const {player, clock, shown} = setup([animation(IDLE_ANIMATION, 2, {loop: true})]);
        player.play(IDLE_ANIMATION);
        clock.tick(2);
        assert.deepEqual(shown, ['attente:0', 'attente:1', 'attente:0']);
    });

    it('falls back to the idle animation after a one-shot', () => {
        const {player, clock} = setup([animation(IDLE_ANIMATION, 1, {loop: true}), animation('saut', 2)]);
        player.play('saut');
        clock.tick(2);
        assert.equal(player.currentName, IDLE_ANIMATION);
    });

    it('calls onDone once the one-shot has ended', () => {
        const {player, clock} = setup([animation(IDLE_ANIMATION, 1, {loop: true}), animation('saut', 2)]);
        let doneCount = 0;
        player.play('saut', {onDone: () => doneCount++});
        clock.tick(1);
        assert.equal(doneCount, 0);
        clock.tick(1);
        assert.equal(doneCount, 1);
    });

    it('falls back to the resting pose set when the one-shot ends', () => {
        const {player, clock} = setup([
            animation(IDLE_ANIMATION, 1, {loop: true}),
            animation('boude', 1, {loop: true}),
            animation('saut', 1),
        ]);
        player.play('saut');
        player.setRestingPose(() => 'boude');
        clock.tick(1);
        assert.equal(player.currentName, 'boude');
    });

    it('loops the tail range forever after one full play', () => {
        const {player, clock, shown} = setup([animation('endormie', 4, {tailLoop: [2, 3]})]);
        player.play('endormie');
        clock.tick(5);
        assert.deepEqual(shown, ['endormie:0', 'endormie:1', 'endormie:2', 'endormie:3', 'endormie:2', 'endormie:3']);
    });

    it('throws on an unknown animation', () => {
        const {player} = setup([animation(IDLE_ANIMATION, 1)]);
        assert.throws(() => player.play('nope'), /unknown animation "nope"/);
    });

    it('cancels the pending frame when stopped', () => {
        const {player, clock} = setup([animation(IDLE_ANIMATION, 2, {loop: true})]);
        player.play(IDLE_ANIMATION);
        player.stop();
        assert.equal(clock.hasPending, false);
        assert.equal(player.currentName, null);
    });

    it('tells the listener each animation that starts and null on stop', () => {
        const {player} = setup([animation(IDLE_ANIMATION, 1, {loop: true})]);
        const started: (string | null)[] = [];
        player.setAnimationListener(def => started.push(def?.name ?? null));
        player.play(IDLE_ANIMATION);
        player.stop();
        assert.deepEqual(started, [IDLE_ANIMATION, null]);
    });
});
