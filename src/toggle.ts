import GObject from 'gi://GObject';
import Gio from 'gi://Gio';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {QuickToggle, SystemIndicator} from 'resource:///org/gnome/shell/ui/quickSettings.js';

const CrepeQuickToggle = GObject.registerClass(
    class CrepeQuickToggle extends QuickToggle {
        constructor() {
            super({
                title: 'Crêpe',
                toggleMode: true,
            });
        }
    },
);

/**
 * The on/off switch in the quick settings menu (top-right of the panel).
 * Bound to the "visible" setting, so it survives logouts and can also be
 * driven from the preferences window.
 */
export class CrepeToggle {
    private readonly indicator: InstanceType<typeof SystemIndicator>;
    private readonly toggle: InstanceType<typeof CrepeQuickToggle>;

    constructor(icon: Gio.Icon, settings: Gio.Settings) {
        this.toggle = new CrepeQuickToggle();
        this.toggle.gicon = icon;
        settings.bind('visible', this.toggle, 'checked', Gio.SettingsBindFlags.DEFAULT);

        this.indicator = new SystemIndicator();
        this.indicator.quickSettingsItems.push(this.toggle);
        quickSettings().addExternalIndicator(this.indicator);
    }

    destroy(): void {
        Gio.Settings.unbind(this.toggle, 'checked');
        for (const item of this.indicator.quickSettingsItems)
            item.destroy();
        this.indicator.destroy();
    }
}

interface QuickSettingsIndicator {
    addExternalIndicator(indicator: InstanceType<typeof SystemIndicator>, colSpan?: number): void;
}

function quickSettings(): QuickSettingsIndicator {
    // Present since GNOME 44 but missing from the typings.
    return Main.panel.statusArea.quickSettings as unknown as QuickSettingsIndicator;
}
