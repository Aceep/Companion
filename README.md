# Crêpe

A bored pixel-art octopus that lives in the corner of your GNOME desktop,
fidgets while you work, falls asleep when you leave and waves when you
come back. Built as a GNOME Shell extension so she can see what happens on
screen (notifications, focused window, pointer, idle time), which a regular
window cannot do under Wayland.

Sprites and animation timings come from Theo's `pieuvre_animations.zip`
and are kept verbatim in `assets/`. See his brief for the style rules and
the PixelLab recipe for new animations.

## Requirements

- GNOME Shell 46 (Wayland or X11)
- Node 22 for the TypeScript build

## Develop

```sh
npm install
npm run build      # tsc -> dist/
npm run deploy     # build + copy to ~/.local/share/gnome-shell/extensions/
npm run nested     # deploy + run an isolated nested GNOME Shell with Crêpe enabled
```

The nested shell has its own D-Bus session and an in-memory GSettings
backend, so enabling the extension there never affects your real session.
Close the nested window to stop it.

To use Crêpe for real, deploy then log out and back in (Wayland cannot
reload extensions in place), then:

```sh
gnome-extensions enable crepe@aceep.github.io
```

A "Crêpe" toggle in the quick settings menu hides or shows her without
disabling the extension. Settings live in the extension's preferences:

- size, and whether she is shown at all;
- minutes of inactivity before she falls asleep, and the hour after
  which she goes to bed by herself (0 turns it off, default 20);
- minutes of continuous activity before she suggests a break (0 turns
  it off, default 50);
- crawling, talking, perching on the focused window (off by default);
- reacting to notifications, to window titles and to music;
- error, success and busy keywords.

Open them with:

```sh
gnome-extensions prefs crepe@aceep.github.io
```

## What she does

- Sits still and blinks every few seconds. Once or twice a minute she
  breathes, sighs, yawns or glances towards the pointer.
- Falls asleep after a configurable idle time, waves when you come back.
- Jumps on any notification. If its title or body contains an error
  keyword she facepalms instead; a success keyword earns a thumbs up.
  Standing in the left or right third of the screen, half the time she
  points a tentacle towards the top centre, where the banner shows,
  instead of jumping.
- Watches the focused window's title with the same keywords, so a
  terminal or IDE tab that says "failed" gets the facepalm. One reaction
  every four seconds at most.
- After three errors within half an hour, the next success gets a slow,
  sarcastic round of applause instead of a thumbs up. The same error
  title in the same window a third time within half an hour gets a
  puzzled head scratch instead of a facepalm.
- A focused window whose title keeps saying it is loading (`loading`,
  `chargement`, `compiling`, `building`, `installing`, `en cours`, or a
  title ending in `…` or `...`) for 30 seconds gets her tapping a
  tentacle, over and over, until the title moves on or focus does.
- A new window opening clearly to one side of her may get pointed at,
  silently, once a minute at most.
- A window title that says it is busy (`building`, `npm run`, `cargo`,
  `pytest`, `chargement`...; the list is a setting) for two minutes or
  more, then stops saying it, earns a thumbs up and a remark about
  patience. If the title turns to an error instead, the facepalm wins.
- Every few minutes she crawls sideways to a new spot.
- "Se cacher" in her menu sends her crawling to the nearest screen edge
  and past it, until only the tips of her tentacles stick out. She
  ignores everything out there, notifications included. She comes back
  to her spot when you click what is left of her, when she wakes up from
  a nap out there (you were away long enough for her to doze off, then
  came back), or when you toggle her off and on in quick settings. While
  she is away or still crawling there, the same menu entry reads
  "Revenir". A click out there is not pestering.
- With "Perches on the focused window" on, she crawls onto the right end
  of the focused window's title bar and rides along when it moves. She
  goes back to her own spot when focus goes to the desktop or the window
  is minimized or closed. Drop her somewhere and that becomes her spot.
- A click on her is a hello. Only her body takes clicks: the transparent
  margin of her frame lets them through, so perched on a title bar she
  does not steal clicks from the window's buttons.
- She does not like being pestered. Clicks and moves add up (a move
  counts double) and wear off after a while. A few too many and she looks
  away with a sigh; keep going and she swings her bat once, then sulks
  for a minute: no fidgets, no crawling, one-word answers to clicks.
  Notifications still make her jump.
- She talks, a little. A bubble above her head shows a short line when a
  notification arrives, when something fails or succeeds, when you click
  her, when she falls asleep or wakes up, and very rarely for no reason.
  Greetings get a remark about the hour now and then (morning, evening,
  Friday afternoon). The first greeting or click of the day, before ten,
  tells the time.
