import Adw from 'gi://Adw';
import Gdk from 'gi://Gdk';
import Gio from 'gi://Gio';
import Gtk from 'gi://Gtk';

import {ExtensionPreferences} from 'resource:///org/gnome/Shell/Extensions/js/extensions/prefs.js';

import {fetchStatus, type BrainStatus} from './brain.js';
import {TALK_SHORTCUT_KEY} from './settings.js';
import {STAT_COUNTERS, parseStats, sumDays, type StatCounter} from './stats.js';
import {OUTFIT_IDS, parseBirthday, type OutfitId} from './wardrobe.js';

const DAEMON_README_PATH = 'blob/main/daemon/README.md';

const STAT_LABELS: Record<StatCounter, string> = {
    notifications: 'Notifications',
    errors: 'Erreurs',
    successes: 'Succès',
    clicks: 'Clics',
    drags: 'Déplacements',
    sulks: 'Bouderies',
    storms: 'Départs furieux',
    nudges: 'Messages de scripts',
    talks: 'Répliques',
    crawls: 'Promenades',
    remarks: 'Remarques spontanées',
    pipelines: 'Pipelines en échec',
    commands: 'Commandes en échec',
    ignored: 'Pense-bêtes ignorés',
    focus: 'Sessions de concentration',
};

/** The groups of the statistics page: a title and how many days back it adds up, today included. */
const STAT_PERIODS: readonly {title: string; days: number}[] = [
    {title: "Aujourd'hui", days: 1},
    {title: '7 jours', days: 7},
    {title: '30 jours', days: 30},
];

export default class CrepePreferences extends ExtensionPreferences {
    override fillPreferencesWindow(window: Adw.PreferencesWindow): void {
        const settings = this.getSettings();
        const page = new Adw.PreferencesPage({title: 'Crêpe', iconName: 'face-plain-symbolic'});
        page.add(this.appearanceGroup(settings));
        page.add(this.behaviourGroup(settings));
        page.add(this.rhythmGroup(settings));
        page.add(outfitsGroup(settings));
        page.add(this.keywordsGroup(settings));
        window.add(page);
        window.add(this.brainPage(window, settings));
        window.add(statsPage(window, settings));
    }

    private brainPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
        const page = new Adw.PreferencesPage({title: 'Cerveau', iconName: 'user-available-symbolic'});

        const conversation = new Adw.PreferencesGroup({
            title: 'Conversation',
            description: 'Avec crepe-daemon lancé, elle peut répondre à ce que tu lui écris. Sans lui, rien ne change.',
        });
        conversation.add(switchRow(settings, 'brain', 'Parler avec le démon', 'Ajoute « Lui parler… » à son menu et active le raccourci.'));
        conversation.add(switchRow(settings, 'brain-remarks', 'Remarques spontanées', 'Une remarque sur trois vient du démon. Chacune compte comme une requête.'));
        conversation.add(shortcutRow(window, settings));
        page.add(conversation);

