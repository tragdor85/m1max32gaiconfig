// Integration test: full extension factory against a fixture chat.db.
// Mocks the pi ExtensionAPI; verifies boot, polling, inbound delivery,
// echo suppression, denial, access control, config round-trips and sending.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, chmodSync, readFileSync, mkdirSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";
import Database from "better-sqlite3";
import {
  buildFixture, SELF_PHONE, SELF_EMAIL, PEER_PHONE, OTHER_PHONE, APPLE_T,
} from "./fixtures.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-imei-bridge-"));
const DB = path.join(tmp, "chat.db");
const CFG = path.join(tmp, "config.json");
const FAKE_SEND = path.join(tmp, "fake-send.sh");
const SEND_LOG = path.join(tmp, "send-log");

buildFixture(DB);
writeFileSync(CFG, JSON.stringify({
  meHandles: [SELF_PHONE, SELF_EMAIL],
  allowFrom: [PEER_PHONE],
  pollingEnabled: false,
  pollIntervalMs: 25,
}));
writeFileSync(FAKE_SEND, `#!/bin/sh
printf '%s\\n' "$1| $2" >> ${SEND_LOG}
exit 0
`);
chmodSync(FAKE_SEND, 0o755);

process.env.PI_IMESSAGE_DB = DB;
process.env.PI_IMESSAGE_CONFIG = CFG;
process.env.PI_IMESSAGE_SEND_CMD = FAKE_SEND;
process.env.PI_TODO_HOME = path.join(tmp, "todos"); // scratch global-todo store

const mod = createJiti(import.meta.url, { fsCache: false, moduleCache: false })("../src/index.ts");

/* --- mock api ------------------------------------------------------ */
const notes = [];
let idle = true;
const ctx = {
  isIdle: () => idle,
  hasUI: true,
  ui: { notify: (m, t) => notes.push([String(m), t]) },
};
const sent = [];
const api = {
  handlers: {},
  on(ev, fn) { this.handlers[ev] = fn; },
  commands: {},
  registerCommand(name, def) { this.commands[name] = def; },
  tools: {},
  registerTool(def) { this.tools[def.name] = def; },
  sendUserMessage(msg, opts) { sent.push({ msg: String(msg), opts }); },
  appended: [],
  appendEntry(kind, data) { this.appended.push([kind, data]); },
  getSessionId: () => "test-session",
};

mod.default(api);

/* --- boot ---------------------------------------------------------- */
await api.handlers.session_start(undefined, ctx);

const notesFlat = () => notes.map((n) => n[0]);
const readyNote = notesFlat().find((n) => n.includes("ready —"));
assert.ok(readyNote, "ready note printed");
assert.match(readyNote, /watermark \d+/, "watermark reported");
assert.match(readyNote, /polling off/, "polling off by default");

/* status sub-command */
const statusBlock = async () => {
  await api.commands.imessage.handler("status", ctx);
  const blocks = notesFlat().filter((n) => n.includes("  db:"));
  return blocks[blocks.length - 1];
};
let status = await statusBlock();
assert.ok(status.includes("polling:   off"), "status shows polling off");
assert.match(status, /allowlist: \+15551234567/, "allowlist shown");
assert.match(status, /self:.*\+15551230001/s, "self phone known");

/* enable polling */
await api.commands.imessage.handler("poll on", ctx);
assert.ok(notesFlat().find((n) => n.includes("polling enabled (every 25 ms)")), "polling enabled note");
status = await statusBlock();
assert.match(status, /polling:\s+on \(every 25 ms\)/, "status shows polling on");

