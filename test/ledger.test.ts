import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addEntry, dropEntry, formatLedger, LEDGER_LIMITS, ledgerBlock, ledgerDir, readLedger } from "../lib/ledger.ts";

test("ledger: decisions, tried approaches and rules are kept per repo, short, and travel as one block", () => {
  const data = mkdtempSync(join(tmpdir(), "ptk-ledger-"));
  const dir = ledgerDir(data, "/home/u/shop");
  assert.notEqual(dir, ledgerDir(data, "/home/u/shop2"), "another repo has its own ledger");
  const d = addEntry(dir, { kind: "decision", text: "Sessions stay server-side; no JWT", why: "the user decided, 21 Nov", by: "shop" });
  addEntry(dir, { kind: "tried", text: "Mocking the clock with freezegun: flaky under xdist", by: "shop" });
  addEntry(dir, { kind: "rule", text: "Every test creates its own data and cleans up in teardown", by: "team_run" });
  const again = addEntry(dir, { kind: "decision", text: "  sessions stay server-side;   no JWT ", by: "api" });
  assert.equal(again.id, d.id, "the same decision twice is stored once");
  const all = readLedger(dir);
  assert.equal(all.length, 3);
  const block = ledgerBlock(all);
  assert.match(block, /Decisions already made \(do not reopen them.*\n- Sessions stay server-side; no JWT \(the user decided, 21 Nov\)/);
  assert.match(block, /Already tried and did not work \(do not try these again\):\n- Mocking the clock/);
  assert.match(block, /Rules that hold for this repository:\n- Every test creates/);
  assert.match(formatLedger(all), /\[sessions-stay-server-side-no-jwt-[0-9a-f]{4}\] decision: Sessions stay/);
  assert.equal(ledgerBlock([]), "");
  // replace by id, drop by id
  addEntry(dir, { kind: "decision", id: d.id, text: "Sessions stay server-side; JWT only for the mobile API", by: "shop" });
  assert.match(readLedger(dir).find((e) => e.id === d.id)!.text, /mobile API/);
  assert.ok(dropEntry(dir, d.id));
  assert.ok(!dropEntry(dir, d.id));
  assert.ok(!dropEntry(dir, "../../etc/passwd"), "an id never reaches outside the ledger folder");
  writeFileSync(join(dir, "broken.json"), "{");
  assert.equal(readLedger(dir).length, 2, "a broken file is skipped");
});

test("ledger: long, empty or too many entries are refused with what to do", () => {
  const dir = ledgerDir(mkdtempSync(join(tmpdir(), "ptk-ledger-")), "/r");
  assert.throws(() => addEntry(dir, { kind: "decision", text: "x".repeat(LEDGER_LIMITS.text + 1), by: "a" }), /the decision itself, not the discussion/);
  assert.throws(() => addEntry(dir, { kind: "decision", text: "   ", by: "a" }), /text is empty/);
  assert.throws(() => addEntry(dir, { kind: "opinion" as never, text: "x", by: "a" }), /kind/);
  assert.throws(() => addEntry(dir, { kind: "decision", text: "x", id: "../x", by: "a" }), /lowercase letters/);
  for (let i = 0; i < LEDGER_LIMITS.entries; i++) addEntry(dir, { kind: "rule", text: `rule number ${i}`, by: "a" });
  assert.throws(() => addEntry(dir, { kind: "rule", text: "one more", by: "a" }), /drop one that no longer matters/);
});
