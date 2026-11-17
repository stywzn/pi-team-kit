// Playbooks: short by rule, changed one line at a time, written from evidence with secrets removed.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatEvidence, gitEvidence, leadEvidence, recentSessions, sessionEvidence } from "../lib/harvest.ts";
import {
  appendRetired,
  applyChanges,
  checkPlaybook,
  copyTemplates,
  findPlaybook,
  findSecrets,
  LIMITS,
  listPlaybooks,
  parsePlaybook,
  playbookBrief,
  readMeta,
  redact,
  renderPlaybook,
  writeMeta,
  type PlaybookDraft,
} from "../lib/playbook.ts";

const draft: PlaybookDraft = {
  name: "web-e2e-automation",
  description: "Automating test cases for a web app with Playwright. Use when asked to automate or add E2E tests.",
  ask: ["Test environment URL and how to get a test account"],
  steps: ["Install Playwright and get one smoke test green", "Log in through the API and reuse the storage state", "Seed test data per test"],
  done: ["Suite passes 3 runs in a row", "No hard waits (waitForTimeout)"],
  tips: ["Prefer data-testid locators"],
  pitfalls: ["Test env resets at 02:00; never rely on yesterday's data"],
  never: ["Never touch production"],
};

test("render: a short skill with stable ids; parse reads it back", () => {
  const text = renderPlaybook(draft);
  assert.match(text, /^---\nname: web-e2e-automation\ndescription: "Automating/);
  assert.match(text, /## Steps\n1\. Install Playwright and get one smoke test green \(s1\)\n2\. Log in/);
  assert.match(text, /## Pitfalls\n- Test env resets at 02:00; never rely on yesterday's data \(p1\)/);
  const p = parsePlaybook(text);
  assert.equal(p.name, "web-e2e-automation");
  assert.equal(p.description, draft.description);
  assert.deepEqual(p.sections.get("steps")?.items.map((i) => i.id), ["s1", "s2", "s3"]);
  assert.deepEqual(checkPlaybook(text), { errors: [], warnings: [] });
  assert.ok(text.split("\n").filter((l) => l.trim()).length < 25, "the whole thing is a screenful");
  // Windows line endings from an editor parse the same
  assert.deepEqual(parsePlaybook(text.replace(/\n/g, "\r\n")).sections.get("done when")?.items.map((i) => i.text), draft.done);
});

test("limits are enforced by code: long or sprawling playbooks are refused with the reason", () => {
  assert.throws(() => renderPlaybook({ ...draft, steps: [] }), /"Steps" needs at least one item/);
  assert.throws(() => renderPlaybook({ ...draft, done: [] }), /"Done when" needs at least one item/);
  assert.throws(() => renderPlaybook({ ...draft, tips: Array.from({ length: 9 }, (_, i) => `tip ${i}`) }), /"Tips" has 9 items; at most 8/);
  assert.throws(() => renderPlaybook({ ...draft, pitfalls: ["x".repeat(LIMITS.item + 1)] }), /one line, under 160/);
  assert.throws(() => renderPlaybook({ ...draft, description: "d".repeat(201) }), /under 200/);
  assert.throws(() => renderPlaybook({ ...draft, name: "Web E2E" }), /name: lowercase/);
  assert.throws(() => renderPlaybook({ ...draft, tips: ["login with password: hunter2hunter2"] }), /secrets \(password or token\)/);
  const long = `---\nname: x\ndescription: y\n---\n## Steps\n1. a (s1)\n## Done when\n- b (d1)\n${Array.from({ length: 60 }, (_, i) => `note ${i}`).join("\n")}\n`;
  assert.match(checkPlaybook(long).errors.join(" "), /keep the playbook under 60/);
  assert.match(checkPlaybook(`---\nname: x\ndescription: y\n---\n## Steps\n1. a\n## Done when\n- b\n## Background\nlots\n`).warnings[0], /details belong in references/);
});

test("changes are single-line edits: add, bump, replace, retire; nothing else moves", () => {
  const text = renderPlaybook(draft).replace("## Never", "Hand-written note the team added.\n\n## Never");
  const t0 = new Date("2026-11-18T09:00:00Z");
  const r = applyChanges(text, [
    { op: "add", section: "pitfalls", text: "Captcha on the login form in test env; log in via API" },
    { op: "bump", id: "t1" },
    { op: "replace", id: "d2", text: "No waitForTimeout; wait on locators or responses" },
    { op: "retire", id: "a1" },
  ], t0);
  assert.match(r.text, /- Captcha on the login form in test env; log in via API \(p2\)/);
  assert.match(r.text, /- Prefer data-testid locators \(t1, 2x\)/);
  assert.match(r.text, /- No waitForTimeout; wait on locators or responses \(d2\)/);
  assert.doesNotMatch(r.text, /Test environment URL/);
  assert.match(r.text, /Hand-written note the team added\./, "lines without ids are left alone");
  assert.deepEqual(r.retired, ["- 2026-11-18 replaced d2: No hard waits (waitForTimeout)", "- 2026-11-18 retired a1: Test environment URL and how to get a test account"]);
  assert.deepEqual(r.log.map((l) => `${l.op}:${l.id}`), ["add:p2", "bump:t1", "replace:d2", "retire:a1"]);
  // the same lesson again is counted, not repeated
  const again = applyChanges(r.text, [{ op: "add", section: "pitfalls", text: "captcha on the login form in test env; log in via API!" }], t0);
  assert.match(again.text, /\(p2, 2x\)/);
  assert.equal((again.text.match(/Captcha/g) ?? []).length, 1);
  // a new step is numbered in order; a new section lands in the canonical place
  const s = applyChanges(renderPlaybook({ name: "x", description: "y", steps: ["a"], done: ["b"] }), [{ op: "add", section: "steps", text: "c" }, { op: "add", section: "ask", text: "who owns the env?" }], t0);
  assert.match(s.text, /## Ask first\n- who owns the env\? \(a1\)\n\n## Steps\n1\. a \(s1\)\n2\. c \(s2\)/);
  const after = applyChanges(s.text, [{ op: "retire", id: "s1" }], t0);
  assert.match(after.text, /## Steps\n1\. c \(s2\)/, "renumbered, id kept");
});

test("a full section takes a replace or retire, never a longer list", () => {
  const full = renderPlaybook({ ...draft, never: ["a", "b", "c", "d", "e"] });
  assert.throws(() => applyChanges(full, [{ op: "add", section: "never", text: "f" }]), /"Never" is full \(5\); replace or retire one of n1, n2, n3, n4, n5 first/);
  assert.throws(() => applyChanges(full, [{ op: "bump", id: "zz9" }]), /no item with id zz9/);
  assert.throws(() => applyChanges(full, [{ op: "add", section: "tips", text: "token=abcdef123456 works" }]), /secret/);
  assert.throws(() => applyChanges(full, [{ op: "replace", id: "t1", text: "y".repeat(200) }]), /under 160/);
  assert.equal(full, renderPlaybook({ ...draft, never: ["a", "b", "c", "d", "e"] }), "input untouched after a refused change");
});

test("the planner gets one short block; Ask-first stays with the lead", () => {
  const b = playbookBrief(renderPlaybook(draft), "web-e2e-automation");
  assert.match(b.block, /^Playbook "web-e2e-automation"/);
  assert.match(b.block, /Steps: 1\) Install Playwright and get one smoke test green; 2\) Log in through the API/);
  assert.doesNotMatch(b.block, /Test environment URL/);
  assert.deepEqual(b.done, draft.done);
  assert.ok(b.block.length < 1200);
});

test("secrets: found and redacted; placeholders are not secrets", () => {
  assert.deepEqual(findSecrets("use sk-abcdefghijklmnopqrstuv for deepseek"), ["API key"]);
  assert.deepEqual(findSecrets("git clone https://bob:pa55word@git.corp/x.git"), ["credentials in a URL"]);
  assert.deepEqual(findSecrets("password=$TEST_PASSWORD from the CI secret; token: <ask the admin>"), []);
  assert.equal(redact("export GH=ghp_abcdefghijklmnopqrstuvwxyz0123 && run"), "export GH=[redacted] && run");
});

test("files: listed across folders, metadata kept, templates copied only from inside the repo", () => {
  const root = mkdtempSync(join(tmpdir(), "ptk-pb-"));
  const mine = join(root, "mine");
  const team = join(root, "team");
  for (const [base, name] of [[mine, "web-e2e-automation"], [team, "web-e2e-automation"], [team, "db-migration"]] as const) {
    mkdirSync(join(base, name), { recursive: true });
    writeFileSync(join(base, name, "SKILL.md"), renderPlaybook({ ...draft, name, description: `${base === mine ? "mine" : "team"} ${name}` }));
  }
  writeMeta(join(mine, "web-e2e-automation"), { version: 1, created: "2026-11-01", uses: [{ at: "2026-11-17T10:00:00Z", repo: "shop", outcome: "gate passed", minutes: 12 }], log: [] });
  const all = listPlaybooks([mine, team, join(root, "missing")]);
  assert.deepEqual(all.map((p) => `${p.name}:${p.description.split(" ")[0]}:${p.uses}`), ["web-e2e-automation:mine:1", "db-migration:team:0"], "the first folder wins on a clash");
  assert.equal(findPlaybook([mine, team], "db-migration")?.dir, join(team, "db-migration"));
  assert.equal(findPlaybook([mine, team], "../mine"), undefined);
  assert.equal(readMeta(join(team, "db-migration")).uses.length, 0, "no playbook.json: empty metadata");
  appendRetired(join(mine, "web-e2e-automation"), ["- old line"]);
  assert.match(readFileSync(join(mine, "web-e2e-automation", "references", "retired.md"), "utf8"), /old line/);

  const repo = join(root, "repo");
  mkdirSync(join(repo, "tests", "fixtures"), { recursive: true });
  writeFileSync(join(repo, "tests", "fixtures", "auth.ts"), "export const login = () => api.post('/login');\n");
  writeFileSync(join(repo, ".env"), "API_KEY=sk-abcdefghijklmnopqrstuvwx\n");
  writeFileSync(join(repo, "big.bin"), Buffer.alloc(LIMITS.templateBytes + 1));
  const t = copyTemplates(repo, ["tests/fixtures/auth.ts", ".env", "big.bin", "../mine/web-e2e-automation/SKILL.md", "nope.ts"], join(root, "out"));
  assert.deepEqual(t.copied, ["tests/fixtures/auth.ts"]);
  assert.equal(readFileSync(join(root, "out", "tests", "fixtures", "auth.ts"), "utf8").includes("login"), true);
  assert.deepEqual(t.skipped.map((s) => s.split(":")[1].trim().split(" ")[0]), ["looks", "larger", "outside", "not"]);
});

const session = [
  { type: "message", timestamp: "2026-11-17T09:00:00Z", message: { role: "user", content: [{ type: "text", text: "Automate the login and checkout test cases with Playwright" }] } },
  { type: "message", timestamp: "2026-11-17T09:05:00Z", message: { role: "assistant", content: [{ type: "toolCall", name: "team_run", arguments: { goal: "E2E for login and checkout", doneWhen: "npx playwright test passes", gate: "npx playwright test" } }] } },
  { type: "message", timestamp: "2026-11-17T09:06:00Z", message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "Error: page.goto: net::ERR_CONNECTION_REFUSED at http://localhost:3000\nmore" }] } },
  { type: "message", timestamp: "2026-11-17T09:07:00Z", message: { role: "toolResult", toolName: "bash", content: [{ type: "text", text: "ok\n[ptk] Stopped after 180s by the ptk guard. If it is a server..." }] } },
  { type: "custom_message", timestamp: "2026-11-17T09:20:00Z", customType: "subagent-notify", content: "Background task completed. Receipt: /runs/abc/workflow-receipt.json" },
  { type: "message", timestamp: "2026-11-17T09:21:00Z", message: { role: "user", content: [{ type: "text", text: "no, use the API to log in, the form has a captcha; my token is ghp_abcdefghijklmnopqrstuvwxyz0123" }] } },
  { type: "message", timestamp: "2026-11-17T09:30:00Z", message: { role: "toolResult", toolName: "team_integrate", content: [{ type: "text", text: "applied lane-a\ngate `npx playwright test`: PASSED\nother" }] } },
  "not json",
].map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");

