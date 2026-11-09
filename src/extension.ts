import type Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import Meta from 'gi://Meta';
import type Mtk from 'gi://Mtk';
import Shell from 'gi://Shell';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadAnimations} from './animations.js';
import {IdleBehaviour, type NudgeReaction, type ReactionOptions} from './behaviour.js';
import {Brain, BrainError, type BrainErrorKind} from './brain.js';
import {SpeechBubble} from './bubble.js';
import {contextJson} from './context.js';
import {MeetingDigest, meetingMode, type MeetingMode} from './digest.js';
import {Dodger} from './dodge.js';
import {DragHandler} from './drag.js';
import {EyesFollower, GAZE_DIRECTIONS, gazePose} from './gaze.js';
import {Hitbox} from './hitbox.js';
import {InkSplatter} from './ink.js';
import {KeywordMatcher, looksLikeWaiting, type Reaction} from './keywords.js';
import {SpriteLayer} from './layer.js';
import {CrepeMenu} from './menu.js';
import {MeetingMonitor} from './meeting.js';
import {pickGag, weekBilanDue, weekResume} from './memory.js';
import type {Side} from './monitors.js';
import {MusicWatcher} from './music.js';
import {NudgeService, type RemindOutcome} from './nudge.js';
import {INFO_MAX, TEXT_IN_LINE_MAX, oneLine, ticketCount, type NudgeKind} from './nudgetext.js';
import {OutfitLayer, loadOutfits} from './outfit.js';
import {AnimationPlayer, IDLE_ANIMATION} from './player.js';
import {Positioner} from './positioner.js';
import {Presence} from './presence.js';
import {PromptBox} from './prompt.js';
import {MAX_PENDING, REMINDER_EXAMPLE, ReminderCenter, clockLabel, parseReminderRequest, plainConfirmation, whenLabel, type DeliveryKind, type Reminder} from './reminders.js';
import {CrepeSettings, TALK_SHORTCUT_KEY} from './settings.js';
import {CrepeSprite, HEAD_PADDING} from './sprite.js';
import {StatsStore, dayKey} from './stats.js';
import {isTerminal} from './terminals.js';
import {TimerPool} from './timers.js';
import {TrackGate} from './tracks.js';
import {CrepeToggle} from './toggle.js';
import {ErrorHistory, LongTasks, NotificationTally, errorKey} from './trackers.js';
import {PointerGame, Visits} from './visits.js';
import {Voice, inClear, type TriggerEvent, type Utterance} from './voice.js';
import {OUTFIT_LINES, activeOutfits, outfitsOwingALine, parseLineDays, type OutfitId} from './wardrobe.js';
import {FocusedWindowWatcher, NewWindowWatcher, NotificationWatcher} from './watchers.js';

/** How long the menu keeps offering to mute notifications after a flood of them. */
const MUTE_OFFER_MS = 5 * 60 * 1000;
/** Error reactions within half an hour after which a success is applauded rather than thumbed up. */
const ERRORS_BEFORE_APPLAUSE = 3;
/** Reactions to the very same error after which the next one is a head scratch rather than a facepalm. */
const REPEATS_BEFORE_SCRATCH = 2;
/** Chance that something off to her side is pointed at rather than jumped at. */
const POINT_CHANCE = 0.5;
/** She points at a new window at most once a minute; opening a session would be a semaphore show otherwise. */
const WINDOW_POINT_EVERY = 60 * 1000;
/** How often she checks whether it is time for the evening recap. */
const RECAP_CHECK_EVERY = 60 * 1000;
/** How often what she wears is checked against the clock. */
const OUTFIT_CHECK_EVERY = 60 * 1000;
/** An outfit just put on gets its line this long after, once whatever put it on has had its own say. */
const OUTFIT_LINE_DELAY = 3 * 1000;
/** A failed command in the terminal gets a reaction at most once a minute; a loop of `make` would be a show otherwise. */
const COMMAND_FAILURE_EVERY = 60 * 1000;
/** A call flickering (a muted microphone released, a stream restarted) is not the end of the meeting. */
const MEETING_END_GRACE = 3 * 1000;
/** A meeting shorter than this ending without news is not worth a word. */
const MEETING_WORTH_A_WORD = 2 * 60 * 1000;
/** The summary waits for her to be free (awake, at home, not focusing) this long, then is dropped as stale. */
const SUMMARY_PATIENCE = 10 * 60 * 1000;
const SUMMARY_RETRY_EVERY = 10 * 1000;
/** Busy elsewhere when a wait should make her tap (crawling, carried, asleep...), she tries again this often while it lasts. */
const IMPATIENCE_RETRY = 10 * 1000;
/** Sprite rows from her head's top to her eyes, in the resting pose. */
const EYES_BELOW_HEAD = 22;

/** What she says when the daemon cannot answer; the reason itself only goes to the logs. */
const BRAIN_TROUBLE_EVENTS: Record<BrainErrorKind, TriggerEvent> = {
    'no-key': 'cerveau_absent',
    'unavailable': 'cerveau_absent',
    'budget': 'cerveau_fatigue',
    'upstream': 'cerveau_panne',
    'timeout': 'cerveau_panne',
    // A question the daemon refuses is still one she could not answer.
    'invalid': 'cerveau_panne',
};

export default class CrepeExtension extends Extension {
    private settings: CrepeSettings | null = null;
    private timers: TimerPool | null = null;
    private sprite: CrepeSprite | null = null;
    private hitbox: Hitbox | null = null;
    private layer: SpriteLayer | null = null;
    private eyes: EyesFollower | null = null;
    private dodger: Dodger | null = null;
    private visits: Visits | null = null;
    private bubble: SpeechBubble | null = null;
    private voice: Voice | null = null;
    private positioner: Positioner | null = null;
    private behaviour: IdleBehaviour | null = null;
    private presence: Presence | null = null;
    private drag: DragHandler | null = null;
    private menu: CrepeMenu | null = null;
    private toggle: CrepeToggle | null = null;
    private notifications: NotificationWatcher | null = null;
    private windows: FocusedWindowWatcher | null = null;
    private newWindows: NewWindowWatcher | null = null;
    private music: MusicWatcher | null = null;
    private brain: Brain | null = null;
    private prompt: PromptBox | null = null;
    private nudges: NudgeService | null = null;
    private meeting: MeetingMonitor | null = null;
    private meetingState: MeetingMode = {hidden: false, silent: false};
    private readonly digest = new MeetingDigest();
    private meetingStartedAt = 0;
    /** The meeting is over and its line is still to be said. */
    private summaryPending = false;
    private summaryDeadline = 0;
    private cancelMeetingEnd: (() => void) | null = null;
    private cancelSummary: (() => void) | null = null;
    private lastCommandFailureAt = 0;
    /** Writable so a test can seat a terminal at the focus. */
    private terminalFocused: () => boolean = () => this.focusedWindowIsTerminal();
    private shortcutAdded = false;
    /** The desktop's own notification settings, where banners are turned off. */
    private desktopNotifications: Gio.Settings | null = null;
    private bannersHandlerId: number | null = null;
    private cancelMuteOffer: (() => void) | null = null;
    private longTasks: LongTasks | null = null;
    private errors: ErrorHistory | null = null;
    /** The window whose title keeps her waiting, timed or already tapped at. */
    private waitingWindowId: number | null = null;
    private cancelImpatience: (() => void) | null = null;
    /** Writable so a test can make her point every time. */
    private pointChance = POINT_CHANCE;
    private lastWindowPointAt = 0;
    private stats: StatsStore | null = null;
    /** She turned the banners off for a focus session, so she turns them back on after it. */
    private bannersMutedForFocus = false;
    /** Set while she flips the banners herself, so the change is not announced like the user's own. */
    private flippingBannersForFocus = false;
    private cancelRecapCheck: (() => void) | null = null;
    private outfits: OutfitLayer | null = null;
    private cancelOutfitCheck: (() => void) | null = null;
    private cancelOutfitLine: (() => void) | null = null;
    /** Writable so a test can dress her for any date. */
    private outfitClock: () => Date = () => new Date();
    /** Writable so a test can make it any day for her memory of the week and the Friday bilan. */
    private weekClock: () => Date = () => new Date();
    private reminders: ReminderCenter | null = null;
    private ink: InkSplatter | null = null;
    private trackGate: TrackGate | null = null;
    private themeContext: St.ThemeContext | null = null;
    private themeScaleHandlerId: number | null = null;

