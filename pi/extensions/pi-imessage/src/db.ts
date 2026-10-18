import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";
import { normHandle } from "./config.ts";

type SqlDb = InstanceType<typeof Database>;
export type { SqlDb };

const DB_PATH: string = process.env.PI_IMESSAGE_DB || path.join(os.homedir(), "Library", "Messages", "chat.db");

let conn: SqlDb | null = null;

export function isMacOS(): boolean {
  return process.platform === "darwin";
}

export function chatDbPath(): string {
  return DB_PATH;
}

export function isAvailable(): boolean {
  return isMacOS() && fs.existsSync(DB_PATH);
}

/** Open (and cache) a read-only connection to chat.db. Returns null when unavailable. */
export function open(): SqlDb | null {
  if (conn) return conn;
  if (process.platform !== "darwin" || !fs.existsSync(DB_PATH)) return null;
  try {
    conn = new Database(DB_PATH, { readonly: true, fileMustExist: true });
    // Extra belt-and-braces: never write, even by accident.
    conn.pragma("query_only = TRUE");
    return conn;
  } catch {
    conn = null;
    return null;
  }
}

export function close(): void {
  try {
    conn?.close();
  } catch {
    /* ignore */
  }
  conn = null;
}

/** Watermark: newest row in chat_message_join (one row per added message). */
export function maxRowid(d: SqlDb): number {
  const r = d.prepare("SELECT MAX(rowid) AS m FROM chat_message_join").get() as { m: number | null } | undefined;
  return typeof r?.m === "number" ? r.m : 0;
}

/**
 * Learn own identity from sent messages:
 *  - phone: account "P:..." on any sent message
 *  - email: account "E:..." on sent iMessages
 * (Matches how the original package learned the owner's address at startup.)
 */
export function learnSelf(d: SqlDb): { phone: string | null; email: string | null } {
  const strip = (acct: string, tag: string): string | null => {
    let a = acct;
    if (a.startsWith("iMessage:")) a = a.slice("iMessage:".length); // "iMessage:P:..."
    if (a.startsWith(tag)) a = a.slice(tag.length);
    return a.trim() || null;
  };
  let phone: string | null = null;
  let email: string | null = null;
  try {
    // Most frequent account on sent rows ("P:<phone>" / "E:<email>",
    // sometimes prefixed with "iMessage:").
    const p = d
      .prepare(
        "SELECT account FROM message WHERE is_from_me = 1 AND (account LIKE 'P:%' OR account LIKE 'iMessage:P:%') GROUP BY account ORDER BY COUNT(*) DESC LIMIT 1",
      )
      .get() as { account: string | null } | undefined;
    if (p?.account) phone = strip(String(p.account), "P:");
    const e = d
      .prepare(
        "SELECT account FROM message WHERE is_from_me = 1 AND service = 'iMessage' AND (account LIKE 'E:%' OR account LIKE 'iMessage:E:%') GROUP BY account ORDER BY COUNT(*) DESC LIMIT 1",
      )
      .get() as { account: string | null } | undefined;
    if (e?.account) email = strip(String(e.account), "E:");
  } catch {
    /* schema drift — leave null */
  }
  return { phone, email };
}

export interface InboundRow {
  /** chat_message_join.rowid — the watermark key. */
  jrowid: number;
  chatId: number;
  chatIdentifier: string | null;
  service: string | null;
  text: string | null;
  /** seconds since 2001-01-01 00:00:00 UTC */
  date: number | null;
  isFromMe: number;
  itemType: number;
  isEmpty: number;
  isServiceMessage: number;
  isSystemMessage: number;
  replace: number;
  /** handle.id of the sender (is_from_me=0), else the recipient handle (is_from_me=1). */
  senderHandle: string | null;
}

const POLL_SQL = `
  SELECT cmj.rowid          AS jrowid,
         cmj.chat_id        AS chatId,
         c.chat_identifier  AS chatIdentifier,
         m.service          AS service,
         m.text             AS text,
         m.date             AS date,
         m.is_from_me       AS isFromMe,
         m.item_type        AS itemType,
         m.is_empty         AS isEmpty,
         m.is_service_message AS isServiceMessage,
         m.is_system_message  AS isSystemMessage,
         m.replace          AS replace,
         h.id               AS senderHandle
    FROM chat_message_join cmj
    JOIN message m ON m.rowid = cmj.message_id
    JOIN chat c    ON c.rowid = cmj.chat_id
    LEFT JOIN handle h ON h.rowid = m.handle_id
   WHERE cmj.rowid > ?
   ORDER BY cmj.rowid ASC
   LIMIT ?`;

