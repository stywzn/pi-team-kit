// Reader digests: saved with their sources, reused while those files are unchanged, and timing per team role.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DIGEST_MAX_CHARS, digestBlock, digestKey, digestSources, findDigest, listDigests, saveDigest } from "../lib/digest.ts";
import { formatFriction, runPhases, sessionSignals } from "../lib/feedback.ts";

const digest = (sources: string[]) =>
  [
    "## Summary",
    "Login and checkout cases for the host app, 42 cases.",
    "## Facts",
    "- Case KH-001 logs in with the seeded admin (cases/login.xlsx:3)",
    "## Resources",
    "- run tests: python -m pytest -q tests/",
    "## Gaps",
    "- no cases for password reset",
    "## Sources",
    ...sources.map((s) => `- ${s}`),
  ].join("\n");

test("sources: the paths under ## Sources, line numbers and bullets stripped, sentences ignored", () => {
  assert.deepEqual(digestSources(digest(["cases/login.xlsx", "`tests/conftest.py:12`", "docs/test plan.md"])), ["cases/login.xlsx", "tests/conftest.py", "docs/test plan.md"]);
  assert.deepEqual(digestSources("## Sources\n- none found in the folders I was given\n"), []);
  assert.deepEqual(digestSources(digest([".git/logs/HEAD", ".venv/pyvenv.cfg", "src/__pycache__/a.pyc", "tests/test_a.py"])), ["tests/test_a.py"], "git internals and environments change all the time");
  assert.deepEqual(digestSources("## Facts\n- a\n"), []);
});

test("a digest is reused while its sources are unchanged and says which changed when it is not", () => {
  const repo = mkdtempSync(join(tmpdir(), "ptk-repo-"));
  const store = mkdtempSync(join(tmpdir(), "ptk-digests-"));
  mkdirSync(join(repo, "cases"));
  writeFileSync(join(repo, "cases", "login.xlsx"), "v1");
  writeFileSync(join(repo, "README.md"), "readme");
  const meta = saveDigest(store, "Login  Test Cases", repo, digest(["cases/login.xlsx", "README.md"]), new Date("2026-11-18T10:00:00Z"));
  assert.equal(meta.topic, "login test cases");
  assert.equal(meta.sources.length, 2);
  const hit = findDigest(store, "login test cases", repo);
  assert.deepEqual(hit?.changed, [], "same topic in other case and spacing: found, fresh");
  assert.match(hit!.text, /KH-001/);
  writeFileSync(join(repo, "cases", "login.xlsx"), "v2");
  assert.deepEqual(findDigest(store, "login test cases", repo)?.changed, ["cases/login.xlsx"]);
  assert.equal(findDigest(store, "login test cases", join(repo, "other")), undefined, "per project");
  assert.equal(digestKey("A b", "/r"), digestKey(" a  B ", "/r"));
  assert.deepEqual(listDigests(store, repo).map((m) => m.topic), ["login test cases"]);
  assert.deepEqual(listDigests(store, "/elsewhere"), []);
});

test("save refuses what could not be checked or is too long, and removes secrets", () => {
  const store = mkdtempSync(join(tmpdir(), "ptk-digests-"));
  assert.throws(() => saveDigest(store, "t", "/r", "## Summary\nno sources here"), /no "## Sources" section/);
  assert.throws(() => saveDigest(store, "t", "/r", "x".repeat(DIGEST_MAX_CHARS + 1)), /under 8000/);
  assert.throws(() => saveDigest(store, "t", "/r", "  "), /empty/);
  saveDigest(store, "env", "/r", digest(["README.md"]).replace("## Gaps", "- api key: sk-abcdefghijklmnopqrstuv\n## Gaps"));
  assert.doesNotMatch(findDigest(store, "env", "/r")!.text, /sk-abcdef/);
});

test("digests for a team run stay within one budget and flag changed sources", () => {
  const d = (topic: string, n: number, changed: string[] = []) => ({ meta: { topic, key: topic, root: "/r", created: "2026-11-18T10:00:00Z", sources: [] }, text: "x".repeat(n), changed });
  const block = digestBlock([d("cases", 100, ["cases/login.xlsx"]), d("framework", 200), d("huge", DIGEST_MAX_CHARS)]);
  assert.match(block, /Reader digest "cases" \(2026-11-18; since changed: cases\/login\.xlsx, check those yourself\):/);
  assert.match(block, /Reader digest "framework" \(2026-11-18\):/);
  assert.match(block, /Reader digest "huge" left out/);
});

test("time per role comes from each child's own record and shows in the friction report", () => {
  const runs = mkdtempSync(join(tmpdir(), "ptk-runs-"));
  const wf = join(runs, "wf1");
  mkdirSync(wf);
  const child = (id: string, start: string, end: string) => {
    mkdirSync(join(runs, id));
    writeFileSync(join(runs, id, "status.json"), JSON.stringify({ startedAt: start, endedAt: end }));
  };
  child("c1", "2026-11-18T10:00:00Z", "2026-11-18T10:02:00Z");
  child("c2", "2026-11-18T10:02:00Z", "2026-11-18T10:08:00Z");
  child("c3", "2026-11-18T10:08:00Z", "2026-11-18T10:12:00Z");
  child("c4", "2026-11-18T10:12:00Z", "2026-11-18T10:13:00Z");
  const settle = (key: string, runId: string) => JSON.stringify({ type: "settle", key, result: { runId } });
  writeFileSync(join(wf, "workflow-children.jsonl"), [JSON.stringify({ type: "start", key: "plan" }), settle("plan", "c1"), settle("login-work", "c2"), settle("login-verify-1", "c3"), settle("login-fix-1", "c4"), settle("gone-work", "nope")].join("\n"));
  assert.deepEqual(runPhases(wf), { planner: 2, worker: 6, verifier: 4, rework: 1 });
  assert.equal(runPhases(join(runs, "missing")), undefined);
  const session = [
    { type: "message", timestamp: "2026-11-18T10:00:00Z", message: { role: "assistant", content: [{ type: "toolCall", id: "a", name: "team_run", arguments: {} }] } },
    { type: "custom_message", timestamp: "2026-11-18T10:13:00Z", customType: "subagent-notify", content: `Workflow receipt: ${wf}/workflow-receipt.json\nReturn:{"lanes":[]}` },
  ].map((e) => JSON.stringify(e)).join("\n");
  const signals = sessionSignals(session, () => undefined, runPhases);
  assert.match(formatFriction(signals, { days: 7, sessions: 1 }), /\nTime by role in team runs: worker 6\.0 min \(46%\), verifier 4\.0 min \(31%\), planner 2\.0 min \(15%\), rework 1\.0 min \(8%\)\./);
});