test("evidence: corrections, failures, reviewer findings and results come out of a session; secrets do not", () => {
  const value = {
    lanes: [
      { lane: "checkout", state: "passed", rounds: 2, findings: [{ file: "tests/checkout.spec.ts", issue: "uses waitForTimeout(3000)" }] },
      // passed in round 3: the final findings are empty, the reasons for rework are in history
      { lane: "login", state: "passed", rounds: 3, findings: [], history: [{ round: 1, gate: "1 failed: login.spec.ts timed out" }, { round: 2, findings: [{ issue: "Missing review marker", fix: "Add `# reviewed-by` as the last line" }] }] },
    ],
  };
  const items = sessionEvidence(session, (dir) => (dir === "/runs/abc" ? value : undefined));
  assert.ok(items.some((e) => e.text === "verifier on login round 2: Missing review marker -> fix: Add `# reviewed-by` as the last line"));
  assert.ok(items.some((e) => e.text === "checks failed on login round 1: 1 failed: login.spec.ts timed out"));
  const kinds = items.map((e) => e.kind);
  for (const k of ["user", "team", "error", "guard", "review", "integrate"]) assert.ok(kinds.includes(k as never), k);
  assert.ok(items.some((e) => e.kind === "review" && /checkout\.spec\.ts: uses waitForTimeout/.test(e.text)));
  assert.ok(items.some((e) => e.kind === "error" && /bash failed: Error: page\.goto/.test(e.text)));
  const lead = leadEvidence({ version: 1, repo: "/r", updatedAt: "2026-11-17T10:00:00Z", brief: { goal: "E2E", doneWhen: "suite green", assumptions: ["staging data"] }, runs: [{ startedAt: "2026-11-17T09:05:00Z", status: "integrated", lanes: ["a"], gate: "npx playwright test", result: "gate PASSED" }] });
  const git = gitEvidence("abc123 add login fixture\ndef456 checkout tests\n", "tests/fixtures/auth.ts\nplaywright.config.ts\ntests/fixtures/auth.ts\n");
  const pack = formatEvidence([...items, ...lead, ...git, ...items]);
  assert.match(pack.text, /^E1 \[brief 11-17 10:00\] goal: E2E/, "brief first");
  assert.match(pack.text, /\[review 11-17 09:20\] verifier on checkout/);
  assert.match(pack.text, /files added: tests\/fixtures\/auth\.ts, playwright\.config\.ts/);
  assert.doesNotMatch(pack.text, /ghp_/, "the token the user pasted is redacted");
  assert.match(pack.text, /\[redacted\]/);
  assert.equal(pack.text.split("\n").length, pack.count);
  assert.equal(new Set(pack.text.split("\n").map((l) => l.replace(/^E\d+ /, ""))).size, pack.count, "duplicates removed");
  const small = formatEvidence([...items, ...lead, ...git], 300);
  assert.ok(small.text.length <= 300 && small.cut > 0, "capped, and says how much was cut");
});

test("recent sessions: newest first, only within the window", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptk-sess-"));
  writeFileSync(join(dir, "a.jsonl"), "");
  writeFileSync(join(dir, "b.jsonl"), "");
  writeFileSync(join(dir, "notes.txt"), "");
  assert.deepEqual(recentSessions(dir, 30).map((f) => f.slice(-7)).sort(), ["a.jsonl", "b.jsonl"]);
  assert.deepEqual(recentSessions(dir, 30, 8, Date.now() + 40 * 86_400_000), [], "older than the window");
  assert.deepEqual(recentSessions(join(dir, "missing"), 30), []);
});
