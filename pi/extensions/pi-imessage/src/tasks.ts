/**
 * Global-todo skill client + outbox operations.
 *
 * The store is owned by the global-todo skill (~/.pi/agent/skills/global-todo).
 * Mutations shell out to taskctl.mjs (which takes the store's own lock); the
 * outbox directory is read directly for iMessage notifications queued by the
 * hourly loop and worker.
 *
 * Env: PI_TODO_HOME   store root (default ~/.pi/agent/todos)
 *      PI_TODO_TASKCTL path to taskctl.mjs (default skill location)
 */
import { execFile } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import os from "node:os";
import path from "node:path";

export const TODO_HOME =
  process.env.PI_TODO_HOME || path.join(os.homedir(), ".pi", "agent", "todos");
export const TASKCTL =
  process.env.PI_TODO_TASKCTL ||
  path.join(os.homedir(), ".pi", "agent", "skills", "global-todo", "scripts", "taskctl.mjs");
export const OUTBOX_DIR = path.join(TODO_HOME, "outbox");
export const OUTBOX_DEAD = path.join(TODO_HOME, "outbox-dead");
/** After this many failed send attempts an outbox entry is dead-lettered. */
export const OUTBOX_MAX_TRIES = 5;

export interface OutboxEntry {
  file: string;
  name: string;
  to: string;
  text: string;
  at?: string;
  tries: number;
}

export function taskctlAvailable(): boolean {
  return existsSync(TASKCTL);
}

/**
 * Run taskctl and parse the JSON result. Async on purpose: the store lock can
 * be held by the hourly loop (waits up to ~30 s) and the bridge must never
 * block its 1 s poll tick on it.
 */
export function runTaskctl(args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    execFile(
      process.execPath,
      [TASKCTL, ...args, "--json"],
      { timeout: 60_000, encoding: "utf8" },
      (err, stdout) => {
        const text = (stdout ?? "").trim();
        if (err) {
          // taskctl exits non-zero for no-ops (lock timeout, not found) but
          // still prints structured JSON — prefer that over the error.
          if (text) {
            try {
              resolve(JSON.parse(text));
              return;
            } catch {
              /* unparseable: fall through to the error */
            }
          }
          reject(err);
          return;
        }
        try {
          resolve(JSON.parse(text || "{}"));
        } catch (e) {
          reject(e as Error);
        }
      },
    );
  });
}

/**
 * Entries queued for iMessage delivery, oldest first. In-flight `.tmp`
 * writes and unreadable entries are skipped, never fatal.
 */
export function outboxEntries(): OutboxEntry[] {
  if (!existsSync(OUTBOX_DIR)) return [];
  const out: OutboxEntry[] = [];
  for (const name of readdirSync(OUTBOX_DIR).sort()) {
    if (!name.endsWith(".json")) continue; // skips *.json.tmp in-flight writes
    const file = path.join(OUTBOX_DIR, name);
    try {
      if (!statSync(file).isFile()) continue;
      const data = JSON.parse(readFileSync(file, "utf8"));
      if (!data || typeof data.to !== "string" || typeof data.text !== "string") continue;
      out.push({
        file,
        name,
        to: data.to,
        text: data.text,
        at: data.at,
        tries: typeof data.tries === "number" ? data.tries : 0,
      });
    } catch {
      /* unreadable entry: skipped */
    }
  }
  return out;
}

/** Entry delivered: remove it. */
export function outboxDone(file: string): void {
  try {
    unlinkSync(file);
  } catch {
    /* already gone */
  }
}

/**
 * Record a failed send attempt. Returns "retry" (counted, will be retried)
 * or "dead" (past OUTBOX_MAX_TRIES — moved to the dead-letter directory).
 */
export function outboxBump(file: string): "retry" | "dead" | "gone" {
  try {
    const data = JSON.parse(readFileSync(file, "utf8"));
    data.tries = (typeof data.tries === "number" ? data.tries : 0) + 1;
    if (data.tries > OUTBOX_MAX_TRIES) {
      mkdirSync(OUTBOX_DEAD, { recursive: true });
      renameSync(file, path.join(OUTBOX_DEAD, path.basename(file)));
      return "dead";
    }
    const tmp = file + ".tmp";
    writeFileSync(tmp, JSON.stringify(data));
    renameSync(tmp, file);
    return "retry";
  } catch {
    return "gone";
  }
}