import Meta from 'gi://Meta';

import {IDLE_ANIMATION} from './animations.js';
import {Annoyance, type PokeKind} from './mood.js';
import type {AnimationPlayer} from './player.js';
import type {Positioner} from './positioner.js';
import type {CrepeSettings} from './settings.js';
import type {TimerPool} from './timers.js';
import {BREAK_AFTER_IDLE_MS, ContinuousActivity, isPastBedtime} from './trackers.js';
import type {LineValues, TriggerEvent} from './voice.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const BLINK_EVERY: [number, number] = [3 * SECOND, 8 * SECOND];
const FIDGET_EVERY: [number, number] = [60 * SECOND, 180 * SECOND];
const CRAWL_EVERY: [number, number] = [3 * MINUTE, 8 * MINUTE];
const COMMENT_EVERY: [number, number] = [20 * MINUTE, 40 * MINUTE];
/** A remark only comes from the resting pose; if she is mid-gesture, try again shortly. */
const COMMENT_RETRY = 5 * SECOND;
/** Pause between two reactions, so a burst of notifications does not turn her into a strobe light. */
const REACTION_COOLDOWN = 4 * SECOND;
/** Crawl speed in sprite pixels per second; multiplied by the on-screen scale. */
const CRAWL_SPEED = 10;
/** Woken up past bedtime, she gives the evening this long before going back to bed. */
const BEDTIME_RESLEEP_AFTER = 10 * MINUTE;
const PAUSE_CHECK_EVERY = 60 * SECOND;

/** Looped while a window title keeps her waiting. */
const TAPPING = 'tapote';

/** Rare gestures while she waits. Looks are resolved towards the pointer. */
const FIDGETS = ['respiration', 'soupir', 'baillement', 'regard', 'regard'] as const;

/**
 * What each reaction gives her to talk about. 'coucou' only comes from a
 * click. Pointing has nothing of its own: a notification passes its event.
 */
const REACTION_EVENTS: Record<string, TriggerEvent> = {
    sursaut: 'notification',
    facepalm: 'erreur',
    pouce: 'succes',
    coucou: 'clic',
    applaudissement: 'enfin',
    gratter: 'perplexe',
};

/** Told about moments worth a line: reactions, falling asleep, waking up, idle remarks, being pestered. */
export type BehaviourEventListener = (event: TriggerEvent, values?: LineValues) => void;

export interface ReactionOptions {
    /** Says this instead of the reaction's usual line. */
    event?: TriggerEvent;
}

/**
 * What Crêpe does on her own. She mostly sits still and blinks; now and
 * then she sighs, yawns, glances at the pointer or crawls somewhere else.
 * She falls asleep when you leave, or by herself past bedtime, and waves
 * when you come back. Pester her too much and she swings her bat, then
 * sulks for a minute. Work too long without a break and she yawns at you.
 * A window that keeps her waiting gets her tapping, and with notification
 * banners off she says nothing at all.
 * Trips she is sent on (hiding, perching) go through `travel()`.
 */
export class IdleBehaviour {
    private readonly player: AnimationPlayer;
    private readonly timers: TimerPool;
    private readonly positioner: Positioner;
    private readonly settings: CrepeSettings;
    private readonly spriteCenterX: () => number;
    private readonly spriteScale: () => number;
    private readonly idleMonitor: Meta.IdleMonitor;
    private readonly onEvent: BehaviourEventListener;
    private readonly mood = new Annoyance();
    private readonly activity = new ContinuousActivity();

    private cancelBlink: (() => void) | null = null;
    private cancelFidget: (() => void) | null = null;
    private cancelCrawl: (() => void) | null = null;
    private cancelComment: (() => void) | null = null;
    private cancelSulkEnd: (() => void) | null = null;
    private cancelPauseCheck: (() => void) | null = null;
    private idleWatchId: number | null = null;
    private activeWatchId: number | null = null;
    private breakWatchId: number | null = null;
    private lastReactionAt = 0;
    private asleep = false;
    private crawling = false;
    /** Tapping until a window is done loading; gestures come back to it instead of resting. */
    private tapping = false;
    /** The crawl in progress is a trip she was sent on, not one of her own. */
    private errand = false;
    private dragging = false;
    private running = false;
    /** Off-screen, or on her way there or back. */
    private away = false;
    private onWakeWhileAway: (() => void) | null = null;
    private wokeWhileAway = false;
    /** Perched on a window, a crawl of her own would walk off it. */
    private crawlAllowed = true;
    private hushed = false;
    private bedtimeAllowedAt = 0;

