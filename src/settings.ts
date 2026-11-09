import type Gio from 'gi://Gio';

import {isRoomDirection, type RoomDirection} from './monitors.js';

const MINUTE = 60 * 1000;

/** Read by the window manager itself, which binds the shortcut straight from the schema. */
export const TALK_SHORTCUT_KEY = 'talk-shortcut';

/** Over every window like the shell's own chrome, or under them, just above the desktop. */
export type Layer = 'top' | 'behind';

export type SettingsKey =
    | 'visible'
    | 'scale'
    | 'sleep-after-minutes'
    | 'crawl'
    | 'talk'
    | 'crepe-speech'
    | 'react-to-notifications'
    | 'react-to-windows'
    | 'error-keywords'
    | 'success-keywords'
    | 'busy-keywords'
    | 'home-monitor'
    | 'fraction-x'
    | 'fraction-y'
    | 'perch'
    | 'eyes-follow'
    | 'dodge'
    | 'layer'
    | 'bedtime-hour'
    | 'pause-reminder-minutes'
    | 'react-to-music'
    | 'brain'
    | 'brain-remarks'
    | 'comment-interval-minutes'
    | 'crawl-interval-minutes'
    | 'homesick-percent'
    | 'focus-minutes'
    | 'focus-dnd'
    | 'hide-during-screencast'
    | 'quiet-during-calls'
    | 'recap'
    | 'recap-hour'
    | 'last-recap-date'
    | 'stats'
    | 'outfits'
    | 'outfit-override'
    | 'birthday'
    | 'last-outfit-lines'
    | 'reminders'
    | 'ink'
    | 'last-week-bilan'
    | 'last-gag-date';

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

    /** Share, from 0 to 100, of her lines said in Crêpe with the sentence in clear below. */
    get crepeSpeech(): number {
        return this.gsettings.get_int('crepe-speech');
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

    get eyesFollow(): boolean {
        return this.gsettings.get_boolean('eyes-follow');
    }

    /** Move out of the focused window's way; only on top of the windows, where she could be in it. */
    get dodge(): boolean {
        return this.gsettings.get_boolean('dodge');
    }

    get layer(): Layer {
        return this.gsettings.get_string('layer') === 'behind' ? 'behind' : 'top';
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

    /** Talk with the conversation daemon when it runs. */
    get brain(): boolean {
        return this.gsettings.get_boolean('brain');
    }

    get brainRemarks(): boolean {
        return this.gsettings.get_boolean('brain-remarks');
    }

    /** Average wait between two idle remarks; 0 means none. */
    get commentIntervalMs(): number {
        return this.gsettings.get_int('comment-interval-minutes') * MINUTE;
    }

    /** Average wait between two crawls of her own; 0 means none, whatever `crawl` says. */
    get crawlIntervalMs(): number {
        return this.gsettings.get_int('crawl-interval-minutes') * MINUTE;
    }

    /** Chance, between 0 and 1, that a calm octopus crawls back after a drop. */
    get homesickChance(): number {
        return this.gsettings.get_int('homesick-percent') / 100;
    }

    get focusMinutes(): number {
        return this.gsettings.get_int('focus-minutes');
    }

    get focusMs(): number {
        return this.focusMinutes * MINUTE;
    }

    /** Turn the desktop's banners off while she helps you focus. */
    get focusDnd(): boolean {
        return this.gsettings.get_boolean('focus-dnd');
    }

    /** Leave the stage while the screen is shared or recorded. */
    get hideDuringScreencast(): boolean {
        return this.gsettings.get_boolean('hide-during-screencast');
    }

    /** Keep quiet while an application uses the microphone or a camera. */
    get quietDuringCalls(): boolean {
        return this.gsettings.get_boolean('quiet-during-calls');
    }

    get recap(): boolean {
        return this.gsettings.get_boolean('recap');
    }

    get recapHour(): number {
        return this.gsettings.get_int('recap-hour');
    }

    /** "YYYY-MM-DD", or "" before the first recap. */
    get lastRecapDate(): string {
        return this.gsettings.get_string('last-recap-date');
    }

    set lastRecapDate(value: string) {
        this.gsettings.set_string('last-recap-date', value);
    }

    /** The daily counters, as JSON; `StatsStore` reads and writes it. */
    get stats(): string {
        return this.gsettings.get_string('stats');
    }

    set stats(value: string) {
        this.gsettings.set_string('stats', value);
    }

    /** The master switch for her outfits. */
    get outfits(): boolean {
        return this.gsettings.get_boolean('outfits');
    }

    /** An outfit id she wears whatever the date, or "" to follow the rules. */
    get outfitOverride(): string {
        return this.gsettings.get_string('outfit-override');
    }

    /** "MM-DD". */
    get birthday(): string {
        return this.gsettings.get_string('birthday');
    }

    /** JSON object: the day, as "YYYY-MM-DD", each outfit last got its line. */
    get lastOutfitLines(): string {
        return this.gsettings.get_string('last-outfit-lines');
    }

    set lastOutfitLines(value: string) {
        this.gsettings.set_string('last-outfit-lines', value);
    }

    /** The pending reminders, as JSON; `ReminderCenter` reads and writes it. */
    get reminders(): string {
        return this.gsettings.get_string('reminders');
    }

    set reminders(value: string) {
        this.gsettings.set_string('reminders', value);
    }

    /** Spit ink when she is furious. */
    get ink(): boolean {
        return this.gsettings.get_boolean('ink');
    }

    /** "YYYY-MM-DD" of the Friday of the last weekly bilan, or "". */
    get lastWeekBilan(): string {
        return this.gsettings.get_string('last-week-bilan');
    }

    set lastWeekBilan(value: string) {
        this.gsettings.set_string('last-week-bilan', value);
    }

    /** "YYYY-MM-DD" of the last day she brought up a fact of the week, or "". */
    get lastGagDate(): string {
        return this.gsettings.get_string('last-gag-date');
    }

    set lastGagDate(value: string) {
        this.gsettings.set_string('last-gag-date', value);
    }

    /** The monitor she lives on, by where it is from the primary one; her fractions are of its work area. */
    get homeMonitor(): RoomDirection {
        const value = this.gsettings.get_string('home-monitor');
        return isRoomDirection(value) ? value : 'primary';
    }

    set homeMonitor(value: RoomDirection) {
        this.gsettings.set_string('home-monitor', value);
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
