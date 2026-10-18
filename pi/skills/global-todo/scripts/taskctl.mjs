#!/usr/bin/env node
/**
 * taskctl — CLI for the pi global todo store (the "global-todo" skill).
 *
 * Store layout ($PI_TODO_HOME, default ~/.pi/agent/todos):
 *   tasks.json      single source of truth: { version, nextId, tasks[] }
 *   summaries/      <id>-r<run>-<stamp>.md   written by the headless worker
 *   logs/           <id>-r<run>-<stamp>.log  headless pi stdout/stderr
 *   work/<id>/      working directory for the headless worker
 *   outbox/         one JSON file per pending iMessage notification
 *   lock/           mkdir-based process lock (atomic on APFS)
 *
 * Commands (all data output is JSON):
 *   add <text...> [--title t] [--cwd dir] [--source s] [--source-peer h]
 *   list [--status pending|in-progress|done|failed]
 *   show <id>
 *   claim                       oldest pending -> in-progress (allocates workdir + summary/log paths)
 *   start <id> --pid <n> [--log path]
 *   complete <id> [--summary path]
 *   fail <id> --error <msg>
 *   release <id>                in-progress -> pending (manual recovery)
 *   retry <id>                  failed -> pending, bumps runs (skips the retry cap)
 *   no-retry <id>               mark failed task as terminal (loop will not auto-retry it)
 *   notify <to|self> <text...>  atomically append an iMessage to the outbox
 *   status                      counts
 *   prune [--keep N]            trim terminal tasks beyond the most recent N
 *
 * Exit codes: 0 ok, 1 no-op / not found / lock timeout, 2 usage.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

export const TODO_HOME =
  process.env.PI_TODO_HOME || path.join(os.homedir(), ".pi", "agent", "todos");
export const TASKS_FILE = path.join(TODO_HOME, "tasks.json");
export const OUTBOX_DIR = path.join(TODO_HOME, "outbox");
const LOCK_TTL_MS = 2 * 60 * 1000; // reclaim stale locks after 2 min

const now = () => new Date().toISOString();
const stamp = () => {
  const s = new Date().toISOString();
  return `${s.slice(0, 4)}${s.slice(5, 7)}${s.slice(8, 10)}-${s.slice(11, 13)}${s.slice(14, 16)}${s.slice(17, 19)}`;
};

/* --- locking ---------------------------------------------------------- */

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === "EPERM"; // exists but owned by someone else
  }
}

export function acquireLock(name = "lock", ttl = LOCK_TTL_MS, timeoutMs = 30_000) {
  fs.mkdirSync(TODO_HOME, { recursive: true });
  const dir = path.join(TODO_HOME, name);
  const deadline = Date.now() + timeoutMs;
  const sleeper = new Int32Array(new SharedArrayBuffer(4).buffer);
  for (;;) {
    try {
      fs.mkdirSync(dir);
      fs.writeFileSync(
        path.join(dir, "info.json"),
        JSON.stringify({ pid: process.pid, ts: Date.now(), argv: process.argv[1] || null }),
      );
      return dir;
    } catch (e) {
      if (e.code !== "EEXIST") throw e;
      try {
        const info = JSON.parse(fs.readFileSync(path.join(dir, "info.json"), "utf8"));
        if (Date.now() - info.ts <= ttl && pidAlive(info.pid)) throw new Error("held");
      } catch (err) {
        if (err.message !== "held") fs.rmSync(dir, { recursive: true, force: true });
        else if (Date.now() > deadline) return null;
        else {
          Atomics.wait(sleeper, 0, 0, 50);
          continue;
        }
      }
      // fell through: stale lock removed — retry
    }
  }
}

export function releaseLock(dir) {
  if (dir) fs.rmSync(dir, { recursive: true, force: true });
}

function requireLock(name = "lock") {
  const dir = acquireLock(name);
  if (!dir) {
    console.log(JSON.stringify({ ok: false, error: "could not acquire store lock (another taskctl running?)" }));
    process.exit(1);
  }
  return dir;
}