    constructor(
        player: AnimationPlayer,
        timers: TimerPool,
        positioner: Positioner,
        settings: CrepeSettings,
        sprite: {centerX: () => number; scale: () => number},
        onEvent: BehaviourEventListener = () => {},
    ) {
        this.player = player;
        this.timers = timers;
        this.positioner = positioner;
        this.settings = settings;
        this.spriteCenterX = sprite.centerX;
        this.spriteScale = sprite.scale;
        this.idleMonitor = global.backend.get_core_idle_monitor();
        this.onEvent = onEvent;
    }

    start(): void {
        if (this.running)
            return;
        this.running = true;
        this.player.play(IDLE_ANIMATION);
        this.scheduleBlink();
        this.scheduleFidget();
        this.scheduleCrawl();
        this.scheduleComment();
        // Hidden mid-sulk: the end-of-sulk timer went with stop(), and nothing else would restart the fidgets.
        if (this.mood.isSulking)
            this.scheduleSulkEnd();
        this.armSleepWatch();
        this.schedulePauseCheck();
        this.breakWatchId = this.idleMonitor.add_idle_watch(BREAK_AFTER_IDLE_MS, () => this.activity.tookBreak());
    }

    stop(): void {
        this.running = false;
        this.cancelTimers();
        this.cancelSulkEnd?.();
        this.cancelSulkEnd = null;
        this.disarmSleepWatch();
        if (this.activeWatchId !== null) {
            this.idleMonitor.remove_watch(this.activeWatchId);
            this.activeWatchId = null;
        }
        if (this.breakWatchId !== null) {
            this.idleMonitor.remove_watch(this.breakWatchId);
            this.breakWatchId = null;
        }
        this.cancelPauseCheck?.();
        this.cancelPauseCheck = null;
        this.stopCrawl();
        this.tapping = false;
        this.asleep = false;
        this.dragging = false;
        this.away = false;
        this.onWakeWhileAway = null;
        this.wokeWhileAway = false;
        this.player.stop();
    }

    get isHushed(): boolean {
        return this.hushed;
    }

    /**
     * She is being carried: drop whatever she was doing, crawl included,
     * and hold the resting pose until `resumeAfterDrag()`.
     */
    interruptForDrag(): void {
        if (!this.running)
            return;
        this.dragging = true;
        this.cancelTimers();
        this.stopCrawl();
        this.tapping = false;
        // Being picked up is activity; a pending wake-up wave would play mid-air.
        this.asleep = false;
        this.player.play(IDLE_ANIMATION);
    }

    resumeAfterDrag(): void {
        if (!this.running || !this.dragging)
            return;
        this.dragging = false;
        this.resumeRoutine();
    }

    /**
     * She is leaving the screen: no fidgets, crawls, remarks, reactions
     * or pestering until `resume()`. Falling asleep out there is silent,
     * and waking up calls `onWake` so whoever sent her away can bring her back.
     */
    suspend(onWake: () => void): void {
        if (!this.running)
            return;
        this.away = true;
        this.onWakeWhileAway = onWake;
        this.tapping = false;
        this.cancelTimers();
    }

    /** Back on screen: the routine starts again, with a wave if she was woken up out there. */
    resume(): void {
        if (!this.running || !this.away)
            return;
        this.away = false;
        this.onWakeWhileAway = null;
        // Dozed off on the way back, unseen; the next activity wakes her as usual.
        if (this.asleep) {
            this.player.play('endormie');
            return;
        }
        if (this.wokeWhileAway) {
            this.wokeWhileAway = false;
            this.greet();
            return;
        }
        this.resumeRoutine();
    }

    /**
     * Crawls her along a path someone else drives (hiding, perching): the
     * crawl loop faces the way she goes while `move` runs. Her own crawl
     * and gestures stop for it. Refused while she sleeps or is carried;
     * `onArrived` only fires if the trip completes.
     */
    travel(goingRight: boolean, move: (onArrived: () => void) => void, onArrived: () => void): boolean {
        if (!this.running || this.asleep || this.dragging)
            return false;
        this.cancelTimers();
        this.stopCrawl();
        this.tapping = false;
        this.crawling = true;
        this.errand = true;
        this.player.play(goingRight ? 'ramper_droite' : 'ramper_gauche');
        move(() => {
            this.crawling = false;
            this.errand = false;
            this.player.play(IDLE_ANIMATION);
            // The idle watch fires once per idle stretch, and fallAsleep() ignored it on the way.
            if (this.idleMonitor.get_idletime() >= this.settings.sleepAfterMs)
                this.fallAsleep('endormissement', true);
            else if (!this.away)
                this.resumeRoutine();
            onArrived();
        });
        return true;
    }

