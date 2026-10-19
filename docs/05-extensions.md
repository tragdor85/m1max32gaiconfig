# 05 — Extensions, skills, and the local agent layer

pi loads resources from the agent directory (`~/.pi/agent`): local extensions in
`extensions/`, npm extensions installed into the agent's `npm/` registry
(`npm/package.json` — see [Pi packages](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md) in the upstream of the fork),
and skills in `skills/` (it also scans `~/.agents/skills/` per the Agent Skills
spec). npm extensions are declared with versions in `npm/package.json`; pi installs
them into `npm/node_modules`.

## Installed (this machine)

| Package (installed version) | What it does | State |
|---|---|---|
| `@firstpick/pi-extension-git-footer-status@0.5.5` | Replaces the footer with git status, token/context usage, model telemetry | active |
| `pi-compaction-model@0.1.0` | Lets native compaction run on a *different* model than the session model | installed, **unconfigured** — settings has no `compactionModel` key, so compaction runs on the session model (see "known drift") |
| `pi-mcp-adapter@5.3.1` | Exposes MCP servers to pi as native tools | active — the only MCP route (built-in MCP is disabled, see `docs/06`) |

The three registry packages are in the vendored [`pi/npm/package.json`](../pi/npm/package.json)
(version ranges as installed). `pi-imessage` is a local source extension (next).

## `pi-imessage` — local source extension (vendored)

Bridges pi and Apple iMessage (this machine has no other phone channel):

- polls `~/Library/Messages/chat.db` every second for new 1:1 DMs **from the allowlist
  only** (polling is off by default in the extension; the local config turns it on);
  own sent messages and their device-echo rows are swallowed via fingerprints,
- inbound messages are injected as user messages to the agent;
- outbound goes through the `imessage_send` tool (AppleScript → Messages.app),
  recipients restricted to the allowlist (own identities always allowed);
- `@task <text>` inbounds are routed **deterministically** into the global-todo
  store — never into the LLM; the outbox queued by the todo loop is drained here;
- group chats, SMS, attachments: intentionally unsupported.

Commands: `/imessage [status | poll on|off | allow <h> | unallow <h> | me [h …] | send <to> <text>]`.
Config: `~/.pi/agent/pi-imessage/config.json` (override with `PI_IMESSAGE_CONFIG`);
denied inbounds land in `denied.log` beside it, never on the console.

Vendored in [`pi/extensions/pi-imessage/`](../pi/extensions/pi-imessage/) (source +
tests; no `node_modules`, no state dir). The **config is not vendored** — it holds
personal handles. Use the sanitized template
[`config.example.json`](../pi/extensions/pi-imessage/config.example.json) and fill
`{{PI_NOTIFY_PHONE}}` / `{{PI_IMESSAGE_ME_EMAIL}}`
from your `.env` (block "Identity") when mirroring:

```json
{
  "meHandles": ["<your phone>", "<your Apple-ID e-mail>"],
  "allowFrom": ["<your phone>"],
  "pollingEnabled": true,
  "pollIntervalMs": 1000
}
```

(placeholder names `{{PI_NOTIFY_PHONE}}` / `{{PI_IMESSAGE_ME_EMAIL}}`
map to the `.env` block "Identity".)

Install: `npm install` in the directory, then point pi at it — a symlink
`~/.pi/agent/extensions/pi-imessage -> <repo>/pi/extensions/pi-imessage` is how
it's loaded here (local extensions need no entry in `settings.json`). The test
fixtures use dummy handles (`+15551230001` / `test@example.com`) — they were
sanitized for the repo.

## `global-todo` skill (vendored)

A shared todo store (`~/.pi/agent/todos/`) every session can read/write, plus a
launchd worker on a 15-minute cadence that runs pending tasks **when the local
27B is free** (single-server busy gate; one worker at a time), with retry policy,
per-run summaries, and iMessage notifications. Full protocol: the vendored
[`SKILL.md`](../pi/skills/global-todo/SKILL.md) — including the worker contract
headless runs receive.

- **Add**: `taskctl add …` from any session, or `@task …` on iMessage (handled by pi-imessage).
- **Loop**: launchd label `com.piagent.pi-todo-loop` (installed by `install-loop.sh`)
  runs `scripts/loop.mjs`, which self-reschedules every `PI_TODO_INTERVAL_S` (900 s).
- **Env**: `PI_TODO_HOME`, `PI_TODO_PI_BIN`, `PI_TODO_INTERVAL_S`,
  `PI_TODO_MAX_RUNTIME_H` (6), `PI_TODO_ACTIVE_WINDOW_S` (120), retry knobs,
  `PI_TODO_SYNC` (checkout auto-sync), `PI_TODO_SKIP_BUSY_CHECK`.
- **Install**: `sh pi/skills/global-todo/install-loop.sh` (`--remove` uninstalls).

Provenance: the skill directory is a checkout of a **public** dev repo
(`https://github.com/tragdor85/pi-todo`, `git pull`-synced each loop run).
`scripts/install.sh` clones it when `PI_TODO_ORIGIN` is set (the default in
`.env.example` points at the public repo); with the variable empty it falls back
to the vendored copy in `pi/skills/global-todo/` and sets `PI_TODO_SYNC=0`.
The live machine's checkout has an SSH remote (`git@github.com:...`); the
installed skill dir is a copy and has no remote at all.

## Known drift: legacy compaction keys in `settings.json`

The vendored `pi/settings.json` carries per-model compaction budgets as
`compaction.reserveTokens.models` / `compaction.keepRecentTokens.models` — a shape
from the pi 0.84 era. pi **1.3.0's schema reads `compaction.modelOverrides`**
(a record keyed by `provider/modelId`, per the native
[compaction docs](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/compaction.md)),
and TypeBox object schemas silently ignore the dotted legacy keys. Consequence on
this machine: the intended per-model budgets (25600/20480) are **not active** —
every model compacts with the global 16384 reserve / 6000 keep-recent, on the
session model. The fix is a one-shot rewrite to `compaction.modelOverrides` (+ add
a `compactionModel` key if Qwen3.6-35B compaction is actually wanted). This repo
mirrors the *live* file as found; apply the migration on the machine, then bump
the vendored copy.

## Deliberately not here

- **Builtin MCP** — disabled (`settings.json: extensions: ["-builtin:mcp"]`); the
  pi-mcp-adapter package is the single MCP route (`docs/06-mcp.md`).
- **Unused provider extensions** — the live `~/.pi/agent/npm/package.json` still
  declares two installed-but-unused model-provider packages; the vendored
  [`pi/npm/package.json`](../pi/npm/package.json) omits them. The only model provider
  in `models.json` is local Splash.
- **`~/.agents/` subagent definitions** (`admin.md`) — pi 1.3.0 has no user-subagent
  loader, so none are vendored.
- No `~/.agents/skills/` content: the only user skill lives in `~/.pi/agent/skills/`.
