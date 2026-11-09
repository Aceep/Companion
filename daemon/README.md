# Crêpe's brain

A small Python service that lets Crêpe answer what you type and, if you
want, make the odd unprompted remark, through the Anthropic API. The GNOME
extension talks to it over the session bus; the contract is in
[PROTOCOL.md](PROTOCOL.md). Without the daemon, or without a key, the
extension keeps using its canned lines.

Dependencies: Python 3.11+, PyGObject with the `Gio` and `Secret` (libsecret)
typelibs from the system, a running secret service (gnome-keyring), and the
`anthropic` and `claude-agent-sdk` packages, which the install script puts in
a dedicated venv (the second one is only used by the optional
[subscription backend](#backend-abonnement)).

## Install

```sh
scripts/install-daemon.sh            # install, then enable and start the user unit
scripts/install-daemon.sh --no-enable  # install only
```

The script is idempotent; run it again after changing the daemon. It stops
at once if `python3` (or an existing venv) is older than 3.11. It:

1. copies `daemon/crepe_daemon` to `~/.local/share/crepe/daemon/`
   (`$XDG_DATA_HOME` is honoured);
2. creates or updates the venv `~/.local/share/crepe/daemon-venv`
   (`--system-site-packages`, so PyGObject stays importable) and installs
   `requirements.txt` into it;
3. installs `crepe-daemon.service` to `~/.config/systemd/user/`;
4. runs `systemctl --user daemon-reload`, `reenable` and a restart (to pick
   up new code), unless `--no-enable` is given. The unit is wanted by
   `graphical-session.target`, so it starts and stops with the desktop
   session.

Logs: `journalctl --user -u crepe-daemon -f`.

## API key

Stored in the desktop keyring (libsecret schema `io.github.aceep.crepe`,
attribute `purpose = api-key`), never in a file:

```sh
cd ~/.local/share/crepe/daemon
../daemon-venv/bin/python -m crepe_daemon --set-key     # prompts, input hidden
../daemon-venv/bin/python -m crepe_daemon --forget-key
../daemon-venv/bin/python -m crepe_daemon --status      # exit 1 if not running
```

The running daemon reads the key on every request, so no restart is needed
after `--set-key`. The `CREPE_API_KEY` environment variable, when set and
non-empty, wins over the keyring (meant for tests).

## Backend abonnement

An alternative to the API key: replies are produced by the Claude Agent SDK
(`claude-agent-sdk`, pinned in `requirements.txt`), which drives the Claude
Code CLI as a subprocess, authenticated with a long-lived token tied to your
Claude subscription instead of an API key. The default stays `backend = "api"`.

Setup:

1. Create the token, in a terminal: `claude setup-token` (it opens a browser
   to sign in and prints the token once).
2. Store it in the keyring (input hidden):

   ```sh
   cd ~/.local/share/crepe/daemon
   ../daemon-venv/bin/python -m crepe_daemon --set-token claude
   ```

3. In `daemon.toml` set `backend = "abonnement"`, then
   `systemctl --user restart crepe-daemon`.

`--forget-token claude` removes the token. `CREPE_CLAUDE_OAUTH_TOKEN`, when
set and non-empty, wins over the keyring (meant for tests). The token is read
at every request, so a new one needs no restart. Without a token the daemon
answers like it does without an API key (`NoKey`), and the journal says to run
`claude setup-token` then `--set-token claude`. `--status` prints
`backend: api` or `backend: abonnement`, and `has_key` then refers to that
backend's credential.

`model` is passed as is: the CLI knows full ids such as `claude-haiku-5-5`
and the aliases `haiku`, `sonnet` and `opus`.

What the wheel brings: `claude-agent-sdk` bundles the Claude Code CLI as a
~320 MB executable inside the package (version 0.2.178 ships CLI 2.1.318 for
Linux x86_64), so there is no separate install and no Node. The install
script says so; on a platform whose wheel has no bundled CLI it warns, and the
backend then looks for a `claude` executable on `PATH`.

Calls count against the usage limits of the subscription, which Claude Code
and the other Claude apps on the same account share. A call that hits the
limit fails with an `Upstream` error ("subscription usage limit reached").
`daily_budget` still applies, counting requests. The cost figures in the
debug log (`--debug`) are the CLI's own estimates, not a bill.

### Isolation

Run as is, the CLI loads your whole Claude Code setup. Here that must not
happen: your user settings have hooks (Stop, Notification, plugin
SessionStart) that would nudge her on every call, which would trigger another
call, and so on. Each call therefore runs with:

- `setting_sources=[]`: no user, project or local `settings.json`, so no
  hooks and no permission rules from them;
- `CLAUDE_CONFIG_DIR` pointing at the empty directory
  `~/.local/share/crepe/agent-config` (mode 0700; `$XDG_DATA_HOME` is honoured):
  no `~/.claude` (no `CLAUDE.md`, plugins, skills, agents, commands), and
  the CLI's own `.claude.json` lives there instead of `~/.claude.json`.
  `HOME` is also set to an empty `agent-home` directory next to it;
- `plugins=[]`, no agents, `disable-slash-commands` (no skills, not even the
  CLI's own), `CLAUDE_CODE_DISABLE_CLAUDE_MDS` and
  `CLAUDE_CODE_DISABLE_AUTO_MEMORY` (no `CLAUDE.md` files, no auto memory);
- `mcp_servers={}` with `strict_mcp_config`: no MCP server from
  `~/.claude.json`, a project or a plugin;
- `tools=[]`: the model has no tool at all (`allowed_tools` would only
  pre-approve some), `max_turns=1`, `permission_mode="dontAsk"` (nothing can
  ever prompt);
- `system_prompt` is the persona string alone, which replaces the CLI's own
  prompt; the working directory is the empty `agent-cwd` (mode 0700), never a
  repo; the prompt is sent `verbatim_prompts` so that an `@path` or a
  `/command` inside a window title is not expanded;
- an environment of its own. The SDK merges its environment over the
  daemon's, so the CLI is started through a small script
  (`~/.local/share/crepe/agent-launcher`, rewritten when needed) that runs it
  with `env -i` and only lets through `PATH`, locale, `TZ`, proxy and CA
  variables, plus the ones set explicitly: `CLAUDE_CODE_OAUTH_TOKEN`,
  `CLAUDE_CONFIG_DIR`, `HOME` and the switches below. An `ANTHROPIC_API_KEY`,
  `ANTHROPIC_AUTH_TOKEN`, `ANTHROPIC_BASE_URL` or cloud-provider variable in
  the daemon's environment never reaches the CLI;
- `DISABLE_AUTOUPDATER`, `DISABLE_TELEMETRY`, `DISABLE_ERROR_REPORTING` and
  `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` set to `1`;
- no session transcript (`no-session-persistence`, and
  `CLAUDE_CODE_SKIP_PROMPT_HISTORY`). Anything else the CLI keeps stays in
  `agent-config`.

On top of that, the init message of every call is checked: if the CLI reports
a tool, an MCP server, a skill or a plugin other than its built-in ones, the
call is dropped with an `Upstream` error and the journal says what was loaded.

Each call starts a CLI process (about 0.4 s to its first message) and is cut
off after 60 s (`AGENT_TIMEOUT_S` in `crepe_daemon/agent_sdk.py`). The request
contains what the Privacy section lists; the CLI also adds its own request
metadata, which the daemon does not control.

To go back: set `backend = "api"` (or remove the line) and restart the unit.
The token can stay in the keyring or be removed with `--forget-token claude`.

## Configuration

Optional, in `~/.config/crepe/daemon.toml` (`$XDG_CONFIG_HOME` is honoured,
`--config PATH` overrides). See [daemon.example.toml](daemon.example.toml):

| Key | Default | |
|---|---|---|
| `backend` | `"api"` | `"api"` (Messages API, API key) or `"abonnement"` (see [Backend abonnement](#backend-abonnement)) |
| `model` | `"claude-haiku-5-5"` | Model used, by both backends |
| `daily_budget` | `200` | API requests per local day, `Ask` and `Remark` together; `0` disables the API |
| `remarks` | `false` | Allow `Remark` to call the API |
| `max_reply_chars` | `160` | Hard cap on a reply |

A missing file means defaults; an invalid one makes the daemon exit with
status 2 and a message in the journal, and systemd does not restart it
(`RestartPreventExitStatus=2`) until you fix the file and restart the unit.
Restart the unit after editing it.

## Guetteurs

Optional watchers that poll your local repos, this machine, a published
calendar and Spotify, and nudge her (method `Nudge` of the
extension, see [PROTOCOL.md](PROTOCOL.md#watchers)) when something happens. Each one runs only when its section exists in
`daemon.toml`; see [daemon.example.toml](daemon.example.toml).

| Section | Polls | Every | Nudges |
|---|---|---|---|
| `[watchers.git]` | `git status` and commits ahead of the upstream in local repos | `interval_minutes`, default 30 | `travail_non_commite` `<repo> · <n> fichiers · <h> h` or `<repo> · <n> commits pas poussés`, once per repo per `nag_after_minutes`, two per look at most |
| `[watchers.machine]` | Disk usage, battery, load average | `interval_minutes`, default 5 | `machine` `disque <mount> <pct> %`, `batterie <pct> %`, `machine à genoux depuis <n> min` |
| `[watchers.ics]` | A published calendar link (ICS) | `interval_minutes`, default 15 | `agenda` `<summary> dans <n> min`, or `<summary> aujourd'hui` for an all-day event at the first look after 07:00; two per look at most |
| `[watchers.spotify]` | What you are playing, from Spotify's Web API | `interval_seconds`, default 30 (`idle_interval_seconds`, default 120, after 10 min of silence) | `musique` `<title> — <artists>` on each new track, `musique_fin` `<n> min` when playback stops after 20 min or more of listening |

The minimum `interval_minutes` is 1 minute (5 for `ics`).

`[watchers.git]`: `paths` (required; each one a repo, or a folder whose
direct children are repos, 50 repos at most, `~` allowed),
`interval_minutes`, `nag_after_minutes` (default 120), `unpushed`
(default true; false leaves commits waiting for a push alone). A repo nags when it
has uncommitted changes (staged, unstaged or untracked, `.gitignore`
honoured) and they are older than `nag_after_minutes`: the age is the oldest
mtime of the modified tracked files, or the time the watcher first saw the
repo dirty if that is earlier. Commits ahead of the upstream branch nag the
same way, timed from when the watcher first saw them. A path that is not a
repo, or where git fails (e.g. "dubious ownership" for a repo owned by
another user), is logged once and skipped.

`[watchers.machine]`: `interval_minutes`, `disk_percent` (default 90),
`disk_paths` (default `["/", "~"]`), `battery_percent` (default 15),
`load_minutes` (default 10). A full disk nudges once, again only after it
went 3 points under the threshold and crossed it again, or once a day
while it stays full. The battery nudges once when discharging under the
threshold, re-armed when charging or 10 points above it; no battery, no
nudge. The load nudges once per episode when the 1-minute load average is
above the CPU count at every look for `load_minutes`.

`[watchers.ics]`: `url` (required, http(s)), `interval_minutes`,
`warn_minutes` (default 10). The watcher warns within
`max(warn_minutes, interval_minutes)`, plus one minute so that no event
slips between two looks: each event starting in that window nudges once.
The parser understands UTC, `TZID` (IANA names and the usual Windows names
Outlook writes) and floating times, all-day events, cancelled events
(skipped, including a single cancelled instance of a series), `EXDATE`,
moved instances, and daily or weekly repeats (`INTERVAL`,
`COUNT`, `UNTIL`, `BYDAY`); any other repeat rule (monthly, yearly...)
counts only its first instance.

`[watchers.spotify]`: `client_id` (required), `redirect_port` (default 8898),
`interval_seconds` (default 30, minimum 15), `idle_interval_seconds` (default
120). See [Spotify](#spotify) below for the one-time setup. Only tracks
count: an ad is skipped without ending the listening session, a podcast
episode gives no nudge and counts as a stop. The track playing when the
daemon starts is not announced. A 429 is waited out for the `Retry-After` it
gives (an hour for a quota error) without counting as a failure.

The first look waits 30 s after start, so login stays quiet. The git,
machine and ICS watchers report a current state rather than past events, so
their first look may nudge. After three failed looks in a row (network,
HTTP error, rejected token) the interval doubles at each further failure, up
to one hour, and goes back to normal at the next success. The journal says
why it failed.

The git, machine and ICS watchers need no token; Spotify has its own
login (below), which stores its token in the keyring like the API key.
`--status` lists the configured watchers and whether the extension answers.

The kinds `pipeline_echec`, `ticket_nouveau` and `tickets_ouverts` have no
watcher in the daemon: a CI job or a script of yours can send them, see
[Depuis un script](#depuis-un-script).

### Spotify

Spotify needs a small app of your own, once. The app stays in "development
mode", which is enough as long as the account that owns it has Premium, and
you are its only user.

1. Go to <https://developer.spotify.com/dashboard> and log in with your
   Spotify account (accept the developer terms the first time).
2. "Create app". Fill in:
   - App name: `Crêpe` (anything);
   - App description: `Desktop companion that comments on what I listen to`
     (anything);
   - Redirect URI: `http://127.0.0.1:8898/callback`, exactly, then "Add".
     It must be an IP literal: `localhost` is refused. If you change
     `redirect_port`, change the port here too;
   - Which API/SDKs are you planning to use: tick "Web API";
   - accept the terms and "Save".
3. Open the app, "Settings": copy the "Client ID" (there is no secret to
   use).
4. In `daemon.toml`:

   ```toml
   [watchers.spotify]
   client_id = "the Client ID you copied"
   ```

5. Restart the daemon (`systemctl --user restart crepe-daemon`), then in a
   terminal:

   ```sh
   cd ~/.local/share/crepe/daemon
   ../daemon-venv/bin/python -m crepe_daemon --login spotify
   ```

   It prints an address and tries to open it in your browser. Log in to
   Spotify if asked and accept; the page then says "C'est bon, tu peux
   fermer cet onglet." and the terminal confirms. You have 5 minutes. The
   login listens on `127.0.0.1:8898` only, for that one answer.

The login uses the Authorization Code flow with PKCE (no client secret) and
asks for the scopes `user-read-currently-playing` and
`user-read-playback-state`. The refresh token goes to the keyring
(`purpose = spotify-refresh-token`); access tokens live in memory only and
Spotify's rotated refresh tokens are stored as they arrive. If Spotify
answers the token request with an error, the terminal shows its message as
is. `--forget-token spotify` removes the token.

If the token is ever refused for good (`invalid_grant`: access revoked in
your Spotify account, or the password changed), the journal says to run
`--login spotify` again and the watcher stops looking until the daemon is
restarted. `CREPE_SPOTIFY_REFRESH_TOKEN`, when set, wins over the keyring
(meant for tests).

Privacy: the watchers call only these endpoints, and never follow a
redirect (it would replay a token, or the secret of a link, elsewhere):

- Spotify: `GET https://api.spotify.com/v1/me/player/currently-playing` with
  the access token in the `Authorization` header, and `POST
  https://accounts.spotify.com/api/token` to renew it (the login also uses
  `https://accounts.spotify.com/authorize` in your browser). Nothing is
  written back to Spotify, and nothing about what you play is stored: the
  current track id and the listening start live in memory only;
- ICS: `GET` of the configured link, nothing else. The link usually holds
  its own secret, so it is never logged: errors and the journal name its
  host only. Keep `daemon.toml` private (`chmod 600`).

The git watcher runs only `git status --porcelain` and
`git rev-list --count @{upstream}..HEAD`, with `GIT_OPTIONAL_LOCKS=0` and
the fsmonitor hook disabled, so it never writes to a repo, never fetches,
and never runs a command from a repo's config; each call is cut off after
10 s. The machine watcher reads `statvfs`, `/sys/class/power_supply/BAT*`
and `/proc/loadavg`, nothing else.

Nothing goes to the Anthropic API. Kept in `~/.local/state/crepe/watchers.json`:
for git, the path of each dirty or unpushed repo with since when and when
it last nagged; for the machine, which mounts are over the threshold and
when they last nudged; for ICS, the UID and start of the events announced
in the last 48 h. No titles, subjects, file names or calendar contents are
stored; they only pass through the nudge text (and the journal line that
logs it).

For a quick manual test, `CREPE_DEV=1` lowers the minimum interval to 0.05
minute (3 s) and makes the first look wait at most one interval instead of
30 s.

### Depuis un script

Anything else can nudge her too, a build script or a long command for
instance: call the extension's `Nudge` method directly with `gdbus`, as
shown in the Nudge section of the [root README](../README.md).

## Privacy

Each request sends, and only sends:

- the persona (the fixed system prompt in `crepe_daemon/persona.md`);
- the last 20 exchanges: what you typed to her (or the placeholder
  `(remarque spontanée)` for her remarks) and what she answered;
- the current message and the context fields the extension passed for
  this call: hour, weekday, focused window title, application name, her
  mood, whether she was asleep, recent event kinds with their age, and her
  last few bubble lines.

The daemon adds nothing else: no screen content, files or clipboard. What
goes into the context is up to the extension, field by field as listed in
PROTOCOL.md. The context of past calls is not kept. Window titles can
contain file names, URLs or chat names, so the window title does go to the
API when the extension sends it.

Kept locally in `~/.local/state/crepe/` (`$XDG_STATE_HOME`):
`history.json` (the 20 exchanges), `requests.json` (today's date and
request count) and, with watchers, `watchers.json` (see Guetteurs).
`Forget()` over D-Bus empties the history; deleting the directory resets
all of them.

## Fake mode

```sh
PYTHONPATH=daemon python3 -m crepe_daemon --fake
```

Never calls the API and needs no key or SDK: every reply is a canned line
starting with `[fake] `, picked deterministically from the message.
Budget counting, memory and errors behave as in normal mode. Handy for
developing the extension side:

```sh
gdbus call --session --dest io.github.aceep.Crepe.Brain \
  --object-path /io/github/aceep/Crepe/Brain \
  --method io.github.aceep.Crepe.Brain.Ask "salut" '{"hour": 15, "mood": "calm"}'
```

## Cost

(With `backend = "abonnement"` nothing is billed per request: see
[Backend abonnement](#backend-abonnement) for the usage limits.)

Claude Haiku 5.5 costs 0.10 $ per million input tokens and 0.50 $ per million
output tokens (prompts up to 100K tokens). A request is roughly 1,500 to
3,000 input tokens (persona plus up to 20 short exchanges) and a few dozen
output tokens, so about 0.0003 $ each: the default budget of 200 requests a
day stays under 0.10 $ a day at worst. The persona is marked for prompt
caching; it is short, so the API may not cache it.

## Tests

```sh
python3 -m unittest discover -s daemon/tests -t daemon
```

Standard library only; the API backend is not exercised (the tests use
scripted and fake backends), and the subscription backend runs against a
fake `claude_agent_sdk` module (plus a stand-in CLI for the launcher script), and the watchers run against a fake HTTP
transport, a fake git, fake `/sys` and `/proc` files in a temporary
directory and an injected clock, so no test touches the network or the
keyring. The Spotify tests also run the `--login` flow against a local fake
token server on the loopback interface, with a simulated browser. One test runs the real `git status` on a scratch repo in the
temporary directory, and is skipped when git is missing.
