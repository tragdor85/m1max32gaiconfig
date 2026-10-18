// Unit tests for src/db.ts + src/config.ts against a fixture chat.db.
import { strict as assert } from "node:assert";
import { mkdtempSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import { buildFixture, SELF_PHONE, SELF_EMAIL, PEER_PHONE, OTHER_PHONE, APPLE_T } from "./fixtures.mjs";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-imei-db-"));
const FIX = path.join(tmp, "chat.db");
const ids = buildFixture(FIX);
const CFG = path.join(tmp, "config.json");
writeFileSync(CFG, JSON.stringify({ meHandles: [SELF_PHONE, SELF_EMAIL], allowFrom: [PEER_PHONE] }));

process.env.PI_IMESSAGE_DB = FIX;
process.env.PI_IMESSAGE_CONFIG = CFG;

const jiti = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const dbmod = jiti("../src/db.ts");
const cfgmod = jiti("../src/config.ts");

/* config */
{
  assert.equal(cfgmod.CONFIG_FILE, CFG);
  const c = cfgmod.loadConfig();
  assert.deepEqual(c.meHandles, [SELF_PHONE, SELF_EMAIL]);
  assert.deepEqual(c.allowFrom, [PEER_PHONE]);
  assert.equal(c.pollingEnabled, false);

  assert.equal(cfgmod.normHandle("  +1 555 1234567 "), "+15551234567");
  assert.equal(cfgmod.normSet(["A B"]).has("ab"), true);
  assert.equal(cfgmod.sameHandle("+155-5123-0001", "+15551230001"), true); // last-10 match
  assert.equal(cfgmod.sameHandle("5551230001", SELF_PHONE), true); // digits-only match
  assert.equal(cfgmod.sameHandle("a@x.com", "a@y.com"), false);
  assert.equal(cfgmod.sameHandle("5551234567", PEER_PHONE), true); // digits-only, no + / country code
  assert.equal(cfgmod.sameHandle(SELF_EMAIL, "TEST@EXAMPLE.COM"), true);
}

/* db core */
{
  assert.equal(dbmod.chatDbPath(), FIX);
  assert.equal(dbmod.isAvailable(), true);
  const d = dbmod.open();
  assert.ok(d, "open() should succeed for fixture");
  assert.equal(dbmod.open(), d, "open() is cached");

  const max = dbmod.maxRowid(d);
  assert.equal(max, 6, "fixture has 6 cmj rows");

  // learnSelf from fixture accounts (P: phone x3, E: email x1)
  const learned = dbmod.learnSelf(d);
  assert.equal(learned.phone, SELF_PHONE);
  assert.equal(learned.email, SELF_EMAIL);

  // appleDateToIso: scale auto-detection (legacy seconds, modern ns, garbage)
  assert.equal(dbmod.appleDateToIso(380), "2001-01-01T00:06:20.000Z", "seconds since 2001");
  assert.equal(dbmod.appleDateToIso(750_000_000).slice(0, 4), "2024", "seconds bucket");
  // one instant, three encodings (real-DB value observed 2026-08-23T14:15:36Z)
  assert.match(dbmod.appleDateToIso(809_187_336_256), /^2026-08-23T14:15:3[56]/, "ms encoding");
  assert.match(dbmod.appleDateToIso(809_187_336_256_000), /^2026-08-23T14:15:3[56]/, "us encoding");
  assert.match(dbmod.appleDateToIso(809_187_336_256_532_000), /^2026-08-23T14:15:3[56]/, "ns encoding");
  // garbage / unrepresentable → null (callers fall back to new Date())
  assert.equal(dbmod.appleDateToIso(null), null);
  assert.equal(dbmod.appleDateToIso(undefined), null);
  assert.equal(dbmod.appleDateToIso(NaN), null);
  assert.equal(dbmod.appleDateToIso(Infinity), null);
  assert.equal(dbmod.appleDateToIso(-1e20), null);

  dbmod.close();
  assert.equal(dbmod.open() === dbmod.open(), true, "reopen after close ok");
}

/* pollNew */
{
  const d = dbmod.open();
  const all = dbmod.pollNew(d, 0);
  // pollNew returns raw candidate rows (all 6); delivery filters live in index.ts handleRow.
  assert.equal(all.length, 6, `pollNew returns every new cmj row, got ${all.length}`);
  assert.deepEqual(all.map((r) => r.jrowid), [1, 2, 3, 4, 5, 6], "insertion order");
  assert.equal(all[3].text, "hello", "row 4 is the inbound hello (selfOut, mail, selfOut2 precede)");
  for (let i = 1; i < all.length; i++) assert.ok(all[i].jrowid > all[i - 1].jrowid, "ascending order");

  const hello = all.find((r) => r.jrowid === ids.rowids.hello);
  assert.equal(hello.chatIdentifier, PEER_PHONE, "DM identifier is the peer's own address");
  assert.equal(hello.text, "hello");
  assert.equal(hello.isFromMe, 0);
  assert.equal(hello.itemType, 0);
  assert.equal(hello.service, "iMessage");
  assert.equal(hello.senderHandle, PEER_PHONE, "h.id carries the sender address");
  assert.equal(dbmod.appleDateToIso(hello.date), dbmod.appleDateToIso(APPLE_T));

  const scoped = dbmod.pollNew(d, ids.rowids.selfOut);
  assert.ok(!scoped.some((r) => r.jrowid <= ids.rowids.selfOut), "watermark is exclusive");

  assert.deepEqual(dbmod.pollNew(d, dbmod.maxRowid(d)), [], "watermark=head → nothing new");
}

/* group detection */
{
  const d = dbmod.open();
  const all = dbmod.pollNew(d, 0);
  const gr = all.find((r) => r.jrowid === ids.rowids.group);
  const dm = all.find((r) => r.jrowid === ids.rowids.hello);
  const selfRow = { ...dm, chatId: ids.chatSelf, chatIdentifier: SELF_PHONE, isFromMe: 1, senderHandle: SELF_PHONE };
  assert.equal(dbmod.isGroupChat(d, gr), true, "chatNNN identifier → group (3 handles)");
  assert.equal(dbmod.isGroupChat(d, dm), false, "DM is not a group");
  assert.equal(dbmod.isGroupChat(d, selfRow), false, "self-chat is not a group");

  // sender-address style group identifier (legacy macOS)
  const legacyGrp = { ...gr, chatId: 4, chatIdentifier: "P:" + PEER_PHONE + ";+;chat9" };
  assert.equal(dbmod.isGroupChat(d, legacyGrp), true, ";+; identifier → group");
}

/* peerOf */
{
  const d = dbmod.open();
  const selfSet = cfgmod.normSet([SELF_PHONE, SELF_EMAIL]);
  const all = dbmod.pollNew(d, 0);
  const dmRow = all.find((r) => r.jrowid === ids.rowids.hello);
  const grRow = all.find((r) => r.jrowid === ids.rowids.group);
  const selfRow = { ...dmRow, chatId: ids.chatSelf, chatIdentifier: SELF_PHONE, isFromMe: 1, senderHandle: SELF_PHONE };

  assert.equal(dbmod.peerOf(d, dmRow, selfSet), PEER_PHONE, "DM → peer handle");
  assert.equal(dbmod.peerOf(d, selfRow, selfSet), SELF_PHONE, "self-chat → own handle");
  // Group: 2+ others → no single peer (null) — caller gated on isGroupChat first.
  assert.equal(dbmod.peerOf(d, grRow, selfSet), null);

  // Self absent from selfSet → DM peer still found via sender-handle fallback.
  assert.equal(dbmod.peerOf(d, dmRow, new Set()), PEER_PHONE);

  // No identity + no handle info → identifier address is the last resort.
  const fakeRow = { ...dmRow, senderHandle: null, chatId: -1 };
  assert.equal(dbmod.peerOf(d, fakeRow, new Set()), PEER_PHONE, "identifier fallback");

  // Unknown chat, no identifier, no sender → null
  const ghost = { ...dmRow, chatId: -1, chatIdentifier: null, senderHandle: null };
  assert.equal(dbmod.peerOf(d, ghost, new Set()), null);
}

/* other numbers are NOT self */
assert.equal(cfgmod.sameHandle(PEER_PHONE, SELF_PHONE), false);
assert.equal(cfgmod.sameHandle(OTHER_PHONE, SELF_PHONE), false);

console.log("db.test: all assertions passed \u2714");
