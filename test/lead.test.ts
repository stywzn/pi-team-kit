import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { continuationMessage, findRunId, leadStatePath, readLeadState, updateLeadState, writeLeadState } from "../lib/lead.ts";

const brief = { goal: "Add E2E tests for login", doneWhen: "npx playwright test passes", outOfScope: "business code", assumptions: ["use the staging seed data"] };

test("a run is recorded when it starts and closed when it is integrated", () => {
  const t0 = new Date("2026-11-17T09:00:00Z");
  let s = updateLeadState(undefined, "/repo", { brief, addRun: { startedAt: t0.toISOString(), status: "running", lanes: ["login-e2e"], gate: "npx playwright test", runId: "abc" } }, t0);
  assert.equal(s.runs.length, 1);
  s = updateLeadState(s, "/repo", { finishRun: { status: "integrated", result: "applied login-e2e\ngate PASSED" } });
  assert.equal(s.runs[0].status, "integrated");
  assert.deepEqual(s.brief, brief, "brief survives later updates");
  s = updateLeadState(s, "/repo", { handoff: "Next: flaky retry test" });
  assert.equal(s.handoff, "Next: flaky retry test");
  assert.deepEqual(s.brief, brief);
  for (let i = 0; i < 15; i++) s = updateLeadState(s, "/repo", { addRun: { startedAt: t0.toISOString(), status: "running", lanes: [], gate: "" } });
  assert.equal(s.runs.length, 10, "only the last 10 runs are kept");
});

test("state is stored per repository outside the working tree and survives a round trip", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptk-lead-"));
  const a = leadStatePath(dir, "/home/u/code/shop");
  const b = leadStatePath(dir, "/home/u/other/shop");
  assert.notEqual(a, b, "same folder name, different repos");
  assert.ok(a.startsWith(join(dir, "leads")));
  const s = updateLeadState(undefined, "/home/u/code/shop", { brief });
  writeLeadState(a, s);
  assert.deepEqual(readLeadState(a), s);
  assert.equal(readLeadState(join(dir, "missing.json")), undefined);
});

test("the takeover message carries the brief and asks for a status check before any new work", () => {
  const now = new Date("2026-11-17T12:00:00Z").getTime();
  let s = updateLeadState(undefined, "/repo", { brief, addRun: { startedAt: "2026-11-17T09:00:00Z", status: "running", lanes: ["a", "b"], gate: "npm test", runId: "1234" } }, new Date("2026-11-17T09:00:00Z"));
  const msg = continuationMessage(s, now);
  assert.match(msg, /3 h ago/);
  assert.match(msg, /Done when: npx playwright test passes/);
  assert.match(msg, /Out of scope: business code/);
  assert.match(msg, /running: lanes a, b; gate `npm test`; run 1234/);
  assert.match(msg, /Do not start new work until I confirm/);
});

test("run ids are found in whatever the spawn returned", () => {
  assert.equal(findRunId({ details: { runId: "b04d9bae-e9c5-417b-9d71-d50aedacd57e" } }), "b04d9bae-e9c5-417b-9d71-d50aedacd57e");
  assert.equal(findRunId(undefined), undefined);
});

test("takeover: what was verified (checks with results) is told apart from what is only claimed, with a smoke check run now", async () => {
  const { continuationMessage, updateLeadState } = await import("../lib/lead.ts");
  const now = Date.parse("2026-11-21T12:00:00Z");
  let s = updateLeadState(undefined, "/r", { brief: { goal: "add login lockout", doneWhen: "tests pass" } }, new Date(now - 3_600_000));
  s = updateLeadState(s, "/r", { progress: { at: new Date(now - 600_000).toISOString(), uncommitted: ["src/login.py", "tests/test_login.py"], checks: [{ command: "pytest tests/test_login.py -q", ok: true, at: new Date(now - 900_000).toISOString() }, { command: "ruff check src", ok: false, at: new Date(now - 800_000).toISOString() }], unchecked: ["src/session.py"] } }, new Date(now - 600_000));
  s = updateLeadState(s, "/r", { handoff: "next: rate limit" }, new Date(now - 500_000));
  assert.ok(s.progress, "progress survives later updates");
  const m = continuationMessage(s, now, { smoke: { command: "pytest -q", ok: false, tail: "FAILED tests/test_session.py::test_expire" }, uncommittedNow: ["src/login.py"], ledger: "Decisions already made (do not reopen them; if one blocks your task, ask the lead):\n- sessions stay server-side" });
  assert.match(m, /recorded by code 10 min ago, not by the model/);
  assert.match(m, /Verified: checks it ran, latest last:\n- `pytest tests\/test_login\.py -q` passed \(15 min ago\)\n- `ruff check src` FAILED/);
  assert.match(m, /Changed after its last check \(claimed, not verified\): src\/session\.py/);
  assert.match(m, /Uncommitted then: src\/login\.py, tests\/test_login\.py\nUncommitted now: src\/login\.py/);
  assert.match(m, /Smoke check just now: `pytest -q` FAILED\.\nFAILED tests\/test_session\.py::test_expire/);
  assert.match(m, /Decisions already made.*\n- sessions stay server-side/);
  assert.match(m, /Count only what a check verified as done/);
  const fresh = continuationMessage(updateLeadState(undefined, "/r", { progress: { at: new Date(now).toISOString(), uncommitted: [], checks: [], unchecked: [] } }, new Date(now)), now, { smoke: { command: "npm test", ok: true, tail: "" } });
  assert.match(fresh, /Verified: no check was run in that session\./);
  assert.match(fresh, /Smoke check just now: `npm test` passed\./);
});
