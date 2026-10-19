# 07 — Sanitizing and publishing the local repos

Three of this machine's repos were local-only (no remote, or private). All
three have been **sanitized, history-rewritten, and published**:

| Local repo | Public remote | Personal data found | History treatment |
|---|---|---|---|
| `~/code/pi-imessage` | `https://github.com/tragdor85/pi-imessage` | real phone + Apple ID email in test fixtures; dirty `.opencode/` scratch | full rewrite (values replaced in every commit) |
| `~/code/splash-serve` | `https://github.com/tragdor85/splash-serve` | personal home-directory paths; personal LaunchAgent label in the committed plist + `install.sh` | full rewrite (paths → `$HOME`, label → generic, plist → template) |
| `~/.pi/agent/skills/global-todo` | `https://github.com/tragdor85/pi-todo` (existing private repo, made public) | old example path + LaunchAgent label in **history**; old author identity | full rewrite (values + author/committer metadata) |

Verification for each: `git log -p --all` grepped for the personal patterns
(home directory, phone, email, label, GitHub user, `eyJ` token prefix) → zero
hits outside self-referential public-URL mentions; plus a fresh public clone
scanned the same way. Tests re-run green after the rewrites (pi-imessage
`node --test test/*.test.mjs`, splash-serve `python3 watchdog/watchdog_test.py`).

## What was changed per repo

**pi-imessage**

- `test/fixtures.mjs`, `test/factory.test.mjs`, `test/db.test.mjs`: real phone →
  `+15551230001` / formatted `+155-5123-0001`, real Apple ID email →
  `test@example.com` (a later pass fixed two assertions the first pass missed:
  the last-10-digits form of the phone, and the email's case-folded variant).
- `.gitignore` (new): `node_modules/`, `*.log`, `.DS_Store`, `.opencode/`, `state/`.
- `config.example.json` (new) as the public config template; the live personal
  config stays in `~/.pi/agent/pi-imessage/config.json`, outside the repo.
- Public `README.md`; the dirty `.opencode/state.md` untracked.

**splash-serve**

- `README.md`, `watchdog/watchdog.py`: personal home paths → `$HOME`/`~`
  (the watchdog's default cwd is now `~/code/splash`, expanduser'd).
- `watchdog/install.sh`: label overridable via `SPLASH_WATCHDOG_LABEL`
  (default `com.piagent.splash-watchdog`); the tracked plist is a template with
  `{{HOME}}`/`{{LABEL}}` placeholders, rendered by `sed` at install time
  (launchd does not expand `$HOME` itself).
- The live machine was migrated to the sanitized version: old personal-label
  agent booted out, generic agent installed, Splash `/status` verified.

**pi-todo (the global-todo skill repo)**

- No content changes at HEAD — the current tree was already clean. The cleanup
  was history-only: an old example path (`SKILL.md`) and an old LaunchAgent
  label (docs/plist text) appeared in three historical commits, plus old
  author/committer identity in every commit.
- `gh repo edit --visibility public --accept-visibility-change-consequences`
  (making it public under the same name, so the live checkout's `origin` and
  the 15-minute sync loop needed no changes).
- The leftover `sync-test` remote branch was deleted.

## The history-rewrite recipe used (git filter-branch)

`git-filter-repo` was not installed; for one-off rewrites `git filter-branch`
works. For each repo:

```sh
git filter-branch --force \
  --tree-filter '<script: sed-replace values, rename files; must end in `true`
                  so a missing file/renamed-condition can't abort a commit>' \
  --env-filter 'export GIT_AUTHOR_NAME=... GIT_AUTHOR_EMAIL=...
                GIT_COMMITTER_NAME=... GIT_COMMITTER_EMAIL=...' \
  --msg-filter 'sed ...' \
  -- --all
# then strip the backup refs and objects:
git for-each-ref --format='%(refname)' refs/original | xargs -r git update-ref -d
git reflog expire --expire=now --all
git gc --prune=now
```

Caveats hit: the tree-filter script must exit 0 for *every* commit (a bare
`[ -f ... ] && mv ...` aborts the rewrite on commits where the file is absent —
wrap in `if ... fi; true`); and `git gc` alone does not remove the old objects
because `refs/original` still references them — delete those refs first.

## How this repo consumes them

- `scripts/install.sh` clones all three from the public URLs (the defaults in
  `.env.example`); existing local checkouts are reused in place.
- `pi/extensions/pi-imessage/` and `pi/skills/global-todo/` remain as vendored
  fallbacks so a mirror works even without the remotes. (The vendor copies of
  global-todo carry the same content; the live upstream now shows the literal
  public origin URL in its docs instead of `{{PI_TODO_ORIGIN}}`.)

## Personal-data inventory (agent-level files)

| Location | Personal data | Status in this repo |
|---|---|---|
| `~/.pi/agent/SYSTEM.md` | phone number | vendored as `pi/SYSTEM.md` with `{{PI_NOTIFY_PHONE}}` — rendered by `scripts/render.sh` |
| `~/.pi/agent/mcp.json` | none in the current template (all servers are local) | vendored as `pi/mcp.json.template` — rendered by `scripts/render.sh` |
| `~/.pi/agent/pi-imessage/config.json` | `meHandles` (phone + Apple ID email), `allowFrom` | never vendored; `config.example.json` + render.sh materialize it |
| `~/.pi/agent/auth.json`, `models-store.json`, `mcp-cache.json` | provider keys / generated caches | **never vendored** — gitignored, regeneratable or secret |

## Reusable pre-publish checklist (run in each upstream repo)

```sh
# patterns are yours: GitHub user, email, home directory, phone digits,
# LAN hostnames, token prefixes, personal launchd labels
git grep -nE '<your-user>|<your-email>|/Users/<you>|<phone-digits>|<lan-host>|eyJ|com\.<you>\.' -- ':!*.lock' || echo clean
# then the full history, not just HEAD:
git log -p --all | grep -nE '<same patterns>' || echo clean
```

Any hit must be justified: a public name (e.g. `paperniuk`) or the repo's own
public URL is fine; anything matching your identity patterns is not, and the
history must be rewritten before making the repo public. Remember that a
successful `https` clone is **not** proof of public visibility (credential
helpers will fetch private repos) — check `gh api repos/<owner>/<name> --jq .visibility`.

Note: live *rendered* files on the source machine (installed launchd plists,
`~/.pi/agent/mcp.json`, rendered configs) will contain real values — that is
expected and fine as long as those files are gitignored and never committed.
