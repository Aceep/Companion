/** Titles are quoted inside a short line; past this they are cut. */
export const TITLE_MAX_LENGTH = 30;
/** The same track reported by two sources inside this is one track. */
const SAME_TRACK_WINDOW_MS = 10 * 60 * 1000;
/** Two ends of music reported inside this are one silence. */
const SAME_SILENCE_WINDOW_MS = 2 * 60 * 1000;
const TITLE_ARTIST_SEPARATOR = ' — ';

export function truncateTitle(title: string): string {
    return title.length > TITLE_MAX_LENGTH ? `${title.slice(0, TITLE_MAX_LENGTH - 1)}…` : title;
}

/** The title of a daemon's "Titre — Artiste"; the whole text when it has no artist. */
export function titleOf(text: string): string {
    const at = text.lastIndexOf(TITLE_ARTIST_SEPARATOR);
    return (at > 0 ? text.slice(0, at) : text).trim();
}

function keyOf(title: string): string {
    return truncateTitle(title).toLowerCase().replace(/\s+/g, ' ').trim();
}

/**
 * Music reaches her from two places: the MPRIS player on this desktop
 * and the daemon's Spotify watcher, which also sees other devices. This
 * keeps it to one remark per track, whichever tells first. While a
 * player on this desktop plays, the daemon is not listened to: MPRIS
 * knows better. Pure bookkeeping, timestamps come in.
 */
export class TrackGate {
    private readonly localPlaying: () => boolean;
    private lastKey: string | null = null;
    private lastTrackAt = 0;
    private lastSilenceAt = -Infinity;

    constructor(localPlaying: () => boolean) {
        this.localPlaying = localPlaying;
    }

    /** The desktop's player started a track (`title` null when it says none). True when it is worth a remark. */
    localTrack(title: string | null, now: number): boolean {
        return this.record(title === null ? null : keyOf(title), now);
    }

    /** The title to quote for a track the daemon saw, or null when it is not worth a remark. */
    remoteTrack(text: string, now: number): string | null {
        const title = titleOf(text);
        if (title.length === 0 || this.localPlaying())
            return null;
        return this.record(keyOf(title), now) ? truncateTitle(title) : null;
    }

    localSilence(now: number): boolean {
        return this.recordSilence(now);
    }

    remoteSilence(now: number): boolean {
        return !this.localPlaying() && this.recordSilence(now);
    }

    private record(key: string | null, now: number): boolean {
        const repeat = key !== null && key === this.lastKey && now - this.lastTrackAt < SAME_TRACK_WINDOW_MS;
        this.lastKey = key;
        this.lastTrackAt = now;
        return !repeat;
    }

    private recordSilence(now: number): boolean {
        const repeat = now - this.lastSilenceAt < SAME_SILENCE_WINDOW_MS;
        this.lastSilenceAt = now;
        return !repeat;
    }
}