        const daemon = new Adw.PreferencesGroup({title: 'Démon'});
        daemon.add(statusRow(window));
        const install = new Adw.ActionRow({
            title: 'Installation',
            subtitle: 'Installer avec scripts/install-daemon.sh, puis enregistrer la clé avec python -m crepe_daemon --set-key',
        });
        const url = this.metadata.url;
        if (typeof url === 'string' && url.length > 0) {
            install.add_suffix(new Gtk.LinkButton({
                label: 'daemon/README.md',
                uri: `${url}/${DAEMON_README_PATH}`,
                valign: Gtk.Align.CENTER,
            }));
        }
        daemon.add(install);
        page.add(daemon);
        return page;
    }

    private appearanceGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: 'Apparence'});
        group.add(spinRow(settings, 'scale', 'Taille', "Pixels d'écran par pixel du sprite. À 3, elle mesure 240 px.", 1, 8));
        group.add(switchRow(settings, 'visible', 'Afficher Crêpe', 'Comme le bouton des réglages rapides.'));
        return group;
    }

    private behaviourGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: 'Comportement'});
        group.add(spinRow(settings, 'sleep-after-minutes', "S'endort après (minutes)", 'Sans activité clavier ni souris.', 1, 120));
        group.add(switchRow(settings, 'crawl', 'Se promène', 'De temps en temps, elle change de place à la même hauteur.'));
        group.add(switchRow(settings, 'talk', 'Parle', 'Lâche une courte remarque de temps en temps.'));
        group.add(switchRow(settings, 'react-to-notifications', 'Réagit aux notifications', "Sursaute à l'arrivée ; facepalm ou pouce levé selon les mots-clés."));
        group.add(switchRow(settings, 'react-to-windows', 'Réagit aux titres de fenêtre', 'Surveille les mots-clés dans le titre de la fenêtre active.'));
        group.add(switchRow(settings, 'ink', "Crache de l'encre quand elle est furieuse", "Quelques taches sombres sur l'écran, qui s'effacent d'elles-mêmes. Aussi quand on la titille en pleine bouderie."));
        group.add(switchRow(settings, 'perch', 'Se perche sur la fenêtre active', 'Sur sa barre de titre, au lieu de sa place à elle.'));
        group.add(switchRow(settings, 'eyes-follow', 'Suit la souris des yeux', "Au repos, elle regarde vers le pointeur ; tout près d'elle ou immobile, elle regarde droit devant."));
        group.add(switchRow(settings, 'dodge', "S'écarte de la fenêtre active", 'Elle se pousse sur sa ligne quand elle la cache, et revient ensuite. Seulement au-dessus des fenêtres.'));
        group.add(layerRow(settings));
        group.add(spinRow(settings, 'bedtime-hour', "Va se coucher toute seule à partir de (heure)", "Jusqu'à 6 h du matin. 0 = jamais.", 0, 23));
        group.add(spinRow(settings, 'pause-reminder-minutes', 'Rappelle de faire une pause après (minutes)', "D'activité sans trois minutes de calme. 0 = jamais.", 0, 180));
        group.add(switchRow(settings, 'react-to-music', 'Commente la musique', 'Une remarque de temps en temps sur les nouveaux morceaux du lecteur.'));
        return group;
    }

    private rhythmGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({title: 'Rythme'});
        group.add(spinRow(settings, 'comment-interval-minutes', 'Remarques spontanées toutes les (minutes)', 'En moyenne, à un tiers près. 0 = jamais.', 0, 180));
        group.add(spinRow(settings, 'crawl-interval-minutes', 'Promenades toutes les (minutes)', 'En moyenne, à un tiers près, si elle a le droit de ramper. 0 = jamais.', 0, 60));
        group.add(spinRow(settings, 'homesick-percent', 'Retour à sa place après un déplacement (%)', 'Quand elle est calme ; le double si elle est agacée, toujours si elle boude. 0 = jamais.', 0, 100));
        group.add(spinRow(settings, 'focus-minutes', 'Durée du mode concentration (minutes)', 'Lancé depuis son menu. Ni remarques, ni promenades, ni réactions.', 5, 180));
        group.add(switchRow(settings, 'focus-dnd', 'Ne pas déranger pendant la concentration', 'Coupe les bannières de notification, puis les remet comme avant.'));
        group.add(switchRow(settings, 'hide-during-screencast', "Se cache pendant le partage d'écran", "Aussi pendant un enregistrement d'écran. Elle revient quand il se termine."));
        group.add(switchRow(settings, 'quiet-during-calls', 'Se tait pendant les appels', "Tant qu'une application utilise le micro ou la caméra. Elle résume en une phrase ce que les scripts ont dit pendant ce temps."));
        group.add(switchRow(settings, 'recap', 'Bilan du soir', 'Une fois par jour, elle résume la journée.'));
        group.add(spinRow(settings, 'recap-hour', 'Heure du bilan', 'Pendant cette heure-là, si elle est réveillée et visible.', 0, 23));
        return group;
    }

    private keywordsGroup(settings: Gio.Settings): Adw.PreferencesGroup {
        const group = new Adw.PreferencesGroup({
            title: 'Mots-clés',
            description: "Séparés par des virgules, sans tenir compte de la casse. Les mots d'erreur l'emportent sur ceux de succès.",
        });
        group.add(keywordsRow(settings, 'error-keywords', 'Facepalm sur'));
        group.add(keywordsRow(settings, 'success-keywords', 'Pouce levé sur'));
        group.add(keywordsRow(settings, 'busy-keywords', 'Tâche longue tant que le titre contient'));
        return group;
    }
}

/** How each outfit is named in the « Tenue forcée » list. */
const OUTFIT_LABELS: Record<OutfitId, string> = {
    masque_nuit: 'Masque de nuit (quand elle dort)',
    bonnet: 'Bonnet',
    lunettes: 'Lunettes de soleil',
    chapeau_fete: "Chapeau d'anniversaire",
    verre: 'Verre',
    transat: 'Transat',
};