export function pollNew(d: SqlDb, afterRowid: number, limit = 500): InboundRow[] {
  const rows = d.prepare(POLL_SQL).all(afterRowid, limit) as Record<string, any>[];
  return rows.map((r) => ({
    jrowid: Number(r.jrowid),
    chatId: Number(r.chatId),
    chatIdentifier: typeof r.chatIdentifier === "string" ? r.chatIdentifier : null,
    service: typeof r.service === "string" ? r.service : null,
    text: typeof r.text === "string" ? r.text : null,
    date: typeof r.date === "number" ? r.date : null,
    isFromMe: Number(r.isFromMe ?? 0),
    itemType: Number(r.itemType ?? -1),
    isEmpty: Number(r.isEmpty ?? 0),
    isServiceMessage: Number(r.isServiceMessage ?? 0),
    isSystemMessage: Number(r.isSystemMessage ?? 0),
    replace: Number(r.replace ?? 0),
    senderHandle: typeof r.senderHandle === "string" ? r.senderHandle : null,
  }));
}

function chatHandleCount(d: SqlDb, chatId: number): number {
  const r = d.prepare("SELECT COUNT(*) AS n FROM chat_handle_join WHERE chat_id = ?").get(chatId) as
    | { n: number }
    | undefined;
  return typeof r?.n === "number" ? r.n : 0;
}

export function chatHandles(d: SqlDb, chatId: number): string[] {
  const rows = d
    .prepare("SELECT h.id FROM chat_handle_join chj JOIN handle h ON h.rowid = chj.handle_id WHERE chj.chat_id = ?")
    .all(chatId) as { id: string }[];
  return rows.map((r) => String(r.id));
}

/**
 * Conservative group detection.
 * Modern macOS: group chats use "chatNNN" identifiers (3+ handles).
 * Legacy macOS: identifiers like "iMessage;+;chatNNN" mark groups.
 * Everything else with 3+ attached handles is treated as a group too.
 * (This extension has no group support by design.)
 */
export function isGroupChat(d: SqlDb, r: InboundRow): boolean {
  const id = r.chatIdentifier ?? "";
  if (id.includes(";+;")) return true;
  if (/^chat\d+$/i.test(id)) return true;
  return chatHandleCount(d, r.chatId) >= 3;
}

/**
 * Identify the single address of a 1:1 chat (the "peer").
 *  - Prefers the chat's attached handle set: a DM has exactly one non-own
 *    handle; a self-chat's handles are all own → the lone handle is self.
 *  - Falls back to the row's sender/recipient handle (is_from_me=0), then the
 *    raw address inside the chat identifier (modern form, or legacy tail).
 */
export function peerOf(d: SqlDb, r: InboundRow, selfSet: Set<string>): string | null {
  const handles = chatHandles(d, r.chatId);
  if (handles.length > 0 && selfSet.size > 0) {
    const others = handles.filter((h) => !selfSet.has(normHandle(h)));
    if (others.length === 1) return others[0]; // 1:1 DM → the other party
    if (others.length === 0 && handles.length === 1) return handles[0]; // self-chat
  }

  if (handles.length <= 1 && r.isFromMe === 0 && r.senderHandle) return r.senderHandle;

  const id = (r.chatIdentifier ?? "").trim();
  if (id) {
    let last = id.includes(";") ? id.split(";").pop() ?? id : id;
    if (!id.includes(";") && /^(SMS|IMSG):/i.test(last)) last = last.split(":").pop() ?? last;
    // Only accept genuine addresses: emails, or numeric (optionally + -prefixed) phone tails.
    if (typeof last === "string" && last.length > 0) {
      if (last.includes("@") && !last.includes(" ")) return last;
      if (/^\+?\d{7,}$/.test(last)) return last;
    }
    if (handles.length === 1) return handles[0];
  }
  return null;
}

/** Resolve a handle rowid to its address value (phone/email), or null. */
export function handleValue(d: SqlDb, rowid: number | null | undefined): string | null {
  if (rowid === null || rowid === undefined) return null;
  const r = d.prepare("SELECT id FROM handle WHERE rowid = ?").get(rowid) as { id: string } | undefined;
  return r ? String(r.id) : null;
}

/** 2001-01-01T00:00:00Z in unix seconds (Apple's legacy timestamp epoch). */
const APPLE_EPOCH = 978307200;

/**
 * message.date has used more than one encoding across macOS versions:
 * older systems store whole seconds since 2001-01-01; modern ones store
 * integer nanoseconds (observed in the wild: 809187336256532000 =
 * 2026-08-23T14:15:36Z). Auto-detect the scale by magnitude, and return
 * null for anything unrepresentable so callers fall back gracefully.
 */
export function appleDateToIso(raw: number | null | undefined): string | null {
  if (typeof raw !== "number" || !Number.isFinite(raw)) return null;
  const v = Math.abs(raw);
  let sec: number;
  if (v < 1e10) sec = raw; // whole seconds (2001 → ~2286 CE)
  else if (v < 1e13) sec = raw / 1e3; // milliseconds
  else if (v < 1e16) sec = raw / 1e6; // microseconds
  else if (v < 1e19) sec = raw / 1e9; // nanoseconds (modern macOS)
  else return null; // out of any known range — garbage
  const t = new Date((sec + APPLE_EPOCH) * 1000);
  return Number.isNaN(t.getTime()) ? null : t.toISOString();
}
