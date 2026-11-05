import Adw from 'gi://Adw';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

export default class CrepePreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): void {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Crêpe', iconName: 'face-plain-symbolic'});
        page.add(this.appearanceGroup(settings));
        page.add(this.behaviourGroup(settings));
        page.add(this.keywordsGroup(settings));
        window.add(page);
    }

    private appearanceGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: 'Appearance'});
        group.add(spinRow(settings, 'scale', 'Size', 'Screen pixels per sprite pixel. 3 makes her 240 px tall.', 1, 8));
        group.add(switchRow(settings, 'visible', 'Show Crêpe', 'Same as the quick settings toggle.'));
        return group;
    }

    private behaviourGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: 'Behaviour'});
        group.add(spinRow(settings, 'sleep-after-minutes', 'Falls asleep after', 'Minutes without keyboard or mouse activity.', 1, 120));
        group.add(switchRow(settings, 'crawl', 'Crawls sideways', 'Now and then she moves to another spot at the same height.'));
        group.add(switchRow(settings, 'talk', 'Talks', 'Shows a short remark now and then.'));
        group.add(switchRow(settings, 'react-to-notifications', 'Reacts to notifications', 'Jumps when one arrives; facepalm or thumbs up if it matches a keyword.'));
        group.add(switchRow(settings, 'react-to-windows', 'Reacts to window titles', 'Watches the title of the focused window for keywords.'));
        group.add(switchRow(settings, 'perch', 'Perches on the focused window', 'Sits on its title bar instead of her own spot.'));
        group.add(spinRow(settings, 'bedtime-hour', 'Falls asleep by herself after (hour)', 'Until 6 in the morning. 0 turns it off.', 0, 23));
        group.add(spinRow(settings, 'pause-reminder-minutes', 'Reminds you to take a break after (minutes)', 'Of activity without three idle minutes. 0 turns it off.', 0, 180));
        group.add(switchRow(settings, 'react-to-music', 'Comments on music', 'Remarks on new tracks from your media player now and then.'));
        return group;
    }

    private keywordsGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: 'Keywords',
            description: 'Comma-separated, case-insensitive. Error words win over success words.',
        });
        group.add(keywordsRow(settings, 'error-keywords', 'Facepalm on'));
        group.add(keywordsRow(settings, 'success-keywords', 'Thumbs up on'));
        group.add(keywordsRow(settings, 'busy-keywords', 'Long task while the title has'));
        return group;
    }
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function spinRow(settings: Gio.Settings, key: string, title: string, subtitle: string, lower: number, upper: number): Adw.SpinRow {
    const row = new Adw.SpinRow({
        title,
        subtitle,
        adjustment: new Gtk.Adjustment({lower, upper, stepIncrement: 1, pageIncrement: 1}),
    });
    settings.bind(key, row, 'value', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

function keywordsRow(settings: Gio.Settings, key: string, title: string): Adw.EntryRow {
    const row = new Adw.EntryRow({title, text: settings.get_strv(key).join(', ')});
    row.connect('apply', () => {
        const words = row.text.split(',').map(word => word.trim()).filter(word => word.length > 0);
        settings.set_strv(key, words);
    });
    row.showApplyButton = true;
    return row;
}
