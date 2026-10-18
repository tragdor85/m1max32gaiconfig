import { mkdtempSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildFixture, SELF_PHONE, SELF_EMAIL, PEER_PHONE } from "./fixtures.mjs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-probe3-"));
const DB = path.join(tmp, "chat.db");
const fix = buildFixture(DB);
const mod = createJiti(import.meta.url, { fsCache: false, moduleCache: false })("../src/db.ts");
const db = mod.open(DB);
console.log("maxRowid:", mod.maxRowid(db), "fixture max:", fix.maxRowid);
console.log("self:", JSON.stringify(mod.learnSelf(db)));
const rows = mod.pollNew(db, 3);
for (const r of rows) {
  const grp = mod.isGroupChat(db, r);
  const peer = mod.peerOf(db, r, new Set([SELF_PHONE.toLowerCase(), SELF_EMAIL.toLowerCase()]));
  console.log("row", r.jrowid, "chat", r.chatId, "grp:", grp, "peer:", peer, "svcMsg:", r.isServiceMessage, "fromMe:", r.isFromMe, "text:", r.text);
}
