import Meta from 'gi://Meta';

import {Recollection} from './context.js';
import type {Point} from './geometry.js';
import {gazePose, restPoseOf, type GazeDirection, type GazeHolder} from './gaze.js';
import {Annoyance, type MoodLevel, type PokeKind} from './mood.js';
import {IDLE_ANIMATION, type AnimationPlayer} from './player.js';
import type {Positioner} from './positioner.js';
import type {CrepeSettings} from './settings.js';
import type {StatCounter} from './stats.js';
import type {TimerPool} from './timers.js';
import {BREAK_AFTER_IDLE_MS, ContinuousActivity, isPastBedtime} from './trackers.js';
import type {LineValues, TriggerEvent} from './voice.js';

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const BLINK_EVERY: [number, number] = [3 * SECOND, 8 * SECOND];
const FIDGET_EVERY: [number, number] = [60 * SECOND, 180 * SECOND];
/** Crawls and remarks come every so often around the set average, never like clockwork. */
const INTERVAL_SPREAD: [number, number] = [2 / 3, 4 / 3];
/** A remark only comes from the resting pose; if she is mid-gesture, try again shortly. */
const COMMENT_RETRY = 5 * SECOND;
/** With the daemon's remarks on, one idle remark in three is its own; the written lines stay the staple. */
const BRAIN_REMARK_CHANCE = 1 / 3;
/** Pause between two reactions, so a burst of notifications does not turn her into a strobe light. */
const REACTION_COOLDOWN = 4 * SECOND;
/** Crawl speed in sprite pixels per second; multiplied by the on-screen scale. */
const CRAWL_SPEED = 10;
/** Woken up past bedtime, she gives the evening this long before going back to bed. */
const BEDTIME_RESLEEP_AFTER = 10 * MINUTE;
/** How long she stays off the screen once pestered past her sulk. */
const FURIOUS_ABSENCE = 60 * SECOND;
const PAUSE_CHECK_EVERY = 60 * SECOND;

/** Looped while a window title keeps her waiting. */
const TAPPING = 'tapote';
/** A nudge's tapping is a loop too; it stops on its own after this. */
const BRIEF_TAP = 3 * SECOND;

/** While she sulks she rests, and blinks, with the bat held in front of her. */
const BAT_HELD = 'batte_tenue';
const BAT_HELD_BLINK = 'batte_clignement';
/** The swing played backwards: the sulk is over, the bat goes back behind her. */
const BAT_PUT_AWAY = 'batte_rangee';

/** Annoyed, she is that many times as likely as calm to crawl back after a drop. */
const HOMESICK_ANNOYED_FACTOR = 2;
/** Stage pixels: dropped this close to where she was, there is nowhere to go back to. */
const HOMESICK_MIN_DISTANCE = 40;

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

/** Something a script told her about, through the extension's own D-Bus object. */
export interface NudgeReaction {
    /** What the daemon is told happened, as the script named it. */
    kind: string;
    gesture: string | null;
    event: TriggerEvent | null;
    values?: LineValues;
    /** Worth waking her up for: she wakes with a start instead of sleeping through it. */
    wakes?: boolean;
}

/** Whoever moves her around the screen, for storming off when pestered past her sulk and coming back. */
export interface StormHandler {
    /** Off the screen, out of sight and out of reach; false when she could not set off. */
    leave: () => boolean;
    /** Back to her spot; `onHome` once she is there. */
    comeBack: (onHome: () => void) => void;
}

/** Told when a focus session starts or ends, before her line about it, so the banners can follow. */
export type FocusListener = (focusing: boolean) => void;

/** Told each time something worth counting happens to her. */
export type StatsListener = (counter: StatCounter) => void;

/** Told when she stops tapping at a wait, whatever stopped her: the wait may still be on. */
export type TappingListener = () => void;

/**
 * Asked to spit ink when she loses her temper: `storm` as she leaves,
 * `sulk` when poked while sulking. True when ink really came, which
 * the poke's line then says.
 */
export type InkHandler = (reason: 'storm' | 'sulk') => boolean;

