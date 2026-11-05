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
}

/**
 * The right-click menu on Crêpe: preferences, the crawl and talk switches,
 * a way to send her off-screen and one to hide her for good (the quick
 * settings toggle brings her back). After a flood of notifications it
 * also offers, for a while, to mute them.
 */
export class CrepeMenu {
    private readonly settings: CrepeSettings;
    private readonly actions: CrepeMenuActions;
    private readonly menu: PopupMenu.PopupMenu;
    private readonly manager: PopupMenu.PopupMenuManager;
    private readonly muteItem: PopupMenu.PopupMenuItem;
    private readonly crawlItem: PopupMenu.PopupSwitchMenuItem;
    private readonly talkItem: PopupMenu.PopupSwitchMenuItem;
    private readonly awayItem: PopupMenu.PopupMenuItem;
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

        const preferencesItem = new PopupMenu.PopupMenuItem('Préférences…');
        preferencesItem.connect('activate', () => actions.openPreferences());
        this.menu.addMenuItem(preferencesItem);

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
        ];

        // The grab it takes on open lets a click elsewhere or Escape close the menu.
        this.manager = new PopupMenu.PopupMenuManager(sourceActor);
        this.manager.addMenu(this.menu, 0);
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
    }
}