/* --- inbound: denied / echo / deliver / group ----------------------- */
{
  const dbw = new Database(DB);
  const insH = dbw.prepare("INSERT INTO handle (id, service, uncanonicalized_id) VALUES (?, ?, ?)");
  const hOther = insH.run(OTHER_PHONE, "iMessage", OTHER_PHONE).lastInsertRowid;
  const insC = dbw.prepare("INSERT INTO chat (chat_identifier, style) VALUES (?, ?)");
  const insChj = dbw.prepare("INSERT INTO chat_handle_join (chat_id, handle_id) VALUES (?, ?)");
  const insM = dbw.prepare(
    `INSERT INTO message (guid, service, account, text, date, is_from_me, item_type, is_empty,
                          is_service_message, is_system_message, replace, handle_id)
     VALUES (?, 'iMessage', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  );
  const insCmj = dbw.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id, message_date, index_state, filter_action, filter_sub_action) VALUES (?, ?, ?, 0, 0, 0)",
  );

  const chatOther = insC.run(OTHER_PHONE, 45).lastInsertRowid;
  insChj.run(chatOther, hOther);
  const chatPeer = 1, chatGroup = 3, hPeer = 2;

  const rowOf = (chat, acct, text, fromMe, h) => {
    const m = insM.run("t-" + Math.random(), "iMessage:acct".replace("iMessage:acct", acct), text, APPLE_T, fromMe, h).lastInsertRowid;
    return insCmj.run(chat, m, APPLE_T).lastInsertRowid;
  };
  const rDeny = rowOf(chatOther, "iMessage:P:" + OTHER_PHONE, "intruder", 0, hOther);
  const rOwn = rowOf(chatPeer, "iMessage:P:" + SELF_PHONE, "agent sent", 1, 1);
  const rIn = rowOf(chatPeer, "iMessage:P:" + PEER_PHONE, "hello again", 0, hPeer);
  const rGrp = rowOf(chatGroup, "iMessage:P:" + PEER_PHONE, "group again", 0, hPeer);

  await sleep(120); // ~5 poll ticks
  dbw.close();


  assert.equal(sent.length, 1, "exactly one inbound delivered (deny/echo/group suppressed)");
  assert.match(sent[0].msg, /^\[iMessage from \+15551234567 @ [^\]]+\] hello again$/, "inbound framing");
  assert.ok(!notesFlat().find((n) => n.includes("denied inbound from")), "denial not printed to console");
  const denied = readFileSync(path.join(tmp, "denied.log"), "utf8").trim().split("\n").map((l) => JSON.parse(l));
  assert.ok(denied.some((l) => l.peer === OTHER_PHONE && l.text.includes("intruder")), "denial logged to denied.log");

  status = await statusBlock();
  assert.match(status, /last denied: .* \+15559876543/, "status still shows last denial");
  const wm = Number(/watermark:\s+(\d+)/.exec(status)[1]);
  assert.ok(wm >= Math.max(rDeny, rOwn, rIn, rGrp), "watermark advanced past all rows");
}

/* --- allow/unallow + me -------------------------------------------- */
{
  const h = api.commands.imessage.handler;
  await h(`unallow ${PEER_PHONE}`, ctx);
  status = await statusBlock();
  assert.match(status, /allowlist: \(empty/, "peer removed from allowlist");

  await h(`allow ${OTHER_PHONE}`, ctx);
  const cfg = JSON.parse(readFileSync(CFG, "utf8"));
  assert.ok(cfg.allowFrom.includes(OTHER_PHONE), "allow persisted to config file");
  assert.ok(!cfg.allowFrom.includes(PEER_PHONE), "unallow persisted");

  await h("me", ctx);
  const meNote = notesFlat().find((n) => n.includes("self handles")) ?? notesFlat().find((n) => /\+15551230001/.test(n));
  assert.ok(meNote, "me sub-command reports identity");
  await h(`me ${SELF_PHONE} ${SELF_EMAIL}`, ctx);
}

/* --- outbound send -------------------------------------------------- */
{
  await api.commands.imessage.handler(`allow ${PEER_PHONE}`, ctx); // outbound gated on allowlist; re-allow
  const readLog = () => {
    try {
      return readFileSync(SEND_LOG, "utf8");
    } catch {
      return "";
    }
  };
  const before = readLog();
  await api.commands.imessage.handler(`send ${PEER_PHONE} hi from test`, ctx);
  const after = readLog();
  assert.ok(after.includes("hi from test"), "message text passed to send cmd");
  assert.ok(after.slice(before.length).includes(PEER_PHONE), "target passed to send cmd");
}

/* --- tool ---------------------------------------------------------- */
{
  assert.ok(api.tools.imessage_send, "imessage_send tool registered");
  const res = await api.tools.imessage_send.execute("call-1", { text: "tool hello" }, undefined, undefined, ctx);
  const text = (res.content ?? []).map((c) => c.text ?? "").join("");
  assert.ok(text.length > 0, "tool returns content");
  const log = readFileSync(SEND_LOG, "utf8");
  assert.ok(log.includes("tool hello"), "tool send routed to last peer");
  assert.ok(log.includes(PEER_PHONE), "last peer used as default target");
}

/* --- self-echo suppression + user self-chat still delivered ---------- */
{
  const dbw = new Database(DB);
  const insM = dbw.prepare(
    `INSERT INTO message (guid, service, account, text, date, is_from_me, item_type, is_empty,
                          is_service_message, is_system_message, replace, handle_id)
     VALUES (?, 'iMessage', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  );
  const insCmj = dbw.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id, message_date, index_state, filter_action, filter_sub_action) VALUES (?, ?, ?, 0, 0, 0)",
  );
  const chatSelf = 2, hSelf = 1; // fixture: 1-handle self chat (handle 1 = SELF)
  const selfRow = (text, fromMe) => {
    const m = insM.run("e-" + Math.random(), "iMessage:P:" + SELF_PHONE, text, APPLE_T, fromMe, hSelf).lastInsertRowid;
    return insCmj.run(chatSelf, m, APPLE_T).lastInsertRowid;
  };

  const sentBefore = sent.length;
  // Agent sends into its own self-chat (own identities are always allowed).
  await api.commands.imessage.handler(`send ${SELF_PHONE} ping from agent`, ctx);
  // The server echo arrives as an inbound-shaped row (is_from_me=0, sender = self).
  const rEcho = selfRow("ping from agent", 0);
  // The user's own self-chat message (e.g. typed on the phone) must still deliver.
  const rUser = selfRow("user reply from phone", 0);
  // User re-types the agent's exact text AFTER the echo was consumed — one-shot
  // consumption means it now delivers.
  const rUser2 = selfRow("ping from agent", 0);

  await sleep(150); // ~6 poll ticks
  dbw.close();

  assert.equal(sent.length, sentBefore + 2, "echo suppressed; both genuine self-chat rows delivered");
  assert.match(sent[sentBefore].msg, /^\[iMessage self-chat @ [^\]]+\] user reply from phone$/, "user row delivered first");
  assert.match(sent[sentBefore + 1].msg, /^\[iMessage self-chat @ [^\]]+\] ping from agent$/, "re-typed text delivered after one-shot consumption");
  assert.ok(notesFlat().find((n) => n.includes("suppressed self-echo")), "suppression noted");

  // Reply routing: the next send targets the number that last messaged (the
  // self-chat's own handle), not the previous peer.
  const logBefore = (() => { try { return readFileSync(SEND_LOG, "utf8"); } catch { return ""; } })();
  await api.tools.imessage_send.execute("call-echo-route", { text: "reply routing check" }, undefined, undefined, ctx);
  const logNew = readFileSync(SEND_LOG, "utf8").slice(logBefore.length);
  assert.ok(logNew.startsWith(SELF_PHONE), "reply routed to the number that sent (self-chat)");

  status = await statusBlock();
  const wm = Number(/watermark:\s+(\d+)/.exec(status)[1]);
  assert.ok(wm >= Math.max(rEcho, rUser, rUser2), "watermark advanced past echo + user rows");
}

