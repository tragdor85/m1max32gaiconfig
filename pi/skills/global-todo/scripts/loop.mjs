#!/usr/bin/env node
/**
 * Periodic loop for the global todo skill (run by launchd: com.piagent.pi-todo-loop).
 * Cadence: PI_TODO_INTERVAL_S (default 900 = 15 min) — the loop self-reschedules
 * with sleep+exit, so interval changes take effect on the next wake.
 *
 * Every run:
 *   1. takes a loop lock (one loop run at a time)
 *   2. reaps in-progress tasks:
 *        - worker alive but over PI_TODO_MAX_RUNTIME_H (default 6) → kill pgid, fail, notify
 *        - worker dead  + summary file exists            → complete, notify
 *        - worker dead  + newest summaries/<id>*.md     → complete (with that summary), notify
 *        - worker dead  + no summary                    → fail (with log tail), notify
 *   3. busy gate (the local model serves one request at a time):
 *        PRIMARY   the model server pi actually uses (settings.json defaultProvider,
 *                  resolved via models.json):
 *                   - kind "engine" (splash etc): GET /health (public) + GET /status
 *                     (keyed) — busy if !ready, in-flight/queued requests, any pi
 *                     session file written within PI_TODO_ACTIVE_WINDOW_S (120),
 *                     or request counters move over that window
 *                   - kind "mtplx": GET /admin/sessions (legacy)
 *        EXCLUSIVITY  a task already in-progress → skip (one worker at a time)
 *        FALLBACK  server unreachable → skip (a worker would have no model)
 *        ESCAPE    --force / PI_TODO_SKIP_BUSY_CHECK=1
 *   4. if tasks are pending: taskctl claim → build prompt → spawn
 *        `pi -p --offline --no-approve --no-extensions -e mtplx-request-policy
 *          -e mtplx-session-reset --name todo-<id> -- <prompt>`
 *        detached (own pgid, stdio → logs/<file>) → taskctl start <id> --pid.
 *
 * The worker is fire-and-forget: it completes its own bookkeeping (taskctl
 * complete/fail + taskctl notify). On pickup the loop sends a "started"
 * iMessage (🚀) to the task's source peer; completion/failure messages
 * (✅/⚠️) are shared with it via notify.mjs. This loop exits after launching.
 *
 * Env: PI_TODO_INTERVAL_S (900), PI_TODO_HOME, PI_TODO_PI_BIN, PI_TODO_PI_EXTENSIONS (comma list of
 * extension file basenames or absolute paths), PI_TODO_MAX_RUNTIME_H,
 * PI_TODO_ACTIVE_WINDOW_S, PI_TODO_SKIP_BUSY_CHECK, PI_TODO_MTPLX_ADMIN,
 * PI_TODO_MTPLX_KEY.
 */
