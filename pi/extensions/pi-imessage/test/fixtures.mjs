// Build a fixture chat.db (schema-compatible subset) for deterministic tests.
// Column placement mirrors the REAL macOS chat.db: filter flags live in
// `message`; `chat_message_join` is slim (chat_id, message_id, message_date,
// index_state, filter_action, filter_sub_action).
import Database from "better-sqlite3";
import { rmSync } from "node:fs";

export const SELF_PHONE = "+15551230001";
export const SELF_EMAIL = "test@example.com";
export const PEER_PHONE = "+15551234567";
export const OTHER_PHONE = "+15559876543";

// Modern macOS stores message.date as integer nanoseconds since 2001-01-01
// (older systems used whole seconds; appleDateToIso auto-detects the scale).
export const APPLE_T = 787_000_000 * 1e9; // ≈ 2025-12-09

export function buildFixture(dbPath) {
  rmSync(dbPath, { force: true });
  const db = new Database(dbPath);
  db.pragma("journal_mode = WAL");

  db.exec(`
    CREATE TABLE handle(
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL,
      service TEXT,
      uncanonicalized_id TEXT
    );
    CREATE TABLE message(
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      guid TEXT,
      service TEXT,
      account TEXT,
      text BLOB,
      date INTEGER,
      is_from_me INTEGER,
      item_type INTEGER,
      is_empty INTEGER,
      is_service_message INTEGER,
      is_system_message INTEGER,
      replace INTEGER,
      handle_id INTEGER
    );
    CREATE TABLE chat(
      rowid INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_identifier TEXT,
      style INTEGER
    );
    CREATE TABLE chat_message_join(
      ROWID INTEGER PRIMARY KEY AUTOINCREMENT,
      chat_id INTEGER,
      message_id INTEGER,
      message_date INTEGER,
      index_state INTEGER,
      filter_action INTEGER,
      filter_sub_action INTEGER
    );
    CREATE TABLE chat_handle_join(
      chat_id INTEGER,
      handle_id INTEGER
    );
  `);

  const insH = db.prepare("INSERT INTO handle (id, service, uncanonicalized_id) VALUES (?, ?, ?)");
  const insM = db.prepare(
    `INSERT INTO message (guid, service, account, text, date, is_from_me, item_type, is_empty,
                          is_service_message, is_system_message, replace, handle_id)
     VALUES (?, 'iMessage', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  );
  const insC = db.prepare("INSERT INTO chat (chat_identifier, style) VALUES (?, ?)");
  const insChj = db.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
  const insCmj = db.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id, message_date, index_state, filter_action, filter_sub_action) VALUES (?, ?, ?, 0, 0, 0)",
  );

  const hSelf = insH.run(SELF_PHONE, "iMessage", SELF_PHONE).lastInsertRowid;
  const hPeer = insH.run(PEER_PHONE, "iMessage", PEER_PHONE).lastInsertRowid;
  const insOther = insH.run(OTHER_PHONE, "iMessage", OTHER_PHONE).lastInsertRowid;

  const chatPeer = insC.run(PEER_PHONE, 45).lastInsertRowid;
  insChj.run(chatPeer, hPeer);
  const chatSelf = insC.run(SELF_PHONE, 45).lastInsertRowid;
  insChj.run(chatSelf, hSelf);
  const chatGroup = insC.run("chat12345", 43).lastInsertRowid;
  insChj.run(chatGroup, hSelf);
  insChj.run(chatGroup, hPeer);
  insChj.run(chatGroup, insOther);

  // 1:1 (self-chat) outbound from self — echo candidate
  const mSelfOut = insM.run("g-selfout", "iMessage:P:" + SELF_PHONE, "self note", APPLE_T, 1, hSelf).lastInsertRowid;
  const cmjSelfOut = insCmj.run(chatSelf, mSelfOut, APPLE_T).lastInsertRowid;
  // Outbound sent iMessage on an E: account (identifies own email)
  const mMail = insM.run("g-mail", "iMessage:E:" + SELF_EMAIL, "mail note", APPLE_T, 1, hSelf).lastInsertRowid;
  const cmjMail = insCmj.run(chatSelf, mMail, APPLE_T).lastInsertRowid;
  // Second sent P: row so the self phone wins the frequency tie-break
  const mSelfOut2 = insM.run("g-selfout2", "iMessage:P:" + SELF_PHONE, "another self note", APPLE_T, 1, hSelf).lastInsertRowid;
  const cmjSelfOut2 = insCmj.run(chatSelf, mSelfOut2, APPLE_T).lastInsertRowid;
  // Inbound DM from peer
  const mHello = insM.run("g-hello", "iMessage:P:" + PEER_PHONE, "hello", APPLE_T, 0, hPeer).lastInsertRowid;
  const cmjHello = insCmj.run(chatPeer, mHello, APPLE_T).lastInsertRowid;
  // Service message (is_service_message) from self
  const mSvc = insM.run("g-svc", "iMessage:P:" + SELF_PHONE, "chat renamed", APPLE_T, 1, hSelf).lastInsertRowid;
  const cmjSvc = insCmj.run(chatSelf, mSvc, APPLE_T).lastInsertRowid;
  db.prepare("UPDATE message SET is_service_message = 1 WHERE ROWID = ?").run(mSvc);
  // Group message from peer
  const mGrp = insM.run("g-grp", "iMessage:P:" + PEER_PHONE, "group hello", APPLE_T, 0, hPeer).lastInsertRowid;
  const cmjGrp = insCmj.run(chatGroup, mGrp, APPLE_T).lastInsertRowid;

  db.close();
  return {
    maxRowid: Math.max(cmjGrp, cmjMail, cmjSelfOut2), // fixture watermark = last cmj rowid
    chatPeer, chatSelf, chatGroup,
    hSelf, hPeer, hOther: insOther,
    rowids: { selfOut: cmjSelfOut, mail: cmjMail, selfOut2: cmjSelfOut2, hello: cmjHello, svc: cmjSvc, group: cmjGrp },
  };
}