/* --- @task dispatch (global-todo skill) + outbox drain -------------- */
{
  const todosHome = path.join(tmp, "todos");
  const dbw = new Database(DB);
  const insM = dbw.prepare(
    `INSERT INTO message (guid, service, account, text, date, is_from_me, item_type, is_empty,
                          is_service_message, is_system_message, replace, handle_id)
     VALUES (?, 'iMessage', ?, ?, ?, ?, 0, 0, 0, 0, 0, ?)`,
  );
  const insCmj = dbw.prepare(
    "INSERT INTO chat_message_join (chat_id, message_id, message_date, index_state, filter_action, filter_sub_action) VALUES (?, ?, ?, 0, 0, 0)",
  );
  const chatSelf = 2, hSelf = 1; // fixture self chat (handle 1 = SELF)
  const selfRow = (text) => {
    const m = insM.run("q-" + Math.random(), "iMessage:P:" + SELF_PHONE, text, APPLE_T, 0, hSelf).lastInsertRowid;
    insCmj.run(chatSelf, m, APPLE_T);
  };

  const sentBefore = sent.length;
  selfRow("@task write a haiku about databases");
  await sleep(300); // poll tick → async taskctl add → confirmation send
  dbw.close();

  assert.equal(sent.length, sentBefore, "@task text never injected into the agent");
  const store = JSON.parse(readFileSync(path.join(todosHome, "tasks.json"), "utf8"));
  assert.ok(store.tasks.some((t) => t.title.includes("haiku")), "task recorded in the global store");
  assert.equal(store.tasks[0].source, "imessage", "source attributed");
  const log = readFileSync(SEND_LOG, "utf8");
  assert.ok(log.includes(SELF_PHONE) && log.includes("haiku"), "queued confirmation sent to self");
  assert.ok(!notesFlat().find((n) => n.includes("delivered") && n.includes("@task")), "no delivery note for @task row");

  // Hourly-loop side: a worker queues a completion notification; the bridge drains it.
  const obDir = path.join(todosHome, "outbox");
  mkdirSync(obDir, { recursive: true });
  writeFileSync(
    path.join(obDir, "20260826-120000-000-abcd.json"),
    JSON.stringify({ to: "self", text: "✅ Todo T0001 done — summary in /tmp/haiku.md", at: new Date().toISOString(), tries: 0 }),
  );
  await sleep(300); // drain tick
  const log2 = readFileSync(SEND_LOG, "utf8");
  assert.ok(log2.includes("done — summary in /tmp/haiku.md"), "outbox notification delivered");
  assert.equal(readdirSync(obDir).filter((n) => n.endsWith(".json")).length, 0, "outbox entry consumed");
}

/* --- session shutdown ---------------------------------------------- */
{
  await api.handlers.session_shutdown?.(undefined, ctx);
  status = await statusBlock();
  assert.match(status, /polling:\s+off/, "shutdown stops polling");
}

console.log("✔ factory.test.mjs — all assertions passed (" + sent.length + " delivered)");