/* --- store ------------------------------------------------------------ */

export function readStore() {
  fs.mkdirSync(TODO_HOME, { recursive: true });
  try {
    const s = JSON.parse(fs.readFileSync(TASKS_FILE, "utf8"));
    return { version: 1, nextId: s.nextId || 1, tasks: s.tasks || [] };
  } catch {
    return { version: 1, nextId: 1, tasks: [] };
  }
}

export function writeStore(s) {
  fs.mkdirSync(TODO_HOME, { recursive: true });
  const tmp = TASKS_FILE + ".tmp";
  fs.writeFileSync(tmp, JSON.stringify(s, null, 2) + "\n");
  fs.renameSync(tmp, TASKS_FILE); // atomic
}

function parseId(x) {
  const m = String(x).match(/^T?0*(\d+)$/i);
  return m ? `T${Number(m[1]).toString().padStart(4, "0")}` : null;
}

function findTask(s, id) {
  const I = parseId(id);
  return I ? s.tasks.find((t) => t.id === I) : undefined;
}

function freshTask(id, text, flags) {
  const lines = text.split(/\n/).map((l) => l.trim()).filter(Boolean);
  return {
    id,
    title: (flags.title || lines[0] || text).slice(0, 120),
    body: text,
    status: "pending",
    source: flags.source || "manual",
    source_peer: flags.sourcePeer || "self",
    cwd: flags.cwd || null,
    created_at: now(),
    updated_at: now(),
    started_at: null,
    finished_at: null,
    worker_pid: null,
    runs: 0,
    workdir: path.join(TODO_HOME, "work", id),
    summary_file: null,
    log_file: null,
    error: null,
    history: [],
  };
}

/* --- commands ---------------------------------------------------------- */

function collectArgs(args, flagNames) {
  const flags = Object.fromEntries(flagNames.map((f) => [f, null]));
  const pos = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "--json") continue;
    if (flagNames.includes(a)) flags[a.slice(2)] = args[++i] ?? "";
    else pos.push(a);
  }
  return { flags, pos };
}

function cmdAdd(args) {
  const { flags, pos } = collectArgs(args, ["--title", "--cwd", "--source", "--source-peer"]);
  const text = pos.join(" ").trim();
  if (!text) {
    console.log(JSON.stringify({ ok: false, error: "add: need task text" }));
    process.exit(2);
  }
  const lock = requireLock();
  const s = readStore();
  const id = `T${s.nextId.toString().padStart(4, "0")}`;
  s.nextId++;
  const t = freshTask(id, text, { ...flags, title: flags.title || null, cwd: flags.cwd || null, source: flags.source || null, sourcePeer: flags.sourcePeer || null });
  s.tasks.push(t);
  writeStore(s);
  releaseLock(lock);
  const pendingCount = s.tasks.filter((x) => x.status === "pending").length;
  console.log(JSON.stringify({ ok: true, task: t, pendingCount }));
}

function cmdList(args) {
  const { flags } = collectArgs(args, ["--status"]);
  const s = readStore();
  let tasks = s.tasks;
  if (flags.status) tasks = tasks.filter((t) => t.status === flags.status);
  tasks = [...tasks].sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  console.log(JSON.stringify({ ok: true, tasks }));
}

