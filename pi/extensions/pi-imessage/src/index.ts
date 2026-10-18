/**
 * pi-imessage — bridges pi and Apple iMessage (read chat.db, send via AppleScript).
 *
 *  - Polls ~/Library/Messages/chat.db every second (OFF by default —
 *    `/imessage poll on`) for messages newer than a watermark that is seeded
 *    at the newest row at startup, so no old messages are ever re-delivered.
 *  - New inbound 1:1 iMessage DMs from the allowlist (and self-chat) are
 *    injected as user messages for the agent. Own sent messages are filtered
 *    (is_from_me=1) and their server-side self-chat echoes (is_from_me=0,
 *    sender = own handle, fresh GUID) are swallowed via text+peer one-shot
 *    fingerprints, so replies from phone/devices still come through.
 *  - Outbound goes through the `imessage_send` tool (osascript → Messages.app);
 *    recipients are restricted to the allowlist, own identities always allowed.
 *  - Global-todo skill: `@task <text>` inbounds (self or allowlisted) are
 *    routed to the shared todo store — never to the LLM. Notifications queued
 *    by the hourly loop in the outbox directory are drained and sent here;
 *    the loop itself never sends, because a send from another process would
 *    look like an inbound self-echo row and could re-enter the agent.
 *  - Group chats, SMS, attachments, and history search are intentionally
 *    unsupported in v1.
 *
 * Commands:  /imessage [status | poll on|off | allow <h> | unallow <h> | me [h …] | send <to> <text>]
 * Env:       PI_IMESSAGE_CONFIG  config file path
 *            PI_IMESSAGE_DB      chat.db path (testing)
 * Log:       denied (not-allowlisted) inbounds → denied.log (JSONL, beside the
 *            config file); never printed to the console. `/imessage status`
 *            shows the last denial.
 */
import fs from "node:fs";
import path from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import {
  CONFIG_FILE,
  DENIED_LOG_FILE,
  ImeConfig,
  loadConfig,
  sameHandle,
  saveConfig,
} from "./config.ts";
import {
  appleDateToIso,
  close as closeDb,
  isAvailable as dbAvailable,
  learnSelf,
  maxRowid,
  open as openDb,
  pollNew,
  isGroupChat,
  peerOf,
  SqlDb,
  InboundRow,
} from "./db.ts";
import { canSend, sendImessage, SendResult } from "./send.ts";
import {
  runTaskctl,
  outboxEntries,
  outboxDone,
  outboxBump,
  taskctlAvailable,
  TASKCTL,
} from "./tasks.ts";

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

interface Bridge {
  pi: ExtensionAPI;
  cfg: ImeConfig;
  db: SqlDb | null;
  watermark: number;
  polling: boolean;
  timer: NodeJS.Timeout | null;
  busy: boolean;
  /** Re-entrancy guard for the global-todo outbox drain. */
  drainBusy: boolean;
  ctx: ExtensionContext | null;
  lastPeer: string | null;
  lastEvent: { time: string; peer: string; text: string } | null;
  lastDenied: { time: string; peer: string; text: string } | null;
  lastError: string | null;
  /** Fingerprints of messages this session sent, for self-echo suppression. */
  outboundEchoes: EchoEntry[];
}

/**
 * A fingerprint of a message this session sent via Messages.app, used to
 * swallow the server-side echo of a self-chat send (see isSelfEcho).
 */
interface EchoEntry {
  text: string;
  peer: string;
  atMs: number;
}
const ECHO_TTL_MS = 2 * 60 * 1000; // echoes arrive within seconds; 2 min is generous
const ECHO_MAX = 50; // bound memory even on chatty sessions

let b: Bridge;

function normSelfSet(): Set<string> {
  const s = new Set<string>();
  for (const h of b.cfg.meHandles) s.add(h.trim().toLowerCase().replace(/\s+/g, ""));
  return s;
}

function isSelf(handle: string): boolean {
  const s = normSelfSet();
  for (const h of s) if (sameHandle(h, handle)) return true;
  return false;
}

function isAllowed(handle: string): boolean {
  const set = b.cfg.allowFrom
    .map((h) => h.trim().toLowerCase().replace(/\s+/g, ""))
    .filter(Boolean);
  const n = handle.trim().toLowerCase().replace(/\s+/g, "");
  if (set.includes(n)) return true;
  for (const h of b.cfg.allowFrom) if (sameHandle(h, handle)) return true;
  return false;
}