    override enable(): void {
        const settings = new CrepeSettings(this.getSettings());
        const assetsDir = this.dir.get_child('assets');
        // Every asset is read and checked before anything reaches the stage or listens to a signal: a bad
        // JSON file then fails the enable with nothing to clean up.
        const {animations} = loadAnimations(assetsDir);
        const outfitCatalog = loadOutfits(assetsDir, animations.keys());
        const voice = new Voice(settings, () => this.bubble?.isShowing === true);
        voice.loadLines(assetsDir);

        // The shell never calls disable() after a failed enable(): whatever was built is torn down here,
        // or an invisible actor would swallow clicks until logout. Each piece is kept on `this` as soon
        // as it exists, so disable() finds it.
        try {
            this.settings = settings;
            this.voice = voice;
            const timers = new TimerPool();
            this.timers = timers;
            const stats = new StatsStore(() => settings.stats, json => {
                settings.stats = json;
            }, timers.schedule);
            // Set before anything can count: the behaviour and the watchers below report to it.
            this.stats = stats;

            const sprite = new CrepeSprite(settings.scale * this.themeScale());
            this.sprite = sprite;
            // Enabling happens at every unlock: only what shows at rest is decoded now, the rest on first use.
            const restingAnimations = [IDLE_ANIMATION, 'clignement', ...GAZE_DIRECTIONS.map(direction => gazePose(IDLE_ANIMATION, direction))];
            sprite.preload(restingAnimations.flatMap(name => animations.get(name) ?? []));
            const outfits = new OutfitLayer(sprite, outfitCatalog);
            this.outfits = outfits;
            const hitbox = new Hitbox(sprite);
            this.hitbox = hitbox;
            const layer = new SpriteLayer(sprite, hitbox);
            this.layer = layer;
            layer.show(settings.layer);
            const positioner = new Positioner(sprite, settings);
            this.positioner = positioner;
            const bubble = new SpeechBubble(sprite, timers);
            this.bubble = bubble;

            const player = new AnimationPlayer(animations, timers.schedule, (animation, frame) => {
                sprite.showFrame(animation, frame);
                outfits.frameShown(animation, frame);
            });
            player.setAnimationListener(animation => {
                // Falling asleep, waking up and sulking all start an animation: what she wears follows at once.
                this.syncOutfits();
                outfits.animationChanged(animation);
            });
            const behaviour = new IdleBehaviour(player, timers, positioner, settings, {
                centerX: () => sprite.actor.x + sprite.size / 2,
                scale: () => sprite.currentScale,
            }, (event, values) => {
                // A fact of the past week comes up in place of the day's first idle remark.
                if (event === 'commentaire' && this.recallFact())
                    return;
                // Any line may mention the open tickets; the voice decides how often.
                const tickets = this.behaviour?.recollection.openTickets ?? null;
                const line = voice.speak(event, tickets === null ? values : {tickets: String(tickets), ...values});
                if (!line)
                    return;
                if (event === 'commentaire')
                    stats.increment('remarks');
                this.sayLine(line);
            });
            this.behaviour = behaviour;
            behaviour.setStatsListener(counter => stats.increment(counter));
            behaviour.setTappingListener(() => this.tappingStopped());
            behaviour.setFocusListener(focusing => this.focusChanged(focusing));
            behaviour.setInkHandler(reason => this.throwInk(reason));
            const presence = new Presence(sprite, hitbox, positioner, behaviour, settings);
            this.presence = presence;
            const body = () => ({x: hitbox.actor.x, y: hitbox.actor.y, width: hitbox.actor.width, height: hitbox.actor.height});
            const eyes = new EyesFollower(behaviour, timers, {
                eyes: () => ({
                    x: sprite.actor.x + sprite.size / 2,
                    y: sprite.actor.y + (HEAD_PADDING + EYES_BELOW_HEAD) * sprite.currentScale,
                }),
                body,
            });
            this.eyes = eyes;
            this.dodger = new Dodger(sprite, presence, behaviour, positioner, timers, () => behaviour.remark('esquive'));
            const inMeeting = () => this.meetingState.silent || this.meetingState.hidden;
            this.visits = new Visits(sprite, presence, behaviour, positioner, eyes, timers, inMeeting);
            // Fed by the eyes' polling and dropped with them: nothing of its own to tear down.
            eyes.setWatcher(new PointerGame(sprite, presence, behaviour, positioner, eyes, body, inMeeting));
            behaviour.setStormHandler({
                leave: () => {
                    // The menu and the box follow her; she is not taking questions on the way out.
                    menu.close();
                    prompt.close();
                    return presence.stormOff();
                },
                comeBack: onHome => presence.stormBack(onHome),
            });
            const prompt = new PromptBox(sprite, {
                onSubmit: text => this.ask(text),
                onClosed: () => this.bubble?.setAnchor(null),
            });
            this.prompt = prompt;

            const desktopNotifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
            this.desktopNotifications = desktopNotifications;
            const menu = new CrepeMenu(hitbox.actor, settings, {
                openPreferences: () => this.openPreferences(),
                toggleHidden: () => presence.toggleHidden(),
                isHidden: () => presence.isHidden,
                muteNotifications: () => desktopNotifications.set_boolean('show-banners', false),
                canConverse: () => settings.brain && this.brain?.available === true,
                openPrompt: () => this.openPrompt(),
                forgetConversation: () => this.forgetConversation(),
                toggleFocus: () => this.toggleFocus(),
                isFocusing: () => behaviour.focusMode,
                addReminder: input => this.addReminderFromMenu(input),
                pendingReminders: () => this.pendingReminderLabels(),
                cancelReminder: id => this.reminders?.cancel(id),
            });
            this.menu = menu;
            this.drag = new DragHandler(hitbox.actor, sprite.actor, {
                onClick: () => {
                    // A click is how she is told a reminder was seen; it is no pestering.
                    if (this.reminders?.acknowledge()) {
                        bubble.dismiss();
                        return;
                    }
                    // The sliver of her left at the edge is there to be clicked; out there a click is no pestering.
                    if (presence.isHidden) {
                        presence.comeBack();
                        return;
                    }
                    stats.increment('clicks');
                    behaviour.pester('click');
                },
                onSecondaryClick: () => menu.toggle(),
                onDragStart: () => {
                    // The menu stays anchored where she was picked up, so it would float in the void.
                    menu.close();
                    prompt.close();
                    bubble.hide();
                    presence.releaseForDrag();
                    behaviour.interruptForDrag();
                },
                onDrop: () => {
                    stats.increment('drags');
                    positioner.rememberPosition();
                    behaviour.resumeAfterDrag();
                    behaviour.pester('drag');
                },
                bounds: (x, y) => positioner.placementAreaAt({x, y}),
            });

            const icon = Gio.FileIcon.new(assetsDir.get_child('reference').get_child('1_sud_face.png'));
            this.toggle = new CrepeToggle(icon, settings.gsettings);

            // Banners off: the tray still gets every notification, she just stops talking about them.
            this.bannersHandlerId = desktopNotifications.connect('changed::show-banners', () =>
                this.syncHush(!this.flippingBannersForFocus));

            const keywordLists = () => ({
                error: settings.errorKeywords,
                success: settings.successKeywords,
                busy: settings.busyKeywords,
            });
            // Compiled once per edit of the lists rather than once per notification or title.
            let keywords = new KeywordMatcher(keywordLists());
            for (const key of ['error-keywords', 'success-keywords', 'busy-keywords'] as const) {
                settings.onChanged(key, () => {
                    keywords = new KeywordMatcher(keywordLists());
                });
            }

            const tally = new NotificationTally();
            this.notifications = new NotificationWatcher(text => {
                // Counted whether she reacts or not: the recap is about your day, not hers.
                const keyword = keywords.classify(text);
                stats.increment('notifications');
                if (keyword === 'facepalm')
                    stats.increment('errors');
                else if (keyword === 'pouce')
                    stats.increment('successes');
                // Off-screen she sees nothing; focusing, she lets them go by.
                if (!settings.reactToNotifications || presence.isAway || behaviour.focusMode || this.meetingState.silent)
                    return;
                const flooded = !behaviour.isHushed && tally.add(Date.now());
                const options: ReactionOptions = flooded ? {event: 'trop_de_notifs'} : {};
                const reacted = keyword ? this.reactToKeyword(keyword, null, options) : this.jumpAtNotification(options);
                if (!flooded)
                    return;
                // Mid-gesture or right after one, she still makes the offer.
                if (!reacted)
                    behaviour.remark('trop_de_notifs');
                this.offerMute();
            });

            const longTasks = new LongTasks();
            this.longTasks = longTasks;
            this.windows = new FocusedWindowWatcher((title, windowId) => {
                if (!settings.reactToWindows) {
                    this.endWait();
                    return;
                }
                const reaction = keywords.classify(title);
                // "Building... failed" is over, whatever its dots say.
                this.followWait(windowId, reaction !== 'facepalm' && looksLikeWaiting(title));
                // Only what she reacted to is counted: a title is seen again every time its window gets focus.
                if (reaction === 'facepalm') {
                    longTasks.forget(windowId);
                    if (this.reactToKeyword('facepalm', errorKey(windowId, title)))
                        stats.increment('errors');
                    return;
                }
                if (longTasks.update(windowId, keywords.looksBusy(title), Date.now())) {
                    if (behaviour.react('pouce', {event: 'patience'}))
                        stats.increment('successes');
                    return;
                }
                if (reaction && this.reactToKeyword(reaction, null))
                    stats.increment(reaction === 'pouce' ? 'successes' : 'errors');
            }, () => this.endWait());
            this.newWindows = new NewWindowWatcher(frame => this.pointAtWindow(frame), () => positioner.roomIndex);

            settings.onChanged('visible', () => this.applyVisibility());
            settings.onChanged('scale', () => this.rescale());
            // Her size is the setting times the desktop's own scale, which can change under her too.
            const themeContext = St.ThemeContext.get_for_stage(global.stage as Clutter.Stage);
            this.themeContext = themeContext;
            this.themeScaleHandlerId = themeContext.connect('notify::scale-factor', () => this.rescale());
            settings.onChanged('sleep-after-minutes', () => behaviour.refresh());
            settings.onChanged('crawl', () => behaviour.refresh());
            settings.onChanged('crawl-interval-minutes', () => behaviour.refresh());
            settings.onChanged('comment-interval-minutes', () => behaviour.refresh());
            settings.onChanged('stats', () => stats.settingChanged());
            settings.onChanged('hide-during-screencast', () => this.syncMeeting());
            settings.onChanged('quiet-during-calls', () => this.syncMeeting());
            settings.onChanged('focus-minutes', () => menu.syncFocus());
            settings.onChanged('perch', () => presence.refresh());
            settings.onChanged('eyes-follow', () => this.syncEyes());
            settings.onChanged('dodge', () => this.syncDodge());
            settings.onChanged('layer', () => this.syncLayer());
            settings.onChanged('react-to-music', () => this.syncMusic());
            settings.onChanged('brain', () => this.syncBrain());
            settings.onChanged('ink', () => {
                if (!settings.ink)
                    this.ink?.clear();
            });
            settings.onChanged('outfits', () => this.syncOutfits());
            settings.onChanged('outfit-override', () => this.syncOutfits());
            settings.onChanged('birthday', () => this.syncOutfits());

            this.errors = new ErrorHistory();
            this.ink = new InkSplatter(assetsDir, timers, () => this.themeScale());
            this.trackGate = new TrackGate(() => this.music?.isPlaying === true);
            this.reminders = new ReminderCenter({
                read: () => settings.reminders,
                write: json => {
                    settings.reminders = json;
                },
                schedule: timers.schedule,
                now: () => Date.now(),
                canDeliver: () => this.canDeliverReminder(),
                deliver: (reminder, kind) => this.deliverReminder(reminder, kind),
                ignored: () => this.reminderIgnored(),
                changed: () => this.menu?.syncReminders(),
            });
            // Banners may already be off: she starts hushed, without making a show of it.
            this.syncHush(false);
            this.syncMusic();
            this.syncBrain();
            behaviour.setRemarkSource({
                ask: () => this.askRemark(),
                show: line => {
                    const said = this.voice?.utter(line);
                    if (!said)
                        return;
                    stats.increment('remarks');
                    this.sayLine(said);
                },
            });
            // The window manager reads the accelerator from the schema and follows its changes on its own.
            Main.wm.addKeybinding(TALK_SHORTCUT_KEY, settings.gsettings, Meta.KeyBindingFlags.NONE,
                Shell.ActionMode.NORMAL, () => this.openPrompt());
            this.shortcutAdded = true;
            // Settled before she is shown, so starting mid-call does not flash her on screen.
            this.meeting = new MeetingMonitor(() => this.syncMeeting());
            this.meetingState = this.currentMeetingMode();
            behaviour.setQuiet(this.meetingState.silent);
            this.nudges = new NudgeService(String(this.metadata.version ?? ''), (kind, text) => this.nudge(kind, text),
                (when, text) => this.remind(when, text));
            this.scheduleRecapCheck();
            this.scheduleOutfitCheck();
            this.applyVisibility();
            this.syncOutfits();
            // Last, so the overdue ones find her on stage.
            this.reminders.start();
        } catch (error) {
            this.disable();
            throw error;
        }
    }