function cmdShow(args) {
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t) {
    console.log(JSON.stringify({ ok: false, error: `no task ${args[0] ?? ""}` }));
    process.exit(1);
  }
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdClaim() {
  const lock = requireLock();
  const s = readStore();
  const pend = s.tasks
    .filter((t) => t.status === "pending")
    .sort((a, b) => a.created_at.localeCompare(b.created_at) || a.id.localeCompare(b.id));
  if (!pend.length) {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: "no pending tasks" }));
    process.exit(1);
  }
  const t = pend[0];
  const runs = (t.runs || 0) + 1;
  t.status = "in-progress";
  t.runs = runs;
  t.started_at = now();
  t.updated_at = t.started_at;
  t.worker_pid = null;
  t.error = null;
  t.workdir = path.join(TODO_HOME, "work", t.id);
  fs.mkdirSync(t.workdir, { recursive: true });
  fs.mkdirSync(path.join(TODO_HOME, "summaries"), { recursive: true });
  fs.mkdirSync(path.join(TODO_HOME, "logs"), { recursive: true });
  const st = stamp();
  t.summary_file = path.join(TODO_HOME, "summaries", `${t.id}-r${runs}-${st}.md`);
  t.log_file = path.join(TODO_HOME, "logs", `${t.id}-r${runs}-${st}.log`);
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdStart(args) {
  const { flags } = collectArgs(args, ["--pid", "--log"]);
  const lock = requireLock();
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t) {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `no task ${args[0] ?? ""}` }));
    process.exit(1);
  }
  if (t.status !== "in-progress") {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `${t.id} is ${t.status}, not in-progress` }));
    process.exit(1);
  }
  if (flags.pid) t.worker_pid = Number(flags.pid);
  if (flags.log) t.log_file = flags.log;
  t.updated_at = now();
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdComplete(args) {
  const { flags } = collectArgs(args, ["--summary"]);
  const lock = requireLock();
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t) {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `no task ${args[0] ?? ""}` }));
    process.exit(1);
  }
  if (t.status === "done" || t.status === "failed") {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: true, task: t, noop: true }));
    return;
  }
  const wasInProgress = t.status === "in-progress";
  if (flags.summary) t.summary_file = flags.summary;
  t.status = "done";
  t.finished_at = now();
  t.worker_pid = null;
  t.error = null;
  if (wasInProgress) t.history.push({ status: "done", at: t.finished_at, summary_file: t.summary_file });
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdFail(args) {
  const { flags } = collectArgs(args, ["--error"]);
  if (!flags.error) {
    console.log(JSON.stringify({ ok: false, error: "fail: need --error <msg>" }));
    process.exit(2);
  }
  const lock = requireLock();
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t) {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `no task ${args[0] ?? ""}` }));
    process.exit(1);
  }
  if (t.status === "done" || t.status === "failed") {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: true, task: t, noop: true }));
    return;
  }
  t.status = "failed";
  t.error = flags.error.slice(0, 500);
  t.last_failure_at = now();
  t.finished_at = now();
  t.worker_pid = null;
  // Always record the failure in history — it doubles as the retry counter.
  // A reap of a crash-killed worker (claim recorded but no worker `fail`)
  // relies on this; a failed task that is re-failed gets another entry,
  // which is correct for the counter. `retry_cap` is set by the retry
  // command, so it naturally survives here; a fresh retry after requeue
  // starts the counter from the new history entries.
  t.history.push({ status: "failed", at: t.finished_at, error: t.error, summary_file: t.summary_file });
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdRelease(args) {
  const lock = requireLock();
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t || t.status !== "in-progress") {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `cannot release ${args[0] ?? ""} (must be in-progress)` }));
    process.exit(1);
  }
  t.status = "pending";
  t.worker_pid = null;
  t.summary_file = null;
  t.log_file = null;
  t.started_at = null;
  t.updated_at = now();
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdRetry(args) {
  const lock = requireLock();
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t) {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `no task ${args[0] ?? ""}` }));
    process.exit(1);
  }
  if (t.status !== "failed") {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `${t.id} is ${t.status}, not failed` }));
    process.exit(1);
  }
  t.status = "pending";
  t.worker_pid = null;
  t.error = null;
  t.started_at = null;
  t.summary_file = null;
  t.log_file = null;
  t.finished_at = null;
  t.retry_cap = true; // manual retry is deliberate — exempt from the auto cap
  t.updated_at = now();
  t.history.push({ status: "pending", at: t.updated_at, note: "manually retried" });
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdNoRetry(args) {
  const lock = requireLock();
  const s = readStore();
  const t = findTask(s, args[0]);
  if (!t || t.status !== "failed") {
    releaseLock(lock);
    console.log(JSON.stringify({ ok: false, error: `cannot mark no-retry ${args[0] ?? ""} (must be failed)` }));
    process.exit(1);
  }
  t.no_retry = true;
  t.updated_at = now();
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, task: t }));
}

