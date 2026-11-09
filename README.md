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

`npm test` compiles `src/` and `tests/` to `build/test/` and runs the
tests with `node --test`. Only modules without a value import from
`gi://` load under node; those are the ones marked "No GNOME dependency"
in the layout below, and the ones the tests cover.

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
- "Suit la souris des yeux" (on by default), "S'écarte de la fenêtre
  active" (on by default) and "Couche": above the windows (default) or
  behind them;
- under "Rythme": the average minutes between two idle remarks (default
  30) and two crawls of her own (default 5), each wait picked between two
  thirds and four thirds of it, 0 meaning never; the chance she crawls
  back after being dropped (default 25 %); the length of a focus session
  (default 45 minutes) and whether it turns notification banners off
  (on by default); the evening recap and its hour (on, 18 by default);
- reacting to notifications, to window titles and to music;
- error, success and busy keywords;
- under "Tenues": whether she dresses up at all, her birthday (`MM-JJ`,
  21 May by default; a date that does not exist is refused) and
  "Tenue forcée", one outfit she wears whatever the date, to show it off;
- on the "Cerveau" page, the conversation daemon: whether to use it,
  whether it may write some of her idle remarks, and the shortcut to
  talk to her;
- on the "Statistiques" page, what she counted today, over 7 days and
  over 30 days, with a "Réinitialiser" button.

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
- Every few minutes (5 on average, a setting) she crawls sideways to a
  new spot.
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
- Resting, her eyes follow the pointer, in eight directions. Within 60
  pixels of her body, or once the pointer has been still for 4 seconds,
  she looks straight ahead again. Blinks are drawn on the straight pose.
  The pointer is polled every 150 ms, only while the setting is on and
  she is shown; mid-gesture, asleep, carried or crawling she does not
  look around.
- Above the windows she can sit right over the one you work in. When
  the focused window comes under her (more than a quarter of her frame
  over it, once it has stopped moving for 400 ms), she crawls along her
  row to the nearest spot clear of it, inside the work area. A window
  taking the whole row (maximized) sends her to the bottom-right corner
  instead. Three seconds after that window loses focus or moves off her
  spot, she crawls back there; dropped somewhere meanwhile, that is her
  spot now. The first time a window sends her aside she may say so
  (`esquive`, one time in three); never from the corner. One dodge every
  10 seconds at most, and none while she is perched, hiding, asleep,
  carried, storming off or focusing, nor in the "behind" layer.
- "Couche" in the preferences puts her behind the windows instead: on
  the desktop, above the wallpaper and the desktop icons, under every
  window. Her speech bubble stays above the windows so it can be read.
  The switch takes effect at once. Clicks reach her wherever she shows
  on Wayland; on X11 she takes none in that layer, since claiming her
  spot for the shell would steal clicks from the windows covering her.
- A click on her is a hello. Only her body takes clicks: the transparent
  margin of her frame lets them through, so perched on a title bar she
  does not steal clicks from the window's buttons.
- She does not like being pestered. Clicks and moves add up (a move
  counts double) and wear off at one point every 20 seconds. From 4
  points she looks away with a sigh; at 8 she swings her bat once, then
  sulks for a minute and a half with the bat held in front of her: no
  fidgets, no crawling, one-word answers to clicks. Every poke while she
  sulks pushes its end back. When it is over she puts the bat away
  behind her, with a word about it. Notifications still make her jump.
- Keep pestering her while she sulks until the score reaches its cap of
  12 points and she has had enough: a word on her way out, then she
  crawls off by the nearest side of the screen, all of her this time,
  nothing left to click. For a minute she ignores everything:
  notifications, scripts, the menu (there is nothing to right-click),
  `Super+C`. Then she crawls back by the same side to her spot, bat still
  in hand, with a word about it: the score is down to 8 and she sulks at
  least another minute, so the next poke does not send her away again.
  A calm octopus never storms off in one go, it takes pestering her
  mid-sulk. Turning her off with the quick settings toggle while she is
  gone, then on again, brings her straight back home, still sulking.
- Dropped somewhere else, she sometimes says she was better off where
  she was and crawls straight back there: one time in four when calm by
  default ("Retour à sa place", 0 to 100 %), twice that when annoyed,
  every time while she sulks. Not when dropped within 40 pixels of where
  she was, nor with crawling turned off.
