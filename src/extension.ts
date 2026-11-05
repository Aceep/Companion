import type Clutter from 'gi://Clutter';
import Gio from 'gi://Gio';
import type Mtk from 'gi://Mtk';
import St from 'gi://St';

import * as Main from 'resource:///org/gnome/shell/ui/main.js';
import {Extension} from 'resource:///org/gnome/shell/extensions/extension.js';

import {loadAnimations} from './animations.js';
import {IdleBehaviour, type ReactionOptions} from './behaviour.js';
import {SpeechBubble} from './bubble.js';
import {DragHandler} from './drag.js';
import {Hitbox} from './hitbox.js';
import {classify, containsKeyword, looksLikeWaiting, type Reaction} from './keywords.js';
import {CrepeMenu} from './menu.js';
import {MusicWatcher} from './music.js';
import {AnimationPlayer} from './player.js';
import {Positioner, type Side} from './positioner.js';
import {Presence} from './presence.js';
import {CrepeSettings} from './settings.js';
import {CrepeSprite} from './sprite.js';
import {TimerPool} from './timers.js';
import {CrepeToggle} from './toggle.js';
import {ErrorHistory, LongTasks, NotificationTally, errorKey} from './trackers.js';
import {Voice} from './voice.js';
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

export default class CrepeExtension extends Extension {
    private settings: CrepeSettings | null = null;
    private timers: TimerPool | null = null;
    private sprite: CrepeSprite | null = null;
    private hitbox: Hitbox | null = null;
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

    override enable(): void {
        const settings = new CrepeSettings(this.getSettings());
        const assetsDir = this.dir.get_child('assets');
        const animations = loadAnimations(assetsDir);
        const timers = new TimerPool();

        const sprite = new CrepeSprite(settings.scale * this.themeScale());
        sprite.preload(animations.values());
        const hitbox = new Hitbox(sprite);
        addSpriteChrome(sprite, hitbox);
        const positioner = new Positioner(sprite, settings);
        const bubble = new SpeechBubble(sprite, timers);
        const voice = new Voice(settings, () => bubble.isShowing);
        voice.loadLines(assetsDir);

        const player = new AnimationPlayer(animations, timers.schedule, (animation, frame) =>
            sprite.showFrame(animation, frame));
        const behaviour = new IdleBehaviour(player, timers, positioner, settings, {
            centerX: () => sprite.actor.x + sprite.size / 2,
            scale: () => sprite.currentScale,
        }, (event, values) => {
            const line = voice.speak(event, values);
            if (line)
                bubble.say(line);
        });
        const presence = new Presence(sprite, positioner, behaviour, settings);

        const desktopNotifications = new Gio.Settings({schema_id: 'org.gnome.desktop.notifications'});
        const menu = new CrepeMenu(hitbox.actor, settings, {
            openPreferences: () => this.openPreferences(),
            toggleHidden: () => presence.toggleHidden(),
            isHidden: () => presence.isHidden,
            muteNotifications: () => desktopNotifications.set_boolean('show-banners', false),
        });
        this.drag = new DragHandler(hitbox.actor, sprite.actor, {
            onClick: () => {
                // The sliver of her left at the edge is there to be clicked; out there a click is no pestering.
                if (presence.isHidden)
                    presence.comeBack();
                else
                    behaviour.pester('click');
            },
            onSecondaryClick: () => menu.toggle(),
            onDragStart: () => {
                // The menu stays anchored where she was picked up, so it would float in the void.
                menu.close();
                bubble.hide();
                presence.releaseForDrag();
                behaviour.interruptForDrag();
            },
            onDrop: () => {
                positioner.rememberPosition();
                behaviour.resumeAfterDrag();
                behaviour.pester('drag');
            },
            bounds: () => positioner.placementArea(),
        });

        const icon = Gio.FileIcon.new(assetsDir.get_child('reference').get_child('1_sud_face.png'));
        this.toggle = new CrepeToggle(icon, settings.gsettings);

        // Banners off: the tray still gets every notification, she just stops talking about them.
        this.bannersHandlerId = desktopNotifications.connect('changed::show-banners', () => this.syncHush(true));

        const tally = new NotificationTally();
        this.notifications = new NotificationWatcher(text => {
            // Off-screen she sees nothing.
            if (!settings.reactToNotifications || presence.isAway)
                return;
            const keyword = classify(text, settings.errorKeywords, settings.successKeywords);
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
            if (reaction === 'facepalm') {
                longTasks.forget(windowId);
                this.reactToKeyword('facepalm', errorKey(windowId, title));
                return;
            }
            if (longTasks.update(windowId, containsKeyword(title, settings.busyKeywords), Date.now())) {
                behaviour.react('pouce', {event: 'patience'});
                return;
            }
            if (reaction)
                this.reactToKeyword(reaction, null);
        }, () => this.endWait());
        this.newWindows = new NewWindowWatcher(frame => this.pointAtWindow(frame));

        settings.onChanged('visible', () => this.applyVisibility());
        settings.onChanged('scale', () => {
            sprite.setScale(settings.scale * this.themeScale());
            presence.settle();
        });
        settings.onChanged('sleep-after-minutes', () => behaviour.refresh());
        settings.onChanged('crawl', () => behaviour.refresh());
        settings.onChanged('perch', () => presence.refresh());
        settings.onChanged('react-to-music', () => this.syncMusic());

        this.settings = settings;
        this.timers = timers;
        this.sprite = sprite;
        this.hitbox = hitbox;
        this.bubble = bubble;
        this.voice = voice;
        this.menu = menu;
        this.positioner = positioner;
        this.behaviour = behaviour;
        this.presence = presence;
        this.desktopNotifications = desktopNotifications;
        this.longTasks = longTasks;
        this.errors = new ErrorHistory();
        // Banners may already be off: she starts hushed, without making a show of it.
        this.syncHush(false);
        this.syncMusic();
        this.applyVisibility();
    }