/** Where an idle remark may come from instead of the written lines: the conversation daemon. */
export interface RemarkSource {
    /** Null when it is not there to ask, or not allowed to; resolves to "" when it has nothing to say, and she says nothing. */
    ask: () => Promise<string> | null;
    show: (line: string) => void;
}

/**
 * What Crêpe does on her own. She mostly sits still and blinks; now and
 * then she sighs, yawns, glances at the pointer or crawls somewhere else.
 * She falls asleep when you leave, or by herself past bedtime, and waves
 * when you come back. Pester her too much and she swings her bat, then
 * sulks for a minute and a half with it in hand; keep at it while she sulks
 * and she storms off the screen for a minute. Carried somewhere she did
 * not ask to go, she sometimes crawls back to where she was. Work too long
 * without a break and she yawns at you.
 * A window that keeps her waiting gets her tapping, and with notification
 * banners off she says nothing at all.
 * Trips she is sent on (hiding, perching) go through `travel()`.
 * In a focus session she holds still and keeps to herself, so only
 * clicks and `attention` nudges get through until it ends.
 */
export class IdleBehaviour implements GazeHolder {
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
    /** What just happened to her, for the daemon. */
    readonly recollection = new Recollection();
    private remarkSource: RemarkSource | null = null;
    private stormHandler: StormHandler | null = null;
    private focusListener: FocusListener = () => {};
    private countStat: StatsListener = () => {};
    private tappingStopped: TappingListener = () => {};
    private inkHandler: InkHandler = () => false;
    /** She has already spat ink in this sulk: once is a gesture, twice is a habit. */
    private inkedThisSulk = false;
    /** Writable so a test can bring her back sooner. */
    furiousAbsenceMs = FURIOUS_ABSENCE;

