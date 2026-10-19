---
name: global-todo
description: Global todo list for pi — add/list/inspect tasks from any session (also via iMessage @task); a 15-minute cadence headless worker picks up pending tasks when the local 27B model is free and writes a summary file per completed task. Use when the user asks about todos, wants a task queued for later, or when you are the headless todo worker.
---

# Global Todo

A shared task store that every pi session can read and write, plus a worker on a 15-minute cadence that executes pending tasks when the local model is free.

## Layout

```
~/.pi/agent/todos/                 ($PI_TODO_HOME)
├── tasks.json                     single source of truth (mkdir-locked)
├── summaries/<id>-r<n>-<stamp>.md  per-run completion summaries (kept across retries)
├── logs/<id>-r<n>-<stamp>.log      headless pi stdout/stderr per run
├── work/<id>/                     worker working dir (persists across retries)
├── outbox/                        one JSON file per pending iMessage notification
├── loop.log                       loop trace (every 15 min)
└── lock/                          process lock
```

## Commands (taskctl)

`node ~/.pi/agent/skills/global-todo/scripts/taskctl.mjs <cmd>` — all output is JSON.

```
add <text...> [--title t] [--cwd dir] [--source s] [--source-peer h]
list [--status pending|in-progress|done|failed]
show <id>                      (accepts T0003 or 3)
claim                          oldest pending → in-progress
start <id> --pid <n> [--log p]
complete <id> [--summary path]
fail <id> --error <msg>
release <id>                   in-progress → pending
notify <to|self> <text...>     append to outbox (bridge delivers as iMessage)
status                         counts
prune [--keep N]
```

## Adding a task

From any session (bash):

```bash
node ~/.pi/agent/skills/global-todo/scripts/taskctl.mjs add "Refactor the ledger" --cwd /path/to/your/project
```

From the phone: text yourself with `@task <anything>` — the pi-imessage
extension handles it deterministically (never enters agent context) and
confirms with a reply. `@task list` shows open todos.

## The loop (every 15 min)

launchd label `com.piagent.pi-todo-loop` boots `scripts/loop.mjs`, which then self-reschedules every `PI_TODO_INTERVAL_S` (900 = 15 min):

0. syncs the skill checkout from `origin/main` (the dev repo,
   `$CODE_DIR/pi-todo`) if there are new commits — skipped when the checkout
   is dirty, the pull isn't a fast-forward, or `PI_TODO_SYNC=0`
1. reaps in-progress tasks (crashed worker → complete if summary exists, else
   fail; runtime > `PI_TODO_MAX_RUNTIME_H` (6) → kill the process group)
2. auto-retries failed tasks: after `PI_TODO_RETRY_COOLDOWN_H` (1h) a failed
   task is requeued, up to `PI_TODO_MAX_RETRIES` (3) failed runs, then it is
   marked no-retry (terminal) — unstick with `taskctl retry <id>`
2. busy gate (single local 27B, one request at a time) — resolves the model
   server from `settings.json` `defaultProvider` + `models.json`:
   - engine servers (splash etc): busy if `GET /status` shows `!ready`,
     in-flight/queued requests, any pi session file written within
     `PI_TODO_ACTIVE_WINDOW_S` (120 s), or request counters move over the window
   - mtplx: legacy `GET /admin/sessions` (in-flight / recent activity)
   server unreachable → skip (a worker would have no model);
   a task already in-progress → skip (one worker at a time)
3. if pending tasks exist: `claim` → spawn `pi -p` headless worker (detached,
   logs captured) → `start`

`--force` / `PI_TODO_SKIP_BUSY_CHECK=1` bypass the busy gate for manual runs.
`PI_TODO_SYNC=0` disables the per-run skill sync.

**Notifications** (via `taskctl notify` → iMessage, to the task's source peer,
`self` if added locally): when a task is picked up the loop sends
`🚀 Todo <id> "<title>" started — worker running`; completion and failure use
the same shared format (`✅ … done` / `⚠️ … failed`) from `scripts/notify.mjs`.

## Development

Edit in `$CODE_DIR/pi-todo` (origin = https://github.com/tragdor85/pi-todo).
After `git push origin main`, the skill dir picks up the change on the next
loop run (≤ 15 min) (or run `node scripts/loop.mjs --force` to test immediately).

## Worker protocol (if you are the dispatched headless worker)

1. Work incrementally; verify with tests/commands.
2. Keep context lean (targeted reads; never dump big files/logs).
3. Write the summary to the exact path in your prompt.
4. `taskctl complete <id> --summary <path>`.
5. `taskctl notify self "✅ Todo <id> ... done — <one-line result>"`.
6. Stop. Never message people or modify the store/skill directly.

## Summary format

```markdown
## What was done
## Files changed
## Verification
## Follow-ups / blockers
```

## Tuning (env)

`PI_TODO_HOME`, `PI_TODO_PI_BIN`, `PI_TODO_PI_EXTENSIONS`,
`PI_TODO_INTERVAL_S` (900), `PI_TODO_MAX_RUNTIME_H` (6),
`PI_TODO_ACTIVE_WINDOW_S` (120), `PI_TODO_RETRY_COOLDOWN_H` (1),
`PI_TODO_MAX_RETRIES` (3),
`PI_TODO_SYNC` (1), `PI_TODO_SKIP_BUSY_CHECK`,
`PI_TODO_MTPLX_ADMIN` / `PI_TODO_MTPLX_KEY`
(later override the provider resolution; legacy mtplx).

## Install / remove

```bash
sh ~/.pi/agent/skills/global-todo/install-loop.sh            # install (RunAtLoad, then 15-min self-reschedule)
sh ~/.pi/agent/skills/global-todo/install-loop.sh --remove   # uninstall
```