    override disable(): void {
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

        if (this.sprite && this.hitbox) {
            if (this.sprite.actor.get_parent() !== null)
                removeSpriteChrome(this.sprite, this.hitbox);
            // It listens to the sprite's position, so it has to go first.
            this.hitbox.destroy();
            this.sprite.destroy();
        }
        this.hitbox = null;
        this.sprite = null;

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
        if (!this.settings || !this.sprite || !this.hitbox || !this.behaviour || !this.presence)
            return;
        const onStage = this.sprite.actor.get_parent() !== null;
        if (this.settings.visible) {
            if (!onStage) {
                addSpriteChrome(this.sprite, this.hitbox);
                this.positioner?.place();
            }
            this.behaviour.start();
            this.presence.start();
            return;
        }
        this.bubble?.hide();
        // Hidden for good means back home: showing her again should not find her off-screen.
        this.presence.stop();
        this.behaviour.stop();
        if (onStage)
            removeSpriteChrome(this.sprite, this.hitbox);
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

    private themeScale(): number {
        return St.ThemeContext.get_for_stage(global.stage as Clutter.Stage).scaleFactor;
    }
}

/** The sprite only shows her; clicks go to the hitbox over her body, above it. */
function addSpriteChrome(sprite: CrepeSprite, hitbox: Hitbox): void {
    Main.layoutManager.addTopChrome(sprite.actor, {
        affectsInputRegion: false,
        affectsStruts: false,
        trackFullscreen: true,
    });
    Main.layoutManager.addTopChrome(hitbox.actor, {
        affectsInputRegion: true,
        affectsStruts: false,
        trackFullscreen: true,
    });
}

function removeSpriteChrome(sprite: CrepeSprite, hitbox: Hitbox): void {
    Main.layoutManager.removeChrome(hitbox.actor);
    Main.layoutManager.removeChrome(sprite.actor);
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

/** The drawn gesture points right; pointing left plays it mirrored. */
function pointerTowards(side: Side): string {
    return side === 'right' ? 'pointer' : 'pointer_gauche';
}
