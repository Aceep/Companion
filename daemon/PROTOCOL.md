# Crêpe brain D-Bus protocol

The brain daemon lives on the **session bus**. Everything below is the whole
contract; the extension needs nothing else.

| | |
|---|---|
| Bus name | `io.github.aceep.Crepe.Brain` |
| Object path | `/io/github/aceep/Crepe/Brain` |
| Interface | `io.github.aceep.Crepe.Brain` |

The daemon is not D-Bus activatable: it runs as the systemd user unit
`crepe-daemon.service`. Callers should treat "name has no owner"
(`org.freedesktop.DBus.Error.ServiceUnknown` / `NameHasNoOwner`) as "no brain,
fall back to the canned lines".

## Methods

### `Ask(s text, s context) -> (s reply)`

A message the user typed. `context` is a JSON string (schema below), or `""`
for none. `reply` is one short line in her voice, never empty for a
non-blank `text`. A blank `text` returns `""` without calling the API.
`text` is collapsed to one line and cut to 500 characters (the last one
becoming `…`); a longer `text` is not an error. That cut text is what the
daemon sends and remembers.

### `Remark(s context) -> (s reply)`

A spontaneous remark about the context. Returns `""` when she has nothing to
say, which is normal and frequent:

- when remarks are disabled in the config (`remarks = false`, the default),
  without calling the API;
- when `context.sleeping` is `true`, without calling the API;
- when the model decides nothing is worth saying.

### `Status() -> (a{sv} status)`

Never blocks on the network or the keyring.

| Key | Type | Meaning |
|---|---|---|
| `has_key` | `b` | The credential of the active backend (API key, or subscription token) was found at the last check (startup, last request, or previous `Status` call) |
| `backend` | `s` | Active backend: `api` or `abonnement` |
| `model` | `s` | Model in use |
| `requests_today` | `u` | API requests made today (local date), `Ask` and `Remark` together |
| `daily_budget` | `u` | Daily request cap |
| `remarks_enabled` | `b` | Whether `Remark` may call the API |
| `fake` | `b` | Running with `--fake` (canned replies, no API calls) |
| `version` | `s` | Daemon version |

Unknown keys may be added later; ignore them.

### `Forget() -> ()`

Clears the conversation memory (in memory and on disk). The daily request
count is kept. It waits its turn behind the requests already queued, like
`Ask` and `Remark`, so an exchange in flight is cleared too.

## Errors

Returned as D-Bus errors; the message is short, English, safe to log, and
never contains a stack trace.

| Error name | When |
|---|---|
| `io.github.aceep.Crepe.Brain.Error.NoKey` | No API key (env or keyring), or the API rejected it |
| `io.github.aceep.Crepe.Brain.Error.Budget` | `requests_today` reached `daily_budget` (resets at local midnight) |
| `io.github.aceep.Crepe.Brain.Error.Upstream` | Network failure, rate limit, API error, or an internal error |
| `io.github.aceep.Crepe.Brain.Error.Invalid` | `context` is longer than 8192 characters, not valid JSON, not an object, or a known field has the wrong type |

## Context JSON

Every field is optional. Unknown keys are ignored; a known key with the
wrong type or value is `Invalid`.

```json
{
  "hour": 14,
  "weekday": "mardi",
  "window_title": "main.rs - Code",
  "app": "Code",
  "mood": "calm",
  "sleeping": false,
  "events": [{"ago_s": 12, "kind": "notification"}],
  "last_lines": ["Encore une."]
}
```

| Field | Type | Notes |
|---|---|---|
| `hour` | integer 0-23 | Local hour |
| `weekday` | string | French day name, e.g. `"vendredi"` |
| `window_title` | string | Focused window title; clipped to 200 characters |
| `app` | string | Focused application name |
| `mood` | `"calm"` \| `"annoyed"` \| `"angry"` | `angry` means she sulks: expect one-word replies |
| `sleeping` | boolean | `true` silences `Remark` |
| `events` | array of `{ago_s: number >= 0, kind: non-empty string}` | Recent events, e.g. the voice event names (`notification`, `erreur`, `succes`...). The 10 most recent are kept |
| `last_lines` | array of strings | Her last bubble lines, oldest first, so she does not repeat herself. The last 5 are kept |

The context is not stored in memory: only the typed text (or the
placeholder `(remarque spontanée)` for a remark) and her reply are.

## Reply conventions

- One line: newlines are collapsed to a space, surrounding quotes removed.
- At most `max_reply_chars` characters (160 by default), cut at a sentence
  end when possible, otherwise at a word with a trailing `…`.
- French, no emoji, usually under 90 characters.
- When the model declines a request, the reply is a short in-character
  refusal (`Non.`, `Je passe.`...), not an error.
- In `--fake` mode replies start with `[fake] `.

## Concurrency and timing

Requests are served one at a time, in arrival order; a second `Ask` sent
while one runs waits its turn. A real API call usually takes one to a few
seconds and is cut off after 20 s per attempt, with one retry, so use a D-Bus
call timeout of about 60 s (more if you queue several calls), and treat a
timeout like `Upstream`.

## Watchers

Added with the git, machine, ICS and Spotify watchers; the methods above are unchanged.

### `Status()` key

