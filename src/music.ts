import Gio from 'gi://Gio';
import GLib from 'gi://GLib';

import {truncateTitle} from './tracks.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const DBUS_NAME = 'org.freedesktop.DBus';
const DBUS_PATH = '/org/freedesktop/DBus';
const MPRIS_NAMESPACE = 'org.mpris.MediaPlayer2';
const MPRIS_PATH = '/org/mpris/MediaPlayer2';
const PLAYER_INTERFACE = 'org.mpris.MediaPlayer2.Player';

/** Playing this long before it stops, and the quiet is worth a remark. */
const LONG_SESSION = 20 * MINUTE;

/** A new track started (`title` is null when the player does not say), or a long session just ended. */
export type MusicEvent = {kind: 'track'; title: string | null} | {kind: 'silence'};

export type MusicListener = (event: MusicEvent) => void;

export interface PlayerState {
    /** MPRIS PlaybackStatus: 'Playing', 'Paused' or 'Stopped'. */
    status: string;
    title: string | null;
    /** Tells tracks apart: artist and title. Null when the player gives no title. */
    trackKey: string | null;
}

/**
 * What one player's state changes mean for her: a new track, or the end
 * of a long session (paused, stopped or gone). No D-Bus in here, so it
 * can be fed by hand. The state the player is in when first seen is
 * taken as it is: re-enabling the extension mid-song is not a new song.
 */
export class PlaybackTracker {
    private playing: boolean;
    private playingSince: number;
    private track: string | null;

    constructor(initial: PlayerState, now: number) {
        this.playing = initial.status === 'Playing';
        this.playingSince = now;
        this.track = initial.trackKey;
    }

    update(state: PlayerState, now: number): MusicEvent | null {
        const wasPlaying = this.playing;
        this.playing = state.status === 'Playing';
        if (this.playing && !wasPlaying)
            this.playingSince = now;
        if (wasPlaying && !this.playing)
            return now - this.playingSince > LONG_SESSION ? {kind: 'silence'} : null;
        if (!this.playing || state.trackKey === null || state.trackKey === this.track)
            return null;
        this.track = state.trackKey;
        return {kind: 'track', title: state.title === null ? null : truncateTitle(state.title)};
    }
}

/**
 * Follows the first MPRIS media player on the session bus (a music app,
 * a browser tab...) and reports new tracks and the end of long listening
 * sessions. When that player goes away, the next one known takes over.
 */
export class MusicWatcher {
    private readonly listener: MusicListener;
    private readonly bus: Gio.DBusConnection;
    private readonly cancellable = new Gio.Cancellable();
    /** Every player on the bus, in order of appearance. */
    private readonly players = new Set<string>();
    private readonly ownerSignalId: number;
    private followed: string | null = null;
    private proxy: Gio.DBusProxy | null = null;
    private proxyHandlerId: number | null = null;
    private tracker: PlaybackTracker | null = null;

    constructor(listener: MusicListener) {
        this.listener = listener;
        this.bus = Gio.DBus.session;
        this.ownerSignalId = this.bus.signal_subscribe(DBUS_NAME, DBUS_NAME, 'NameOwnerChanged', DBUS_PATH,
            MPRIS_NAMESPACE, Gio.DBusSignalFlags.MATCH_ARG0_NAMESPACE,
            (_bus, _sender, _path, _interface, _signal, parameters) => {
                const [name, , newOwner] = parameters.deepUnpack<[string, string, string]>();
                if (newOwner)
                    this.playerAppeared(name);
                else
                    this.playerVanished(name);
            });
        this.listExistingPlayers();
    }

    /** The followed player is playing right now. */
    get isPlaying(): boolean {
        return this.proxy?.get_cached_property('PlaybackStatus')?.deepUnpack<string>() === 'Playing';
    }

    destroy(): void {
        this.cancellable.cancel();
        this.bus.signal_unsubscribe(this.ownerSignalId);
        this.unfollow();
        this.players.clear();
    }

    private listExistingPlayers(): void {
        this.bus.call(DBUS_NAME, DBUS_PATH, DBUS_NAME, 'ListNames', null, new GLib.VariantType('(as)'),
            Gio.DBusCallFlags.NONE, -1, this.cancellable, (_bus, result) => {
                let names: string[];
                try {
                    [names] = this.bus.call_finish(result).deepUnpack<[string[]]>();
                } catch (error) {
                    reportUnlessCancelled(error, 'Crêpe: could not list D-Bus names');
                    return;
                }
                for (const name of names)
                    this.playerAppeared(name);
            });
    }

    private playerAppeared(name: string): void {
        if (!name.startsWith(`${MPRIS_NAMESPACE}.`))
            return;
        this.players.add(name);
        if (this.followed === null)
            this.follow(name);
    }

    private playerVanished(name: string): void {
        if (!this.players.delete(name) || name !== this.followed)
            return;
        // A player quitting mid-song ends the session just like pressing stop.
        const event = this.tracker?.update({status: 'Stopped', title: null, trackKey: null}, Date.now());
        if (event)
            this.listener(event);
        this.unfollow();
        const [next] = this.players;
        if (next !== undefined)
            this.follow(next);
    }

    private follow(name: string): void {
        this.followed = name;
        Gio.DBusProxy.new(this.bus, Gio.DBusProxyFlags.DO_NOT_AUTO_START, null, name, MPRIS_PATH, PLAYER_INTERFACE,
            this.cancellable, (_source, result) => {
                let proxy: Gio.DBusProxy;
                try {
                    proxy = Gio.DBusProxy.new_finish(result);
                } catch (error) {
                    reportUnlessCancelled(error, `Crêpe: could not follow media player ${name}`);
                    return;
                }
                // It vanished, or another one took over, while the proxy was being made.
                if (this.followed !== name)
                    return;
                this.proxy = proxy;
                this.tracker = new PlaybackTracker(readState(proxy), Date.now());
                // The proxy updates its property cache from PropertiesChanged before emitting this.
                this.proxyHandlerId = proxy.connect('g-properties-changed', () => this.onPropertiesChanged());
            });
    }

    private unfollow(): void {
        if (this.proxy && this.proxyHandlerId !== null)
            this.proxy.disconnect(this.proxyHandlerId);
        this.proxy = null;
        this.proxyHandlerId = null;
        this.tracker = null;
        this.followed = null;
    }

    private onPropertiesChanged(): void {
        if (!this.proxy || !this.tracker)
            return;
        const event = this.tracker.update(readState(this.proxy), Date.now());
        if (event)
            this.listener(event);
    }
}

function readState(proxy: Gio.DBusProxy): PlayerState {
    const status = proxy.get_cached_property('PlaybackStatus')?.deepUnpack<string>() ?? 'Stopped';
    const metadata = (proxy.get_cached_property('Metadata')?.recursiveUnpack() ?? {}) as Record<string, unknown>;
    const rawTitle = metadata['xesam:title'];
    const rawArtists = metadata['xesam:artist'];
    const title = typeof rawTitle === 'string' && rawTitle.length > 0 ? rawTitle : null;
    const artists = Array.isArray(rawArtists) ? rawArtists.join(', ') : '';
    return {status, title, trackKey: title === null ? null : `${artists}\n${title}`};
}

/** Cancelling is how destroy() stops pending calls; anything else is a real failure. */
function reportUnlessCancelled(error: unknown, message: string): void {
    if (error instanceof GLib.Error && error.matches(Gio.IOErrorEnum, Gio.IOErrorEnum.CANCELLED))
        return;
    logError(error instanceof Object ? error : new Error(String(error)), message);
}