    override disable(): void {
        this.nudges?.destroy();
        this.nudges = null;
        this.reminders?.destroy();
        this.reminders = null;
        this.ink?.destroy();
        this.ink = null;
        this.trackGate = null;
        this.meeting?.destroy();
        this.meeting = null;
        this.cancelMeetingEnd?.();
        this.cancelMeetingEnd = null;
        this.cancelSummary?.();
        this.cancelSummary = null;
        this.summaryPending = false;
        this.meetingState = {hidden: false, silent: false};
        this.digest.clear();
        this.cancelRecapCheck?.();
        this.cancelRecapCheck = null;
        this.cancelOutfitCheck?.();
        this.cancelOutfitCheck = null;
        this.cancelOutfitLine?.();
        this.cancelOutfitLine = null;
        if (this.shortcutAdded)
            Main.wm.removeKeybinding(TALK_SHORTCUT_KEY);
        this.shortcutAdded = false;
        // Closing it pops its modal grab; it follows the sprite, so it goes before it.
        this.prompt?.destroy();
        this.prompt = null;
        this.brain?.destroy();
        this.brain = null;
        this.music?.destroy();
        this.music = null;
        this.newWindows?.destroy();
        this.newWindows = null;
        this.windows?.destroy();
        this.windows = null;
        this.cancelImpatience?.();
        this.cancelImpatience = null;
        this.waitingWindowId = null;
        this.longTasks = null;
        this.errors = null;
        this.notifications?.destroy();
        this.notifications = null;
        // A focus session cut short by a logout or a lock screen must not leave the desktop muted.
        if (this.desktopNotifications && this.bannersMutedForFocus)
            this.desktopNotifications.set_boolean('show-banners', true);
        this.bannersMutedForFocus = false;
        if (this.desktopNotifications && this.bannersHandlerId !== null)
            this.desktopNotifications.disconnect(this.bannersHandlerId);
        this.bannersHandlerId = null;
        this.desktopNotifications = null;
        this.cancelMuteOffer?.();
        this.cancelMuteOffer = null;
        if (this.themeContext && this.themeScaleHandlerId !== null)
            this.themeContext.disconnect(this.themeScaleHandlerId);
        this.themeScaleHandlerId = null;
        this.themeContext = null;

        this.drag?.destroy();
        this.drag = null;

        this.menu?.destroy();
        this.menu = null;

        // They all talk to the behaviour and the presence, so they go first.
        this.eyes?.stop();
        this.eyes = null;
        this.dodger?.stop();
        this.dodger = null;
        this.visits?.stop();
        this.visits = null;

        // Disabled mid-crawl (a logout), she stays where she stopped and that is her spot next time,
        // rather than being snapped back to where the crawl began. A trip she was sent on is not
        // hers to remember: the positioner ignores it while detached.
        if (this.behaviour?.isCrawling)
            this.positioner?.cancelMove();
        // Gives the sprite back to the positioner, so it has to go before the behaviour stops.
        this.presence?.destroy();
        this.presence = null;

        this.behaviour?.stop();
        this.behaviour = null;

        this.toggle?.destroy();
        this.toggle = null;

        this.positioner?.destroy();
        this.positioner = null;

        this.voice = null;
        // It listens to the sprite's position, so it has to go first.
        this.bubble?.destroy();
        this.bubble = null;

        this.layer?.hide();
        this.layer = null;
        // Its actors are the sprite's children and go with it; it only drops its images.
        this.outfits?.destroy();
        this.outfits = null;
        // It listens to the sprite's position, so it has to go first.
        this.hitbox?.destroy();
        this.sprite?.destroy();
        this.hitbox = null;
        this.sprite = null;

        // Last, once nothing can count any more; it cancels its own pending write.
        this.stats?.flush();
        this.stats = null;

        this.timers?.cancelAll();
        this.timers = null;

        this.settings?.destroy();
        this.settings = null;
    }