function outfitsGroup(settings: Gio.Settings): Adw.PreferencesGroup {
    const group = new Adw.PreferencesGroup({
        title: 'Tenues',
        description: "Masque pour dormir, bonnet l'hiver, lunettes l'été, chapeau pour son anniversaire, verre et transat le vendredi soir.",
    });
    group.add(switchRow(settings, 'outfits', "S'habille selon le jour", 'Désactivé, elle ne porte rien, tenue forcée comprise.'));
    group.add(birthdayRow(settings));
    group.add(overrideRow(settings));
    return group;
}

/** Saved only once it is a date of the year; until then the row says it is wrong and the setting keeps its value. */
function birthdayRow(settings: Gio.Settings): Adw.EntryRow {
    const row = new Adw.EntryRow({title: 'Anniversaire (MM-JJ)', text: settings.get_string('birthday')});
    row.showApplyButton = true;
    row.connect('changed', () => {
        if (parseBirthday(row.text) === null)
            row.add_css_class('error');
        else
            row.remove_css_class('error');
    });
    row.connect('apply', () => {
        if (parseBirthday(row.text) === null)
            return;
        settings.set_string('birthday', row.text.trim());
    });
    return row;
}

/** « Aucune » follows the rules; any other entry is worn whatever the date. Bound by hand like the layer row. */
function overrideRow(settings: Gio.Settings): Adw.ComboRow {
    const values: readonly string[] = ['', ...OUTFIT_IDS];
    const row = new Adw.ComboRow({
        title: 'Tenue forcée',
        subtitle: 'Pour la montrer : elle la porte seule, quel que soit le jour.',
        model: Gtk.StringList.new(['Aucune', ...OUTFIT_IDS.map(id => OUTFIT_LABELS[id])]),
    });
    const sync = () => {
        row.selected = Math.max(0, values.indexOf(settings.get_string('outfit-override')));
    };
    sync();
    const handlerId = settings.connect('changed::outfit-override', sync);
    row.connect('destroy', () => settings.disconnect(handlerId));
    row.connect('notify::selected', () => {
        const value = values[row.selected];
        if (value !== undefined && value !== settings.get_string('outfit-override'))
            settings.set_string('outfit-override', value);
    });
    return row;
}

function switchRow(settings: Gio.Settings, key: string, title: string, subtitle: string): Adw.SwitchRow {
    const row = new Adw.SwitchRow({title, subtitle});
    settings.bind(key, row, 'active', Gio.SettingsBindFlags.DEFAULT);
    return row;
}

/** The layer setting's values, in the order the combo row lists them. */
const LAYERS: readonly {value: string; label: string}[] = [
    {value: 'top', label: 'Au-dessus des fenêtres'},
    {value: 'behind', label: 'Derrière les fenêtres'},
];

