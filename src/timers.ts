import GLib from 'gi://GLib';

import type {Scheduler} from './player.js';

/**
 * GLib-backed timers that can all be cancelled at once. GNOME Shell requires
 * extensions to remove every source they created when disabled, so every
 * timeout in Crêpe goes through here.
 */
export class TimerPool {
    private readonly sources = new Set<number>();

    readonly schedule: Scheduler = (delayMs, callback) => {
        const id = GLib.timeout_add(GLib.PRIORITY_DEFAULT, delayMs, () => {
            this.sources.delete(id);
            callback();
            return GLib.SOURCE_REMOVE;
        });
        this.sources.add(id);
        return () => this.cancel(id);
    };

    cancel(id: number): void {
        if (!this.sources.delete(id))
            return;
        GLib.Source.remove(id);
    }

    cancelAll(): void {
        for (const id of this.sources)
            GLib.Source.remove(id);
        this.sources.clear();
    }
}
