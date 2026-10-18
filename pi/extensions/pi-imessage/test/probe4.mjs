import { mkdtempSync, writeFileSync, chmodSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildFixture, SELF_PHONE, SELF_EMAIL, PEER_PHONE, OTHER_PHONE } from "./fixtures.mjs";
import Database from "better-sqlite3";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-probe4-"));
const DB = path.join(tmp, "chat.db");
buildFixture(DB);
writeFileSync(path.join(tmp, "cfg.json"), "{}");

const mod = createJiti(import.meta.url, { fsCache: false, moduleCache: false })("../src/db.ts");
const db = mod.open(DB);
const ins = new Database(DB);
const r = ins.prepare(
  `INSERT INTO chat_message_join (chat_id, message_id, stevedraw_handle_id, item_type, is_from_me, is_empty, is_group_chats, is_broadcast)
   SELECT 1, (SELECT ROWID FROM message WHERE text = 'hello'), (SELECT ROWID FROM handle WHERE value = ?), 0, 0, 0, 0, 0`,
).run(PEER_PHONE);
console.log("inserted rowid:", r.lastInsertRowid);
console.log("direct MAX(ROWID):", ins.prepare("SELECT MAX(ROWID) m FROM chat_message_join").get().m);
console.log("pollNew rows>13:", mod.pollNew(db, 13).length);
db.close();
