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
