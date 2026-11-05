import Meta from 'gi://Meta';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';

import type {Hitbox} from './hitbox.js';
import {isDesktop} from './presence.js';
import type {Layer} from './settings.js';
import type {CrepeSprite} from './sprite.js';

/**
 * Puts her on the stage, on top of the windows like the shell's own chrome
 * or under them, just above the desktop, and takes her off it. The sprite
 * only shows her; clicks go to the hitbox over her body, right above it.
 *
 * Under the windows she lives in the window group, among the window
 * actors. The compositor restacks that group by lowering every window to
 * the bottom in turn, which leaves any other actor above them all, so she
 * is put back under them after every restack. Clicks reach her there on
 * Wayland, where the shell picks what is under the pointer; on X11 the
 * shell only gets the clicks its input region asks for, and asking for
 * hers would steal them from the windows covering her, so she takes none.
 */
export class SpriteLayer {
    private readonly sprite: CrepeSprite;
    private readonly hitbox: Hitbox;
    /** Null while off the stage. */
    private layer: Layer | null = null;
    private restackHandlerId: number | null = null;

    constructor(sprite: CrepeSprite, hitbox: Hitbox) {
        this.sprite = sprite;
        this.hitbox = hitbox;
    }

    get isShown(): boolean {
        return this.layer !== null;
    }

    get current(): Layer | null {
        return this.layer;
    }

    /** On the stage in `layer`, moved there if she was in the other one. */
    show(layer: Layer): void {
        if (this.layer === layer)
            return;
        this.hide();
        if (layer === 'top')
            this.addTopChrome();
        else
            this.addUnderWindows();
        this.layer = layer;
    }

    hide(): void {
        if (this.layer === 'top') {
            Main.layoutManager.removeChrome(this.hitbox.actor);
            Main.layoutManager.removeChrome(this.sprite.actor);
        } else if (this.layer === 'behind') {
            if (this.restackHandlerId !== null)
                global.display.disconnect(this.restackHandlerId);
            this.restackHandlerId = null;
            global.window_group.remove_child(this.hitbox.actor);
            global.window_group.remove_child(this.sprite.actor);
        }
        this.layer = null;
    }

    private addTopChrome(): void {
        Main.layoutManager.addTopChrome(this.sprite.actor, {
            affectsInputRegion: false,
            affectsStruts: false,
            trackFullscreen: true,
        });
        Main.layoutManager.addTopChrome(this.hitbox.actor, {
            affectsInputRegion: true,
            affectsStruts: false,
            trackFullscreen: true,
        });
    }

    private addUnderWindows(): void {
        global.window_group.add_child(this.sprite.actor);
        global.window_group.add_child(this.hitbox.actor);
        this.restackHandlerId = global.display.connect('restacked', () => this.sinkUnderWindows());
        this.sinkUnderWindows();
    }

    /** Right under the lowest window that is not the desktop, so above the background and the desktop icons. */
    private sinkUnderWindows(): void {
        const group = global.window_group;
        const lowestWindow = group.get_children().find(child => {
            if (!(child instanceof Meta.WindowActor))
                return false;
            const window = child.get_meta_window();
            return window !== null && !isDesktop(window);
        });
        if (lowestWindow)
            group.set_child_below_sibling(this.sprite.actor, lowestWindow);
        else
            group.set_child_above_sibling(this.sprite.actor, null);
        group.set_child_above_sibling(this.hitbox.actor, this.sprite.actor);
    }
}
