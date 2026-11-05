import Meta from 'gi://Meta';
import type Mtk from 'gi://Mtk';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import type * as MessageTray from 'resource:///org/gnome/shell/ui/messageTray.js';

export type TextListener = (text: string) => void;

/** `windowId` tells windows apart, so a task followed in one title is not ended by another. */
export type TitleListener = (title: string, windowId: number) => void;

/** Calls `listener` once per normal window opened on the primary monitor, when it first shows, with its frame. */
export class NewWindowWatcher {
    private readonly listener: (frame: Mtk.Rectangle) => void;
    private readonly createdHandlerId: number;
    /** Windows still waiting for their first frame, with the handlers to drop if it never comes. */
    private readonly pending = new Map<Meta.WindowActor, number[]>();

    constructor(listener: (frame: Mtk.Rectangle) => void) {
        this.listener = listener;
        this.createdHandlerId = global.display.connect('window-created',
            (_display: Meta.Display, window: Meta.Window) => this.watch(window));
    }

    destroy(): void {
        global.display.disconnect(this.createdHandlerId);
        for (const actor of [...this.pending.keys()])
            this.unwatch(actor);
    }

    private watch(window: Meta.Window): void {
        if (window.get_window_type() !== Meta.WindowType.NORMAL)
            return;
        // Its size and place are only settled once it draws for the first time.
        const actor = window.get_compositor_private<Meta.WindowActor | null>();
        if (!actor) {
            this.report(window);
            return;
        }
        this.pending.set(actor, [
            actor.connect('first-frame', () => {
                this.unwatch(actor);
                this.report(window);
            }),
            // Closed before it ever drew.
            actor.connect('destroy', () => this.unwatch(actor)),
        ]);
    }

    private unwatch(actor: Meta.WindowActor): void {
        for (const id of this.pending.get(actor) ?? [])
            actor.disconnect(id);
        this.pending.delete(actor);
    }

    private report(window: Meta.Window): void {
        if (window.get_monitor() === Main.layoutManager.primaryIndex)
            this.listener(window.get_frame_rect());
    }
}

/**
 * Reports every notification shown by the shell as "title\nbody" text.
 * Sources that already exist when the watcher starts are hooked too.
 */
export class NotificationWatcher {
    private readonly listener: TextListener;
    private readonly sourceHandlers = new Map<MessageTray.Source, number>();
    private readonly trayHandlers: number[] = [];

    constructor(listener: TextListener) {
        this.listener = listener;
        const tray = Main.messageTray;
        this.trayHandlers.push(
            tray.connect('source-added', (_tray, source) => this.watchSource(source)),
            tray.connect('source-removed', (_tray, source) => this.unwatchSource(source)),
        );
        for (const source of tray.getSources())
            this.watchSource(source);
    }

    destroy(): void {
        for (const id of this.trayHandlers)
            Main.messageTray.disconnect(id);
        this.trayHandlers.length = 0;
        for (const source of [...this.sourceHandlers.keys()])
            this.unwatchSource(source);
    }

    private watchSource(source: MessageTray.Source): void {
        if (this.sourceHandlers.has(source))
            return;
        const id = source.connect('notification-added', (_source, notification) => {
            const text = [notification.title, notification.body].filter(Boolean).join('\n');
            this.listener(text);
        });
        this.sourceHandlers.set(source, id);
    }

    private unwatchSource(source: MessageTray.Source): void {
        const id = this.sourceHandlers.get(source);
        if (id === undefined)
            return;
        source.disconnect(id);
        this.sourceHandlers.delete(source);
    }
}

/**
 * Reports the title of the focused window whenever focus moves or the
 * title changes (terminals and IDEs rewrite it as you work), and when
 * no window has focus any more.
 */
export class FocusedWindowWatcher {
    private readonly listener: TitleListener;
    private readonly onUnfocused: () => void;
    private readonly focusHandlerId: number;
    private watched: Meta.Window | null = null;
    private titleHandlerId: number | null = null;

    constructor(listener: TitleListener, onUnfocused: () => void) {
        this.listener = listener;
        this.onUnfocused = onUnfocused;
        this.focusHandlerId = global.display.connect('notify::focus-window', () => this.follow(global.display.focus_window));
        this.follow(global.display.focus_window);
    }

    destroy(): void {
        global.display.disconnect(this.focusHandlerId);
        this.unwatch();
    }

    private follow(window: Meta.Window | null): void {
        this.unwatch();
        if (!window) {
            this.onUnfocused();
            return;
        }
        this.watched = window;

        this.titleHandlerId = window.connect('notify::title', () => this.report(window));
        this.report(window);
    }

    private unwatch(): void {
        if (this.watched && this.titleHandlerId !== null)
            this.watched.disconnect(this.titleHandlerId);
        this.watched = null;
        this.titleHandlerId = null;
    }

    private report(window: Meta.Window): void {
        const title = window.get_title();
        if (title)
            this.listener(title, window.get_id());
    }
}