    /**
     * Hiding means leaving the stage, not just `visible = false`: the layout
     * manager rewrites `visible` on fullscreen-tracked chrome whenever the
     * overview or a fullscreen window comes and goes, which would bring a
     * toggled-off Crêpe back.
     */
    private applyVisibility(): void {
        if (!this.settings || !this.layer || !this.behaviour || !this.presence)
            return;
        if (this.isShown()) {
            if (!this.layer.isShown) {
                this.layer.show(this.settings.layer);
                this.positioner?.place();
            }
            this.behaviour.start();
            this.presence.start();
            this.syncEyes();
            this.syncDodge();
            this.visits?.sync(true);
            return;
        }
        this.prompt?.close();
        this.menu?.close();
        this.bubble?.hide();
        this.ink?.clear();
        this.syncEyes();
        this.syncDodge();
        this.visits?.sync(false);
        // Hidden for good means back home: showing her again should not find her off-screen.
        this.presence.stop();
        this.behaviour.stop();
        this.layer.hide();
    }

    /** Polling the pointer only while she is shown and her eyes may follow it. */
    private syncEyes(): void {
        if (!this.settings || !this.eyes)
            return;
        if (this.isShown() && this.settings.eyesFollow)
            this.eyes.start();
        else
            this.eyes.stop();
    }

    /** Under the windows she cannot be in anyone's way. */
    private syncDodge(): void {
        if (!this.settings || !this.dodger)
            return;
        this.dodger.sync(this.isShown() && this.settings.dodge && this.settings.layer === 'top');
    }

    /** Moved to the other layer where she stands; hidden, she goes there when shown again. */
    private syncLayer(): void {
        if (!this.settings || !this.layer)
            return;
        if (this.layer.isShown) {
            // Both are anchored to her; a reparented anchor would leave them floating.
            this.menu?.close();
            this.prompt?.close();
            this.layer.show(this.settings.layer);
        }
        this.syncDodge();
    }

    /** The menu entry: a session of the set length, or the end of the one going on. */
    private toggleFocus(): void {
        const behaviour = this.behaviour;
        if (!behaviour || !this.settings)
            return;
        behaviour.setFocus(behaviour.focusMode ? 0 : this.settings.focusMs);
    }

    /**
     * Called before her line at the end of a session, so the banners are
     * back and she is no longer hushed when she says it. The session's own
     * line says it all: no tentacle to her mouth, no remark about the sound
     * coming back. The hush follows at once, whether the settings signal
     * comes during the write or later.
     */
    private focusChanged(focusing: boolean): void {
        const banners = this.desktopNotifications;
        if (focusing && banners && this.settings?.focusDnd && banners.get_boolean('show-banners')) {
            this.setBannersQuietly(banners, false);
            this.bannersMutedForFocus = true;
        } else if (!focusing && banners && this.bannersMutedForFocus) {
            this.setBannersQuietly(banners, true);
            this.bannersMutedForFocus = false;
        }
        this.menu?.syncFocus();
    }

    private setBannersQuietly(banners: Gio.Settings, shown: boolean): void {
        this.flippingBannersForFocus = true;
        try {
            banners.set_boolean('show-banners', shown);
            this.syncHush(false);
        } finally {
            this.flippingBannersForFocus = false;
        }
    }

    private scheduleRecapCheck(): void {
        if (!this.timers)
            return;
        this.cancelRecapCheck = this.timers.schedule(RECAP_CHECK_EVERY, () => {
            this.cancelRecapCheck = null;
            this.recapIfDue();
            this.scheduleRecapCheck();
        });
    }

    /**
     * Once a day, during the recap hour, if she is there to say it: shown,
     * awake, at home, not focusing and not hushed. Missed for any of those,
     * she tries again the next minute, until the hour is over.
     */
    private recapIfDue(): void {
        const {settings, behaviour, presence, voice, stats} = this;
        if (!settings || !behaviour || !presence || !voice || !stats)
            return;
        const now = this.weekClock();
        const today = dayKey(now);
        const free = this.isShown() && !this.meetingState.silent && !behaviour.isAsleep && !presence.isAway && !behaviour.focusMode &&
            !behaviour.isHushed && this.reminders?.isShowing !== true;
        if (free && this.weekBilanIfDue(now))
            return;
        if (!settings.recap || now.getHours() !== settings.recapHour || settings.lastRecapDate === today)
            return;
        if (!free)
            return;
        const counts = stats.today(now);
        const told = [counts.notifications, counts.errors, counts.successes, counts.clicks, counts.nudges];
        // Her own chatter and crawls are no news: a day with nothing else in it is an empty one.
        const line = voice.recap(told.every(count => count === 0) ? null : {
            notifs: String(counts.notifications),
            erreurs: String(counts.errors),
            succes: String(counts.successes),
            clics: String(counts.clicks),
            nudges: String(counts.nudges),
        });
        if (!line)
            return;
        settings.lastRecapDate = today;
        behaviour.recollection.noteEvent('bilan');
        this.sayLine(line);
    }