- She talks, a little. A bubble above her head shows a short line when a
  notification arrives, when something fails or succeeds, when you click
  her, when she falls asleep or wakes up, and now and then for no reason
  (every 30 minutes on average, a setting; 0 turns those off).
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
  title) in `musique`, `{texte}` (what a script sent, see below) in
  the nudge events, `{tickets}` (the last count of open tickets a
  script sent) in any event she says on her own (`retour`, `matin`,
  `clic`, `commentaire`...), where such a line comes up one time in
  three once the count is known and never before, and `{notifs}`,
  `{erreurs}`, `{succes}`, `{clics}`, `{nudges}` in `bilan`, `{resume}` in
  `reunion_fin_resume`; any other
  name between braces is refused at load. A switch in the menu and in
  the preferences silences her.
- "Mode concentration (45 min)" in her menu (the length is a setting)
  starts a focus session: no idle remarks, no crawls of her own, no
  fidgets, no bedtime, no reactions to notifications, window titles or
  music. She holds still. Only clicks (which still annoy her) and
  `attention` nudges get through. With "Ne pas déranger pendant la
  concentration" on, notification banners go off for the session and
  back to what they were after, without her usual tentacle to the mouth.
  The entry reads "Arrêter la concentration" meanwhile; when the session
  ends, by itself or from the menu, she says so (`fin_concentration`)
  and everything resumes. Hiding or disabling her ends it silently, and
  the banners come back.
- Once a day, during the recap hour (18 by default), if she is shown,
  awake, at home, not focusing and not hushed, she sums up the day from
  her counters: notifications, errors, successes, clicks on her and
  script nudges (`bilan`). A day with none of those gets a shorter line.
  The day of the last recap is kept in the settings, so logging in again
  does not repeat it; missed for the whole hour, it is skipped.
- She counts, per day: notifications, errors and successes (keywords in
  notifications, window titles she reacted to, failed pipelines from
  scripts), clicks, drags, sulks, storms, nudges, lines said, crawls and
  idle remarks. The last 30 days live in the `stats` setting as JSON,
  written at most once a minute and when the extension is disabled; the
  "Statistiques" page of the preferences reads it.
- Pestered past her patience she spits ink: 1 to 3 dark splats on the monitor she is on, below
  the top bar, over the windows, taking no clicks, fading away in about 20 seconds (3 on screen
  at most). She does it when she storms off and once per sulk when poked meanwhile (`encre`),
  never during a meeting, and they vanish when she is hidden. "Crache de l'encre" turns it off.
  The splats are drawn by `scripts/make-ink.py` into `assets/encre/`.
- She remembers the week. The stats also count failed pipelines and commands, ignored
  reminders and focus sessions. At most once a day an idle remark is replaced by a notable fact
  of the last 7 days, not today ("Au fait, mardi : 4 pipelines cassés. Je dis ça…":
  `rappel_pipeline`, `rappel_commandes`, `rappel_bouderie`, `rappel_focus`, with `{jour}` and `{nombre}`). On Friday from
  17:00, with the recap on, she sums the week up once (`bilan_semaine`, `{resume}`).
