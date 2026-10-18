# 07 — Sanitizing the local-only repos for publication

This repo vendors sanitized copies of two local-only tools (`pi-imessage`,
`global-todo`) and documents a third (`splash-serve`). When you publish any of
the upstreams, apply the exact changes below so the public repos contain no
personal data. The vendored copies in this repo are the reference for the
post-sanitization state — diff against them.

## Personal-data inventory

| Location | Personal data | Status in this repo |
|---|---|---|
| `~/.pi/agent/SYSTEM.md` | phone number | vendored as `pi/SYSTEM.md` with `{{PI_NOTIFY_PHONE}}` — rendered by `scripts/render.sh` |
| `~/.pi/agent/mcp.json` | HA long-lived JWT, the personal LAN hostname | vendored as `pi/mcp.json.template` — rendered by `scripts/render.sh` |
| `~/.pi/agent/pi-imessage/config.json` | `meHandles` (phone + Apple ID email), `allowFrom` | never vendored; `config.example.json` + render.sh materialize it |
| `~/code/pi-imessage` | your phone + Apple ID email in test fixtures, `.opencode/` scratch, dirty `state.md` | vendored sanitized into `pi/extensions/pi-imessage/` |
| `~/code/splash-serve` | personal home-directory paths in README + `watchdog/watchdog.py`, a personal LaunchAgent label in the committed plist | not vendored (local-only); changes below |
| `~/.pi/agent/skills/global-todo` (a private personal fork) | only the git origin URL | vendored with `{{PI_TODO_ORIGIN}}` in SKILL.md/README.md |
| `~/.omlx/settings.json` | LAN hostname/IP aliases | not vendored; manual step (below) |
| `~/.pi/agent/auth.json`, `models-store.json`, `mcp-cache.json` | provider keys / generated caches | **never vendored** — gitignored, regeneratable or secret |

## pi-imessage (`~/code/pi-imessage`)

**Current personal data**

- `~/.pi/agent/pi-imessage/config.json` — `meHandles` (your phone + Apple ID
  email) and `allowFrom` (the phone that may talk to it).
- `test/fixtures.mjs`, `test/factory.test.mjs`, `test/db.test.mjs` — your real
  phone number and Apple ID email in fixtures and assertions.
- `.opencode/` — local agent scratch (`state.md`, `inspect-echo.mjs`); untracked/dirty.
- `src/*.ts` — clean (all personal values come from the external config).

**Changes required before publishing**

1. Sanitize the three test files exactly like the vendored copy
   (`pi/extensions/pi-imessage/test/`): your phone → `+15551230001`, your
   Apple ID email → `test@example.com`, and the formatted phone variant →
   `+155-5123-0001` (diff the vendored tests against your tree to get every occurrence).
2. Add a `.gitignore`: `node_modules/`, `.opencode/`, `state/`.
3. Commit a `config.example.json` (the vendored one) instead of any real config.
4. Keep the live config in `~/.pi/agent/pi-imessage/config.json` (outside the repo).
5. Dev dependency `@earendil-works/pi-coding-agent ^0.84.2` is older than the
   live pi 1.3.0 but the extension runs against the installed pi's types; bump
   it to `^1.3.0` at your convenience, not as a publication blocker.

**How this repo consumes it:** `scripts/install.sh` clones
`$PI_IMESSAGE_REPO` when set; otherwise it uses the vendored copy in
`pi/extensions/pi-imessage/`. Either way it `npm install`s and symlinks
`~/.pi/agent/extensions/pi-imessage`.

## splash-serve (`~/code/splash-serve`)

**Current personal data**

- `README.md` — personal home-directory paths.
- `watchdog/watchdog.py` — personal home-directory paths.
- `watchdog/com.*.splash-watchdog.plist` — a *committed* personal LaunchAgent
  label (the generic label `com.piagent.splash-watchdog` is what docs/04 documents).
- Excluded by its `.gitignore` (keep it): `__pycache__/`, `*.log`, `PAUSE`, `watchdog/state.json`.

**Changes required before publishing**

1. Replace the personal home-directory paths with `$HOME`-style or `~` paths in `README.md` and `watchdog/watchdog.py`.
2. Remove the personal plist from the repo (it is generated at install time);
   if the watchdog label must be configurable, honor `SPLASH_WATCHDOG_LABEL`
   (default `com.piagent.splash-watchdog`) in `watchdog.py`.
3. Keep the existing `.gitignore` exclusions.

**How this repo consumes it:** `scripts/install.sh` clones
`$SPLASH_SERVE_REPO` when set and installs the launcher into `~/.local/bin`;
otherwise it prints a pointer to this doc. The live machine keeps its personal
label until the fork is published and re-installed.

## global-todo / pi-todo (a private personal fork)

**Current personal data:** only the git origin URL (the content itself is clean —
the vendored copy in `pi/skills/global-todo/` proves it).

**Two options:**

1. **Publish a public fork** (recommended): push the skill to a public repo,
   set `PI_TODO_ORIGIN` in `.env`. `scripts/install.sh` then clones it and the
   15-minute sync loop keeps it current (it `git pull`s origin/main).
2. **Keep it private:** leave `PI_TODO_ORIGIN` empty. `scripts/install.sh`
   installs the vendored copy, which has no git metadata, so the loop's sync
   is a silent no-op — and it rewrites the LaunchAgent to `PI_TODO_SYNC=0`.

## oMLX host aliases

`~/.omlx/settings.json` contains your LAN hostname/IP aliases. They are
machine-specific and never vendored. On a mirror, write them by hand:

```json
{ "hosts": { "omlx1": "<host-or-ip-of-machine-1>", "omlx2": "<host-or-ip-of-machine-2>" } }
```

(docs/01 documents how the aliases feed the oMLX provider; on this machine the
aliases are not even consumed by pi, since `models.json` has no `omlx` provider.)

## Pre-publish checklist (run in each upstream repo)

```sh
# run in each upstream repo — patterns are yours: home dir name, GitHub user,
# email address, phone digits, LAN hostnames, and token prefixes
git grep -nE '<your-user>|<your-email>|<phone-digits>|<lan-host>|eyJ|/Users/[^/~]' -- ':!*.lock' || echo clean
```

Any hit must be justified (a public name like `paperniuk` is fine; anything
matching the patterns above is not).
