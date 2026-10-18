// test/real.test.mjs — smoke tests against the REAL chat.db (read-only, WAL-safe).
// Run: node test/real.test.mjs
//
// Verifies the schema assumptions (learnSelf, watermark init, group detection)
// hold on the user's actual database. Skips cleanly if the real DB is unavailable.

import assert from "node:assert";
import { existsSync, readFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const realDbPath = path.join(os.homedir(), "Library/Messages/chat.db");
if (!existsSync(realDbPath)) {
  console.log("real.test: skipped (no real chat.db)");
  process.exit(0);
}

import { createRequire } from "node:module";
import { createJiti } from "jiti";

createRequire(import.meta.url)("better-sqlite3"); // resolve native binding up front
const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const mod = jiti("../src/index.ts");
const { open, close, learnSelf, pollNew, maxRowid, isGroupChat, sameHandle, chatHandles } = mod;

const db = open();
if (!db) {
  console.log("real.test: skipped (could not open real chat.db read-only)");
  process.exit(0);
}

try {
  // --- learnSelf against real data
  const self = learnSelf(db);
  console.log("learnSelf:", JSON.stringify(self));
  assert.ok(self.phone, "real phone handle present");
  assert.match(self.phone, /^\+\d{8,}$/, "real phone looks like +1...");
  assert.ok(self.email, "real email handle present (E: account on sent iMessages)");

  // Cross-check the learned identity against the user's configured identity,
  // if a pre-existing config exists (leftover from the original package).
  const knownPath = path.join(os.homedir(), ".pi/agent/imessage/config.json");
  if (existsSync(knownPath)) {
    const known = JSON.parse(readFileSync(knownPath, "utf8"));
    const candidates = [known.primaryHandle, known.primaryIdentifier].filter(Boolean);
    for (const c of candidates) {
      const match = (self.phone && sameHandle(self.phone, c)) || (self.email && sameHandle(self.email, c));
      assert.ok(match, `learnSelf must match configured identity ${c}`);
    }
  }

  // --- watermark: fresh polling starts at MAX(ROWID)
  const max = maxRowid(db);
  console.log("max rowid (watermark):", max);
  assert.ok(max > 100_000, "populated DB has many chat_message_join rows");
  const all = pollNew(db, 0, 10_000_000);
  assert.ok(all.length > 0, "rows found from rowid 0");
  assert.strictEqual(all[all.length - 1].jrowid, max, "last row == max rowid");
  const above = pollNew(db, max, 100);
  assert.strictEqual(above.length, 0, "nothing above the init watermark");

  // --- group detection on real rows: one style-43 (group) row, one style-45 (DM) row
  const latestRowForChat = (chatId) =>
    db
      .prepare(
        `SELECT cmj.rowid AS jrowid, cmj.chat_id AS chatId, c.chat_identifier AS chatIdentifier
           FROM chat_message_join cmj JOIN chat c ON c.rowid = cmj.chat_id
          WHERE cmj.chat_id = ?
          ORDER BY cmj.rowid DESC LIMIT 1`,
      )
      .get(chatId);
  const oneChatOfStyle = (style) =>
    db
      .prepare(
        `SELECT chat.rowid AS c FROM chat WHERE chat.style = ?
           ORDER BY (SELECT COUNT(*) FROM chat_handle_join chj WHERE chj.chat_id = chat.rowid) DESC
          LIMIT 1`,
      )
      .get(style)?.c;

  const groupChat = oneChatOfStyle(43);
  const dmChat = oneChatOfStyle(45);
  const cases = [];
  if (groupChat) {
    const row = latestRowForChat(groupChat);
    if (row) cases.push([row, true, `group chat ${groupChat} (style 43, ${chatHandles(db, groupChat).length} handles)`]);
  }
  if (dmChat) {
    const row = latestRowForChat(dmChat);
    if (row) cases.push([row, false, `DM/self chat ${dmChat} (style 45, ${chatHandles(db, dmChat).length} handles)`]);
  }
  assert.ok(cases.length >= 1, "found at least one real chat with messages");
  for (const [row, expected, label] of cases) {
    assert.strictEqual(isGroupChat(db, row), expected, label);
  }
  console.log("isGroupChat real cases:", cases.map((c) => `${c[0].jrowid}->${c[1]} (${c[2]})`).join(" | "));

  console.log("real.test: all assertions passed ✔");
} finally {
  close();
}