    /** No crawls of her own while she sits on a window; she would walk off it. */
    allowCrawling(allowed: boolean): void {
        this.crawlAllowed = allowed;
        if (this.running && !this.crawling)
            this.scheduleCrawl();
    }

    /**
     * Notification banners are off, whoever turned them off: she puts a
     * tentacle to her mouth and says nothing at all until they are back
     * on, which she remarks on. She still jumps when a notification comes
     * in. `announce` false only follows the setting, as at start-up.
     */
    chut(hushed: boolean, announce: boolean): void {
        if (hushed === this.hushed)
            return;
        this.hushed = hushed;
        if (!announce)
            return;
        if (hushed)
            this.react('chut');
        else
            this.remark('fin_du_chut');
    }

    /** A line about what goes on around her (music, a pile of notifications). Kept to herself while away or asleep. */
    remark(event: TriggerEvent, values?: LineValues): void {
        if (!this.running || this.asleep || this.away)
            return;
        this.say(event, values);
    }

    /**
     * A window title has said "loading" for too long: she taps a tentacle,
     * over and over, until `stopTapping()`. Gestures in between come back
     * to it. Refused while asleep, away, crawling or carried.
     */
    startTapping(): boolean {
        if (!this.running || this.asleep || this.away || this.crawling || this.dragging || this.tapping)
            return false;
        this.tapping = true;
        this.cancelTimers();
        this.player.play(TAPPING);
        this.say('impatience');
        return true;
    }

    /** The wait is over (the title moved on, or focus did): back to the resting pose and her routine. */
    stopTapping(): void {
        if (!this.tapping)
            return;
        this.tapping = false;
        this.scheduleCrawl();
        this.scheduleComment();
        // Mid-gesture, the end of the gesture brings the resting pose and the fidgets back.
        if (this.player.currentName !== TAPPING)
            return;
        this.player.play(IDLE_ANIMATION);
        this.scheduleBlink();
        this.scheduleFidget();
    }

    /** Settings changed: re-arm whatever depends on them. */
    refresh(): void {
        if (!this.running)
            return;
        this.disarmSleepWatch();
        this.armSleepWatch();
        this.scheduleCrawl();
    }

    /**
     * Plays a reaction (notification, error, task done...), then goes back
     * to waiting. Ignored while asleep or away, mid-crawl, right after
     * another reaction, and while she is being dragged.
     */
    react(name: string, options: ReactionOptions = {}): boolean {
        if (!this.running || this.asleep || this.away || this.crawling || this.dragging || !this.player.has(name))
            return false;
        const now = Date.now();
        if (now - this.lastReactionAt < REACTION_COOLDOWN)
            return false;
        this.lastReactionAt = now;
        this.playGesture(name);
        const event = options.event ?? REACTION_EVENTS[name];
        if (event)
            this.say(event);
        return true;
    }

    /**
     * A click on her, or a drop after carrying her. Each one adds to her
     * annoyance: calm, she waves; annoyed, she looks away; past the limit
     * she swings the bat once and sulks for a minute, answering in
     * monosyllables.
     */
    pester(kind: PokeKind): void {
        // On an errand she has somewhere to be; a swing would leave her stranded halfway.
        if (!this.running || this.asleep || this.away || this.errand)
            return;
        const {level, becameAngry} = this.mood.poke(kind);
        if (becameAngry) {
            this.swingBat();
            return;
        }
        if (this.mood.isSulking) {
            // The poke pushed the end of the sulk back.
            this.scheduleSulkEnd();
            this.say(kind === 'click' ? 'boude' : 'deplacee');
            return;
        }
        if (level === 'calm') {
            if (kind === 'click')
                this.react('coucou');
            return;
        }
        if (kind === 'drag') {
            this.say('deplacee');
            return;
        }
        this.lookAway();
        this.say('agacee');
    }