    /** Friday from 17:00, once: the week's counters in one line. Called only when she is free to say it. */
    private weekBilanIfDue(now: Date): boolean {
        const {settings, behaviour, voice, stats} = this;
        if (!settings || !behaviour || !voice || !stats || !weekBilanDue(now, settings.lastWeekBilan, settings.recap))
            return false;
        const resume = weekResume(stats.allDays(), now);
        const line = voice.tell('bilan_semaine', resume === null ? {} : {resume}, resume !== null);
        if (!line)
            return false;
        settings.lastWeekBilan = dayKey(now);
        behaviour.recollection.noteEvent('bilan_semaine');
        this.sayLine(line);
        return true;
    }

    /**
     * In place of an idle remark, at most once a day: the most notable
     * thing of the last seven days. False when there is none, she already
     * did today, or she is not let to talk.
     */
    private recallFact(): boolean {
        const {settings, behaviour, voice, stats} = this;
        if (!settings || !behaviour || !voice || !stats || !voice.mayRemark || this.reminders?.isShowing)
            return false;
        const now = this.weekClock();
        const today = dayKey(now);
        if (settings.lastGagDate === today)
            return false;
        const gag = pickGag(stats.allDays(), now);
        if (!gag)
            return false;
        const line = voice.tell(gag.event, gag.values, false);
        if (!line)
            return false;
        settings.lastGagDate = today;
        stats.increment('remarks');
        behaviour.recollection.noteEvent(gag.event);
        this.sayLine(line);
        return true;
    }

    /** She can say a reminder now: on stage, out of a meeting, not off in a fury. */
    private canDeliverReminder(): boolean {
        return this.isShown() && !this.meetingState.silent && this.presence?.isStorming !== true && this.behaviour !== null;
    }

    /**
     * A reminder's bubble stays until she is clicked, whatever the talk
     * switch, the banners or a focus session say: she was asked for it.
     * Hiding at the edge of the screen, she comes back for it; asleep, she
     * wakes with a start.
     */
    private deliverReminder(reminder: Reminder, kind: DeliveryKind): void {
        const {behaviour, presence, voice} = this;
        if (!behaviour || !presence || !voice)
            return;
        const event = kind === 'nag' ? 'pense_bete_relance' : kind === 'late' ? 'pense_bete_en_retard' : 'pense_bete';
        // Stored on one line and cut already, by the center.
        const texte = reminder.text;
        const told = voice.pick(event, {texte, heure: clockLabel(new Date(reminder.at))});
        const line = told ? inClear(told) : texte;
        if (presence.isHidden)
            presence.comeBack();
        behaviour.nudged({kind: 'pense_bete', gesture: 'tapote', event: null, wakes: true});
        this.stats?.increment('talks');
        this.bubble?.stay(line);
        behaviour.recollection.noteLine(line);
    }

    /** A delivery nobody answered: counted, and she holds it against you a little. */
    private reminderIgnored(): void {
        this.stats?.increment('ignored');
        this.behaviour?.irritate();
    }

    /** The menu's entry: she answers in her bubble, understood or not. */
    private addReminderFromMenu(input: string): void {
        const outcome = this.createReminder(input, '');
        if (outcome.ok) {
            this.say(outcome.confirmation);
            return;
        }
        const event = outcome.error === 'TooMany' ? 'pense_bete_plein' : 'pense_bete_incompris';
        this.say(this.voice?.pick(event) ?? outcome.message);
    }

    /** `Remind()` on D-Bus: the caller gets the confirmation, or an error that carries an example. */
    private remind(when: string, text: string): RemindOutcome {
        const outcome = this.createReminder(when, text);
        if (outcome.ok)
            this.say(outcome.confirmation);
        return outcome;
    }

    private createReminder(when: string, text: string): RemindOutcome {
        const {reminders, voice} = this;
        if (!reminders || !voice)
            return {ok: false, error: 'BadTime', message: 'Crêpe is starting up, try again.'};
        const now = new Date();
        const parsed = parseReminderRequest(when, text, now);
        if (!parsed.ok)
            return {ok: false, error: 'BadTime', message: `${parsed.reason} Essaie par exemple ${REMINDER_EXAMPLE}.`};
        const added = reminders.add(parsed.at, parsed.text);
        if (!added.ok)
            return {ok: false, error: 'TooMany', message: `Déjà ${MAX_PENDING} pense-bêtes en attente : annules-en un d'abord.`};
        const line = voice.pick('pense_bete_ok', {quand: whenLabel(parsed.at, now), heure: clockLabel(parsed.at)});
        return {ok: true, confirmation: line ? inClear(line) : plainConfirmation(parsed.at, now)};
    }

    /** Her answer to something the user just did: shown over a waiting reminder too, unless she is kept quiet. */
    private say(line: Utterance | string): void {
        if (this.isShown() && !this.meetingState.silent)
            this.sayLine(line, true);
    }

    private pendingReminderLabels(): {id: string; label: string}[] {
        const now = new Date();
        return (this.reminders?.list() ?? []).map(reminder => ({
            id: reminder.id,
            label: `${whenLabel(new Date(reminder.at), now).replace(/^à /, '')} · ${oneLine(reminder.text, 40)}`,
        }));
    }

    /** Ink on the monitor she is on, below the top bar. True when some came. */
    private throwInk(reason: 'storm' | 'sulk'): boolean {
        const {settings, ink, sprite, hitbox} = this;
        if (!settings?.ink || !ink || !sprite || !hitbox || !this.isShown() || this.meetingState.silent)
            return false;
        const found = Main.layoutManager.findIndexForActor(sprite.actor);
        const area = Main.layoutManager.getWorkAreaForMonitor(found >= 0 ? found : Main.layoutManager.primaryIndex);
        const count = (reason === 'storm' ? 2 : 1) + Math.floor(Math.random() * 2);
        const body = {x: hitbox.actor.x, y: hitbox.actor.y, width: hitbox.actor.width, height: hitbox.actor.height};
        return ink.splash(count, {x: area.x, y: area.y, width: area.width, height: area.height}, [body], sprite.actor) > 0;
    }

    private scheduleOutfitCheck(): void {
        if (!this.timers)
            return;
        this.cancelOutfitCheck = this.timers.schedule(OUTFIT_CHECK_EVERY, () => {
            this.cancelOutfitCheck = null;
            this.syncOutfits();
            this.remarkOnOutfits();
            this.scheduleOutfitCheck();
        });
    }

    /**
     * What she wears, from the clock, her state and the settings. Cheap
     * enough to run on every animation change, which is how falling
     * asleep, waking up and the bat coming out show at once; the minute
     * check catches the clock, and a sulk ending while she sleeps.
     */
    private syncOutfits(): void {
        const {settings, behaviour, outfits} = this;
        if (!settings || !behaviour || !outfits)
            return;
        // Only what the pack draws: the rules may name a hat this pack has no picture of.
        const worn = outfits.available(activeOutfits(this.outfitClock(), {
            isAsleep: behaviour.isAsleep,
            isSulking: behaviour.isSulking,
        }, {
            enabled: settings.outfits,
            override: settings.outfitOverride,
            birthday: settings.birthday,
        }));
        const previous = outfits.wearing;
        if (worn.size === previous.size && [...worn].every(id => previous.has(id)))
            return;
        outfits.wear(worn);
        // Called from inside the player, mid-transition: the line waits for whatever started it to be said.
        if ([...worn].some(id => !previous.has(id) && OUTFIT_LINES[id] !== undefined))
            this.scheduleOutfitLine();
    }