- She dresses up for the occasion, see "Tenues" below.
- A right-click opens a small menu: preferences, the focus session,
  switches for crawling and talking, a way to send her off-screen ("Se
  cacher") and one to hide her completely.
- You can drag her anywhere on the primary monitor. She remembers the
  spot across logouts and crawls at that height.

## Tenues

Outfits are 80×80 PNGs drawn over her frame, or under it, at the same
origin, scaled with her and never blurred. They change nothing else: her
hitbox, bubble and menu stay where they were, and they follow her in
both layers. What she wears:

| Outfit | When |
| --- | --- |
| `masque_nuit` | A sleep mask, while she sleeps |
| `bonnet` | A red knit hat, from 1 December to the end of February, all day |
| `lunettes` | Sunglasses, from 21 June to 1 September, 11:00 to 17:00, not asleep |
| `chapeau_fete` | A party hat on her birthday, all day, asleep too. It replaces the knit hat |
| `verre`, `transat` | A drink and a deckchair on Friday from 17:00 until midnight. Sulking, the bat replaces the drink; the deckchair stays |

What she wears is checked every minute and every time she starts an
animation, so falling asleep, waking up and the bat coming out show at
once. The first time each of `bonnet`, `lunettes`, `chapeau_fete` and the
Friday pair goes on in a day, she says a word about it (`tenue_hiver`,
`tenue_ete`, `tenue_fete`, `tenue_vendredi` in `assets/repliques.json`)
when she can: shown, awake, at home, not focusing, not hushed, and past
the usual 45 seconds between two lines; otherwise she tries again at the
next minute while she still wears it. The day each one was said lives in
the `last-outfit-lines` setting, so logging in again does not repeat it.
The sleep mask comes with falling asleep, which has its own line.

"S'habille selon le jour" off (`outfits`) takes everything off, forced
outfit included. "Tenue forcée" (`outfit-override`) makes her wear that
outfit alone instead of what the rules say; it still shows only during
the animations it allows, so the sleep mask needs her asleep. Putting a
forced outfit on counts as putting it on: it gets its line of the day.

`assets/tenues.json` describes each outfit:

```json
"bonnet": {
  "usage": "…",
  "calques": [{"fichier": "tenues/bonnet.png", "z": "devant", "suit_la_tete": true}],
  "visible_pendant": ["attente", "yeux_*"],
  "cache_pendant": ["ramper_*", "batte"]
}
```

- `calques`: one or more layers. `z` is `devant` (over her) or
  `derriere` (under her, like the deckchair). With `suit_la_tete`, the
  layer moves up and down with her head, frame by frame: the extension
  finds the top of her head in every frame when it decodes them, so a
  hat stays on through a breath, a yawn or a jump.
- `visible_pendant` (optional): the only animations it shows during;
  `cache_pendant`: animations it hides during, whichever else allows it.
  A name ending in `*` covers every animation starting with the rest.
  Hats come off for a crawl, a bat swing and a head scratch, the glasses
  for a facepalm or a tentacle to the mouth, the drink shows only while
  she rests, since her tentacles move in every gesture.

Every outfit the rules know must be in it, every file must exist and
every animation name must match one, or the extension refuses to load.

The PNGs in `assets/tenues/` are hand-drawn placeholders made by
`scripts/make-outfits.py`, on the coordinates of `attente_00.png` (her
head's top on row 20, her eyes on rows 39 to 45), in her palette, with
a 1 px dark outline and flat fills. The script is deterministic. To use
other art, save an 80×80 RGBA PNG under the same name, positioned
against `attente_00.png` the same way (against her head in the resting
pose for a layer that follows her head), and do not rerun the script,
or remove that outfit from its `OUTFITS` table first. Adjust
`visible_pendant` and `cache_pendant` if the new art needs it.

## Lui parler

With the optional daemon in `daemon/` running, she can answer what you
type to her. Without it nothing changes: the menu entries below stay
hidden and she keeps to her written lines.

- `Super+C` (a setting) or "Lui parler…" in her menu opens a small box
  over her head. Enter sends, Escape or a click anywhere else closes it.
  While she thinks the bubble shows "…"; her answer replaces it and the
  box stays open for the next one. Hidden with the toggle she is not
  there to talk to and the shortcut does nothing; sent off-screen, she
  comes back for it.
- When the daemon cannot answer she says so in her own words: no key or
  no daemon, the day's budget spent, or the remote model failing or too
  slow (45 seconds). The reason goes to the shell's journal, never to
  the screen. These lines are the `cerveau_absent`, `cerveau_fatigue`
  and `cerveau_panne` events of `assets/repliques.json`.
- "Oublier notre conversation", at the bottom of the same part of the
  menu, makes the daemon drop the exchanges it keeps.
- "Remarques spontanées" in the preferences (off by default) lets one
  idle remark in three come from the daemon, under the same cooldown as
  the written ones. The daemon also has to allow remarks in its own
  config; when it has nothing to say, she says nothing.

What is sent, with each question or remark, and nothing else: the hour
and the day of the week, her mood (calm, annoyed or sulking, storming
off counting as sulking), whether she is asleep, the last five things
that happened to her (event kind and how many seconds ago: a
notification, an error, a click, a nudge from a script...), the last
three lines she said, and, only while "Reacts to window titles" is on,
the focused window's title and application name. The daemon adds the
last 20 exchanges it keeps (what you typed and what she answered); see
`daemon/README.md` for what it stores and where.

Install the daemon, then store an API key in the desktop keyring:

```sh
scripts/install-daemon.sh
cd ~/.local/share/crepe/daemon && ../daemon-venv/bin/python -m crepe_daemon --set-key
```

To stop it, turn "Parler avec le démon" off in the preferences (the
extension stops watching for the daemon), or stop the daemon itself with
`systemctl --user disable --now crepe-daemon`.

## Depuis un script

The extension exports an object on the shell's own connection to the
session bus, so any script, build tool or editor with a post-task hook can
make her react:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /io/github/aceep/Crepe \
    --method io.github.aceep.Crepe.Nudge tache_terminee "mon-projet"
```

`Nudge(s kind, s text)` takes one of these kinds; `text` may be empty:

| Kind | What she does |
| --- | --- |
| `tache_terminee` | Points towards the focused window: something somewhere finished |
| `attention` | Jumps: something is waiting for you. The only one that wakes her up |
| `pipeline_echec` | Facepalms, naming `text` (the project, the branch) |
| `ticket_nouveau` | Jumps, naming `text` (the ticket) |
| `tickets_ouverts` | Remarks on `text` open tickets. A plain number is also kept for her greetings (`{tickets}`) |
| `travail_non_commite` | Glances towards the pointer: uncommitted work lying around (`crepe · 3 fichiers · 2 h`) |
| `machine` | Something about the computer (`disque 92 %`): a glance, or a jump when `text` mentions `batterie` |
| `agenda` | Taps a tentacle for a few seconds: a meeting is coming (`Point équipe dans 10 min`) |
| `commande_echec` | Facepalms, naming `text` (the command and its exit code, `make · 2`). At most one shown a minute. Sent by the terminal hook, see below |
| `commande_longue` | A sigh, naming `text` (`npm · 3 min 12 s`). Dropped while a terminal window has the focus. Sent by the terminal hook |
| `musique` | A remark on a new track, `text` being `Titre — Artiste`. Sent by the daemon's Spotify watcher for her other devices; ignored while a player on this desktop plays or when it is the track that player just reported. Only with "Commente la musique" |
| `musique_fin` | Notices the quiet after a long listening session on another device. Same rules |
| `info` | Says `text` as is, cut to 160 characters, no gesture |

`text` goes into her line on a single line, cut to 60 characters
(`info` aside); lines that need it are skipped when it is empty. Any
other kind is refused with the `io.github.aceep.Crepe.Error.UnknownKind`
error. Lines follow the "Parler" switch; with banners off she keeps them
to herself like the rest. Nudges are ignored while she is hidden, off the
screen, storming off or asleep (`attention` wakes her with a start), in
a focus session (`attention` aside), and
each kind gets through once every five seconds at most, extra ones being
dropped. Every nudge that gets through is one of the recent events the
daemon is told about, under its kind.

### Pense-bêtes

"Pense-bête…" in her menu is an entry to type into (Enter validates): `15h30 appeler Paul`,
`dans 20 min sortir le pain`, `dans 1h30 pause`, `demain 9h rendez-vous`, with an optional
`:` or ` - ` before the text. A time already past today means tomorrow. She confirms in her
bubble, or says she did not understand and gives an example. "Pense-bêtes (n)" lists the
pending ones (20 at most); clicking one cancels it. From a script:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /io/github/aceep/Crepe \
    --method io.github.aceep.Crepe.Remind "dans 20 min" "sortir le pain"
```

It answers with her confirmation, or fails with `io.github.aceep.Crepe.Error.BadTime` (the
message has examples) or `...Error.TooMany`. They live in the `reminders` setting, so a re-login
keeps them; overdue ones are delivered when she starts ("Tu avais un pense-bête à 14h : ..."). When one
rings, her bubble stays until you click her (a click that is no pestering), she wakes up for
it, and ignored, she repeats it every 5 minutes, 3 times at most, getting a little more
annoyed each time. During a meeting it waits and is said first when it ends, before the summary.
The lines are `pense_bete`, `pense_bete_relance`, `pense_bete_ok`, `pense_bete_incompris`,
`pense_bete_en_retard`, `pense_bete_plein` (`{texte}`, `{heure}`, and `{quand}` in `pense_bete_ok`).

### Meetings

While the screen is shared or recorded she leaves the stage altogether
(sprite, bubble, outfits) and comes back a few seconds after it ends;
"Se cache pendant le partage d'écran" turns this off. While an application
uses the microphone or a camera she stays, but says nothing and ignores
nudges and notifications; "Se tait pendant les appels" turns this off.
Nudges that come in meanwhile are counted (20 at most), and once the
meeting is over she says one line, such as "Pendant ta réu : 2 pipelines
en échec, 1 ticket." (`reunion_fin_resume`), or `reunion_fin_rien` after
a meeting of two minutes or more without news. The line waits for her to be
awake, at home, not focusing and not hushed, and is dropped after ten
minutes. Focus sessions and "ne pas déranger" work as before.

The signals are the ones the shell's own indicators use: the remote access
controller's `new-handle` (screen sharing, remote desktop, portal
screencasts) and `Main.screenshotUI`'s `screencast-in-progress` (the
built-in recorder); the volume control's source outputs for the
microphone; `Shell.CameraMonitor` for cameras, which only sees PipeWire
cameras, not an application opening `/dev/video*` directly. No daemon is
needed.