    /** The opposite of a fidget's glance: she turns her eyes away from whoever keeps clicking. */
    private lookAway(): void {
        if (this.crawling)
            return;
        const [pointerX] = global.get_pointer();
        this.playGesture(pointerX < this.spriteCenterX() ? 'regard_droite' : 'regard_gauche');
    }

    /** The one swing per sulk. Whatever she was doing stops for it, a crawl included. */
    private swingBat(): void {
        this.cancelTimers();
        this.stopCrawl();
        this.tapping = false;
        // A notification landing right now would cut the swing short.
        this.lastReactionAt = Date.now();
        this.playGesture('batte');
        this.say('enervee');
        this.scheduleSulkEnd();
    }

    private scheduleSulkEnd(): void {
        this.cancelSulkEnd?.();
        this.cancelSulkEnd = this.timers.schedule(this.mood.sulkRemainingMs, () => this.endSulk());
    }

    private endSulk(): void {
        this.cancelSulkEnd = null;
        // GLib's monotonic clock and the wall clock the mood uses can disagree by a few milliseconds.
        if (this.mood.isSulking) {
            this.scheduleSulkEnd();
            return;
        }
        // Asleep, carried or away, waking up, the drop or the return reschedules everything anyway.
        if (!this.running || this.asleep || this.dragging || this.away)
            return;
        this.scheduleFidget();
        this.scheduleCrawl();
        this.scheduleComment();
    }

    private playGesture(name: string, onDone: () => void = () => {}): void {
        this.cancelBlink?.();
        this.cancelBlink = null;
        this.cancelFidget?.();
        this.cancelFidget = null;
        this.player.play(name, {
            onDone: () => {
                if (this.tapping)
                    this.player.play(TAPPING);
                else
                    this.scheduleBlink();
                this.scheduleFidget();
                onDone();
            },
        });
    }

    /** Every line goes through here: with banners off she keeps them all to herself. */
    private say(event: TriggerEvent, values?: LineValues): void {
        if (this.hushed)
            return;
        this.onEvent(event, values);
    }

    private resumeRoutine(): void {
        this.scheduleBlink();
        this.scheduleFidget();
        this.scheduleCrawl();
        this.scheduleComment();
    }

    private scheduleBlink(): void {
        this.cancelBlink?.();
        this.cancelBlink = this.schedule(BLINK_EVERY, () => {
            this.cancelBlink = null;
            // Only blink from the resting pose; never interrupt a gesture.
            if (this.player.currentName === IDLE_ANIMATION)
                this.player.play('clignement', {onDone: () => this.scheduleBlink()});
            else
                this.scheduleBlink();
        });
    }

    private scheduleFidget(): void {
        this.cancelFidget?.();
        this.cancelFidget = null;
        // A sulking octopus does not sigh for show; endSulk() brings the fidgets back. Tapping is fidget enough.
        if (this.mood.isSulking || this.away || this.tapping)
            return;
        this.cancelFidget = this.schedule(FIDGET_EVERY, () => {
            this.cancelFidget = null;
            this.playGesture(this.pickFidget(), () => this.goToBedIfLate());
        });
    }

    private scheduleCrawl(): void {
        this.cancelCrawl?.();
        this.cancelCrawl = null;
        if (!this.settings.crawl || !this.crawlAllowed || this.away || this.mood.isSulking || this.tapping)
            return;
        this.cancelCrawl = this.schedule(CRAWL_EVERY, () => {
            this.cancelCrawl = null;
            this.crawl();
        });
    }

    private scheduleComment(): void {
        this.cancelComment?.();
        this.cancelComment = null;
        if (this.mood.isSulking || this.away)
            return;
        this.cancelComment = this.schedule(COMMENT_EVERY, () => this.comment());
    }

    private comment(): void {
        this.cancelComment = null;
        if (this.player.currentName !== IDLE_ANIMATION) {
            this.cancelComment = this.timers.schedule(COMMENT_RETRY, () => this.comment());
            return;
        }
        this.say('commentaire');
        this.scheduleComment();
    }

    private crawl(): void {
        const destination = this.positioner.pickDestination();
        if (destination === null || this.player.currentName !== IDLE_ANIMATION) {
            this.scheduleCrawl();
            return;
        }
        this.crawling = true;
        this.cancelBlink?.();
        this.cancelBlink = null;
        this.cancelFidget?.();
        this.cancelFidget = null;

        const goingRight = destination > this.spriteCenterX();
        this.player.play(goingRight ? 'ramper_droite' : 'ramper_gauche');
        this.positioner.moveTo(destination, CRAWL_SPEED * this.spriteScale(), () => {
            this.crawling = false;
            this.player.play(IDLE_ANIMATION);
            this.scheduleBlink();
            this.scheduleFidget();
            this.scheduleCrawl();
        });
    }

