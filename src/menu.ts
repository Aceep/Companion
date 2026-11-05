import type Clutter from 'gi://Clutter';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import * as PopupMenu from 'resource:///org/gnome/shell/ui/popupMenu.js';

import type {CrepeSettings} from './settings.js';

/** Where the menu's arrow points from, along her width: her middle. */
const ARROW_ALIGNMENT = 0.5;

export interface CrepeMenuActions {
    openPreferences: () => void;
    /** Sends her off-screen, or brings her back. */
    toggleHidden: () => void;
    isHidden: () => boolean;
    /** Turns notification banners off for the whole session. */
    muteNotifications: () => void;
    /** The daemon runs and she is allowed to use it. */
    canConverse: () => boolean;
    openPrompt: () => void;
    /** Asks the daemon to drop what it remembers of the conversation. */
    forgetConversation: () => void;
    /** Starts a focus session of the set length, or ends the one going on. */
    toggleFocus: () => void;
    isFocusing: () => boolean;
}

/**
 * The right-click menu on Crêpe: preferences, the crawl and talk switches,
 * a way to send her off-screen and one to hide her for good (the quick
 * settings toggle brings her back). After a flood of notifications it
 * also offers, for a while, to mute them. With the conversation daemon
 * running, it offers to talk to her and to make her forget it. A focus
 * session starts and ends from it too.
 */
export class CrepeMenu {
    private readonly settings: CrepeSettings;
    private readonly actions: CrepeMenuActions;
    private readonly menu: PopupMenu.PopupMenu;
    private readonly manager: PopupMenu.PopupMenuManager;
    private readonly muteItem: PopupMenu.PopupMenuItem;
    private readonly converseItem: PopupMenu.PopupMenuItem;
    private readonly forgetItem: PopupMenu.PopupMenuItem;
    private readonly crawlItem: PopupMenu.PopupSwitchMenuItem;
    private readonly talkItem: PopupMenu.PopupSwitchMenuItem;
    private readonly awayItem: PopupMenu.PopupMenuItem;
    private readonly focusItem: PopupMenu.PopupMenuItem;
    private readonly settingsHandlerIds: number[];

    constructor(sourceActor: Clutter.Actor, settings: CrepeSettings, actions: CrepeMenuActions) {
        this.settings = settings;
        this.actions = actions;

        // The arrow on the bottom edge opens the menu above her; the shell
        // flips it below on its own when there is no room above. The menu
        // only positions itself against its source, so a plain Clutter actor
        // is enough despite the St.Widget typing.
        this.menu = new PopupMenu.PopupMenu(sourceActor as St.Widget, ARROW_ALIGNMENT, St.Side.BOTTOM);
        Main.uiGroup.add_child(this.menu.actor);
        this.menu.actor.hide();

        // First, so it is noticed while it lasts.
        this.muteItem = new PopupMenu.PopupMenuItem('Couper les notifications');
        this.muteItem.connect('activate', () => {
            this.withdrawMuteOffer();
            this.actions.muteNotifications();
        });
        this.muteItem.visible = false;
        this.menu.addMenuItem(this.muteItem);

        this.converseItem = new PopupMenu.PopupMenuItem('Lui parler…');
        this.converseItem.connect('activate', () => this.actions.openPrompt());
        this.menu.addMenuItem(this.converseItem);

        const preferencesItem = new PopupMenu.PopupMenuItem('Préférences…');
        preferencesItem.connect('activate', () => actions.openPreferences());
        this.menu.addMenuItem(preferencesItem);

        this.forgetItem = new PopupMenu.PopupMenuItem('Oublier notre conversation');
        this.forgetItem.connect('activate', () => this.actions.forgetConversation());
        this.menu.addMenuItem(this.forgetItem);

        this.focusItem = new PopupMenu.PopupMenuItem('');
        this.focusItem.connect('activate', () => this.actions.toggleFocus());
        this.menu.addMenuItem(this.focusItem);

        this.menu.addMenuItem(new PopupMenu.PopupSeparatorMenuItem());

        this.crawlItem = new PopupMenu.PopupSwitchMenuItem('Ramper', settings.crawl);
        this.crawlItem.connect('toggled', (_item: PopupMenu.PopupSwitchMenuItem, state: boolean) => {
            this.settings.crawl = state;
        });
        this.menu.addMenuItem(this.crawlItem);

        this.talkItem = new PopupMenu.PopupSwitchMenuItem('Parler', settings.talk);
        this.talkItem.connect('toggled', (_item: PopupMenu.PopupSwitchMenuItem, state: boolean) => {
            this.settings.talk = state;
        });
        this.menu.addMenuItem(this.talkItem);

        this.awayItem = new PopupMenu.PopupMenuItem('Se cacher');
        this.awayItem.connect('activate', () => this.actions.toggleHidden());
        this.menu.addMenuItem(this.awayItem);

        const hideItem = new PopupMenu.PopupMenuItem('Masquer Crêpe');
        hideItem.connect('activate', () => {
            this.settings.visible = false;
        });
        this.menu.addMenuItem(hideItem);

        // The preferences window can change these settings while the menu exists.
        this.settingsHandlerIds = [
            settings.gsettings.connect('changed::crawl', () => this.syncSwitches()),
            settings.gsettings.connect('changed::talk', () => this.syncSwitches()),
            settings.gsettings.connect('changed::brain', () => this.syncSwitches()),
            settings.gsettings.connect('changed::focus-minutes', () => this.syncFocus()),
        ];

        // The grab it takes on open lets a click elsewhere or Escape close the menu.
        this.manager = new PopupMenu.PopupMenuManager(sourceActor);
        this.manager.addMenu(this.menu, 0);
        this.syncConversation();
        this.syncFocus();
    }

    get isOpen(): boolean {
        return this.menu.isOpen;
    }

    toggle(): void {
        if (!this.menu.isOpen)
            this.syncSwitches();
        this.menu.toggle();
    }

    close(): void {
        if (this.menu.isOpen)
            this.menu.close(false);
    }

    offerMute(): void {
        this.muteItem.visible = true;
    }

    withdrawMuteOffer(): void {
        this.muteItem.visible = false;
    }

    /** The daemon came or went: the entries that need it follow, even with the menu open. */
    syncConversation(): void {
        const canConverse = this.actions.canConverse();
        this.converseItem.visible = canConverse;
        this.forgetItem.visible = canConverse;
    }

    /** A session started or ended, from here or from its timer. */
    syncFocus(): void {
        this.focusItem.label.text = this.actions.isFocusing()
            ? 'Arrêter la concentration'
            : `Mode concentration (${this.settings.focusMinutes} min)`;
    }

    destroy(): void {
        for (const id of this.settingsHandlerIds)
            this.settings.gsettings.disconnect(id);
        this.manager.removeMenu(this.menu);
        this.menu.destroy();
    }

    private syncSwitches(): void {
        this.crawlItem.setToggleState(this.settings.crawl);
        this.talkItem.setToggleState(this.settings.talk);
        this.awayItem.label.text = this.actions.isHidden() ? 'Revenir' : 'Se cacher';
        this.syncConversation();
        this.syncFocus();
    }
}