### Terminal hook

`scripts/crepe-shell-hook.bash` tells her when a command fails or takes
long. Source it from `~/.bashrc`, after any prompt setup:

```sh
source /path/to/crepe/scripts/crepe-shell-hook.bash
```

A failed command sends `commande_echec` (`make · 2`); a successful one that
took `CREPE_LONG_SECONDS` seconds (60 by default) or more sends
`commande_longue` (`npm · 3 min 12 s`). A long command that also failed is
reported as a failure only. Ctrl+C (130) and Ctrl+Z (148), empty lines and
the first prompt send nothing. The name is the first word of the line,
past `VAR=value` prefixes, read from the history, so a line the history
ignores (`HISTCONTROL=ignorespace`) is named after the previous one. The hook
needs bash 5 and an interactive shell, prints nothing, keeps `$?` and the
`PROMPT_COMMAND` you had (string or array), and calls `gdbus` from a
detached process, so a missing `gdbus` or extension costs nothing. It
times commands with `PS0` and sets no `DEBUG` trap.

`Ping() -> (s version)` returns the extension's version, to check she is
there:

```sh
gdbus call --session --dest org.gnome.Shell --object-path /io/github/aceep/Crepe \
    --method io.github.aceep.Crepe.Ping
```

## Layout

| Path | Role |
| --- | --- |
| `src/animations.ts` | Loads `assets/animations.json`, resolves frame files, adds mirrored variants |
| `src/player.ts` | Animation state machine: loops, one-shots, tail loops; tells a listener each animation that starts. No GNOME dependency |
| `src/sprite.ts` | Clutter actor showing the current frame, nearest-neighbour upscaling, mirrored frames, layers over and under it, where her head is in each frame |
| `src/outfit.ts` | Loads `assets/tenues.json`, and the outfit layers on the sprite shown per animation and moved with her head |
| `src/wardrobe.ts` | Which outfits she wears for a date and her state, and which still owe their line of the day. No GNOME dependency, shared with the preferences |
| `src/gaze.ts` | Which way her eyes look, the eye poses' names, and the pointer polling that turns them |
| `src/dodge.ts` | Moving out of the focused window's way and back, overlap and free-spot maths |
| `src/layer.ts` | Puts her on the stage above the windows (top chrome) or below them (window group), kept there across restacks |
| `src/hitbox.ts` | Invisible actor over her body that takes clicks, kept on the sprite |
| `src/positioner.ts` | Keeps her inside the work area at a remembered spot, moves her sideways, off-screen or anywhere for trips |
| `src/presence.ts` | Where she is when not at her spot: hiding off-screen, storming off, perched on the focused window, out of its way. Drives the trips there and back |
| `src/drag.ts` | Click versus drag on the hitbox, pointer grab while she is carried |
| `src/menu.ts` | Right-click menu: preferences, focus session, crawl and talk switches, off-screen and hide entries, temporary mute offer, conversation entries |
| `src/behaviour.ts` | Blinks, rare fidgets, crawling, sleep on idle and at bedtime, wave on return, reactions, impatient tapping, hush, pestering, break reminder, focus sessions, trips she is sent on, events worth a line |
| `src/mood.ts` | Annoyance score from clicks and moves, decay, sulking and storming off. No GNOME dependency |
| `src/nudge.ts` | The `io.github.aceep.Crepe` D-Bus object scripts call (`Nudge`, `Ping`), per-kind rate limit, text clean-up |
| `src/voice.ts` | Picks a line from `assets/repliques.json`: cooldown, odds, time of day, placeholders, the evening recap. No Clutter dependency |
| `src/meeting.ts` | Screen sharing, microphone and camera signals from the shell |
| `src/digest.ts` | What a meeting hides or silences, and the count of nudges she missed. No GNOME dependency |
| `src/terminals.ts` | The terminal emulators whose focus silences `commande_longue`. No GNOME dependency |
| `src/reminders.ts` | French time parser for reminders, the pending list and its delivery and nagging. No GNOME dependency |
| `src/memory.ts` | The week's notable fact and the Friday bilan text. No GNOME dependency |
| `src/tracks.ts` | One music remark per track whichever source tells first. No GNOME dependency |
| `src/ink.ts`, `src/inkspots.ts` | The ink splats on screen, and where they may fall (pure) |
| `src/stats.ts` | Daily counters, their JSON in the `stats` setting, sums over days. No GNOME dependency, shared with the preferences |
| `src/bubble.ts` | Speech bubble above her head, follows her and fades out on its own |
| `src/prompt.ts` | The box to type something to her, over her head, with a modal grab while open |
| `src/brain.ts` | Conversation daemon on the session bus: name watch, calls, errors sorted by kind. No shell UI, shared with the preferences |
| `src/context.ts` | Recent events and lines, and the context JSON sent with each question. No GNOME dependency |
| `src/watchers.ts` | Notification, focused-window title and new-window sources |
| `src/music.ts` | MPRIS player watcher on the session bus, and the pure tracker deciding what is a new track or a long session ending |
| `src/trackers.ts` | Notification tally per hour, long tasks and waits seen in window titles, recent errors, continuous activity, bedtime hours. No GNOME dependency |
| `src/keywords.ts` | Text to reaction mapping. No GNOME dependency |
| `src/settings.ts` | Typed view over the GSettings schema |
| `src/toggle.ts` | Quick settings on/off switch, bound to the `visible` setting |
| `src/prefs.ts` | Preferences window (libadwaita) |
| `src/extension.ts` | Wires everything into the shell, cleans up on disable |
| `schemas/` | GSettings schema, compiled at deploy time |
| `scripts/` | Terminal hook for bash, deploy, nested-shell, blink-frame, bat-pose, eye-pose and placeholder-outfit helpers |

