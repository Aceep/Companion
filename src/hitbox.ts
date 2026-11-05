import Clutter from 'gi://Clutter';

import {FRAME_SIZE} from './animations.js';
import {FEET_PADDING, HEAD_PADDING, SIDE_PADDING, type CrepeSprite} from './sprite.js';

/**
 * The part of Crêpe that takes clicks: an invisible actor over her body
 * in the resting pose, without the transparent margin of the frame. Perched
 * on a title bar, that margin would otherwise swallow clicks meant for the
 * window's buttons. It follows the sprite wherever it goes, rescales included.
 */
export class Hitbox {
    readonly actor: Clutter.Actor;
    private readonly sprite: CrepeSprite;
    private readonly spriteHandlerIds: number[];

    constructor(sprite: CrepeSprite) {
        this.sprite = sprite;
        this.actor = new Clutter.Actor({name: 'crepe-hitbox', reactive: true});
        // Plain property updates rather than constraints, so `x` and `y` read true from Eval too.
        this.spriteHandlerIds = [
            sprite.actor.connect('notify::x', () => this.follow()),
            sprite.actor.connect('notify::y', () => this.follow()),
            sprite.actor.connect('notify::width', () => this.follow()),
        ];
        this.follow();
    }

    /** Out of reach takes no clicks at all: no menu, no drag, no pestering. */
    setReachable(reachable: boolean): void {
        this.actor.reactive = reachable;
    }

    destroy(): void {
        for (const id of this.spriteHandlerIds)
            this.sprite.actor.disconnect(id);
        this.spriteHandlerIds.length = 0;
        this.actor.destroy();
    }

    private follow(): void {
        const scale = this.sprite.currentScale;
        const sprite = this.sprite.actor;
        this.actor.set_position(sprite.x + SIDE_PADDING * scale, sprite.y + HEAD_PADDING * scale);
        this.actor.set_size(
            (FRAME_SIZE - 2 * SIDE_PADDING) * scale,
            (FRAME_SIZE - HEAD_PADDING - FEET_PADDING) * scale,
        );
    }
}