    private scheduleOutfitLine(): void {
        if (!this.timers)
            return;
        this.cancelOutfitLine?.();
        this.cancelOutfitLine = this.timers.schedule(OUTFIT_LINE_DELAY, () => {
            this.cancelOutfitLine = null;
            this.remarkOnOutfits();
        });
    }

    /**
     * Once a day per outfit, a word about it, when she is there to say
     * it: shown, awake, at home, not focusing and not hushed. Missed, or
     * kept quiet by the voice's cooldown, she tries again at the next
     * minute check while she still wears it. The day is kept in the
     * settings, so logging in again does not repeat it.
     */
    private remarkOnOutfits(): void {
        const {settings, behaviour, presence, voice, outfits} = this;
        if (!settings || !behaviour || !presence || !voice || !outfits)
            return;
        if (!this.isShown() || this.meetingState.silent || behaviour.isAsleep || presence.isAway || behaviour.focusMode || behaviour.isHushed ||
            this.reminders?.isShowing)
            return;
        const today = dayKey(this.outfitClock());
        const lineDays = parseLineDays(settings.lastOutfitLines);
        const owing: OutfitId | undefined = outfitsOwingALine(outfits.wearing, lineDays, today)[0];
        const event = owing === undefined ? undefined : OUTFIT_LINES[owing];
        if (owing === undefined || event === undefined)
            return;
        const line = voice.speak(event);
        if (!line)
            return;
        settings.lastOutfitLines = JSON.stringify({...lineDays, [owing]: today});
        behaviour.recollection.noteEvent(event);
        this.sayLine(line);
    }

    /** Visible by choice, and not sent off the stage by a screen sharing. */
    private isShown(): boolean {
        return this.settings?.visible === true && !this.meetingState.hidden;
    }

    private currentMeetingMode(): MeetingMode {
        if (!this.settings || !this.meeting)
            return {hidden: false, silent: false};
        return meetingMode(this.meeting.signals, {
            hide: this.settings.hideDuringScreencast,
            quiet: this.settings.quietDuringCalls,
        });
    }

    /**
     * The sharing or call signals, or the two settings, changed. A meeting
     * starting is obeyed at once, for what is on screen could be seen;
     * one ending waits a few seconds, so a flicker does not bring her back.
     */
    private syncMeeting(): void {
        const next = this.currentMeetingMode();
        const current = this.meetingState;
        if (next.hidden === current.hidden && next.silent === current.silent) {
            this.cancelMeetingEnd?.();
            this.cancelMeetingEnd = null;
            return;
        }
        if ((next.hidden && !current.hidden) || (next.silent && !current.silent)) {
            this.cancelMeetingEnd?.();
            this.cancelMeetingEnd = null;
            this.applyMeeting(next);
            return;
        }
        if (this.cancelMeetingEnd || !this.timers)
            return;
        this.cancelMeetingEnd = this.timers.schedule(MEETING_END_GRACE, () => {
            this.cancelMeetingEnd = null;
            this.applyMeeting(this.currentMeetingMode());
        });
    }

    private applyMeeting(next: MeetingMode): void {
        const previous = this.meetingState;
        this.meetingState = next;
        this.behaviour?.setQuiet(next.silent);
        if (next.silent && !previous.silent) {
            this.cancelSummary?.();
            this.cancelSummary = null;
            // Meetings back to back are one: the summary still owed covers both.
            if (!this.summaryPending)
                this.meetingStartedAt = Date.now();
            this.bubble?.hide();
            this.prompt?.close();
            this.ink?.clear();
        }
        if (next.hidden !== previous.hidden)
            this.applyVisibility();
        if (previous.silent && !next.silent) {
            // What came due meanwhile is said first, before the summary of the meeting.
            this.reminders?.tick();
            this.meetingOver();
        }
    }

    /** One line about what scripts said meanwhile, or about nothing, if the meeting was long enough to wonder. */
    private meetingOver(): void {
        if (!this.timers)
            return;
        if (this.digest.summary() === null && Date.now() - this.meetingStartedAt < MEETING_WORTH_A_WORD) {
            this.digest.clear();
            return;
        }
        this.summaryPending = true;
        this.summaryDeadline = Date.now() + SUMMARY_PATIENCE;
        this.cancelSummary?.();
        // She has just come back on stage: give her a moment to settle first.
        this.cancelSummary = this.timers.schedule(MEETING_END_GRACE, () => this.tellSummary());
    }

    /** Tried again until she is free to say it, shown, awake, at home, not focusing and not hushed. */
    private tellSummary(): void {
        this.cancelSummary = null;
        const {behaviour, presence, voice, timers} = this;
        if (!this.summaryPending || !behaviour || !presence || !voice || !timers)
            return;
        const stale = Date.now() > this.summaryDeadline;
        const free = this.isShown() && !this.meetingState.silent && !behaviour.isAsleep && !presence.isAway &&
            !behaviour.focusMode && !behaviour.isHushed && !this.reminders?.isShowing;
        if (!stale && !free) {
            this.cancelSummary = timers.schedule(SUMMARY_RETRY_EVERY, () => this.tellSummary());
            return;
        }
        const resume = this.digest.summary();
        const event = resume === null ? 'reunion_fin_rien' : 'reunion_fin_resume';
        const line = stale ? null : voice.speak(event, resume === null ? {} : {resume});
        if (!line && !stale) {
            this.cancelSummary = timers.schedule(SUMMARY_RETRY_EVERY, () => this.tellSummary());
            return;
        }
        this.summaryPending = false;
        this.digest.clear();
        if (!line)
            return;
        behaviour.recollection.noteEvent(event);
        this.sayLine(line);
    }

    private focusedWindowIsTerminal(): boolean {
        const window = global.display.focus_window;
        if (!window)
            return false;
        const app = Shell.WindowTracker.get_default().get_window_app(window);
        return isTerminal([window.get_wm_class(), window.get_gtk_application_id(), app?.get_id()]);
    }

    /** Banners off means notifications are muted, whoever turned them off; `announce` says it with a gesture or a line. */
    private syncHush(announce: boolean): void {
        if (!this.desktopNotifications || !this.behaviour)
            return;
        const hushed = !this.desktopNotifications.get_boolean('show-banners');
        this.behaviour.chut(hushed, announce);
        if (hushed)
            this.withdrawMuteOffer();
    }

    /**
     * An error or success keyword, weighed against the errors before it: a
     * success after a string of them is applauded, the same error coming
     * back a third time gets a head scratch. `error` tells errors apart,
     * null when there is nothing to tell them apart by.
     */
    private reactToKeyword(reaction: Reaction, error: string | null, options: ReactionOptions = {}): boolean {
        if (!this.behaviour || !this.errors)
            return false;
        const now = Date.now();
        if (reaction === 'pouce') {
            if (this.errors.count(now) < ERRORS_BEFORE_APPLAUSE)
                return this.behaviour.react('pouce', options);
            const applauded = this.behaviour.react('applaudissement', options);
            if (applauded)
                this.errors.clearStreak();
            return applauded;
        }
        const repeated = error !== null && this.errors.countOf(error, now) >= REPEATS_BEFORE_SCRATCH;
        const reacted = this.behaviour.react(repeated ? 'gratter' : 'facepalm', options);
        if (reacted)
            this.errors.add(error, now);
        return reacted;
    }