| Key | Type | Meaning |
|---|---|---|
| `watchers` | `as` | Names of the configured watchers (`git`, `machine`, `ics`, `spotify`), in that order. A watcher waiting for its token is listed too |

### Calls the daemon makes

The daemon calls the extension, never the other way round for watchers:

| | |
|---|---|
| Bus name | `org.gnome.Shell` |
| Object path | `/io/github/aceep/Crepe` |
| Interface | `io.github.aceep.Crepe` |

- `Nudge(s kind, s text) -> ()`, asynchronous, flag `NO_AUTO_START`, 5 s
  timeout. Every error (extension disabled, shell restarting,
  `io.github.aceep.Crepe.Error.UnknownKind`) is logged and dropped; nothing
  is retried.
- `Ping() -> (s version)`, only from `--status`.

| Kind | Sent by | `text` |
|---|---|---|
| `travail_non_commite` | `git` | `<repo> · <n> fichiers · <h> h` (or `· 45 min` under an hour) for uncommitted changes, `<repo> · <n> commits pas poussés` for commits ahead of the upstream; once per repo per `nag_after_minutes`, at most two per look |
| `machine` | `machine` | `disque <mount> <pct> %`, `batterie <pct> %` or `machine à genoux depuis <n> min` |
| `agenda` | `ics` | `<summary> dans <n> min` for an event about to start, `<summary> aujourd'hui` for an all-day event (first look after 07:00); once per event, at most two per look |

`text` is one line of at most 60 characters (longer text is cut with `…`).
The extension accepts one nudge per kind every 5 s, so the daemon spaces
nudges of the same kind by 5.5 s. The `git`, `machine` and `ics` watchers
report a current state, not past events, so their first look may nudge.

### Kinds for scripts

No watcher of the daemon sends these; the extension accepts them from any
caller, e.g. a CI job or a script polling a forge or a tracker:

| Kind | `text` |
|---|---|
| `pipeline_echec` | `<project name> · <ref>` |
| `ticket_nouveau` | `#<id> <subject>` |
| `tickets_ouverts` | The open issue count as decimal digits, e.g. `"7"`; the extension keeps a plain number for her greetings |

### Kinds sent by the terminal hook

`scripts/crepe-shell-hook.bash` calls `Nudge` itself, without the daemon, with two more kinds. The extension accepts them from any caller, and the daemon's `Nudger` knows them.

| Kind | `text` |
|---|---|
| `commande_echec` | `<command> · <exit code>`: the first word of a command that failed, e.g. `make · 2`. Exit codes 130 and 148 (Ctrl+C, Ctrl+Z) are never sent. The extension shows at most one per 60 s |
| `commande_longue` | `<command> · <duration>` for a command that succeeded after at least `CREPE_LONG_SECONDS` seconds (60 by default), e.g. `npm · 3 min 12 s`. The extension drops it while a terminal window has the focus |

### Meetings

The extension keeps quiet while the screen is shared or recorded (she is hidden), or while a microphone or a camera is in use (she says nothing). Nudges that arrive then are not lost: the extension counts them per kind (20 at most) and says one summary line when the meeting ends. Nothing changes for callers: `Nudge` is accepted as usual. The signals come from the shell itself, so the daemon has nothing to report.

### Music from other devices

The `spotify` watcher sends two more kinds, for what plays on any of her Spotify devices (the desktop's own MPRIS player is followed by the extension itself):

| Kind | Sent by | `text` |
|---|---|---|
| `musique` | `spotify` | `<title> — <artist>` when a new track starts (separator: space, em dash, space) |
| `musique_fin` | `spotify` | Empty, or the total duration, after a long listening session stops |

The extension maps them to its music remarks (`musique` with the title, `silence`), and only when "Commente la musique" is on. To say one remark per track whatever the source, it ignores a `musique` whose title is the one the MPRIS player last reported (or that arrived within ten minutes of the same title), and any `musique` or `musique_fin` while an MPRIS player is playing. Neither kind counts as a script nudge for her statistics or her meeting summary. The usual limit of one nudge per kind every 5 s applies.

### `Remind(s when, s text) -> (s confirmation)`

Not a watcher call: any script may set a reminder (pense-bête) through the same object as `Nudge`.

```sh
gdbus call --session --dest org.gnome.Shell --object-path /io/github/aceep/Crepe \
    --method io.github.aceep.Crepe.Remind "dans 20 min" "sortir le pain"
```

`when` is French, relative to now: `15h`, `15h30`, `15:30`, `à 15h`, `dans 20 min`, `dans 2 h`, `dans 1h30`, `demain 9h`, `demain à 9h15`. A clock time already past today means tomorrow; a delay is at most 48 h. `text` may be empty when `when` already holds it (`"15h30 : appeler Paul"`), and `when` may be empty when `text` holds both. The reply is the line she says, e.g. `Je m'en occupe demain à 9h.`

| Error name | When |
|---|---|
| `io.github.aceep.Crepe.Error.BadTime` | The time or the text cannot be read; the message is French and carries examples |
| `io.github.aceep.Crepe.Error.TooMany` | Already 20 reminders pending |

Reminders are kept in the `reminders` setting and survive a re-login; those overdue when she starts are delivered right away. A reminder's bubble stays until she is clicked, is repeated every 5 minutes up to 3 times, and waits for the end of a meeting. `Remind` is not rate limited.
