# Crêpe's brain

A small Python service that lets Crêpe answer what you type and, if you
want, make the odd unprompted remark, through the Anthropic API. The GNOME
extension talks to it over the session bus; the contract is in
[PROTOCOL.md](PROTOCOL.md). Without the daemon, or without a key, the
extension keeps using its canned lines.

Dependencies: Python 3.11+, PyGObject with the `Gio` and `Secret` (libsecret)
typelibs from the system, a running secret service (gnome-keyring), and the
`anthropic` SDK, which the install script puts in a dedicated venv.

## Install

```sh
scripts/install-daemon.sh            # install, then enable and start the user unit
scripts/install-daemon.sh --no-enable  # install only
```

The script is idempotent; run it again after changing the daemon. It:

1. copies `daemon/crepe_daemon` to `~/.local/share/crepe/daemon/`
   (`$XDG_DATA_HOME` is honoured);
2. creates or updates the venv `~/.local/share/crepe/daemon-venv`
   (`--system-site-packages`, so PyGObject stays importable) and installs
   `requirements.txt` into it;
3. installs `crepe-daemon.service` to `~/.config/systemd/user/`;
4. runs `systemctl --user daemon-reload` and `enable --now` (and a restart,
   to pick up new code), unless `--no-enable` is given.

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

## Configuration

Optional, in `~/.config/crepe/daemon.toml` (`$XDG_CONFIG_HOME` is honoured,
`--config PATH` overrides). See [daemon.example.toml](daemon.example.toml):

| Key | Default | |
|---|---|---|
| `model` | `"claude-haiku-5-5"` | Model used |
| `daily_budget` | `200` | API requests per local day, `Ask` and `Remark` together; `0` disables the API |
| `remarks` | `false` | Allow `Remark` to call the API |
| `max_reply_chars` | `160` | Hard cap on a reply |

A missing file means defaults; an invalid one stops the daemon with a
message in the journal. Restart the unit after editing it.

## Guetteurs

Optional watchers that poll your forge, your tracker, your local repos,
this machine and a published calendar, and nudge her (method `Nudge` of the
extension, see [PROTOCOL.md](PROTOCOL.md#watchers)) when something happens. Each one runs only when its section exists in
`daemon.toml`; see [daemon.example.toml](daemon.example.toml).

| Section | Polls | Every | Nudges |
|---|---|---|---|
| `[watchers.gitlab]` | Failed pipelines you triggered, in the `projects` listed or else the 30 most recently active projects you are a member of | `interval_minutes`, default 5 | `pipeline_echec` `<project> · <ref>`, at most one per project per look |
| `[watchers.redmine]` | Open issues assigned to you | `interval_minutes`, default 10 | `ticket_nouveau` `#<id> <subject>` (two per look at most), `tickets_ouverts` `<count>` when the count changes and once a day at the first look after 07:00 |
| `[watchers.git]` | `git status` and commits ahead of the upstream in local repos | `interval_minutes`, default 30 | `travail_non_commite` `<repo> · <n> fichiers · <h> h` or `<repo> · <n> commits pas poussés`, once per repo per `nag_after_minutes`, two per look at most |
| `[watchers.machine]` | Disk usage, battery, load average | `interval_minutes`, default 5 | `machine` `disque <mount> <pct> %`, `batterie <pct> %`, `machine à genoux depuis <n> min` |
| `[watchers.ics]` | A published calendar link (ICS) | `interval_minutes`, default 15 | `agenda` `<summary> dans <n> min`, or `<summary> aujourd'hui` for an all-day event at the first look after 07:00; two per look at most |

Keys of `[watchers.gitlab]`: `url` (required, e.g. `https://gitlab.example.com`),
`interval_minutes`, `projects` (list of paths with namespace, e.g.
`["team/app"]`), `only_mine` (default `true`; `false` nudges for anyone's
failed pipelines). `[watchers.redmine]`: `url` (required) and
`interval_minutes`. The minimum interval is 1 minute (5 for `ics`).

`[watchers.git]`: `paths` (required; each one a repo, or a folder whose
direct children are repos, 50 repos at most, `~` allowed),
`interval_minutes`, `nag_after_minutes` (default 120). A repo nags when it
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
`warn_minutes` (default 10). Events starting within `warn_minutes`, or
within one interval if that is longer, nudge once each. The parser
understands UTC, `TZID` (IANA names and the usual Windows names Outlook
writes) and floating times, all-day events, cancelled events (skipped),
`EXDATE`, moved instances, and daily or weekly repeats (`INTERVAL`,
`COUNT`, `UNTIL`, `BYDAY`); any other repeat rule (monthly, yearly...)
counts only its first instance.

The first look waits 30 s after start, so login stays quiet, and the very
first look ever only records what exists: no nudge for old failures or
issues, only the Redmine count. The git, machine and ICS watchers report a
current state rather than past events, so their first look may nudge. After three failed looks in a row (network,
HTTP error, rejected token) the interval doubles at each further failure, up
to one hour, and goes back to normal at the next success. The journal says
why it failed.

Tokens, in the keyring like the API key (attribute `purpose = gitlab-token`
or `redmine-key`):

```sh
../daemon-venv/bin/python -m crepe_daemon --set-token gitlab     # personal access token, scope read_api
../daemon-venv/bin/python -m crepe_daemon --set-token redmine    # your API key, Redmine "My account" page
../daemon-venv/bin/python -m crepe_daemon --forget-token gitlab
```

The git, machine and ICS watchers need no token. A GitLab or Redmine
watcher without its token logs it once and stays idle; it checks the
keyring again at every look, so no restart is needed after `--set-token`.
`CREPE_GITLAB_TOKEN` and `CREPE_REDMINE_KEY`, when set and non-empty, win
over the keyring (meant for tests). `--status` lists the configured watchers
and whether the extension answers.

Privacy: the watchers call only these endpoints, with your token in a header
(`PRIVATE-TOKEN` for GitLab, `X-Redmine-API-Key` for Redmine), and never
follow a redirect (it would replay the token elsewhere):

- GitLab: `GET /api/v4/user` (your username, once per run),
  `GET /api/v4/projects?membership=true&simple=true&per_page=100&order_by=last_activity_at`
  (or `GET /api/v4/projects/<path>` once per configured project), and
  `GET /api/v4/projects/<id>/pipelines?status=failed&updated_after=…&username=…&per_page=20`;
- Redmine: `GET /issues.json?assigned_to_id=me&status_id=open&limit=100&sort=updated_on:desc`;
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
the last 200 pipeline ids and issue ids already seen, the time of the last
GitLab look, the last open issue count and the day of the last morning count;
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
scripted and fake backends), and the watchers run against a fake HTTP
transport, a fake git, fake `/sys` and `/proc` files in a temporary
directory and an injected clock, so no test touches the network or the
keyring. One test runs the real `git status` on a scratch repo in the
temporary directory, and is skipped when git is missing.
