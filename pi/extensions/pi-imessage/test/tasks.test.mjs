// Unit tests for src/tasks.ts: global-todo store client + outbox operations.
// Uses a scratch PI_TODO_HOME; the real taskctl.mjs does the store work.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { createJiti } from "jiti";

const tmp = mkdtempSync(path.join(os.tmpdir(), "pi-todo-tasks-"));
process.env.PI_TODO_HOME = tmp;

const mod = createJiti(import.meta.url, { fsCache: false, moduleCache: false })("../src/tasks.ts");

assert.equal(mod.TODO_HOME, tmp, "PI_TODO_HOME override honored");
assert.ok(mod.taskctlAvailable(), "taskctl found at default skill path");

/* --- store round-trip through taskctl ------------------------------ */
{
  const added = await mod.runTaskctl(["add", "unit task one\nsome body detail", "--source", "test"]);
  assert.ok(added.ok, "add ok");
  assert.equal(added.task.id, "T0001");
  assert.equal(added.pendingCount, 1);
  const list = await mod.runTaskctl(["list"]);
  assert.equal(list.tasks.length, 1);
  assert.equal(list.tasks[0].title, "unit task one"); // derived from first line
  assert.equal(list.tasks[0].source, "test");
  const pending = await mod.runTaskctl(["list", "--status", "pending"]);
  assert.equal(pending.tasks.length, 1);
}

/* --- outbox surface ------------------------------------------------- */
{
  const ob = mod.OUTBOX_DIR;
  mkdirSync(ob, { recursive: true });
  writeFileSync(path.join(ob, "a.json"), JSON.stringify({ to: "self", text: "hi", at: "x", tries: 0 }));
  writeFileSync(path.join(ob, "b.json.tmp"), "junk"); // in-flight write: must be ignored
  let entries = mod.outboxEntries();
  assert.deepEqual(entries.map((e) => e.name), ["a.json"], "sorted, in-flight .tmp skipped");
  mod.outboxDone(entries[0].file);
  assert.equal(mod.outboxEntries().length, 0, "done removes entry");

  // bump: counted retry until max, then dead-lettered
  writeFileSync(path.join(ob, "c.json"), JSON.stringify({ to: "self", text: "failing", tries: mod.OUTBOX_MAX_TRIES - 1 }));
  assert.equal(mod.outboxBump(path.join(ob, "c.json")), "retry");
  assert.equal(JSON.parse(readFileSync(path.join(ob, "c.json"), "utf8")).tries, mod.OUTBOX_MAX_TRIES);
  assert.equal(mod.outboxBump(path.join(ob, "c.json")), "dead"); // past max
  assert.ok(readdirSync(mod.OUTBOX_DEAD).includes("c.json"), "dead-lettered");
  assert.equal(mod.outboxEntries().length, 0);

  // unreadable entry: skipped, not fatal
  writeFileSync(path.join(ob, "d.json"), "{not json");
  assert.equal(mod.outboxEntries().length, 0, "unreadable skipped");
}

console.log("✔ tasks.test.mjs — all assertions passed");