import test from "node:test";
import assert from "node:assert/strict";
import { notifyMessage } from "./notify.mjs";

test("start message format", () => {
  assert.equal(
    notifyMessage({ id: "T0013", title: "global-todo: iMessage on task start (pickup)" }, "start", "worker running"),
    "🚀 Todo T0013 \"global-todo: iMessage on task start (pickup)\" started — worker running",
  );
});

test("done message is byte-identical to the pre-change format", () => {
  assert.equal(
    notifyMessage({ id: "T0007", title: "Refactor the ledger" }, "done", "worker finished"),
    "✅ Todo T0007 \"Refactor the ledger\" done — worker finished",
  );
});

test("failed message is byte-identical to the pre-change format", () => {
  assert.equal(
    notifyMessage({ id: "T0007", title: "Refactor the ledger" }, "failed", "runtime exceeded 6h — killed"),
    "⚠️ Todo T0007 \"Refactor the ledger\" failed — runtime exceeded 6h — killed",
  );
});

test("unknown outcome falls back to the failed format", () => {
  assert.equal(notifyMessage({ id: "T0007", title: "x" }, "weird", "boom"), "⚠️ Todo T0007 \"x\" failed — boom");
});
