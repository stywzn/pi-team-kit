// Friction report: signals come out of pi's session files; the report ranks them by time lost, briefly.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { formatFriction, frictionFromFiles, frictionItems, sessionFiles, sessionSignals } from "../lib/feedback.ts";

const at = (min: number) => new Date(Date.parse("2026-11-18T09:00:00Z") + min * 60_000).toISOString();
const value = {
  plan: { tasks: [{ key: "fixtures", files: ["tests/fixtures/**"] }, { key: "login", files: ["tests/login.spec.ts", "tests/fixtures/auth.ts"] }, { key: "cart", files: ["tests/cart.spec.ts"] }] },
  lanes: [
    { lane: "fixtures-plus1", tasks: ["fixtures", "login"], state: "passed", rounds: 2, history: [{ round: 1, findings: [{ issue: "uses waitForTimeout(3000) in tests/login.spec.ts" }] }] },
    { lane: "cart", tasks: ["cart"], state: "needs-human", rounds: 3, error: null, summary: "selector for checkout button not found", history: [{ round: 1, gate: "1 failed" }, { round: 2, findings: [{ issue: "uses waitForTimeout(5000) in tests/cart.spec.ts" }] }] },
  ],
};
const lines = [
  { type: "session", version: 3, id: "s", timestamp: at(0), cwd: "/home/u/code/shop-e2e" },
  { type: "message", timestamp: at(1), message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "team_run", arguments: { goal: "E2E" } }] } },
  { type: "message", timestamp: at(2), message: { role: "toolResult", toolCallId: "c1", toolName: "team_run", content: [{ type: "text", text: "Team run started" }] } },
  { type: "message", timestamp: at(5), message: { role: "user", content: "is it stuck?" } },
  { type: "custom_message", timestamp: at(21), customType: "subagent-notify", content: `Background task completed: **workflow**\nWorkflow receipt: /tmp/My Runs/r1/workflow-receipt.json\n\nWorkflow completed with 5 child run(s). Return:${JSON.stringify(value)}` },
  { type: "message", timestamp: at(22), message: { role: "toolResult", toolName: "team_integrate", content: [{ type: "text", text: "applied a\nFAILED /tmp/b.patch\nerror: patch failed" }] } },
  { type: "message", timestamp: at(23), message: { role: "toolResult", toolName: "team_integrate", content: [{ type: "text", text: "applied a\ngate `npx playwright test`: FAILED (exit 1)\nNOT removed (1):\n- x" }] } },
  { type: "message", timestamp: at(24), message: { role: "assistant", content: [{ type: "toolCall", id: "c2", name: "bash", arguments: { command: "npx playwright test --project=chromium && echo ok" } }] } },
  { type: "message", timestamp: at(39), message: { role: "toolResult", toolCallId: "c2", toolName: "bash", isError: true, content: [{ type: "text", text: "Command timed out\n[ptk] Stopped after 900s by the ptk guard. If it is a server..." }] } },
  { type: "message", timestamp: at(40), message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "This command would not finish on its own: `npm run dev` starts a dev server. Run it in the background" }] } },
  { type: "message", timestamp: at(41), message: { role: "toolResult", toolName: "bash", isError: true, content: [{ type: "text", text: "1 failed: login.spec.ts" }] } },
  { type: "message", timestamp: at(42), message: { role: "toolResult", toolName: "toolbox", isError: true, content: [{ type: "text", text: "md2pdf: no browser found\nmore" }] } },
  { type: "message", timestamp: at(43), message: { role: "assistant", content: [], stopReason: "aborted" } },
  { type: "message", timestamp: at(44), message: { role: "assistant", content: [], stopReason: "error", errorMessage: "429 rate limit exceeded" } },
  { type: "compaction", timestamp: at(45), summary: "x", firstKeptEntryId: "a" },
  { type: "custom", timestamp: at(46), customType: "ptk-friction", data: { text: "the planner put fixtures and login into one lane" } },
  "garbage",
].map((e) => (typeof e === "string" ? e : JSON.stringify(e))).join("\n");