import { execFileSync, spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { notifyMessage } from "./notify.mjs";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const SKILL_DIR = path.dirname(HERE);
const TASKCTL = path.join(HERE, "taskctl.mjs");
const TODO_HOME = process.env.PI_TODO_HOME || path.join(os.homedir(), ".pi", "agent", "todos");
const TASKS_FILE = path.join(TODO_HOME, "tasks.json");
const LOCK_DIR = path.join(TODO_HOME, "loop.lock");
const LOG_FILE = path.join(TODO_HOME, "loop.log");

const INTERVAL_S = Number(process.env.PI_TODO_INTERVAL_S || "900");
const MAX_RUNTIME_H = Number(process.env.PI_TODO_MAX_RUNTIME_H || "6");
const ACTIVE_WINDOW_S = Number(process.env.PI_TODO_ACTIVE_WINDOW_S || "120");
const RETRY_COOLDOWN_H = Number(process.env.PI_TODO_RETRY_COOLDOWN_H || "1");
const MAX_RETRIES = Number(process.env.PI_TODO_MAX_RETRIES || "3");
const SKIP_BUSY = process.env.PI_TODO_SKIP_BUSY_CHECK === "1";

const EXT_DIR = path.join(os.homedir(), ".pi", "agent", "extensions");
const DEFAULT_EXTS = ["mtplx-request-policy.ts", "mtplx-session-reset.ts"];
const PI_BIN =
  process.env.PI_TODO_PI_BIN ||
  ["/opt/homebrew/bin/pi", "/usr/local/bin/pi", "/usr/bin/pi"].find((p) => {
    try { fs.accessSync(p); return true; } catch { return false; }
  }) || "pi";

const sleeper = new Int32Array(new SharedArrayBuffer(4));
const sleep = (ms) => {
  try { Atomics.wait(sleeper, 0, 0, ms); }
  catch { try { spawnSync("/bin/sleep", [String(Math.ceil(ms / 1000))]); } catch { /* no sleep available */ } }
};

function log(msg) {
  try {
    fs.mkdirSync(TODO_HOME, { recursive: true });
    fs.appendFileSync(LOG_FILE, `${new Date().toISOString()} ${msg}\n`);
    const st = fs.statSync(LOG_FILE);
    if (st.size > 2 * 1024 * 1024) fs.writeFileSync(LOG_FILE, fs.readFileSync(LOG_FILE, "utf8").slice(-1024 * 1024));
  } catch { /* best effort */ }
  console.log(msg);
}

function pidAlive(pid) {
  try { process.kill(pid, 0); return true; } catch (e) { return e.code === "EPERM"; }
}

function runTaskctl(args) {
  const raw = execFileSync(process.execPath, [TASKCTL, ...args, "--json"], {
    timeout: 60_000,
    encoding: "utf8",
  });
  return JSON.parse(raw);
}

/* --- model server busy check ------------------------------------------- */

/**
 * Resolve the local model server pi actually uses: settings.json
 * defaultProvider, falling back to models.json entries (mtplx/splash/omlx).
 * @returns {{kind:"mtplx"|"engine", name:string, base:string, key?:string} | null}
 */
function modelServer() {
  if (process.env.PI_TODO_MTPLX_ADMIN) {
    return { kind: "mtplx", name: process.env.PI_TODO_MTPLX_ADMIN, base: process.env.PI_TODO_MTPLX_ADMIN, key: process.env.PI_TODO_MTPLX_KEY || "1313" };
  }
  try {
    const mj = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "models.json"), "utf8"));
    const provs = mj.providers || {};
    let defName = null;
    try {
      defName = JSON.parse(fs.readFileSync(path.join(os.homedir(), ".pi", "agent", "settings.json"), "utf8"))?.defaultProvider || null;
    } catch { /* no settings file */ }
    const pick =
      (defName && provs[defName] ? [defName, provs[defName]] : null) ||
      Object.entries(provs).find(([n, v]) => /mtplx/i.test(n) || /mtplx/i.test(v?.baseUrl || "")) ||
      Object.entries(provs).find(([n, v]) => /splash|omlx/i.test(n) || /splash|omlx/i.test(v?.baseUrl || "")) ||
      null;
    if (!pick?.[1]?.baseUrl) return null;
    const [name, v] = pick;
    const kind = /mtplx/i.test(name) || /mtplx/i.test(v.baseUrl) ? "mtplx" : "engine";
    return { kind, name, base: new URL(v.baseUrl).origin, key: v.apiKey };
  } catch {
    return null;
  }
}

/** Count pi session files written within ACTIVE_WINDOW_S (any agent recently used the model). */
function recentPiActivity() {
  const root = path.join(os.homedir(), ".pi", "agent", "sessions");
  const cutoff = Date.now() - ACTIVE_WINDOW_S * 1000;
  let found = 0;
  const walk = (dir) => {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) { walk(p); continue; }
      if (!e.name.endsWith(".jsonl")) continue;
      try {
        if (fs.statSync(p).mtimeMs >= cutoff) { found++; return; }
      } catch { /* removed mid-scan */ }
    }
  };
  walk(root);
  return found;
}

/**
 * @returns {{state:"ok", busy:boolean, reason:string} |
 *           {state:"unreachable"} | {state:"unconfigured"}}
 */