    private cancelBlink: (() => void) | null = null;
    private cancelFidget: (() => void) | null = null;
    private cancelCrawl: (() => void) | null = null;
    private cancelComment: (() => void) | null = null;
    private cancelSulkEnd: (() => void) | null = null;
    private cancelPauseCheck: (() => void) | null = null;
    private cancelFuryEnd: (() => void) | null = null;
    private cancelFocusEnd: (() => void) | null = null;
    private cancelBriefTap: (() => void) | null = null;
    /** In a focus session, until its timer or `setFocus(0)` ends it. */
    private focusing = false;
    /** Stormed off the screen, until the fury timer brings her back. */
    private furious = false;
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
    /** In a call: every line is kept to herself, like with banners off. */
    private quiet = false;
    private hushed = false;
    private bedtimeAllowedAt = 0;
    /** Where she was picked up, for the drop to decide whether she crawls back there. */
    private dragOrigin: Point | null = null;
    /** Where her eyes point while she rests; null is straight ahead. */
    private gaze: GazeDirection | null = null;

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
        this.player.setRestingPose(() => this.restFrame);
    }

    start(): void {
        if (this.running)
            return;
        this.running = true;
        this.player.play(this.restFrame);
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
        this.cancelFuryEnd?.();
        this.cancelFuryEnd = null;
        this.cancelBriefTap?.();
        this.cancelBriefTap = null;
        // Hidden or disabled, the session ends without a word; whoever turned the banners off gets to restore them.
        this.endFocus(false);
        // Hidden or disabled while gone: shown again she is home, still sulking but no longer storming off.
        if (this.furious)
            this.mood.cameBack();
        this.furious = false;
        this.stopCrawl();
        this.endTapping();
        this.asleep = false;
        this.dragging = false;
        this.away = false;
        this.onWakeWhileAway = null;
        this.wokeWhileAway = false;
        this.dragOrigin = null;
        this.player.stop();
    }

    get isHushed(): boolean {
        return this.hushed;
    }

    /** A meeting is on: no line at all until it is over. The routine and the gestures go on. */
    setQuiet(quiet: boolean): void {
        this.quiet = quiet;
    }

    get moodLevel(): MoodLevel {
        return this.mood.level;
    }

    get isAsleep(): boolean {
        return this.asleep;
    }

    /** Bat in hand, or off the screen in a fury. */
    get isSulking(): boolean {
        return this.mood.isSulking;
    }

    get isFurious(): boolean {
        return this.furious;
    }

    get focusMode(): boolean {
        return this.focusing;
    }

    get isDragging(): boolean {
        return this.dragging;
    }

    /** On a crawl, her own or a trip she was sent on. */
    get isCrawling(): boolean {
        return this.crawling;
    }

    get isTapping(): boolean {
        return this.tapping;
    }

    /** Resting where she is, so her eyes may wander: not asleep, carried, off-screen, crawling or tapping. */
    get canFollowPointer(): boolean {
        return this.running && !this.asleep && !this.away && !this.dragging && !this.crawling && !this.tapping;
    }

    /**
     * Turns her eyes, or puts them back straight with null. Seen at once
     * when she is in her resting pose; mid-blink or mid-gesture, the pose
     * that comes after it looks that way.
     */
    lookTowards(direction: GazeDirection | null): void {
        if (direction === this.gaze)
            return;
        this.gaze = direction;
        if (this.running && this.isResting(this.player.currentName))
            this.player.play(this.restFrame);
    }

    setFocusListener(listener: FocusListener): void {
        this.focusListener = listener;
    }

    setStatsListener(listener: StatsListener): void {
        this.countStat = listener;
    }

    setTappingListener(listener: TappingListener): void {
        this.tappingStopped = listener;
    }

    setInkHandler(handler: InkHandler): void {
        this.inkHandler = handler;
    }

    /** A reminder of hers went unanswered: one more point of annoyance, short of a sulk. */
    irritate(): void {
        this.mood.irritate();
    }

    /**
     * Starts a focus session of `ms`, or ends the current one with a word
     * when `ms` is 0 or less. Starting one while in one restarts its clock.
     * Refused while she is not running. In a session: no remarks, crawls,
     * fidgets, bedtime or reactions; clicks and `attention` nudges only.
     */
    setFocus(ms: number): boolean {
        if (!this.running)
            return false;
        if (ms <= 0) {
            this.endFocus(true);
            return true;
        }
        this.cancelFocusEnd?.();
        this.cancelFocusEnd = this.timers.schedule(ms, () => {
            this.cancelFocusEnd = null;
            this.endFocus(true);
        });
        if (this.focusing)
            return true;
        this.focusing = true;
        this.countStat('focus');
        this.cancelFidget?.();
        this.cancelFidget = null;
        this.cancelCrawl?.();
        this.cancelCrawl = null;
        this.cancelComment?.();
        this.cancelComment = null;
        this.stopTapping();
        this.focusListener(true);
        return true;
    }

    /** `announce` false when she is going away anyway: nobody would see the line. */
    private endFocus(announce: boolean): void {
        this.cancelFocusEnd?.();
        this.cancelFocusEnd = null;
        if (!this.focusing)
            return;
        this.focusing = false;
        this.focusListener(false);
        if (!announce || !this.running)
            return;
        if (!this.asleep && !this.away && !this.dragging && !this.crawling)
            this.resumeRoutine();
        if (!this.asleep && !this.away)
            this.say('fin_concentration');
    }

    setRemarkSource(source: RemarkSource | null): void {
        this.remarkSource = source;
    }

    setStormHandler(handler: StormHandler | null): void {
        this.stormHandler = handler;
    }

    /**
     * She has just been told something and answers: a glance towards the
     * pointer, no more, and only from the resting pose (or a blink) so she
     * never cuts a gesture short for it.
     */
    acknowledge(): void {
        if (!this.running || this.asleep || this.away || this.crawling || this.dragging || this.tapping)
            return;
        // A blink is part of resting; cutting it short for the glance goes unnoticed.
        const current = this.player.currentName;
        if (!this.isResting(current) && current !== this.blinkName)
            return;
        const [pointerX] = global.get_pointer();
        this.playGesture(pointerX < this.spriteCenterX() ? 'regard_gauche' : 'regard_droite');
    }

    /** What she holds still in, and what every gesture falls back to. */
    private get restPose(): string {
        return this.mood.isSulking ? BAT_HELD : IDLE_ANIMATION;
    }

    /** The resting pose with her eyes where they look: what she actually shows while resting. */
    private get restFrame(): string {
        const frame = gazePose(this.restPose, this.gaze);
        return this.player.has(frame) ? frame : this.restPose;
    }

    /** `name` is the current resting pose, whichever way its eyes look. */
    private isResting(name: string | null): boolean {
        return restPoseOf(name) === this.restPose;
    }

    /** The blink drawn on top of the current resting pose. */
    private get blinkName(): string {
        return this.mood.isSulking ? BAT_HELD_BLINK : 'clignement';
    }

    /**
     * She is being carried: drop whatever she was doing, crawl included,
     * and hold the resting pose (bat in hand if she sulks) until
     * `resumeAfterDrag()`. Where she was picked up is kept for the drop.
     */
    interruptForDrag(): void {
        if (!this.running)
            return;
        this.dragging = true;
        this.cancelTimers();
        this.stopCrawl();
        const origin = this.positioner.position;
        // Picked up from the sliver left at the screen edge, there is no spot of hers to go back to.
        this.dragOrigin = this.positioner.isInsideArea(origin) ? origin : null;
        this.endTapping();
        // Being picked up is activity; a pending wake-up wave would play mid-air.
        this.asleep = false;
        // Carried, she looks straight ahead rather than at the hand holding her.
        this.gaze = null;
        this.player.play(this.restPose);
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
        this.endTapping();
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
        this.endTapping();
        this.crawling = true;
        this.errand = true;
        this.player.play(goingRight ? 'ramper_droite' : 'ramper_gauche');
        move(() => {
            this.crawling = false;
            this.errand = false;
            this.player.play(this.restFrame);
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
        // In a focus session she makes no show of it, whoever turned the banners off.
        if (!announce || this.focusing)
            return;
        if (hushed)
            this.react('chut');
        else
            this.remark('fin_du_chut');
    }

    /** A line about what goes on around her (music, a pile of notifications). Kept to herself while away or asleep. */
    remark(event: TriggerEvent, values?: LineValues): void {
        if (!this.running || this.asleep || this.away || this.focusing)
            return;
        this.say(event, values);
    }

    /**
     * A window title has said "loading" for too long: she taps a tentacle,
     * over and over, until `stopTapping()`. Gestures in between come back
     * to it. Refused while asleep, away, crawling or carried.
     */
    startTapping(): boolean {
        if (!this.running || this.asleep || this.away || this.crawling || this.dragging || this.tapping || this.focusing)
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
        this.endTapping();
        this.scheduleCrawl();
        this.scheduleComment();
        // Mid-gesture, the end of the gesture brings the resting pose and the fidgets back.
        if (this.player.currentName !== TAPPING)
            return;
        this.player.play(this.restFrame);
        this.scheduleBlink();
        this.scheduleFidget();
    }

    /**
     * The one way tapping ends, so whoever started it hears of it. The
     * routine is left to the caller: an interruption has its own plans.
     */
    private endTapping(): void {
        if (!this.tapping)
            return;
        this.tapping = false;
        this.tappingStopped();
    }

    /** Settings changed: re-arm whatever depends on them. */
    refresh(): void {
        if (!this.running)
            return;
        this.disarmSleepWatch();
        this.armSleepWatch();
        // Asleep, carried or crawling, whatever ends it reschedules both with the new settings.
        if (this.asleep || this.dragging || this.crawling)
            return;
        this.scheduleCrawl();
        this.scheduleComment();
    }

    /**
     * Plays a reaction (notification, error, task done...), then goes back
     * to waiting. Ignored while asleep or away, mid-crawl, right after
     * another reaction, while she is being dragged, and in a focus session.
     */
    react(name: string, options: ReactionOptions = {}): boolean {
        if (this.focusing)
            return false;
        return this.playReaction(name, options);
    }

    /** `react()` without the focus rule, for what still gets through it: a click. */
    private playReaction(name: string, options: ReactionOptions): boolean {
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
     * A script on the session bus wants her attention. Kept for the daemon
     * whatever happens; ignored while she is hidden or away, and while she
     * sleeps unless it is worth waking her for, in which case she wakes
     * with a start. The gesture plays when a reaction could; the line comes
     * either way. False when she took no notice at all. In a focus
     * session only `attention` gets through.
     */
    nudged(reaction: NudgeReaction): boolean {
        this.recollection.noteEvent(reaction.kind);
        if (!this.running || this.away || this.dragging)
            return false;
        // Only what is worth waking her for gets through a focus session.
        if (this.focusing && !reaction.wakes)
            return false;
        const wakingUp = this.asleep;
        if (wakingUp) {
            if (!reaction.wakes)
                return false;
            this.wakeWithAStart();
        }
        if (reaction.gesture)
            this.gestureIfFree(reaction.gesture, wakingUp);
        if (reaction.event)
            this.say(reaction.event, reaction.values, false);
        return true;
    }

    /**
     * A click on her, or a drop after carrying her. Each one adds to her
     * annoyance: calm, she waves; annoyed, she looks away; past the limit
     * she swings the bat once and sulks for a minute and a half, bat in
     * hand, answering in monosyllables. Pestered to the cap while she
     * sulks, she storms off the screen for a minute. A drop may send her crawling back
     * to where she was picked up, all the more likely the more fed up she is.
     */
    pester(kind: PokeKind): void {
        const origin = kind === 'drag' ? this.dragOrigin : null;
        this.dragOrigin = null;
        // On an errand she has somewhere to be; a swing would leave her stranded halfway.
        if (!this.running || this.asleep || this.away || this.errand)
            return;
        const wasSulking = this.mood.isSulking;
        const {level, becameAngry, becameFurious} = this.mood.poke(kind);
        if (becameAngry) {
            this.countStat('sulks');
            this.inkedThisSulk = false;
        }
        if (becameFurious)
            this.countStat('storms');
        if (becameFurious) {
            this.inkHandler('storm');
            this.inkedThisSulk = true;
            this.stormOff();
            return;
        }
        if (becameAngry) {
            this.swingBat();
            return;
        }
        // Pestered mid-sulk, once per sulk, the line is the ink's.
        const inked = wasSulking && !this.inkedThisSulk && this.inkHandler('sulk');
        if (inked)
            this.inkedThisSulk = true;
        // Going back is her answer to the drop; it comes with its own line instead of the usual one.
        const goingBack = origin !== null && this.goBackIfHomesick(origin, level);
        if (this.mood.isSulking) {
            // The poke pushed the end of the sulk back.
            this.scheduleSulkEnd();
            if (!goingBack)
                this.say(inked ? 'encre' : kind === 'click' ? 'boude' : 'deplacee');
            return;
        }
        if (goingBack)
            return;
        if (level === 'calm') {
            if (kind === 'click')
                this.playReaction('coucou', {});
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

    /**
     * Dropped far enough from where she was, with crawling allowed: she
     * may crawl straight back there. `rollHomesick()` decides. Even in a
     * focus session: going back is staying put, as far as she is concerned.
     */
    private goBackIfHomesick(origin: Point, level: MoodLevel): boolean {
        if (!this.settings.crawl || this.crawling)
            return false;
        const here = this.positioner.position;
        if (Math.hypot(origin.x - here.x, origin.y - here.y) < HOMESICK_MIN_DISTANCE)
            return false;
        if (!this.rollHomesick(level))
            return false;
        this.crawlBack(origin);
        return true;
    }

    /** Its own method so a test can force either outcome from Eval. */
    private rollHomesick(level: MoodLevel): boolean {
        return Math.random() < this.homesickChance(level);
    }

    /** Angry only happens while she sulks; furious, she is off the screen and nobody can drop her anywhere. */
    private homesickChance(level: MoodLevel): number {
        if (this.mood.isSulking || level === 'angry' || level === 'furious')
            return 1;
        const calm = this.settings.homesickChance;
        return level === 'annoyed' ? Math.min(1, HOMESICK_ANNOYED_FACTOR * calm) : calm;
    }

    /**
     * Straight back to where she was picked up, at her crawl pace, and that
     * is her spot again. Picked up on the way, she stops there and the drop
     * decides afresh.
     */
    private crawlBack(origin: Point): void {
        this.cancelTimers();
        this.crawling = true;
        this.countStat('crawls');
        this.player.play(origin.x > this.positioner.position.x ? 'ramper_droite' : 'ramper_gauche');
        this.say('retour_maison');
        this.positioner.travelTo(origin, CRAWL_SPEED * this.spriteScale(), () => {
            this.crawling = false;
            this.positioner.rememberPosition();
            this.player.play(this.restFrame);
            this.resumeRoutine();
        });
    }

    /** The one swing per sulk. Whatever she was doing stops for it, a crawl included. */
    private swingBat(): void {
        this.cancelTimers();
        this.stopCrawl();
        this.endTapping();
        // A notification landing right now would cut the swing short.
        this.lastReactionAt = Date.now();
        // She is sulking already, so the swing ends on the bat held in front of her.
        this.playGesture('batte');
        this.say('enervee');
        this.scheduleSulkEnd();
    }

    /**
     * Enough is enough: a word, then off the screen by the nearest side,
     * deaf to everything, until the fury timer brings her back.
     */
    private stormOff(): void {
        this.cancelTimers();
        this.stopCrawl();
        this.endTapping();
        // The sulk goes on out there; the return reschedules its end.
        this.cancelSulkEnd?.();
        this.cancelSulkEnd = null;
        this.say('depart');
        if (!this.stormHandler?.leave()) {
            // Nowhere to go: she stays and keeps sulking, just as angry.
            this.mood.cameBack();
            this.scheduleSulkEnd();
            this.resumeRoutine();
            return;
        }
        this.furious = true;
        this.cancelFuryEnd = this.timers.schedule(this.furiousAbsenceMs, () => this.endFury());
    }

    /** Back to her spot by the side she left, bat still in hand: the sulk is not over. */
    private endFury(): void {
        this.cancelFuryEnd = null;
        if (!this.running || !this.furious)
            return;
        this.furious = false;
        this.mood.cameBack();
        // Woken up out there by the user coming back, she still does not wave at them.
        this.wokeWhileAway = false;
        const handler = this.stormHandler;
        if (!handler)
            return;
        handler.comeBack(() => {
            this.scheduleSulkEnd();
            if (!this.asleep)
                this.say('retour_furieuse');
        });
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
        // Asleep, carried or away, waking up, the drop or the return reschedules everything,
        // and brings the plain resting pose back without a show.
        if (!this.running || this.asleep || this.dragging || this.away)
            return;
        this.putBatAway();
        this.scheduleFidget();
        this.scheduleCrawl();
        this.scheduleComment();
    }

    /**
     * Only from the bat pose: mid-gesture, crawling or tapping the bat is
     * not in sight, and whatever she does next ends on the plain pose.
     */
    private putBatAway(): void {
        const current = this.player.currentName;
        if (restPoseOf(current) !== BAT_HELD && current !== BAT_HELD_BLINK)
            return;
        this.playGesture(BAT_PUT_AWAY);
        this.say('batte_rangee');
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

    /** A gesture of a reaction's, under its rules; `force` skips the pause between two of them. */
    private gestureIfFree(name: string, force: boolean): void {
        if (this.crawling || this.dragging || !this.player.has(name))
            return;
        const now = Date.now();
        if (!force && now - this.lastReactionAt < REACTION_COOLDOWN)
            return;
        this.lastReactionAt = now;
        if (name === TAPPING && !this.tapping)
            this.tapBriefly();
        else
            this.playGesture(name);
    }

    /** A few taps of the tentacle, then back to resting; the loop would otherwise never end. */
    private tapBriefly(): void {
        this.cancelBlink?.();
        this.cancelBlink = null;
        this.cancelFidget?.();
        this.cancelFidget = null;
        this.player.play(TAPPING);
        this.cancelBriefTap?.();
        this.cancelBriefTap = this.timers.schedule(BRIEF_TAP, () => {
            this.cancelBriefTap = null;
            // A wait in a window title or a crawl took over meanwhile: it owns the pose now.
            if (this.tapping || this.player.currentName !== TAPPING)
                return;
            this.player.play(this.restFrame);
            this.scheduleBlink();
            this.scheduleFidget();
        });
    }

    /** Woken by something rather than someone: no wave, no greeting, the routine starts again. */
    private wakeWithAStart(): void {
        this.asleep = false;
        this.bedtimeAllowedAt = Date.now() + BEDTIME_RESLEEP_AFTER;
        this.player.play(this.restFrame);
        this.resumeRoutine();
    }

    /**
     * Every line goes through here: with banners off she keeps them all to
     * herself. `note` false when whoever asked already told the daemon.
     */
    private say(event: TriggerEvent, values?: LineValues, note = true): void {
        // Kept even when she keeps quiet: it still happened.
        if (note)
            this.recollection.noteEvent(event);
        if (this.hushed || this.quiet)
            return;
        this.onEvent(event, values);
    }

    private resumeRoutine(): void {
        // The sulk ended while she was carried, away or asleep: the bat is gone when she is back.
        if (restPoseOf(this.player.currentName) === BAT_HELD && this.restPose !== BAT_HELD)
            this.player.play(this.restFrame);
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
            if (this.isResting(this.player.currentName))
                this.player.play(this.blinkName, {onDone: () => this.scheduleBlink()});
            else
                this.scheduleBlink();
        });
    }

    private scheduleFidget(): void {
        this.cancelFidget?.();
        this.cancelFidget = null;
        // A sulking octopus does not sigh for show; endSulk() brings the fidgets back. Tapping is fidget enough.
        // Focusing, she holds still.
        if (this.mood.isSulking || this.away || this.tapping || this.focusing)
            return;
        this.cancelFidget = this.schedule(FIDGET_EVERY, () => {
            this.cancelFidget = null;
            this.playGesture(this.pickFidget(), () => this.goToBedIfLate());
        });
    }

    private scheduleCrawl(): void {
        this.cancelCrawl?.();
        this.cancelCrawl = null;
        const every = this.settings.crawlIntervalMs;
        if (!this.settings.crawl || every <= 0 || !this.crawlAllowed || this.away || this.mood.isSulking || this.tapping ||
            this.focusing)
            return;
        this.cancelCrawl = this.scheduleAround(every, () => {
            this.cancelCrawl = null;
            this.crawl();
        });
    }

    private scheduleComment(): void {
        this.cancelComment?.();
        this.cancelComment = null;
        const every = this.settings.commentIntervalMs;
        if (every <= 0 || this.mood.isSulking || this.away || this.focusing)
            return;
        this.cancelComment = this.scheduleAround(every, () => this.comment());
    }

    private comment(): void {
        this.cancelComment = null;
        if (!this.isResting(this.player.currentName)) {
            this.cancelComment = this.timers.schedule(COMMENT_RETRY, () => this.comment());
            return;
        }
        this.scheduleComment();
        const asked = this.remarkSource && this.rollBrainRemark() ? this.remarkSource.ask() : null;
        if (!asked) {
            this.say('commentaire');
            return;
        }
        const source = this.remarkSource;
        asked.then(line => {
            // The answer takes a while: she may have dozed off, left or been hushed since.
            if (!this.running || this.asleep || this.away || this.hushed || this.quiet)
                return;
            // Nothing to say is an answer too: she keeps quiet, like a bored octopus would.
            if (line.trim().length > 0 && source)
                source.show(line.trim());
        }, () => {
            if (this.running && !this.asleep && !this.away)
                this.say('commentaire');
        });
    }

    /** Its own method so a test can force either outcome from Eval. */
    private rollBrainRemark(): boolean {
        return Math.random() < BRAIN_REMARK_CHANCE;
    }

    private crawl(): void {
        const destination = this.positioner.pickDestination();
        if (destination === null || !this.isResting(this.player.currentName)) {
            this.scheduleCrawl();
            return;
        }
        this.crawling = true;
        this.countStat('crawls');
        this.cancelBlink?.();
        this.cancelBlink = null;
        this.cancelFidget?.();
        this.cancelFidget = null;

        const goingRight = destination > this.spriteCenterX();
        this.player.play(goingRight ? 'ramper_droite' : 'ramper_gauche');
        this.positioner.moveTo(destination, CRAWL_SPEED * this.spriteScale(), () => {
            this.crawling = false;
            this.player.play(this.restFrame);
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
        if (this.focusing || !isPastBedtime(new Date(), this.settings.bedtimeHour) || Date.now() < this.bedtimeAllowedAt)
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
        this.endTapping();
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

    private scheduleAround(averageMs: number, callback: () => void): () => void {
        const [low, high] = INTERVAL_SPREAD;
        return this.schedule([low * averageMs, high * averageMs], callback);
    }
}