- At the tenth notification within an hour (then the twentieth...) she
  asks if she should mute them, and her menu offers "Couper les
  notifications" for five minutes. It turns notification banners off for
  the whole desktop. When banners go off, by her or by you, she puts a
  tentacle to her mouth and says nothing at all until they come back on,
  which she remarks on. She still jumps when a notification comes in.
- Past bedtime (20:00 by default, until 6 in the morning) she announces
  she is going to bed after one of her fidgets and falls asleep. That nap
  ends like any other: once you have been idle for the sleep delay and
  come back. Ten minutes later, if it is still late, she goes back to bed.
- After 50 minutes of activity without three idle minutes in a row she
  yawns and tells you to take a break, then waits for another 50.
- She listens to the first media player on the session bus (anything
  speaking MPRIS) and now and then remarks on a new track, sometimes by
  its title. When music stops after more than twenty minutes, she
  notices the quiet. At most one line every 45 seconds, clicks,
  greetings and annoyance aside. The lines live in `assets/repliques.json`, one list per
  event; add a string to a list and redeploy. Every event key must stay
  present and non-empty or the extension refuses to load. A line may
  use `{heure}` (the time, `HH:MM`) anywhere, and `{titre}` (the track
  title) in `musique`; any other name between braces is refused at load. A switch in the
  menu and in the preferences silences her.
- A right-click opens a small menu: preferences, switches for crawling
  and talking, a way to send her off-screen ("Se cacher") and one to hide
  her completely.
- You can drag her anywhere on the primary monitor. She remembers the
  spot across logouts and crawls at that height.

## Layout

| Path | Role |
| --- | --- |
| `src/animations.ts` | Loads `assets/animations.json`, resolves frame files, adds mirrored variants |
| `src/player.ts` | Animation state machine: loops, one-shots, tail loops. No GNOME dependency |
| `src/sprite.ts` | Clutter actor showing the current frame, nearest-neighbour upscaling, mirrored frames |
| `src/hitbox.ts` | Invisible actor over her body that takes clicks, kept on the sprite |
| `src/positioner.ts` | Keeps her inside the work area at a remembered spot, moves her sideways, off-screen or anywhere for trips |
| `src/presence.ts` | Where she is when not at her spot: hiding off-screen, perched on the focused window. Drives the trips there and back |
| `src/drag.ts` | Click versus drag on the hitbox, pointer grab while she is carried |
| `src/menu.ts` | Right-click menu: preferences, crawl and talk switches, off-screen and hide entries, temporary mute offer |
| `src/behaviour.ts` | Blinks, rare fidgets, crawling, sleep on idle and at bedtime, wave on return, reactions, impatient tapping, hush, pestering, break reminder, trips she is sent on, events worth a line |
| `src/mood.ts` | Annoyance score from clicks and moves, decay and sulking. No GNOME dependency |
| `src/voice.ts` | Picks a line from `assets/repliques.json`: cooldown, odds, time of day, `{heure}` and `{titre}` placeholders. No Clutter dependency |
| `src/bubble.ts` | Speech bubble above her head, follows her and fades out on its own |
| `src/watchers.ts` | Notification, focused-window title and new-window sources |
| `src/music.ts` | MPRIS player watcher on the session bus, and the pure tracker deciding what is a new track or a long session ending |
| `src/trackers.ts` | Notification tally per hour, long tasks and waits seen in window titles, recent errors, continuous activity, bedtime hours. No GNOME dependency |
| `src/keywords.ts` | Text to reaction mapping. No GNOME dependency |
| `src/settings.ts` | Typed view over the GSettings schema |
| `src/toggle.ts` | Quick settings on/off switch, bound to the `visible` setting |
| `src/prefs.ts` | Preferences window (libadwaita) |
| `src/extension.ts` | Wires everything into the shell, cleans up on disable |
| `schemas/` | GSettings schema, compiled at deploy time |
| `scripts/` | Deploy, nested-shell and blink-frame helpers |

## Animation metadata

`assets/animations.json` is Theo's file with three additions:

- `boucle_fin` on `endormie`: the 1-based inclusive frame range to loop
  once she is asleep (frames 5 to 8), as described in his brief.
- `attente`: a single-frame loop, the resting pose. It is the default
  state instead of `respiration`, so her tentacles stay still.
- `clignement`: a four-frame blink drawn on top of the resting pose with
  the closed-eye arc from `endormie`. Both are generated by
  `scripts/make-blink.py` from `respiration_00.png`; rerun it if that
  frame changes.

`pointer` is only drawn pointing right. `src/animations.ts` adds
`pointer_gauche`, the same frames flipped horizontally when they are
decoded; her body sits in the middle of the frame, so nothing shifts.

## Typings

`@girs/gnome-shell@46` targets GNOME 46. Its transitive `@girs/*`
packages are pinned through `overrides` in `package.json`; without that
npm installs several incompatible copies of the GObject typings and
`tsc` rejects perfectly valid calls.