async function modelServerBusy() {
  const m = modelServer();
  if (!m) return { state: "unconfigured" };

  if (m.kind === "mtplx") {
    // legacy mtplx admin API
    try {
      const ctl = new AbortController();
      const to = setTimeout(() => ctl.abort(), 4000);
      const res = await fetch(m.base + "/admin/sessions", {
        headers: { authorization: `Bearer ${m.key}`, "x-mtplx-client": "pi" },
        signal: ctl.signal,
      });
      clearTimeout(to);
      if (!res.ok) return { state: "unreachable" };
      const body = await res.json();
      const sessions = body.sessions || [];
      const inflight = sessions.filter((s) => s.in_flight);
      const recent = sessions.filter((s) => !s.in_flight && s.last_access_s && Date.now() / 1000 - s.last_access_s < ACTIVE_WINDOW_S);
      if (inflight.length) return { state: "ok", busy: true, reason: `${inflight.length} session(s) in-flight` };
      if (recent.length) return { state: "ok", busy: true, reason: `${recent.length} session(s) active within ${ACTIVE_WINDOW_S}s` };
      return { state: "ok", busy: false, reason: "all sessions idle" };
    } catch {
      return { state: "unreachable" };
    }
  }

  // "engine" kind (splash / openai-compatible local servers)
  let health;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    health = await fetch(m.base + "/health", { signal: ctl.signal });
    clearTimeout(to);
  } catch {
    return { state: "unreachable" };
  }
  if (!health.ok) return { state: "unreachable" };

  const headers = m.key ? { authorization: `Bearer ${m.key}` } : {};
  let status = null;
  try {
    const ctl = new AbortController();
    const to = setTimeout(() => ctl.abort(), 4000);
    const res = await fetch(m.base + "/status", { headers, signal: ctl.signal });
    clearTimeout(to);
    if (res.ok) status = await res.json();
  } catch { /* /status unavailable — remaining signals still apply */ }

  if (status) {
    const active = status.frontend?.active || 0;
    const waiting = status.admission?.waiting || 0;
    if (!status.ready) return { state: "ok", busy: true, reason: `engine not ready (model ${m.name})` };
    if (active > 0 || waiting > 0) return { state: "ok", busy: true, reason: `in-flight: active=${active} waiting=${waiting}` };
  }

  if (recentPiActivity()) return { state: "ok", busy: true, reason: `pi session activity within ${ACTIVE_WINDOW_S}s` };

  if (status?.latency) {
    const c1h = status.latency.http_request?.count ?? 0;
    const c1o = status.latency.output_interval?.count ?? 0;
    sleep(ACTIVE_WINDOW_S * 1000);
    try {
      const res = await fetch(m.base + "/status", { headers });
      if (res.ok) {
        const st2 = await res.json();
        const c2h = st2.latency?.http_request?.count ?? 0;
        const c2o = st2.latency?.output_interval?.count ?? 0;
        if (c2h !== c1h || c2o !== c1o) {
          return { state: "ok", busy: true, reason: `request counters moved over ${ACTIVE_WINDOW_S}s (http ${c1h}→${c2h}, output ${c1o}→${c2o})` };
        }
      }
    } catch { /* second sample failed — prior signals already ran */ }
  }

  return { state: "ok", busy: false, reason: "idle (no in-flight, no recent activity)" };
}

/* --- keep the skill in sync with the dev repo ------------------------- */

/**
 * Development happens in $CODE_DIR/pi-todo (origin = the GitHub repo). Each
 * each run pulls the skill checkout forward from origin/main so fixes
 * deployed there take effect. Skipped when the checkout is dirty, the pull
 * would not be a fast-forward, or PI_TODO_SYNC=0.
 */