function note(text: string, type: "info" | "warning" | "error" = "info"): void {
  try {
    const ctx = b.ctx;
    if (ctx && ctx.hasUI) {
      ctx.ui.notify(`pi-imessage: ${text}`, type);
    } else {
      process.stderr.write(`[pi-imessage] ${text}\n`);
    }
  } catch {
    /* never let notifications crash the bridge */
  }
}

function bindCtx(ctx: ExtensionContext): void {
  b.ctx = ctx;
}

/**
 * Append a denial record to the JSONL log (beside the config file).
 * Silent by design: denials are logged, never printed to the console.
 */
function logDenied(entry: { time: string; peer: string; text: string }): void {
  try {
    fs.mkdirSync(path.dirname(DENIED_LOG_FILE), { recursive: true });
    fs.appendFileSync(DENIED_LOG_FILE, JSON.stringify(entry) + "\n", "utf8");
  } catch {
    /* never let logging crash the bridge */
  }
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

/**
 * Persist a state snapshot into the session (custom entry, not LLM-visible).
 * Best-effort: appendEntry may not be available in every mode.
 */
function persist(): void {
  try {
    b.pi.appendEntry("pi-imessage-state", {
      watermark: b.watermark,
      polling: b.polling,
      meHandles: b.cfg.meHandles,
      allowFrom: b.cfg.allowFrom,
      pollIntervalMs: b.cfg.pollIntervalMs,
      lastPeer: b.lastPeer,
      lastEvent: b.lastEvent,
      lastDenied: b.lastDenied,
      lastError: b.lastError,
      at: new Date().toISOString(),
    });
  } catch {
    /* non-interactive mode without entries — ignore */
  }
}

/* ------------------------------------------------------------------ */
/* lifecycle                                                           */
/* ------------------------------------------------------------------ */

function setup(): void {
  b.cfg = loadConfig();
  b.db = openDb();
  // No re-delivery: seed the watermark at the newest existing join row.
  b.watermark = b.db ? maxRowid(b.db) : 0;
  b.lastPeer = null;
  b.lastEvent = null;
  b.lastDenied = null;
  b.lastError = null;

  // Learn own identities (phone / e-mail) from sent-message accounts and
  // persist them so self-chat detection survives config edits.
  if (b.db) {
    const learned = learnSelf(b.db);
    let changed = false;
    for (const h of [learned.phone, learned.email]) {
      if (h && !b.cfg.meHandles.some((x) => sameHandle(x, h))) {
        b.cfg.meHandles.push(h);
        changed = true;
      }
    }
    if (changed) saveConfig(b.cfg);
  } else {
    b.lastError = "chat.db unavailable";
  }

  if (b.cfg.pollingEnabled) startPolling();

  note(
    b.db
      ? `ready — watermark ${b.watermark}, polling ${b.polling ? "on" : "off"}, allowlist [${b.cfg.allowFrom.join(", ")}], self [${b.cfg.meHandles.join(", ")}]`
      : "chat.db unavailable (not macOS or path missing) — commands limited",
    b.db ? "info" : "warning",
  );
  persist();
}

function teardown(): void {
  stopPolling();
  closeDb();
  b.db = undefined as unknown as SqlDb;
}

function startPolling(): void {
  stopPolling();
  b.polling = true;
  note(`polling started (every ${b.cfg.pollIntervalMs} ms)`);
  tick();
  const t = setInterval(() => tick(), b.cfg.pollIntervalMs);
  t.unref?.(); // never keep a headless process alive
  b.timer = t;
}

function stopPolling(): void {
  if (b.timer) {
    clearInterval(b.timer);
    b.timer = null;
  }
  b.polling = false;
}

/* ------------------------------------------------------------------ */
/* polling + inbound handling                                          */
/* ------------------------------------------------------------------ */

function tick(): void {
  if (b.busy || !b.polling) return;
  if (!b.db) return;
  b.busy = true;
  void drainOutbox(); // global-todo notifications; independent of row polling
  try {
    const rows = pollNew(b.db, b.watermark);
    if (rows.length === 0) return;
    let maxRid = b.watermark;
    for (const r of rows) {
      if (r.jrowid > maxRid) maxRid = r.jrowid;
      handleRow(r);
    }
    b.watermark = maxRid;
    persist();
  } catch (e) {
    b.lastError = e instanceof Error ? e.message : String(e);
    note(`poll failed: ${b.lastError}`, "error");
    persist();
  } finally {
    b.busy = false;
  }
}

function rememberPeer(peer: string): void {
  b.lastPeer = peer;
}

/**
 * Record an outbound send so its server echo can be suppressed.
 * A self-chat iMessage sent from this Mac comes BACK as an inbound row
 * (is_from_me=0, sender = own handle, fresh GUID) that is indistinguishable
 * from a user self-chat message typed on the phone; only "we just sent this
 * exact text to this chat" separates the two.
 */
function recordOutboundEcho(peer: string, text: string): void {
  const now = Date.now();
  b.outboundEchoes = b.outboundEchoes.filter((e) => now - e.atMs < ECHO_TTL_MS);
  b.outboundEchoes.push({ text: text.trim(), peer, atMs: now });
  if (b.outboundEchoes.length > ECHO_MAX)
    b.outboundEchoes.splice(0, b.outboundEchoes.length - ECHO_MAX);
}

/**
 * Matches (and CONSUMES) the entry when an inbound row is the echo of a
 * message this session just sent. One-shot: each send suppresses at most one
 * row, so if the user then types the same text again it still delivers.
 */
function isSelfEcho(peer: string, text: string): boolean {
  const now = Date.now();
  const i = b.outboundEchoes.findIndex(
    (e) => now - e.atMs < ECHO_TTL_MS && e.text === text && sameHandle(e.peer, peer),
  );
  if (i < 0) return false;
  b.outboundEchoes.splice(i, 1);
  return true;
}

function handleRow(r: InboundRow): void {
  const db = b.db;
  if (!db) return;
  const selfSet = normSelfSet();

  // Own outbound (agent or human): never inject (echo suppression);
  // only track the chat's peer for reply routing.
  if (r.isFromMe === 1) {
    const peer = peerOf(db, r, selfSet);
    if (peer && !isSelf(peer)) rememberPeer(peer);
    return;
  }

  if (isGroupChat(db, r)) return; // no group support by design

  const peer = peerOf(db, r, selfSet);
  if (!peer) return;

  // Delivered-message filters (v1: plain iMessage text, 1:1 chats only).
  if (r.itemType !== 0) return;
  if (r.isEmpty === 1) return;
  if (r.isServiceMessage === 1) return; // chat renamed / member added / …
  if (r.isSystemMessage === 1) return;
  if (r.replace === 1) return; // edited / deleted message replacement
  if (r.service !== "iMessage") return; // v1 is iMessage-only
  const text = (r.text ?? "").trim();
  if (!text) return;

  const self = isSelf(peer);
  if (!self && !isAllowed(peer)) {
    const t = appleDateToIso(r.date) ?? new Date().toISOString();
    b.lastDenied = { time: t, peer, text: truncate(text, 80) };
    logDenied(b.lastDenied);
    persist();
    return;
  }

  // Self-echo suppression: a send from this session arriving back as an
  // inbound-shaped row (is_from_me=0, sender = own handle). Consumed
  // one-shot, so an identical genuine user message later still delivers.
  if (isSelfEcho(peer, text)) {
    note(`suppressed self-echo → ${truncate(text, 80)}`, "info");
    persist();
    return;
  }

  // @task dispatch (global-todo skill): the text goes to the shared todo
  // store, never to the LLM — no turn is consumed. Fire-and-forget: taskctl
  // may wait on the store lock held by the hourly loop (≤30 s), which must
  // not stall the 1 s poll tick.
  if (text === "@task" || text.startsWith("@task ")) {
    void handleTask(peer, text);
    return;
  }

  const time = appleDateToIso(r.date) ?? new Date().toISOString();
  const label = self ? "iMessage self-chat" : `iMessage from ${peer}`;
  const msg = `[${label} @ ${time}] ${text}`;

  rememberPeer(peer);
  b.lastEvent = { time, peer, text: truncate(text, 200) };

  // Inject as a user message. If the agent is busy, queue as followUp
  // (a new user turn); otherwise prompt directly.
  const idle = b.ctx ? b.ctx.isIdle() : true;
  b.pi.sendUserMessage(msg, idle ? undefined : { deliverAs: "followUp" });

  note(`delivered ${label} → ${truncate(text, 80)}`, "info");
  persist();
}

/* ------------------------------------------------------------------ */
/* sending                                                             */
/* ------------------------------------------------------------------ */

function doSend(
  toRaw: string | null,
  text: string,
): Promise<SendResult & { to?: string }> {
  const to = (toRaw ?? b.lastPeer ?? "").trim();
  if (!to) {
    return Promise.resolve({
      ok: false,
      error: "no recipient — pass `to` (phone or e-mail) or receive an inbound message first",
    });
  }
  if (!(isSelf(to) || isAllowed(to))) {
    return Promise.resolve({
      ok: false,
      error: `access denied: ${to} is not in the allowlist (add with /imessage allow ${to})`,
    });
  }
  const res = sendImessage(text, to);
  res.then((r) => {
    if (r.ok) {
      b.lastPeer = to;
      recordOutboundEcho(to, text);
    } else {
      b.lastError = `send to ${to} failed: ${r.error}`;
      note(b.lastError!, "error");
      persist();
    }
  });
  return res.then((r) => (r.ok ? { ...r, to } : r));
}

/* ------------------------------------------------------------------ */
/* global-todo skill: @task dispatch + outbox drain                    */
/* ------------------------------------------------------------------ */

/**
 * Drain the global-todo outbox: iMessage notifications queued by the hourly
 * loop and worker. The loop cannot send on its own — a send from a separate
 * process would arrive as an inbound self-echo row that could re-inject into
 * an agent; the bridge owns echo suppression, so the bridge does the sending.
 * Reuses doSend, so allowlist rules and outbound-echo recording apply.
 */
async function drainOutbox(): Promise<void> {
  if (b.drainBusy || !b.polling) return;
  b.drainBusy = true;
  try {
    for (const e of outboxEntries()) {
      const to = e.to === "self" ? (b.cfg.meHandles[0] ?? "") : e.to;
      if (!to || !(isSelf(to) || isAllowed(to))) {
        outboxDone(e.file); // unresolvable or not allowlisted: drop
        continue;
      }
      const r = await doSend(to, e.text);
      if (r.ok) outboxDone(e.file);
      else {
        outboxBump(e.file); // attempt recorded; retried on the next drain
        break; // stop at the first failure to preserve FIFO order
      }
    }
  } catch {
    /* fs/transient error: retry on the next tick */
  } finally {
    b.drainBusy = false;
  }
}

/**
 * Handle a `@task` inbound deterministically (no LLM turn consumed):
 *   @task           → list the queue
 *   @task list      → list the queue
 *   @task <text>    → add to the global store; the hourly loop picks it up
 */
async function handleTask(peer: string, text: string): Promise<void> {
  const body = text.replace(/^@task\b/, "").trim();
  const cmd = body.toLowerCase();
  const reply = (msg: string) => {
    void doSend(peer, msg).then((r) => {
      if (!r.ok) note(`@task reply failed: ${r.error}`, "error");
    });
  };
  if (!taskctlAvailable()) {
    reply(`todo system not installed (expected ${TASKCTL})`);
    return;
  }
  try {
    if (!body || cmd === "help" || cmd === "list" || cmd === "ls" || cmd === "status") {
      const res = await runTaskctl(["list"]);
      const tasks: any[] = res.tasks ?? [];
      const open = tasks.filter(
        (t) => t.status === "pending" || t.status === "in-progress",
      );
      const done = tasks.filter((t) => t.status === "done");
      if (open.length === 0 && done.length === 0) {
        reply("✅ No todos.");
        return;
      }
      const lines = open.map((t) => `${t.status === "in-progress" ? "⚡" : "•"} ${t.id}  ${t.title}`);
      reply(`✅ Todos — ${open.length} open, ${done.length} done:\n${lines.join("\n")}`);
      return;
    }
    const res = await runTaskctl([
      "add",
      body,
      "--source",
      "imessage",
      "--source-peer",
      isSelf(peer) ? "self" : peer,
    ]);
    if (!res.ok) {
      reply(`todo error: ${res.error ?? "unknown"}`);
      return;
    }
    reply(
      `✅ Todo ${res.task.id} queued: ${res.task.title} (${res.pendingCount} open). ` +
        `It runs on the hourly loop when the model is free; you'll get a text when it finishes.`,
    );
  } catch (e) {
    reply(`todo error: ${e instanceof Error ? e.message : String(e)}`);
  }
}

/* ------------------------------------------------------------------ */
/* commands                                                            */
/* ------------------------------------------------------------------ */

function statusText(): string {
  const lines: string[] = [];
  lines.push("pi-imessage");
  lines.push(`  db:        ${b.db ? "open" : "unavailable"}`);
  lines.push(`  watermark: ${b.db ? String(b.watermark) : "n/a"}`);
  lines.push(
    `  polling:   ${b.polling ? `on (every ${b.cfg.pollIntervalMs} ms)` : "off"}`,
  );
  lines.push(`  self:      ${b.cfg.meHandles.length ? b.cfg.meHandles.join(", ") : "(unknown — /imessage me)"}`);
  lines.push(
    `  allowlist: ${b.cfg.allowFrom.length ? b.cfg.allowFrom.join(", ") : "(empty — nothing is delivered)"}`,
  );
  lines.push(`  sending:   ${canSend() ? "available (osascript)" : "unavailable"}`);
  lines.push(`  config:    ${CONFIG_FILE}`);
  lines.push(`  denied log: ${DENIED_LOG_FILE}`);
  if (b.lastEvent)
    lines.push(`  last event: ${b.lastEvent.time} ${b.lastEvent.peer}: ${b.lastEvent.text}`);
  if (b.lastDenied)
    lines.push(`  last denied: ${b.lastDenied.time} ${b.lastDenied.peer}: ${b.lastDenied.text}`);
  if (b.lastError) lines.push(`  last error: ${b.lastError}`);
  return lines.join("\n");
}

function registerCommand(pi: ExtensionAPI): void {
  const subs = ["status", "poll", "allow", "unallow", "me", "send"];
  pi.registerCommand("imessage", {
    description: "iMessage bridge: status, polling, allowlist, identity, send",
    getArgumentCompletions: (p) => {
      const m = subs.filter((s) => s.startsWith(p.toLowerCase()));
      return m.length ? m.map((v) => ({ value: v, label: v })) : null;
    },
    handler: async (args, ctx) => {
      bindCtx(ctx);
      const parts = args.trim().split(/\s+/);
      const sub = (parts[0] ?? "status").toLowerCase();

      switch (sub) {
        case "status":
        case "": {
          note(statusText(), "info");
          break;
        }

        case "poll": {
          const arg = (parts[1] ?? "").toLowerCase();
          const next =
            arg === ""
              ? !b.cfg.pollingEnabled
              : arg === "on" || arg === "yes" || arg === "1";
          b.cfg.pollingEnabled = next;
          saveConfig(b.cfg);
          if (next) startPolling();
          else {
            stopPolling();
          }
          note(`polling ${next ? `enabled (every ${b.cfg.pollIntervalMs} ms)` : "disabled"}`);
          persist();
          break;
        }

        case "allow":
        case "unallow":
        case "remove": {
          const h = parts[1]?.trim();
          if (!h) {
            note("usage: /imessage " + (sub === "allow" ? "allow" : "unallow") + " <phone-or-email>", "warning");
            break;
          }
          if (sub === "allow") {
            if (!b.cfg.allowFrom.some((x) => sameHandle(x, h))) b.cfg.allowFrom.push(h);
            saveConfig(b.cfg);
            note(`${h} added to allowlist`);
          } else {
            b.cfg.allowFrom = b.cfg.allowFrom.filter((x) => !sameHandle(x, h));
            saveConfig(b.cfg);
            note(`${h} removed from allowlist`);
          }
          persist();
          break;
        }

        case "me": {
          const hs = parts.slice(1).map((x) => x.trim()).filter(Boolean);
          if (hs.length > 0) {
            b.cfg.meHandles = hs;
            note(`self identity set: ${hs.join(", ")}`);
          } else if (b.db) {
            const learned = learnSelf(b.db);
            const merged: string[] = [...b.cfg.meHandles];
            for (const h of [learned.phone, learned.email])
              if (h && !merged.some((x) => sameHandle(x, h))) merged.push(h);
            b.cfg.meHandles = merged;
            note(`self identity learned: ${merged.join(", ") || "(none found)"}`);
          } else {
            note("chat.db unavailable — cannot learn identity; pass handles explicitly", "warning");
          }
          saveConfig(b.cfg);
          persist();
          break;
        }

        case "send": {
          const to = parts[1]?.trim();
          const text = parts.slice(2).join(" ").trim();
          if (!to || !text) {
            note("usage: /imessage send <to> <text>", "warning");
            break;
          }
          const res = await doSend(to, text);
          note(res.ok ? `sent to ${res.to}: ${truncate(text, 80)}` : `send failed: ${res.error}`, res.ok ? "info" : "error");
          persist();
          break;
        }

        default: {
          note(
            "usage: /imessage [status | poll on|off | allow <h> | unallow <h> | me [h …] | send <to> <text>]",
            "info",
          );
        }
      }
    },
  });
}

/* ------------------------------------------------------------------ */
/* tool                                                                */
/* ------------------------------------------------------------------ */

function registerTool(pi: ExtensionAPI): void {
  pi.registerTool({
    name: "imessage_send",
    label: "iMessage Send",
    description:
      "Send a text iMessage via Messages.app to a phone number or Apple-ID e-mail. " +
      "Only allowlisted recipients are accepted (own identities always allowed). " +
      "Omit `to` to send to the peer of the most recent inbound iMessage.",
    promptSnippet:
      "Send iMessages to allowlisted peers; omit `to` to reply to the latest inbound iMessage peer.",
    parameters: Type.Object({
      text: Type.String({ description: "Message text to send.", minLength: 1 }),
      to: Type.Optional(
        Type.String({
          description:
            "Recipient phone number (e.g. +15551234567) or Apple-ID e-mail. " +
            "Omit to reply to the last inbound peer.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      bindCtx(ctx);
      const text = (params.text ?? "").trim();
      if (!text) {
        return { content: [{ type: "text" as const, text: "error: text is empty" }], details: {} };
      }
      const res = await doSend(params.to ?? null, text);
      if (!res.ok) {
        return {
          content: [{ type: "text" as const, text: `imessage_send failed: ${res.error}` }],
          details: { ok: false },
        };
      }
      note(`sent ${text.length}-char iMessage to ${res.to} via Messages.app`, "info");
      persist();
      return {
        content: [
          {
            type: "text" as const,
            text: `Sent ${text.length}-character iMessage to ${res.to}.`,
          },
        ],
        details: { ok: true, to: res.to, chars: text.length },
      };
    },
  });
}

/* ------------------------------------------------------------------ */
/* entry point                                                         */
/* ------------------------------------------------------------------ */

export default function (pi: ExtensionAPI): void {
  const cfg = loadConfig();
  b = {
    pi,
    cfg,
    db: null,
    watermark: 0,
    polling: false,
    timer: null,
    busy: false,
    drainBusy: false,
    ctx: null,
    lastPeer: null,
    lastEvent: null,
    lastDenied: null,
    lastError: null,
    outboundEchoes: [],
  };

  pi.on("session_start", (_event, ctx) => {
    bindCtx(ctx);
    setup();
  });
  pi.on("session_shutdown", () => teardown());

  registerCommand(pi);
  registerTool(pi);
}

export { loadConfig, saveConfig, defaultConfig, normHandle, sameHandle, normSet, CONFIG_FILE, type ImeConfig } from "./config";
export { open, close, isMacOS, chatDbPath, isAvailable, maxRowid, learnSelf, pollNew, chatHandles, isGroupChat, peerOf, appleDateToIso, type SqlDb, type InboundRow } from "./db";
export { canSend, sendImessage, type SendResult } from "./send";
export {
  runTaskctl,
  outboxEntries,
  outboxDone,
  outboxBump,
  taskctlAvailable,
  TODO_HOME,
  TASKCTL,
  OUTBOX_DIR,
  OUTBOX_DEAD,
  OUTBOX_MAX_TRIES,
  type OutboxEntry,
} from "./tasks";
export { dbAvailable };