function cmdNotify(args) {
  const { flags, pos } = collectArgs(args, ["--to"]);
  const to = flags.to || pos.shift() || "self";
  const text = pos.join(" ").trim();
  if (!text) {
    console.log(JSON.stringify({ ok: false, error: "notify: need text" }));
    process.exit(2);
  }
  fs.mkdirSync(OUTBOX_DIR, { recursive: true });
  const name = `${stamp()}${new Date().getMilliseconds()}-${Math.random().toString(36).slice(2, 6)}.json`;
  const entry = { to: to === "self" ? "self" : to, text: text.slice(0, 900), at: now(), tries: 0 };
  const tmp = path.join(OUTBOX_DIR, `.${name}.tmp`);
  fs.writeFileSync(tmp, JSON.stringify(entry) + "\n");
  fs.renameSync(tmp, path.join(OUTBOX_DIR, name)); // atomic; the bridge drains the dir
  console.log(JSON.stringify({ ok: true, file: name }));
}

function cmdStatus() {
  const s = readStore();
  const count = (st) => s.tasks.filter((t) => t.status === st).length;
  const last = [...s.tasks].sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""))[0];
  console.log(
    JSON.stringify({
      ok: true,
      home: TODO_HOME,
      counts: { pending: count("pending"), "in-progress": count("in-progress"), done: count("done"), failed: count("failed") },
      total: s.tasks.length,
      lastFinished: last ? { id: last.id, title: last.title, status: last.status, at: last.finished_at } : null,
    }),
  );
}

function cmdPrune(args) {
  let keep = 200;
  for (let i = 0; i < args.length; i++) if (args[i] === "--keep") keep = Number(args[++i]) || 200;
  const lock = requireLock();
  const s = readStore();
  const terminal = s.tasks
    .filter((t) => t.status === "done" || t.status === "failed")
    .sort((a, b) => (b.finished_at || "").localeCompare(a.finished_at || ""));
  const toDrop = new Set(terminal.slice(keep).map((t) => t.id));
  s.tasks = s.tasks.filter((t) => !toDrop.has(t.id));
  writeStore(s);
  releaseLock(lock);
  console.log(JSON.stringify({ ok: true, pruned: toDrop.size, total: s.tasks.length }));
}

function usage(code) {
  console.log(
    [
      "usage: taskctl <command> [args]   (see file header for the full reference)",
      "  add <text...> [--title t] [--cwd dir] [--source s] [--source-peer h]",
      "  list [--status pending|in-progress|done|failed]",
      "  show <id>",
      "  claim",
      "  start <id> --pid <n> [--log path]",
      "  complete <id> [--summary path]",
      "  fail <id> --error <msg>",
      "  release <id>",
      "  retry <id> (failed → pending, bumps runs)",
      "  no-retry <id> (mark failed task terminal)",
      "  notify <to|self> <text...>",
      "  status",
      "  prune [--keep N]",
    ].join("\n"),
  );
  process.exit(code);
}

function main() {
  const [cmd, ...args] = process.argv.slice(2);
  switch (cmd) {
    case "add": return cmdAdd(args);
    case "list": return cmdList(args);
    case "show": return cmdShow(args);
    case "claim": return cmdClaim();
    case "start": return cmdStart(args);
    case "complete": return cmdComplete(args);
    case "fail": return cmdFail(args);
    case "release": return cmdRelease(args);
    case "retry": return cmdRetry(args);
    case "no-retry": return cmdNoRetry(args);
    case "notify": return cmdNotify(args);
    case "status": return cmdStatus();
    case "prune": return cmdPrune(args);
    case "--help":
    case "-h":
      return usage(0);
    default:
      return usage(cmd ? 2 : 2);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main();
}