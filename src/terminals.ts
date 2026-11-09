/**
 * Terminal emulators, by the lower-cased WM_CLASS or application id their
 * windows carry. The one place to add yours.
 */
const TERMINALS: ReadonlySet<string> = new Set([
    'gnome-terminal',
    'gnome-terminal-server',
    'org.gnome.terminal',
    'kgx',
    'org.gnome.console',
    'ptyxis',
    'org.gnome.ptyxis',
    'kitty',
    'alacritty',
    'org.wezfurlong.wezterm',
    'wezterm',
    'tilix',
    'com.gexperts.tilix',
    'foot',
    'footclient',
    'konsole',
    'org.kde.konsole',
    'xterm',
    'terminator',
    'com.mitchellh.ghostty',
    'ghostty',
    'com.raggesilver.blackbox',
]);

/** True when any of the identifiers (WM_CLASS, application id, desktop file id) names a terminal. */
export function isTerminal(identifiers: readonly (string | null | undefined)[]): boolean {
    return identifiers.some(identifier => {
        if (!identifier)
            return false;
        return TERMINALS.has(identifier.toLowerCase().replace(/\.desktop$/, ''));
    });
}