    private pickFidget(): string {
        const choice = FIDGETS[Math.floor(Math.random() * FIDGETS.length)] ?? 'soupir';
        if (choice !== 'regard')
            return choice;
        // Looking at the pointer reads as attention; looking away reads as a glitch.
        const [pointerX] = global.get_pointer();
        return pointerX < this.spriteCenterX() ? 'regard_gauche' : 'regard_droite';
    }

    /** Past bedtime, right after a fidget, she calls it a night; woken up, she gives the evening ten minutes first. */
    private goToBedIfLate(): void {
        if (!isPastBedtime(new Date(), this.settings.bedtimeHour) || Date.now() < this.bedtimeAllowedAt)
            return;
        this.fallAsleep('couche_tard', false);
    }

    /** Every minute: has the user been at it long enough to need a break? */
    private schedulePauseCheck(): void {
        this.cancelPauseCheck = this.timers.schedule(PAUSE_CHECK_EVERY, () => {
            this.cancelPauseCheck = null;
            this.checkPause();
            this.schedulePauseCheck();
        });
    }

    private checkPause(): void {
        const now = Date.now();
        if (!this.activity.isDue(this.idleMonitor.get_idletime(), now, this.settings.pauseReminderMs))
            return;
        // Asleep, away or busy, she says it at the next check instead.
        if (this.react('baillement', {event: 'pause'}))
            this.activity.reminded(now);
    }

    private armSleepWatch(): void {
        this.idleWatchId = this.idleMonitor.add_idle_watch(this.settings.sleepAfterMs, () => this.onIdle());
    }

    private disarmSleepWatch(): void {
        if (this.idleWatchId === null)
            return;
        this.idleMonitor.remove_watch(this.idleWatchId);
        this.idleWatchId = null;
    }

    private onIdle(): void {
        // Already asleep: a bedtime nap taken while the user was still there.
        // Now that they have left too, their return wakes her as it always does.
        if (this.asleep) {
            this.armWakeWatch();
            return;
        }
        this.fallAsleep('endormissement', true);
    }

    /**
     * `wakeOnActivity` is false for a bedtime nap: the user is still
     * working, and the very next keystroke would wake her. That nap ends
     * like any other sleep, once they have left and come back.
     */
    private fallAsleep(line: TriggerEvent, wakeOnActivity: boolean): void {
        // An errand checks the idle time again when it arrives.
        if (!this.running || this.asleep || this.dragging || this.errand)
            return;
        this.asleep = true;
        if (wakeOnActivity)
            this.armWakeWatch();
        // Off-screen nobody sees her doze off.
        if (this.away)
            return;
        this.cancelTimers();
        this.stopCrawl();
        this.tapping = false;
        this.player.play('endormie');
        this.say(line);
    }

    private armWakeWatch(): void {
        if (this.activeWatchId !== null)
            return;
        // One-shot by design: Mutter drops it after it fires.
        this.activeWatchId = this.idleMonitor.add_user_active_watch(() => {
            this.activeWatchId = null;
            this.wakeUp();
        });
    }

    private wakeUp(): void {
        if (!this.running || !this.asleep)
            return;
        this.asleep = false;
        this.bedtimeAllowedAt = Date.now() + BEDTIME_RESLEEP_AFTER;
        if (this.away) {
            this.wokeWhileAway = true;
            this.onWakeWhileAway?.();
            return;
        }
        this.greet();
    }

    private greet(): void {
        this.player.play('coucou', {onDone: () => this.resumeRoutine()});
        this.say('retour');
    }

    private stopCrawl(): void {
        if (!this.crawling)
            return;
        this.positioner.cancelMove();
        this.crawling = false;
        this.errand = false;
    }

    private cancelTimers(): void {
        this.cancelBlink?.();
        this.cancelBlink = null;
        this.cancelFidget?.();
        this.cancelFidget = null;
        this.cancelCrawl?.();
        this.cancelCrawl = null;
        this.cancelComment?.();
        this.cancelComment = null;
    }

    private schedule([min, max]: [number, number], callback: () => void): () => void {
        return this.timers.schedule(min + Math.random() * (max - min), callback);
    }
}
