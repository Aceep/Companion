import type Gio from 'gi://Gio';

const MINUTE = 60 * 1000;

export type SettingsKey =
    | 'visible'
    | 'scale'
    | 'sleep-after-minutes'
    | 'crawl'
    | 'talk'
    | 'react-to-notifications'
    | 'react-to-windows'
    | 'error-keywords'
    | 'success-keywords'
    | 'busy-keywords'
    | 'fraction-x'
    | 'fraction-y'
    | 'perch'
    | 'bedtime-hour'
    | 'pause-reminder-minutes'
    | 'react-to-music';

/** Typed, cleanup-friendly view over the extension's GSettings. */
export class CrepeSettings {
    readonly gsettings: Gio.Settings;
    private readonly handlerIds: number[] = [];

    constructor(gsettings: Gio.Settings) {
        this.gsettings = gsettings;
    }

    get visible(): boolean {
        return this.gsettings.get_boolean('visible');
    }

    set visible(value: boolean) {
        this.gsettings.set_boolean('visible', value);
    }

    get scale(): number {
        return this.gsettings.get_int('scale');
    }

    get sleepAfterMs(): number {
        return this.gsettings.get_int('sleep-after-minutes') * MINUTE;
    }

    get crawl(): boolean {
        return this.gsettings.get_boolean('crawl');
    }

    set crawl(value: boolean) {
        this.gsettings.set_boolean('crawl', value);
    }

    get talk(): boolean {
        return this.gsettings.get_boolean('talk');
    }

    set talk(value: boolean) {
        this.gsettings.set_boolean('talk', value);
    }

    get reactToNotifications(): boolean {
        return this.gsettings.get_boolean('react-to-notifications');
    }

    get reactToWindows(): boolean {
        return this.gsettings.get_boolean('react-to-windows');
    }

    get errorKeywords(): string[] {
        return this.gsettings.get_strv('error-keywords');
    }

    get successKeywords(): string[] {
        return this.gsettings.get_strv('success-keywords');
    }

    get busyKeywords(): string[] {
        return this.gsettings.get_strv('busy-keywords');
    }

    get perch(): boolean {
        return this.gsettings.get_boolean('perch');
    }

    /** 0 means no bedtime. */
    get bedtimeHour(): number {
        return this.gsettings.get_int('bedtime-hour');
    }

    /** 0 means no reminder. */
    get pauseReminderMs(): number {
        return this.gsettings.get_int('pause-reminder-minutes') * MINUTE;
    }

    get reactToMusic(): boolean {
        return this.gsettings.get_boolean('react-to-music');
    }

    get fractionX(): number {
        return this.gsettings.get_double('fraction-x');
    }

    set fractionX(value: number) {
        this.gsettings.set_double('fraction-x', value);
    }

    get fractionY(): number {
        return this.gsettings.get_double('fraction-y');
    }

    set fractionY(value: number) {
        this.gsettings.set_double('fraction-y', value);
    }

    onChanged(key: SettingsKey, callback: () => void): void {
        this.handlerIds.push(this.gsettings.connect(`changed::${key}`, callback));
    }

    destroy(): void {
        for (const id of this.handlerIds)
            this.gsettings.disconnect(id);
        this.handlerIds.length = 0;
    }
}