/** A combo row bound by hand: `Gio.Settings.bind` cannot map a string key to a selected index. */
function layerRow(settings: Gio.Settings): Adw.ComboRow {
    const row = new Adw.ComboRow({
        title: 'Couche',
        subtitle: 'Derrière les fenêtres, elle vit sur le bureau ; sa bulle reste au-dessus.',
        model: Gtk.StringList.new(LAYERS.map(layer => layer.label)),
    });
    const sync = () => {
        const index = LAYERS.findIndex(layer => layer.value === settings.get_string('layer'));
        row.selected = Math.max(0, index);
    };
    sync();
    const handlerId = settings.connect('changed::layer', sync);
    row.connect('destroy', () => settings.disconnect(handlerId));
    row.connect('notify::selected', () => {
        const layer = LAYERS[row.selected];
        if (layer && layer.value !== settings.get_string('layer'))
            settings.set_string('layer', layer.value);
    });
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

/**
 * The day's counters, the week's and the month's, read straight from the
 * setting and following it. The extension writes it once a minute at
 * most, so today lags behind by up to that.
 */
function statsPage(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.PreferencesPage {
    const page = new Adw.PreferencesPage({title: 'Statistiques', iconName: 'view-list-bullet-symbolic'});
    const valueLabels = STAT_PERIODS.map(period => {
        const group = new Adw.PreferencesGroup({title: period.title});
        const labels = new Map<StatCounter, Gtk.Label>();
        for (const counter of STAT_COUNTERS) {
            const row = new Adw.ActionRow({title: STAT_LABELS[counter]});
            const label = new Gtk.Label({label: '0', valign: Gtk.Align.CENTER});
            label.add_css_class('numeric');
            row.add_suffix(label);
            group.add(row);
            labels.set(counter, label);
        }
        page.add(group);
        return {days: period.days, labels};
    });

    const sync = () => {
        const days = parseStats(settings.get_string('stats'));
        const today = new Date();
        for (const {days: dayCount, labels} of valueLabels) {
            const totals = sumDays(days, today, dayCount);
            for (const [counter, label] of labels)
                label.label = String(totals[counter]);
        }
    };
    sync();
    const handlerId = settings.connect('changed::stats', sync);
    window.connect('close-request', () => {
        settings.disconnect(handlerId);
        return false;
    });

    const reset = new Adw.PreferencesGroup();
    const button = new Gtk.Button({label: 'Réinitialiser', halign: Gtk.Align.CENTER});
    button.add_css_class('destructive-action');
    button.connect('clicked', () => settings.set_string('stats', '{}'));
    reset.add(button);
    page.add(reset);
    return page;
}

/** The shortcut that opens the box to talk to her, with a button to record a new one. */
function shortcutRow(window: Adw.PreferencesWindow, settings: Gio.Settings): Adw.ActionRow {
    const row = new Adw.ActionRow({title: 'Raccourci pour lui parler'});
    const label = new Gtk.ShortcutLabel({disabledText: 'Aucun', valign: Gtk.Align.CENTER});
    const sync = () => {
        label.accelerator = settings.get_strv(TALK_SHORTCUT_KEY)[0] ?? '';
    };
    sync();
    const handlerId = settings.connect(`changed::${TALK_SHORTCUT_KEY}`, sync);
    row.connect('destroy', () => settings.disconnect(handlerId));

    const button = new Gtk.Button({label: 'Changer…', valign: Gtk.Align.CENTER});
    button.connect('clicked', () => captureShortcut(window, accelerator => {
        settings.set_strv(TALK_SHORTCUT_KEY, accelerator === null ? [] : [accelerator]);
    }));
    row.add_suffix(label);
    row.add_suffix(button);
    row.activatableWidget = button;
    return row;
}

/**
 * A small modal window that records the next key combination. Escape
 * cancels, Backspace alone turns the shortcut off (null). Modifiers alone
 * and plain letters are not shortcuts, so they are waited past.
 */
function captureShortcut(parent: Gtk.Window, onCaptured: (accelerator: string | null) => void): void {
    const dialog = new Adw.Window({
        modal: true,
        transientFor: parent,
        title: 'Nouveau raccourci',
        defaultWidth: 380,
        resizable: false,
    });
    const content = new Gtk.Box({orientation: Gtk.Orientation.VERTICAL});
    content.append(new Adw.HeaderBar());
    content.append(new Adw.StatusPage({
        iconName: 'preferences-desktop-keyboard-shortcuts-symbolic',
        title: 'Appuie sur le raccourci',
        description: 'Échap pour annuler, Retour arrière pour le désactiver.',
    }));
    dialog.set_content(content);

    const keys = new Gtk.EventControllerKey();
    keys.connect('key-pressed', (_controller: Gtk.EventControllerKey, keyval: number, keycode: number, state: Gdk.ModifierType) => {
        const modifiers = state & Gtk.accelerator_get_default_mod_mask();
        if (modifiers === 0 && keyval === Gdk.KEY_Escape) {
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        if (modifiers === 0 && keyval === Gdk.KEY_BackSpace) {
            onCaptured(null);
            dialog.close();
            return Gdk.EVENT_STOP;
        }
        // A bare letter would fire on every keystroke in every window.
        if (modifiers === 0 || !Gtk.accelerator_valid(keyval, modifiers))
            return Gdk.EVENT_STOP;
        onCaptured(Gtk.accelerator_name_with_keycode(null, keyval, keycode, modifiers));
        dialog.close();
        return Gdk.EVENT_STOP;
    });
    dialog.add_controller(keys);
    dialog.present();
}

/** Asked straight from this process: the preferences window has its own session bus connection. */
function statusRow(window: Adw.PreferencesWindow): Adw.ActionRow {
    const row = new Adw.ActionRow({title: 'État du démon', subtitle: '…'});
    const cancellable = new Gio.Cancellable();
    const refresh = () => {
        row.subtitle = '…';
        fetchStatus(cancellable, status => {
            row.subtitle = describeStatus(status);
        });
    };
    const button = new Gtk.Button({
        iconName: 'view-refresh-symbolic',
        valign: Gtk.Align.CENTER,
        tooltipText: 'Actualiser',
    });
    button.add_css_class('flat');
    button.connect('clicked', refresh);
    row.add_suffix(button);
    window.connect('close-request', () => {
        cancellable.cancel();
        return false;
    });
    refresh();
    return row;
}

function describeStatus(status: BrainStatus | null): string {
    if (status === null)
        return 'non démarré';
    if (!status.hasKey)
        return 'clé absente';
    const fake = status.fake ? ' (factice)' : '';
    return `${status.model}${fake}, ${status.requestsToday}/${status.dailyBudget} requêtes aujourd'hui`;
}
