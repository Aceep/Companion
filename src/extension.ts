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
import {Dodger} from './dodge.js';
import {DragHandler} from './drag.js';
import {EyesFollower} from './gaze.js';
import {Hitbox} from './hitbox.js';
import {classify, containsKeyword, looksLikeWaiting, type Reaction} from './keywords.js';
import {SpriteLayer} from './layer.js';
import {CrepeMenu} from './menu.js';
import {MusicWatcher} from './music.js';
import {INFO_MAX, NudgeService, TEXT_IN_LINE_MAX, oneLine, ticketCount, type NudgeKind} from './nudge.js';
import {OutfitLayer, loadOutfits} from './outfit.js';
import {AnimationPlayer} from './player.js';
import {Positioner, type Side} from './positioner.js';
import {Presence} from './presence.js';
import {PromptBox} from './prompt.js';
import {CrepeSettings, TALK_SHORTCUT_KEY} from './settings.js';
import {CrepeSprite, HEAD_PADDING} from './sprite.js';
import {StatsStore, dayKey} from './stats.js';
import {TimerPool} from './timers.js';
import {CrepeToggle} from './toggle.js';
import {ErrorHistory, LongTasks, NotificationTally, errorKey} from './trackers.js';
import {Voice, type TriggerEvent} from './voice.js';
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

    override enable(): void {
        const settings = new CrepeSettings(this.getSettings());
        const assetsDir = this.dir.get_child('assets');
        const animations = loadAnimations(assetsDir);
        const timers = new TimerPool();
        const stats = new StatsStore(() => settings.stats, json => {
            settings.stats = json;
        }, timers.schedule);
        // Set before anything can count: the behaviour and the watchers below report to it.
        this.stats = stats;

        const sprite = new CrepeSprite(settings.scale * this.themeScale());
        sprite.preload(animations.values());
        const outfits = new OutfitLayer(sprite, loadOutfits(assetsDir, animations.keys()));
        this.outfits = outfits;
        const hitbox = new Hitbox(sprite);
        const layer = new SpriteLayer(sprite, hitbox);
        layer.show(settings.layer);
        const positioner = new Positioner(sprite, settings);
        const bubble = new SpeechBubble(sprite, timers);
        const voice = new Voice(settings, () => bubble.isShowing);
        voice.loadLines(assetsDir);

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
            // Any line may mention the open tickets; the voice decides how often.
            const tickets = this.behaviour?.recollection.openTickets ?? null;
            const line = voice.speak(event, tickets === null ? values : {tickets: String(tickets), ...values});
            if (!line)
                return;
            if (event === 'commentaire')
                stats.increment('remarks');
            this.sayLine(line);
        });
        behaviour.setStatsListener(counter => stats.increment(counter));
        behaviour.setFocusListener(focusing => this.focusChanged(focusing));
        const presence = new Presence(sprite, hitbox, positioner, behaviour, settings);
        this.eyes = new EyesFollower(behaviour, timers, {
            eyes: () => ({
                x: sprite.actor.x + sprite.size / 2,
                y: sprite.actor.y + (HEAD_PADDING + EYES_BELOW_HEAD) * sprite.currentScale,
            }),
            body: () => ({x: hitbox.actor.x, y: hitbox.actor.y, width: hitbox.actor.width, height: hitbox.actor.height}),
        });
        this.dodger = new Dodger(sprite, presence, behaviour, positioner, timers, () => behaviour.remark('esquive'));
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

        const desktopNotifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
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
        });
        this.drag = new DragHandler(hitbox.actor, sprite.actor, {
            onClick: () => {
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
            bounds: () => positioner.placementArea(),
        });

        const icon = Gio.FileIcon.new(assetsDir.get_child('reference').get_child('1_sud_face.png'));
        this.toggle = new CrepeToggle(icon, settings.gsettings);

        // Banners off: the tray still gets every notification, she just stops talking about them.
        this.bannersHandlerId = desktopNotifications.connect('changed::show-banners', () =>
            this.syncHush(!this.flippingBannersForFocus));

        const tally = new NotificationTally();
        this.notifications = new NotificationWatcher(text => {
            // Counted whether she reacts or not: the recap is about your day, not hers.
            const keyword = classify(text, settings.errorKeywords, settings.successKeywords);
            stats.increment('notifications');
            if (keyword === 'facepalm')
                stats.increment('errors');
            else if (keyword === 'pouce')
                stats.increment('successes');
            // Off-screen she sees nothing; focusing, she lets them go by.
            if (!settings.reactToNotifications || presence.isAway || behaviour.focusMode)
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
        this.windows = new FocusedWindowWatcher((title, windowId) => {
            if (!settings.reactToWindows) {
                this.endWait();
                return;
            }
            const reaction = classify(title, settings.errorKeywords, settings.successKeywords);
            // "Building... failed" is over, whatever its dots say.
            this.followWait(windowId, reaction !== 'facepalm' && looksLikeWaiting(title));
            // Only what she reacted to is counted: a title is seen again every time its window gets focus.
            if (reaction === 'facepalm') {
                longTasks.forget(windowId);
                if (this.reactToKeyword('facepalm', errorKey(windowId, title)))
                    stats.increment('errors');
                return;
            }
            if (longTasks.update(windowId, containsKeyword(title, settings.busyKeywords), Date.now())) {
                if (behaviour.react('pouce', {event: 'patience'}))
                    stats.increment('successes');
                return;
            }
            if (reaction && this.reactToKeyword(reaction, null))
                stats.increment(reaction === 'pouce' ? 'successes' : 'errors');
        }, () => this.endWait());
        this.newWindows = new NewWindowWatcher(frame => this.pointAtWindow(frame));

        settings.onChanged('visible', () => this.applyVisibility());
        settings.onChanged('scale', () => {
            sprite.setScale(settings.scale * this.themeScale());
            presence.settle();
        });
        settings.onChanged('sleep-after-minutes', () => behaviour.refresh());
        settings.onChanged('crawl', () => behaviour.refresh());
        settings.onChanged('crawl-interval-minutes', () => behaviour.refresh());
        settings.onChanged('comment-interval-minutes', () => behaviour.refresh());
        settings.onChanged('stats', () => stats.settingChanged());
        settings.onChanged('focus-minutes', () => menu.syncFocus());
        settings.onChanged('perch', () => presence.refresh());
        settings.onChanged('eyes-follow', () => this.syncEyes());
        settings.onChanged('dodge', () => this.syncDodge());
        settings.onChanged('layer', () => this.syncLayer());
        settings.onChanged('react-to-music', () => this.syncMusic());
        settings.onChanged('brain', () => this.syncBrain());
        settings.onChanged('outfits', () => this.syncOutfits());
        settings.onChanged('outfit-override', () => this.syncOutfits());
        settings.onChanged('birthday', () => this.syncOutfits());

        this.settings = settings;
        this.timers = timers;
        this.sprite = sprite;
        this.hitbox = hitbox;
        this.layer = layer;
        this.bubble = bubble;
        this.voice = voice;
        this.menu = menu;
        this.prompt = prompt;
        this.positioner = positioner;
        this.behaviour = behaviour;
        this.presence = presence;
        this.desktopNotifications = desktopNotifications;
        this.longTasks = longTasks;
        this.errors = new ErrorHistory();
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
        this.nudges = new NudgeService(String(this.metadata.version ?? ''), (kind, text) => this.nudge(kind, text));
        this.scheduleRecapCheck();
        this.scheduleOutfitCheck();
        this.applyVisibility();
        this.syncOutfits();
    }

    override disable(): void {
        this.nudges?.destroy();
        this.nudges = null;
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

        this.drag?.destroy();
        this.drag = null;

        this.menu?.destroy();
        this.menu = null;

        // Both talk to the behaviour and the presence, so they go first.
        this.eyes?.stop();
        this.eyes = null;
        this.dodger?.stop();
        this.dodger = null;

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
        if (this.sprite && this.hitbox) {
            // It listens to the sprite's position, so it has to go first.
            this.hitbox.destroy();
            this.sprite.destroy();
        }
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
        if (this.settings.visible) {
            if (!this.layer.isShown) {
                this.layer.show(this.settings.layer);
                this.positioner?.place();
            }
            this.behaviour.start();
            this.presence.start();
            this.syncEyes();
            this.syncDodge();
            return;
        }
        this.prompt?.close();
        this.bubble?.hide();
        this.syncEyes();
        this.syncDodge();
        // Hidden for good means back home: showing her again should not find her off-screen.
        this.presence.stop();
        this.behaviour.stop();
        this.layer.hide();
    }

    /** Polling the pointer only while she is shown and her eyes may follow it. */
    private syncEyes(): void {
        if (!this.settings || !this.eyes)
            return;
        if (this.settings.visible && this.settings.eyesFollow)
            this.eyes.start();
        else
            this.eyes.stop();
    }

    /** Under the windows she cannot be in anyone's way. */
    private syncDodge(): void {
        if (!this.settings || !this.dodger)
            return;
        this.dodger.sync(this.settings.visible && this.settings.dodge && this.settings.layer === 'top');
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
        const now = new Date();
        const today = dayKey(now);
        if (!settings.recap || now.getHours() !== settings.recapHour || settings.lastRecapDate === today)
            return;
        if (!settings.visible || behaviour.isAsleep || presence.isAway || behaviour.focusMode || behaviour.isHushed)
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
        const worn = activeOutfits(this.outfitClock(), {
            isAsleep: behaviour.isAsleep,
            isSulking: behaviour.isSulking,
        }, {
            enabled: settings.outfits,
            override: settings.outfitOverride,
            birthday: settings.birthday,
        });
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
        if (!settings.visible || behaviour.isAsleep || presence.isAway || behaviour.focusMode || behaviour.isHushed)
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
        const texte = oneLine(text, TEXT_IN_LINE_MAX);
        // Without it, the lines that need it are skipped.
        const values = texte.length > 0 ? {texte} : {};
        this.stats?.increment('nudges');
        // A broken pipeline is an error of the day, whether or not she gets to facepalm at it.
        if (kind === 'pipeline_echec')
            this.stats?.increment('errors');
        const reaction = nudgeReaction(kind, values, this.pointerAtFocusedWindow(), this.glanceAtPointer());
        if (!behaviour.nudged(reaction) || kind !== 'info' || behaviour.isHushed)
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

    /** Banners drop in at the top centre: from a side third of the screen she may point at them instead of jumping. */
    private jumpAtNotification(options: ReactionOptions): boolean {
        if (!this.behaviour || !this.sprite)
            return false;
        const side = bannerSide(this.sprite.actor.x + this.sprite.size / 2);
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
        const behaviour = this.behaviour;
        this.waitingWindowId = windowId;
        this.cancelImpatience = this.timers.schedule(dueIn, () => {
            this.cancelImpatience = null;
            behaviour.startTapping();
        });
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
            if (event.kind === 'silence')
                behaviour.remark('silence');
            else
                behaviour.remark('musique', event.title === null ? {} : {titre: event.title});
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
        if (!this.settings?.visible || !this.settings.brain || !this.prompt || !this.presence || this.presence.isStorming)
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
            this.sayLine(reply.trim());
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
            this.sayLine(line);
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

    /** Every line she says goes through here, so the daemon knows what she last said. */
    private sayLine(line: string): void {
        this.stats?.increment('talks');
        this.bubble?.say(line);
        this.behaviour?.recollection.noteLine(line);
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

    private themeScale(): number {
        return St.ThemeContext.get_for_stage(global.stage as Clutter.Stage).scaleFactor;
    }
}

/** Where a banner shows from her, if she stands in a side third of the primary monitor. */
function bannerSide(spriteCenterX: number): Side | null {
    const monitor = Main.layoutManager.primaryMonitor;
    if (!monitor)
        return null;
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
function nudgeReaction(kind: NudgeKind, values: {texte?: string}, pointer: string | null, glance: string): NudgeReaction {
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
    case 'info':
        return {kind, gesture: null, event: null};
    }
}

/** The drawn gesture points right; pointing left plays it mirrored. */
function pointerTowards(side: Side): string {
    return side === 'right' ? 'pointer' : 'pointer_gauche';
}