test("signals: a session's run, integration, guard, tool, model and user events", () => {
  const s = sessionSignals(lines); // no status.json: the value comes from the notice
  const kinds = s.map((x) => x.kind);
  assert.equal(new Set(s.map((x) => x.project)).size, 1);
  assert.equal(s[0].project, "shop-e2e");
  for (const k of ["run", "rework", "failed-lane", "serialized", "conflict", "gate-failed", "not-removed", "timeout", "block", "tool-error", "aborted", "model-error", "compaction", "intervened", "note"])
    assert.ok(kinds.includes(k as never), k);
  const run = s.find((x) => x.kind === "run")!;
  assert.deepEqual([run.lanes, run.tasks], [2, 3]);
  const rework = s.filter((x) => x.kind === "rework");
  assert.deepEqual(rework.map((x) => x.key), ["uses waitForTimeout(N) in <file>", "checks failed: N failed"], "numbers and file names are folded so repeats group");
  assert.equal(Math.round(rework[0].minutes), 7, "20-minute run, 3 rounds max: one extra round ≈ 7 min");
  assert.equal(s.find((x) => x.kind === "serialized")?.key, "tests/fixtures/auth.ts", "the shared file is named");
  const timeout = s.find((x) => x.kind === "timeout")!;
  assert.deepEqual([timeout.key, timeout.minutes], ["npx playwright test --project=chromium", 15]);
  assert.equal(s.find((x) => x.kind === "block")?.key, "a command that never ends (server, watcher)");
  assert.equal(s.filter((x) => x.kind === "tool-error").length, 1, "a failing test is not tool friction");
  assert.equal(s.find((x) => x.kind === "tool-error")?.key, "toolbox: md2pdf: no browser found");
  assert.equal(s.find((x) => x.kind === "model-error")?.key, "429 rate limit exceeded");
  assert.equal(s.find((x) => x.kind === "status.json" as never), undefined);
  // the receipt path with a space reaches readRunValue intact
  let asked = "";
  sessionSignals(lines, (dir) => ((asked = dir), value));
  assert.equal(asked, "/tmp/My Runs/r1");
});

test("a refused team_run is not a run; a person typing outside a run is not stepping in", () => {
  const s = sessionSignals(
    [
      { type: "message", timestamp: at(1), message: { role: "assistant", content: [{ type: "toolCall", id: "c1", name: "team_run", arguments: {} }] } },
      { type: "message", timestamp: at(1), message: { role: "toolResult", toolCallId: "c1", toolName: "team_run", isError: true, content: [{ type: "text", text: "The user did not confirm the brief." }] } },
      { type: "message", timestamp: at(2), message: { role: "user", content: "change the goal" } },
    ].map((e) => JSON.stringify(e)).join("\n"),
  );
  assert.deepEqual(s.map((x) => x.kind), ["tool-error"]);
});

test("report: ranked by time lost, a few lines per item, with what to try and the leads' notes", () => {
  const signals = sessionSignals(lines);
  const items = frictionItems(signals);
  // a 20-minute run: one lane with 1 extra round of 2, one with 2 extra of 3 → ≈20 min of rework, ahead of a 15-minute timeout
  assert.deepEqual(items.slice(0, 2).map((i) => [i.kind, Math.round(i.minutes)]), [["rework", 20], ["timeout", 15]]);
  assert.ok(items.findIndex((i) => i.kind === "timeout") < items.findIndex((i) => i.kind === "block"));
  const report = formatFriction(signals, { days: 30, sessions: 1 });
  assert.match(report, /^pi-team-kit friction, last 30 days: 1 session\(s\), 1 project\(s\) \(shop-e2e\), 1 team run\(s\), most lanes in one run: 2/);
  assert.match(report, /\n1\. Lanes sent back for rework: 2, ≈20 min\. "uses waitForTimeout\(N\) in <file>"; "checks failed: N failed"\n   Try: /);
  assert.match(report, /\n2\. Commands stopped by the timeout: 1, ≈15 min\. "npx playwright test --project=chromium"/);
  assert.match(report, /Shared files put tasks into one lane \(no parallelism\): 1, ≈10 min\. "tests\/fixtures\/auth\.ts"/);
  assert.match(report, /Noted by leads:\n- the planner put fixtures and login into one lane/);
  assert.ok(report.split("\n").length <= 25, "short enough to read and hand on");
  assert.match(formatFriction([], { days: 7, sessions: 3 }), /Nothing found/);
});

test("files: lead sessions of every project within the window; filtered by project folder", () => {
  const root = mkdtempSync(join(tmpdir(), "ptk-fb-"));
  mkdirSync(join(root, "--home-u-code-shop-e2e--", "subagent-artifacts"), { recursive: true });
  mkdirSync(join(root, "--home-u-code-other--"));
  writeFileSync(join(root, "--home-u-code-shop-e2e--", "a.jsonl"), lines);
  writeFileSync(join(root, "--home-u-code-shop-e2e--", "subagent-artifacts", "child.jsonl"), lines);
  writeFileSync(join(root, "--home-u-code-other--", "b.jsonl"), `${JSON.stringify({ type: "session", cwd: "/home/u/code/other" })}\n${JSON.stringify({ type: "compaction" })}`);
  writeFileSync(join(root, "stray.jsonl"), "");
  const files = sessionFiles(root, 30);
  assert.equal(files.length, 2, "top-level lead sessions only");
  assert.equal(frictionFromFiles(files).sessions, 2);
  const shop = frictionFromFiles(files, "shop-e2e");
  assert.equal(shop.sessions, 1);
  assert.ok(shop.signals.every((s) => s.project === "shop-e2e"));
  assert.deepEqual(frictionFromFiles(files, "nope"), { signals: [], sessions: 0 });
  assert.deepEqual(sessionFiles(join(root, "missing"), 30), []);
});
