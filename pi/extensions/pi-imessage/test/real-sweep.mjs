// Regression diagnostic: feed every distinct message.date in the real chat.db
// through appleDateToIso. 2026-08 bug: modern macOS stores ns-since-2001; the
// old code assumed seconds → out-of-range Date → RangeError "Invalid time value".
import { createJiti } from "jiti";
const j = createJiti(import.meta.url, { fsCache: false, moduleCache: false });
const db = j("../src/db.ts");

const c = db.open();
if (!c) { console.log("DB not available"); process.exit(1); }

const rows = c.prepare(
  "SELECT m.date AS d, COUNT(*) AS n FROM message m GROUP BY m.date ORDER BY d ASC"
).all();
console.log("maxRowid:", db.maxRowid(c));
console.log("distinct m.date values:", rows.length);

let nulls = 0;
const throwing = [];
for (const r of rows) {
  const coerced = typeof r.d === "number" ? r.d : null;
  try {
    if (db.appleDateToIso(coerced) === null && coerced !== null) {
      nulls++;
      if (nulls <= 5) console.log("UNRENDERED:", JSON.stringify(r.d));
    }
  } catch (e) {
    throwing.push({ raw: r.d, err: String(e) });
  }
}
console.log("null results (non-null input):", nulls);
console.log("THROWING count:", throwing.length);
for (const t of throwing.slice(0, 10)) console.log("THROW:", JSON.stringify(t));

const render = (d) => {
  const v = typeof d === "number" ? d : null;
  try { return db.appleDateToIso(v) ?? "null"; } catch (e) { return "THROW:" + e; }
};
if (rows.length) {
  console.log("lowest: ", rows.slice(0, 3).map((r) => `${r.d} -> ${render(r.d)}`).join("  |  "));
  console.log("highest:", rows.slice(-3).map((r) => `${r.d} -> ${render(r.d)}`).join("  |  "));
}
db.close();
process.exit(throwing.length ? 1 : 0);
