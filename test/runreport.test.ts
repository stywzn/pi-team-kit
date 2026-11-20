// After a run that did not finish cleanly the lead sees what it left behind.
import assert from "node:assert/strict";
import { test } from "node:test";
import { formatRunReport, lanesNotPassed, noticeRuns, parseNumstat, runFacts } from "../lib/runreport.ts";

test("runs come from pi-subagents' completion notice; facts from the run's status.json", () => {
  const runs = noticeRuns({ runs: [{ runId: "r1", agent: "team-worker", status: "failed", asyncDir: "/tmp/r1", durationMs: 7_200_000 }, { agent: "x" }, null] });
  assert.deepEqual(runs, [{ runId: "r1", agent: "team-worker", status: "failed", asyncDir: "/tmp/r1", durationMs: 7_200_000 }]);
  assert.deepEqual(noticeRuns(undefined), []);
  const f = runFacts({
    cwd: "/repo",
    startedAt: 1000,
    steps: [{ error: "Subagent timed out after 7200000ms.", worktreePath: "/wt/a", recentTools: Array.from({ length: 8 }, (_, i) => ({ tool: "edit", args: { path: `f${i}.py` } })) }],
  });
  assert.equal(f.cwd, "/repo");
  assert.equal(f.worktree, "/wt/a");
  assert.equal(f.startedAt, 1000);
  assert.match(f.error ?? "", /timed out/);
  assert.equal(f.lastTools.length, 5, "the last five calls");
  assert.match(f.lastTools[4], /edit \{"path":"f7\.py"\}/);
  assert.deepEqual(runFacts(undefined).lastTools, []);
});

test("lanes that did not pass, with what they were allowed to change", () => {
  const lanes = lanesNotPassed({ lanes: [{ lane: "a", state: "passed", files: ["a.py"] }, { lane: "b", state: "failed", runDir: "/runs/2", files: ["b.py", "tests/"] }, "junk"] });
  assert.deepEqual(lanes, [{ lane: "b", state: "failed", runDir: "/runs/2", files: ["b.py", "tests/"] }]);
  assert.deepEqual(lanesNotPassed({}), []);
});

test("numstat and the report: changed files with sizes, files outside the brief called out", () => {
  const m = parseNumstat("153\t0\tlib/bench_seed.py\n99\t2\ttests/kh/conftest.py\n-\t-\timg.png\n");
  assert.deepEqual(m.get("lib/bench_seed.py"), { added: 153, deleted: 0 });
  assert.deepEqual(m.get("img.png"), { added: undefined, deleted: undefined });
  const text = formatRunReport([
    {
      title: "subagent team-worker failed after 120 min",
      where: "/repo",
      changed: [{ path: "lib/bench_seed.py", added: 153, deleted: 0 }, { path: "tests/kh/new_test.py", newLines: 40 }, { path: "gone.py" }],
      outside: ["lib/bench_seed.py"],
      lastTools: ["edit {}"],
      error: "Subagent timed out after 7200000ms.",
    },
    { title: "team lane b: needs-human", changed: [], outside: [], lastTools: [], note: "its worktree is gone or was never made" },
  ]);
  assert.match(text, /changed: lib\/bench_seed\.py \+153 -0, tests\/kh\/new_test\.py \(new, 40 lines\), gone\.py/);
  assert.match(text, /OUTSIDE what it was allowed to change: lib\/bench_seed\.py/);
  assert.match(text, /error: Subagent timed out/);
  assert.match(text, /team lane b: needs-human[\s\S]*changed: nothing[\s\S]*note: its worktree is gone/);
  const many = formatRunReport([{ title: "x", changed: Array.from({ length: 30 }, (_, i) => ({ path: `f${i}` })), outside: [], lastTools: [] }]);
  assert.match(many, /and 10 more/);
});