    /**
     * A script told her something through `Nudge()`. Kept for the daemon
     * and, for a ticket count, for her greetings, even when she takes no
     * notice: hidden, away, asleep (only `attention` wakes her), or stormed off.
     */
    private nudge(kind: NudgeKind, text: string): void {
        const behaviour = this.behaviour;
        if (!behaviour)
            return;
        if (kind === 'tickets_ouverts') {
            const count = ticketCount(text);
            if (count !== null)
                behaviour.recollection.noteOpenTickets(count);
        }
        if (kind === 'musique' || kind === 'musique_fin') {
            this.remoteMusic(kind, text);
            return;
        }
        // She would not hear it, whoever is in front of her: only a terminal out of sight needs the news.
        if (kind === 'commande_longue' && this.terminalFocused())
            return;
        this.stats?.increment('nudges');
        // A broken pipeline or command is an error of the day, whether or not she gets to facepalm at it.
        if (kind === 'pipeline_echec' || kind === 'commande_echec')
            this.stats?.increment('errors');
        if (kind === 'pipeline_echec')
            this.stats?.increment('pipelines');
        if (kind === 'commande_echec')
            this.stats?.increment('commands');
        // Counted for the line she says once the meeting is over.
        if (this.meetingState.silent) {
            this.digest.add(kind);
            return;
        }
        if (kind === 'commande_echec' && Date.now() - this.lastCommandFailureAt < COMMAND_FAILURE_EVERY)
            return;
        const texte = oneLine(text, TEXT_IN_LINE_MAX);
        // Without it, the lines that need it are skipped.
        const values = texte.length > 0 ? {texte} : {};
        const reaction = nudgeReaction(kind, values, this.pointerAtFocusedWindow(), this.glanceAtPointer());
        const reacted = behaviour.nudged(reaction);
        if (reacted && kind === 'commande_echec')
            this.lastCommandFailureAt = Date.now();
        if (!reacted || kind !== 'info' || behaviour.isHushed)
            return;
        const said = this.voice?.relay(oneLine(text, INFO_MAX));
        if (said)
            this.sayLine(said);
    }

    /**
     * The pointing gesture towards the focused window, or null when it is
     * right above or below her, or there is none: desktop icons extensions
     * draw the desktop in a window that covers the whole screen.
     */
    private pointerAtFocusedWindow(): string | null {
        const window = global.display.focus_window;
        if (!window || !this.hitbox || window.get_window_type() !== Meta.WindowType.NORMAL || window.is_skip_taskbar())
            return null;
        const frame = window.get_frame_rect();
        const side = sideOf(frame.x + frame.width / 2, this.hitbox.actor);
        return side === null ? null : pointerTowards(side);
    }

    /** The glance a fidget gives, towards the pointer. */
    private glanceAtPointer(): string {
        if (!this.sprite)
            return 'regard_droite';
        const [pointerX] = global.get_pointer();
        return pointerX < this.sprite.actor.x + this.sprite.size / 2 ? 'regard_gauche' : 'regard_droite';
    }

    /** Banners drop in at the top centre of the primary: from a side third of it she may point at them instead of jumping. */
    private jumpAtNotification(options: ReactionOptions): boolean {
        if (!this.behaviour || !this.sprite)
            return false;
        const side = bannerSide(this.sprite);
        if (side === null || Math.random() >= this.pointChance)
            return this.behaviour.react('sursaut', options);
        return this.behaviour.react(pointerTowards(side), {event: 'notification', ...options});
    }

    /** A window opening clearly to one side of her may get pointed at, silently. */
    private pointAtWindow(frame: Mtk.Rectangle): void {
        if (!this.settings?.reactToWindows || !this.behaviour || !this.hitbox || this.presence?.isAway)
            return;
        const now = Date.now();
        if (now - this.lastWindowPointAt < WINDOW_POINT_EVERY)
            return;
        const side = sideOf(frame.x + frame.width / 2, this.hitbox.actor);
        if (side === null || Math.random() >= this.pointChance)
            return;
        if (this.behaviour.react(pointerTowards(side)))
            this.lastWindowPointAt = now;
    }

    /**
     * The focused window's title says it is loading, or stopped saying it.
     * Half a minute of it, focus staying put, and she taps until it ends.
     */
    private followWait(windowId: number, waiting: boolean): void {
        if (!this.longTasks || !this.timers || !this.behaviour)
            return;
        const now = Date.now();
        this.longTasks.wait(windowId, waiting, now);
        if (!waiting || windowId !== this.waitingWindowId)
            this.endWait();
        const dueIn = this.longTasks.impatienceIn(windowId, now);
        if (dueIn === null || this.waitingWindowId === windowId)
            return;
        this.armImpatience(windowId, dueIn);
    }

    private armImpatience(windowId: number, delayMs: number): void {
        const {timers, behaviour} = this;
        if (!timers || !behaviour)
            return;
        this.cancelImpatience?.();
        this.waitingWindowId = windowId;
        this.cancelImpatience = timers.schedule(delayMs, () => {
            this.cancelImpatience = null;
            if (!behaviour.startTapping() && !behaviour.isTapping)
                this.armImpatience(windowId, IMPATIENCE_RETRY);
        });
    }

    /**
     * Something cut her tapping short (a drag, a trip, a nap, a sulk) while
     * the title still waits: she gets back to it later. `endWait()` clears
     * the wait before it stops her, so its own stop does not come back here.
     */
    private tappingStopped(): void {
        if (this.waitingWindowId === null || this.cancelImpatience)
            return;
        this.armImpatience(this.waitingWindowId, IMPATIENCE_RETRY);
    }

    /** Focus moved or the title stopped waiting: no more tapping, no pending impatience. */
    private endWait(): void {
        this.cancelImpatience?.();
        this.cancelImpatience = null;
        this.waitingWindowId = null;
        this.behaviour?.stopTapping();
    }

    private offerMute(): void {
        if (!this.menu || !this.timers)
            return;
        this.cancelMuteOffer?.();
        this.menu.offerMute();
        this.cancelMuteOffer = this.timers.schedule(MUTE_OFFER_MS, () => {
            this.cancelMuteOffer = null;
            this.menu?.withdrawMuteOffer();
        });
    }

    private withdrawMuteOffer(): void {
        this.cancelMuteOffer?.();
        this.cancelMuteOffer = null;
        this.menu?.withdrawMuteOffer();
    }

    /**
     * The daemon saw a track start, or a long session end, on one of her
     * Spotify devices. Not told twice with the desktop's own player, see
     * `TrackGate`; kept to herself in a meeting.
     */
    private remoteMusic(kind: 'musique' | 'musique_fin', text: string): void {
        const {behaviour, trackGate} = this;
        if (!behaviour || !trackGate || !this.settings?.reactToMusic || this.meetingState.silent)
            return;
        const now = Date.now();
        if (kind === 'musique_fin') {
            if (trackGate.remoteSilence(now))
                behaviour.remark('silence');
            return;
        }
        const title = trackGate.remoteTrack(oneLine(text, INFO_MAX), now);
        if (title !== null)
            behaviour.remark('musique', {titre: title});
    }

    private syncMusic(): void {
        if (!this.settings?.reactToMusic) {
            this.music?.destroy();
            this.music = null;
            return;
        }
        if (this.music || !this.behaviour)
            return;
        const behaviour = this.behaviour;
        this.music = new MusicWatcher(event => {
            const now = Date.now();
            if (event.kind === 'silence') {
                if (this.trackGate?.localSilence(now) !== false)
                    behaviour.remark('silence');
            } else if (this.trackGate?.localTrack(event.title, now) !== false) {
                behaviour.remark('musique', event.title === null ? {} : {titre: event.title});
            }
        });
    }