function syncSkill() {
  if (process.env.PI_TODO_SYNC === "0") return;
  const git = (args, timeout = 30_000) =>
    execFileSync("git", ["-C", SKILL_DIR, ...args], { timeout, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  let origin = null;
  try { origin = git(["remote", "get-url", "origin"]).trim(); } catch { return; }
  if (!/github\.com[/:]/.test(origin)) {
    log(`sync skipped: origin not a GitHub remote (${origin})`);
    return;
  }
  try {
    if (git(["status", "--porcelain"]).trim()) {
      log("sync skipped: skill checkout is dirty");
      return;
    }
    git(["fetch", "origin", "main"]);
    const head = git(["rev-parse", "HEAD"]).trim();
    const remote = git(["rev-parse", "origin/main"]).trim();
    if (head === remote) return;
    // --is-ancestor exits 1 (not an ancestor) without throwing via spawnSync
    const ff = spawnSync("git", ["-C", SKILL_DIR, "merge-base", "--is-ancestor", head, remote], { timeout: 10_000 });
    if (ff.status !== 0) {
      log("sync skipped: local commit(s) ahead of origin/main — push from the dev repo instead");
      return;
    }
    git(["pull", "--ff-only", "origin", "main"]);
    log(`sync: skill updated to ${remote.slice(0, 8)} (this run keeps the pre-pull code; new code takes effect next run)`);
  } catch (e) {
    log(`sync failed: ${String(e.stderr || e.message).trim().slice(0, 120)}`);
  }
}

/* --- reap ------------------------------------------------------------- */

function newestSummaryFor(id) {
  const dir = path.join(TODO_HOME, "summaries");
  let names;
  try { names = fs.readdirSync(dir); } catch { return null; }
  const cand = names
    .filter((n) => n.startsWith(`${id}-r`) && n.endsWith(".md"))
    .sort()
    .reverse();
  return cand.length ? path.join(dir, cand[0]) : null;
}

function logTail(file, maxBytes = 300) {
  try {
    const st = fs.statSync(file);
    const start = Math.max(0, st.size - maxBytes);
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(file, "r");
    fs.readSync(fd, buf, 0, buf.length, start);
    fs.closeSync(fd);
    return buf.toString("utf8").replace(/\s+/g, " ").trim().slice(-250);
  } catch { return null; }
}

/**
 * Send an iMessage about a task to its source peer via taskctl notify.
 * outcome: "start" | "done" | "failed" — one shared format (notify.mjs).
 */
function notifyPeer(t, outcome, extra) {
  try {
    runTaskctl(["notify", t.source_peer || "self", notifyMessage(t, outcome, extra)]);
  } catch (e) {
    log(`T ${t.id} notify failed: ${e.message?.slice(0, 120)}`);
  }
}

/* --- auto-retry --------------------------------------------------------- */

/**
 * Auto-recovery for failed tasks: after RETRY_COOLDOWN_H, a failed task is
 * requeued (failed → pending, runs+1) unless it already failed
 * MAX_RETRIES or more times, is marked no_retry, or was manually retried
 * (retry_cap).
 * Returns [retried, exhausted] counts.
 */
function retryFailed() {
  let s;
  try { s = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch { return [0, 0]; }
  const cutoff = Date.now() - RETRY_COOLDOWN_H * 3.6e6;
  let retried = 0, exhausted = 0;
  for (const t of s.tasks) {
    if (t.status !== "failed" || t.no_retry) continue;
    const failAt = Date.parse(t.last_failure_at || "");
    if (Number.isNaN(failAt) || failAt > cutoff) continue; // no recorded failure time → don't guess
    const failures = t.history?.filter((h) => h.status === "failed").length ?? 1;
    if (t.retry_cap) {
      runTaskctl(["retry", t.id]);
      t.status = "pending";
      t.retry_cap = false;
      retried++;
      log(`T ${t.id} auto-retried (manual requeue, run ${t.runs})`);
    } else if ((failures || 1) >= MAX_RETRIES) {
      t.no_retry = true;
      exhausted++;
      log(`T ${t.id} gave up: ${failures} failed run(s) ≥ ${MAX_RETRIES} — marked no-retry (use: taskctl retry ${t.id})`);
    } else {
      runTaskctl(["retry", t.id]);
      retried++;
      log(`T ${t.id} auto-retried (${failures} failed run(s), run ${t.runs})`);
    }
  }
  if (retried || exhausted) {
    const tmp = TASKS_FILE + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
    fs.renameSync(tmp, TASKS_FILE);
  }
  return [retried, exhausted];
}

/**
 * Reap in-progress tasks (crashed workers, runtime overruns).
 * Returns how many tasks were resolved.
 */
function reap() {
  let s;
  try { s = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch { return 0; }
  let resolved = 0;
  for (const t of s.tasks.filter((t) => t.status === "in-progress")) {
    const alive = t.worker_pid ? pidAlive(t.worker_pid) : false;
    const ageH = t.started_at ? (Date.now() - Date.parse(t.started_at)) / 3.6e6 : 0;

    if (alive && ageH > MAX_RUNTIME_H) {
      log(`T ${t.id} exceeded max runtime (${ageH.toFixed(1)}h) — killing worker pid ${t.worker_pid}`);
      try { process.kill(-t.worker_pid, "SIGTERM"); } catch { try { process.kill(t.worker_pid, "SIGTERM"); } catch {} }
      sleep(5000);
      if (pidAlive(t.worker_pid)) { try { process.kill(-t.worker_pid, "SIGKILL"); } catch { try { process.kill(t.worker_pid, "SIGKILL"); } catch {} } }
      try { runTaskctl(["fail", t.id, "--error", `runtime exceeded ${MAX_RUNTIME_H}h (worker killed)`]); } catch (e) { log(`fail after kill failed: ${e.message?.slice(0, 120)}`); }
      notifyPeer(t, "failed", `runtime exceeded ${MAX_RUNTIME_H}h — killed`);
      resolved++;
      continue;
    }

    if (!alive) {
      const summary = fs.existsSync(t.summary_file || "") ? t.summary_file : newestSummaryFor(t.id);
      if (summary) {
        try { runTaskctl(["complete", t.id, "--summary", summary]); } catch (e) { log(`complete failed: ${e.message?.slice(0, 120)}`); }
        notifyPeer(t, "done", "worker finished");
        resolved++;
      } else {
        const tail = logTail(t.log_file);
        const err = `worker exited without a summary${tail ? ` (log tail: ${tail})` : ""}`;
        try {
          runTaskctl(["fail", t.id, "--error", err]);
          // reap's fail path skips the history push (wasInProgress guard);
          // record the failure here so the auto-retry cooldown has a clock
          const s2 = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
          const t2 = s2.tasks.find((x) => x.id === t.id);
          if (t2 && t2.status === "failed") {
            t2.last_failure_at = new Date().toISOString();
            const last = t2.history[t2.history.length - 1];
            if (!last || last.status !== "failed") {
              t2.history.push({ status: "failed", at: t2.last_failure_at, error: err.slice(0, 500), summary_file: t2.summary_file });
            }
            fs.writeFileSync(TASKS_FILE + ".tmp", JSON.stringify(s2, null, 2) + "\n");
            fs.renameSync(TASKS_FILE + ".tmp", TASKS_FILE);
          }
        } catch (e) { log(`fail bookkeeping failed: ${e.message?.slice(0, 120)}`); }
        notifyPeer(t, "failed", err.slice(0, 160));
        resolved++;
      }
    }
    // alive and under max runtime → leave running
  }
  return resolved;
}

/* --- launch ----------------------------------------------------------- */

function buildPrompt(t) {
  const sum = t.summary_file;
  return [
    "You are a headless pi worker dispatched by the global-todo loop (15-min cadence). The local 27B model serves one request at a time; no other agent is running right now.",
    "",
    `Task id: ${t.id}`,
    `Task title: ${t.title}`,
    "",
    "Task body:",
    t.body,
    "",
    `Working directory: ${t.workdir} (your session state lives here; previous runs may have left files and a state.md — read them first if present)`,
    t.cwd ? `The task points at project: ${t.cwd} — do the work there (cd via bash) but keep session state in the working directory.` : "",
    "",
    "Completion protocol (follow exactly):",
    "1. Work incrementally; verify with tests or commands whenever possible.",
    "2. Keep context lean: use targeted commands (rg, sed -n, git diff, tail) — never dump large files or full logs into context.",
    `3. Write a completion summary to EXACTLY this path: ${sum}`,
    "   Sections: '## What was done', '## Files changed', '## Verification', '## Follow-ups / blockers'.",
    `4. Then run: node ${TASKCTL} complete ${t.id} --summary ${sum}`,
    `5. Then run: node ${TASKCTL} notify ${t.source_peer || "self"} "✅ Todo ${t.id} \\"${t.title}\\" done — <one-line result>"`,
    "6. Stop. Do not start unrelated work, do not message people, do not modify the todo store or this skill except via the taskctl commands above.",
    "",
    "If the task turns out infeasible or blocked: write the summary explaining what you tried and what is needed, run the fail command with a short reason, then notify with a one-line blocked message, then stop.",
    "",
    "Model context is limited (~50k). Make progress in small verified steps; never one giant pass.",
  ]
    .filter((l) => l !== null)
    .join("\n");
}

function launch(t) {
  const prompt = buildPrompt(t);
  const exts = (process.env.PI_TODO_PI_EXTENSIONS ? process.env.PI_TODO_PI_EXTENSIONS.split(",") : DEFAULT_EXTS)
    .map((f) => (f.trim().startsWith("/") ? f.trim() : path.join(EXT_DIR, f.trim())))
    .filter((f) => fs.existsSync(f));
  if (!exts.length) log("warning: no mtplx extensions found; worker will run without model policy");
  const logPath = t.log_file || path.join(TODO_HOME, "logs", `${t.id}-manual.log`);
  fs.mkdirSync(path.dirname(logPath), { recursive: true });
  const logFd = fs.openSync(logPath, "a");
  const args = [
    "-p", "--offline", "--no-approve", "--no-extensions",
    ...exts.flatMap((f) => ["-e", f]),
    "--name", `todo-${t.id}`,
    "--", prompt,
  ];
  const child = spawn(PI_BIN, args, {
    cwd: t.workdir,
    detached: true, // own process group → killable as a unit
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      PATH: "/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin",
      NO_COLOR: "1",
      TERM: "dumb",
    },
  });
  child.unref();
  let started = false;
  try {
    runTaskctl(["start", t.id, "--pid", String(child.pid), "--log", logPath]);
    started = true;
  } catch (e) {
    log(`start bookkeeping failed: ${e.message?.slice(0, 150)}`);
  }
  if (started) notifyPeer(t, "start", "worker running");
  log(`T ${t.id} launched: pi worker pid ${child.pid} (run ${t.runs}) → ${logPath}`);
}

/* --- main ------------------------------------------------------------- */

function loopLock() {
  fs.mkdirSync(TODO_HOME, { recursive: true });
  try {
    fs.mkdirSync(LOCK_DIR);
    fs.writeFileSync(path.join(LOCK_DIR, "info.json"), JSON.stringify({ pid: process.pid, ts: Date.now() }));
    return true;
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let stale = false;
    try {
      const info = JSON.parse(fs.readFileSync(path.join(LOCK_DIR, "info.json"), "utf8"));
      stale = Date.now() - info.ts > 10 * 60 * 1000 || !pidAlive(info.pid);
    } catch { stale = true; }
    if (stale) {
      fs.rmSync(LOCK_DIR, { recursive: true, force: true });
      return loopLock();
    }
    return false;
  }
}

function releaseLoopLock() {
  fs.rmSync(LOCK_DIR, { recursive: true, force: true });
}

const t0 = Date.now();

async function main() {
  if (process.argv.includes("--status")) {
    const st = JSON.parse(execFileSync(process.execPath, [TASKCTL, "status", "--json"], { encoding: "utf8" }));
    const busy = await modelServerBusy();
    console.log(JSON.stringify({ ...st, model: busy }, null, 2));
    return;
  }
  if (!loopLock()) {
    log("another loop run in progress — exiting");
    return;
  }
  try {
    syncSkill();
    fs.mkdirSync(TODO_HOME, { recursive: true });
    const reaped = reap();
    if (reaped) log(`reaped ${reaped} finished/stale in-progress task(s)`);
    const [retried, exhausted] = retryFailed();
    if (retried) log(`auto-retried ${retried} failed task(s)`);
    if (exhausted) log(`gave up on ${exhausted} failed task(s) (retry cap reached)`);

    if (!SKIP_BUSY && !process.argv.includes("--force")) {
      const b = await modelServerBusy();
      if (b.state === "unreachable") {
        log("model server unreachable — skipping (a worker would have no model)");
        return;
      }
      if (b.state === "unconfigured") {
        log("warning: no model server config found — proceeding without busy check");
      } else if (b.busy) {
        log(`model server busy (${b.reason}) — skipping launch`);
        return;
      }
    } else {
      log("busy check skipped (--force / PI_TODO_SKIP_BUSY_CHECK)");
    }

    let s;
    try { s = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8")); } catch { s = { tasks: [] }; }
    if (!s.tasks.some((t) => t.status === "pending")) {
      log("no pending tasks — done");
      return;
    }
    if (s.tasks.some((t) => t.status === "in-progress")) {
      log("a worker is already running — skipping launch (one worker at a time)");
      return;
    }
    let t;
    try {
      t = runTaskctl(["claim"]).task;
    } catch (e) {
      log(`claim failed: ${e.message?.slice(0, 150)}`);
    }
    if (t) launch(t);
  } finally {
    releaseLoopLock();
    // self-reschedule: sleep until the next wake, then re-run this file.
    // (launchd cannot be reloaded from a detached process; this also makes
    // PI_TODO_INTERVAL_S changes take effect without reinstalling the plist).
    // Manual --force runs exit instead — no background sleeper.
    const manual = process.argv.includes("--force") || SKIP_BUSY;
    if (!manual) {
      const wait = Math.max(0, INTERVAL_S - (Date.now() - t0) / 1000);
      if (wait > 0) {
        log(`next run in ${Math.round(wait)}s`);
        sleep(Math.ceil(wait) * 1000);
        spawnSync(process.execPath, [new URL(import.meta.url).pathname], {
          stdio: "ignore",
          detached: true,
          env: process.env,
        });
      }
    }
  }
}

main().catch((e) => {
  log(`FATAL: ${e?.stack || e}`);
  releaseLoopLock();
  process.exit(1);
});