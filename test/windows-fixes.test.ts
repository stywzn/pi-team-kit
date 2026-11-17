// Regression tests for the issues found running pi-team-kit on a company Windows machine.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backslashSources, gitCommonDir, localProjectDataDir } from "../lib/config.ts";
import { mergeFactFiles } from "../lib/facts.ts";
import { gateProgram, looksUnrunnable } from "../lib/guard.ts";
import { buildTeamScript, validateTasks } from "../lib/team.ts";

test("A6: agent-written project data lives in the git dir, also from a linked worktree", () => {
  const main = mkdtempSync(join(tmpdir(), "ptk-repo-"));
  mkdirSync(join(main, ".git", "worktrees", "wt1"), { recursive: true });
  writeFileSync(join(main, ".git", "worktrees", "wt1", "commondir"), "../..\n");
  const wt = mkdtempSync(join(tmpdir(), "ptk-wt-"));
  writeFileSync(join(wt, ".git"), `gitdir: ${join(main, ".git", "worktrees", "wt1")}\n`);
  assert.equal(gitCommonDir(main), join(main, ".git"));
  assert.equal(gitCommonDir(wt), join(main, ".git"), "a worktree shares the main repo's data");
  assert.equal(localProjectDataDir(main), join(main, ".git", "ptk"), "inside .git: never in git status, never blocks a team run");
  assert.equal(localProjectDataDir(tmpdir()) === undefined || !localProjectDataDir(mkdtempSync(join(tmpdir(), "ptk-nogit-"))), true);
});

test("local facts are shared with the team by an explicit merge", () => {
  const team = { version: 1 as const, facts: [{ id: "db", text: "old", added: "2026-01-01" }], pitfalls: [] };
  const mine = { version: 1 as const, facts: [{ id: "db", text: "port 5433", added: "2026-11-17" }, { id: "mirror", text: "npmmirror", added: "2026-11-17" }], pitfalls: [] };
  const { file, added, updated } = mergeFactFiles(team, mine);
  assert.equal(added, 1);
  assert.equal(updated, 1);
  assert.deepEqual(file.facts.map((f) => f.text), ["port 5433", "npmmirror"]);
});

test("Windows local-path installs with backslashes are detected", () => {
  const settings = JSON.stringify({ packages: ["npm:pi-subagents", "..\\..\\code\\pi-team-kit", { source: "C:\\work\\kit" }, "git:github.com/x/y"] });
  assert.deepEqual(backslashSources(settings), ["..\\..\\code\\pi-team-kit", "C:\\work\\kit"]);
  assert.deepEqual(backslashSources("{not json"), []);
});

test("gate preflight: find the program, recognise 'cannot run here' but not failing tests", () => {
  assert.equal(gateProgram("python3 -m unittest -q"), "python3");
  assert.equal(gateProgram("CI=1 npm test"), "npm");
  assert.equal(gateProgram("cd api && py -3 -m pytest"), "py");
  assert.ok(looksUnrunnable(9009, "Python was not found; run without arguments to install from the Microsoft Store"));
  assert.ok(looksUnrunnable(127, "bash: python3: command not found"));
  assert.ok(looksUnrunnable(1, "'pytest' is not recognized as an internal or external command"));
  assert.ok(!looksUnrunnable(0, "Python 3.12.4"));
  assert.ok(!looksUnrunnable(1, "FAILED (failures=2)"), "a failing suite is a runnable gate");
});

test("A8: more tasks than the limit is an error, never a silent cut", async () => {
  const many = Array.from({ length: 3 }, (_, i) => ({ key: `t${i}`, title: `T${i}`, brief: "do the thing and add a test", files: [`f${i}.py`] }));
  assert.throws(() => validateTasks(many, 2), /at most 2/);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...a: string[]) => (...b: unknown[]) => Promise<any>;
  const script = buildTeamScript({ goal: "g", lanes: [], gate: "", gateTimeoutSec: 5, maxRounds: 1, workerAgent: "w", verifierAgent: "v", maxTasks: 2 });
  const calls: string[] = [];
  const runs = {
    run: async (key: string) => {
      calls.push(key);
      return { ok: true, runId: "r", artifactPaths: ["/r"], output: "", structuredOutput: { tasks: many, questions: [], notes: "" } };
    },
    status: async () => ({}),
  };
  const result = await new AsyncFunction("runs", script)(runs);
  assert.deepEqual(calls, ["plan"], "no worker starts");
  assert.equal(result.state, "needs-input");
  assert.match(result.questions[0], /3 tasks; the limit is 2/);
  assert.equal(result.plan.tasks.length, 3, "the full plan is handed back");
});