## Animation metadata

`assets/animations.json` is Theo's file with these additions:

- `boucle_fin` on `endormie`: the 1-based inclusive frame range to loop
  once she is asleep (frames 5 to 8), as described in his brief.
- `attente`: a single-frame loop, the resting pose. It is the default
  state instead of `respiration`, so her tentacles stay still.
- `clignement`: a four-frame blink drawn on top of the resting pose with
  the closed-eye arc from `endormie`. Both are generated by
  `scripts/make-blink.py` from `respiration_00.png`; rerun it if that
  frame changes.
- `batte_tenue`, `batte_clignement`, `batte_rangee`: her resting pose and
  blink while she sulks, bat in hand, and the swing played backwards when
  she puts it away. Generated by `scripts/make-bat-pose.py` from the
  `batte` frames (the last one is the held pose); rerun it if they change.

- `yeux_<direction>` and `batte_yeux_<direction>` (`nord`, `nord_est`,
  `est`, `sud_est`, `sud`, `sud_ouest`, `ouest`, `nord_ouest`): the
  resting pose and the bat pose with both eyes moved inside the face,
  two pixels sideways or one up or down (one each way on the
  diagonals), like Theo's glance. The eyes keep their exact shape and
  nothing else changes; `scripts/make-eyes.py` derives them from
  `attente_00.png` and `batte_tenue_00.png` and checks both. Rerun it if
  those frames change.

`pointer` is only drawn pointing right. `src/animations.ts` adds
`pointer_gauche`, the same frames flipped horizontally when they are
decoded; her body sits in the middle of the frame, so nothing shifts.

## Typings

`@girs/gnome-shell@46` targets GNOME 46. Its transitive `@girs/*`
packages are pinned through `overrides` in `package.json`; without that
npm installs several incompatible copies of the GObject typings and
`tsc` rejects perfectly valid calls.