    /** The daemon is optional: watched only while she is allowed to use it. */
    private syncBrain(): void {
        if (!this.settings?.brain) {
            this.prompt?.close();
            this.brain?.destroy();
            this.brain = null;
            this.menu?.syncConversation();
            return;
        }
        if (this.brain)
            return;
        this.brain = new Brain(() => this.menu?.syncConversation());
    }

    /**
     * The menu entry or the shortcut. Hidden with the toggle, she is not
     * there to talk to; sent off-screen, she comes back for it. Without the
     * daemon she says so instead of opening a box that leads nowhere.
     */
    private openPrompt(): void {
        // Stormed off, she is not coming back to chat.
        if (!this.isShown() || !this.settings?.brain || !this.prompt || !this.presence || this.presence.isStorming)
            return;
        if (this.presence.isHidden)
            this.presence.comeBack();
        this.menu?.close();
        if (!this.brain?.available) {
            this.sayTrouble(new BrainError('unavailable', 'the daemon is not running'));
            return;
        }
        if (this.prompt.open())
            this.bubble?.setAnchor(this.prompt.actor);
    }

    private ask(text: string): void {
        const brain = this.brain;
        const prompt = this.prompt;
        if (!brain || !prompt)
            return;
        prompt.setPending(true);
        this.bubble?.ponder();
        brain.ask(text, this.context()).then(reply => {
            // Disabled, or the daemon switched off, while she was thinking.
            if (this.brain !== brain || this.prompt !== prompt)
                return;
            prompt.setPending(false);
            if (reply.trim().length === 0) {
                this.sayTrouble(new BrainError('upstream', 'Ask: empty reply'));
                return;
            }
            prompt.clear();
            this.sayLine(reply.trim(), true);
            this.behaviour?.acknowledge();
        }, (error: unknown) => {
            if (this.brain !== brain || this.prompt !== prompt)
                return;
            prompt.setPending(false);
            this.sayTrouble(error);
        });
    }

    /** One of her own lines about the daemon failing; never the error itself. */
    private sayTrouble(error: unknown): void {
        const kind = error instanceof BrainError ? error.kind : 'upstream';
        console.warn(`Crêpe: the daemon could not answer (${kind}): ${error instanceof Error ? error.message : String(error)}`);
        const line = this.voice?.speak(BRAIN_TROUBLE_EVENTS[kind]);
        if (line)
            this.sayLine(line, true);
        else
            this.bubble?.hide();
    }

    /** An idle remark from the daemon, when she may use it and would be let to speak anyway. */
    private askRemark(): Promise<string> | null {
        const brain = this.brain;
        if (!this.settings?.brainRemarks || !brain?.available || !brain.remarksEnabled || !this.voice?.mayRemark || this.prompt?.isOpen)
            return null;
        return brain.remark(this.context()).catch((error: unknown) => {
            console.warn(`Crêpe: no remark from the daemon: ${error instanceof Error ? error.message : String(error)}`);
            throw error;
        });
    }

    private forgetConversation(): void {
        this.brain?.forget().catch((error: unknown) =>
            console.warn(`Crêpe: the daemon could not forget: ${error instanceof Error ? error.message : String(error)}`));
    }

    /**
     * Every line she says goes through here, so the daemon knows what she
     * last said. A reminder waiting for a click holds the bubble: other
     * lines are dropped, unless `force` (an answer to what the user just did).
     * A plain string is a line written to be read as is (the daemon's, a script's).
     */
    private sayLine(line: Utterance | string, force = false): void {
        if (!force && this.reminders?.isShowing)
            return;
        const utterance = typeof line === 'string' ? {text: line, translation: null} : line;
        this.stats?.increment('talks');
        this.bubble?.say(utterance.text, utterance.translation);
        // The daemon reads what she said in clear: a context full of "crêpe" would tell it nothing.
        this.behaviour?.recollection.noteLine(inClear(utterance));
    }

    /**
     * What the daemon gets to know about the moment. The focused window
     * only when she is allowed to read titles at all.
     */
    private context(): string {
        const behaviour = this.behaviour;
        const window = this.settings?.reactToWindows ? this.windows?.window ?? null : null;
        const app = window ? Shell.WindowTracker.get_default().get_window_app(window)?.get_name() ?? null : null;
        if (!behaviour)
            return '{}';
        return contextJson({
            date: new Date(),
            windowTitle: window?.get_title() ?? null,
            app,
            mood: behaviour.moodLevel,
            sleeping: behaviour.isAsleep,
            recollection: behaviour.recollection,
        });
    }

    /** The scale setting or the desktop's scale changed. */
    private rescale(): void {
        const {settings, sprite, presence} = this;
        if (!settings || !sprite || !presence)
            return;
        sprite.setScale(settings.scale * this.themeScale());
        presence.settle();
    }

    private themeScale(): number {
        return St.ThemeContext.get_for_stage(global.stage as Clutter.Stage).scaleFactor;
    }
}

/**
 * Where a banner shows from her, if she stands in a side third of the
 * primary monitor. Banners only show on the primary: from another
 * monitor there is nothing in sight to point at.
 */
function bannerSide(sprite: CrepeSprite): Side | null {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor || Main.layoutManager.findIndexForActor(sprite.actor) !== monitor.index)
        return null;
    const spriteCenterX = sprite.actor.x + sprite.size / 2;
    const third = monitor.width / 3;
    if (spriteCenterX < monitor.x + third)
        return 'right';
    if (spriteCenterX > monitor.x + 2 * third)
        return 'left';
    return null;
}

/** Which side of her body `x` is on, or null when it is right above or below her. */
function sideOf(x: number, body: Clutter.Actor): Side | null {
    if (x < body.x)
        return 'left';
    if (x > body.x + body.width)
        return 'right';
    return null;
}

/** What each kind of nudge makes her do; `info` has no line of its own, its text is the line. */
function nudgeReaction(kind: Exclude<NudgeKind, 'musique' | 'musique_fin'>, values: {texte?: string}, pointer: string | null, glance: string): NudgeReaction {
    switch (kind) {
    case 'tache_terminee':
        return {kind, gesture: pointer, event: 'tache_terminee', values};
    case 'attention':
        return {kind, gesture: 'sursaut', event: 'attention', values, wakes: true};
    case 'pipeline_echec':
        return {kind, gesture: 'facepalm', event: 'pipeline_echec', values};
    case 'ticket_nouveau':
        return {kind, gesture: 'sursaut', event: 'ticket_nouveau', values};
    case 'tickets_ouverts':
        return {kind, gesture: null, event: 'tickets_ouverts', values};
    case 'travail_non_commite':
        return {kind, gesture: glance, event: 'travail_non_commite', values};
    case 'machine':
        // A battery running out is urgent; a disk filling up can wait for a look.
        return {kind, gesture: /batterie/i.test(values.texte ?? '') ? 'sursaut' : glance, event: 'machine', values};
    case 'agenda':
        return {kind, gesture: 'tapote', event: 'agenda', values};
    case 'commande_echec':
        return {kind, gesture: 'facepalm', event: 'commande_echec', values};
    case 'commande_longue':
        return {kind, gesture: 'soupir', event: 'commande_longue', values};
    case 'info':
        return {kind, gesture: null, event: null};
    }
}

/** The drawn gesture points right; pointing left plays it mirrored. */
function pointerTowards(side: Side): string {
    return side === 'right' ? 'pointer' : 'pointer_gauche';
}
