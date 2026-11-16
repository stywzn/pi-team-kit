import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTeamScript, cleanupTargets, patchesFromHandoff, patternsOverlap, planLanes, validateTasks, worktreeFromHandoff, type TeamPlan, type TeamTask } from "../lib/team.ts";

const task = (key: string, files: string[]): TeamTask => ({ key, title: `Task ${key}`, brief: `Do the ${key} change and add a test for it.`, files });

test("validateTasks reports every problem at once", () => {
  assert.throws(
    () => validateTasks([{ key: "a", title: "", brief: "short", files: [] }, { key: "a", title: "ok", brief: "long enough brief here!!", files: ["/abs"] }]),
    (e: Error) => /title/.test(e.message) && /brief/.test(e.message) && /files/.test(e.message) && /used twice/.test(e.message) && /relative/.test(e.message),
  );
  const [t] = validateTasks([{ key: "API Auth!", title: "Auth", brief: "Add token check to the API.", files: ["./src/api/", "src\\auth.ts"] }]);
  assert.equal(t.key, "api-auth");
  assert.deepEqual(t.files, ["src/api", "src/auth.ts"]);
});

test("patternsOverlap is conservative", () => {
  assert.ok(patternsOverlap("src/a.ts", "src/a.ts"));
  assert.ok(patternsOverlap("src", "src/a.ts"));
  assert.ok(patternsOverlap("src/**/*.ts", "src/x/y.ts"));
  assert.ok(patternsOverlap("**/*.md", "docs/a.md"), "leading wildcard overlaps everything");
  assert.ok(!patternsOverlap("src/api", "src/apix"));
  assert.ok(!patternsOverlap("src/api/**", "web/**"));
  assert.ok(!patternsOverlap("calc.py", "test_calc.py"));
});

test("planLanes merges tasks that share files, keeps the rest parallel", () => {
  const lanes = planLanes([task("api", ["src/api/**"]), task("ui", ["web/**"]), task("api-tests", ["src/api/handler.test.ts"]), task("docs", ["README.md"])]);
  assert.deepEqual(lanes.map((l) => l.tasks.map((t) => t.key)), [["api", "api-tests"], ["ui"], ["docs"]]);
  assert.equal(lanes[0].key, "api-plus1");
});

test("cleanupTargets / worktreeFromHandoff read kept worktrees only", () => {
  const json = JSON.stringify({ groups: [{ baseCommit: "abc123", cleanup: { tasks: [{ path: "/wt/a", branch: "pi-subagents/a", worktreeRemoved: false }, { path: "/wt/b", worktreeRemoved: true }] } }] });
  assert.deepEqual(cleanupTargets(json), [{ path: "/wt/a", branch: "pi-subagents/a" }]);
  assert.deepEqual(worktreeFromHandoff(json), { path: "/wt/a", baseCommit: "abc123" });
  assert.equal(worktreeFromHandoff(JSON.stringify({ groups: [] })), undefined);
});

test("patchesFromHandoff reads pi-subagents handoff.json", () => {
  const json = JSON.stringify({ groups: [{ children: [{ patch: { path: "/tmp/x.patch", branch: "b", diffStat: "1 file", changed: true } }, { patch: { path: "/tmp/y.patch", changed: false } }] }] });
  const p = patchesFromHandoff("/run", json);
  assert.equal(p.length, 2);
  assert.equal(p[0].path, "/tmp/x.patch");
  assert.equal(p[1].changed, false);
});

// ---- the generated workflow, run against a fake pi-subagents `runs` object ----

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<any>;

type Item = {
  agent?: string;
  resume?: string;
  task: string;
  worktree?: boolean;
  gate?: { command: string };
  outputSchema?: unknown;
  acceptance?: { level: string; preserveStagedIndex?: boolean; verify?: { command: string }[] };
};

/** Mimics pi-subagents: a failed child rejects with a message only; runs.status(key) still knows its run. */
async function simulate(plan: Partial<TeamPlan>, respond: (key: string, item: Item) => Record<string, unknown> | "fail") {
  const full: TeamPlan = {
    goal: "goal",
    lanes: planLanes([task("one", ["a.py"])]),
    gate: "python3 -m unittest -q",
    gateTimeoutSec: 60,
    maxRounds: 3,
    workerAgent: "team-worker",
    verifierAgent: "team-verifier",
    ...plan,
  };
  const calls: { key: string; item: Item }[] = [];
  const byKey = new Map<string, number>();
  const runs = {
    run: async (key: string, item: Item) => {
      calls.push({ key, item });
      byKey.set(key, calls.length);
      const r = respond(key, item);
      if (r === "fail") throw new Error(`Run '${key}' failed: Acceptance verification 'gate' failed.`);
      return { ok: true, runId: `run-${calls.length}`, artifactPaths: [`/runs/${calls.length}`], output: "done", ...r };
    },
    status: async (key: string) => {
      const n = byKey.get(key);
      return { runId: `run-${n}`, artifactPaths: [], output: `State: failed\nDir: /runs/${n}\n` };
    },
  };
  const result = await new AsyncFunction("runs", buildTeamScript(full))(runs);
  return { result, calls };
}

test("happy path: worker in a worktree with a gate, verifier passes", async () => {
  const { result, calls } = await simulate({}, (key) => (key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "fine", findings: [] } } : {}));
  assert.deepEqual(calls.map((c) => c.key), ["one-work", "one-verify-1"]);
  assert.equal(calls[0].item.worktree, true);
  assert.equal(calls[0].item.gate?.command, "python3 -m unittest -q");
  assert.ok(calls[1].item.outputSchema, "verifier returns a structured verdict");
  assert.match(calls[1].item.task, /\/runs\/1\/handoff\.json/);
  assert.equal(result.lanes[0].state, "passed");
  assert.equal(result.lanes[0].runDir, "/runs/1");
});

test("rework: verifier finding goes back to the same worker, then passes", async () => {
  let reviews = 0;
  const { result, calls } = await simulate({}, (key) =>
    key.includes("verify")
      ? { structuredOutput: ++reviews === 1 ? { verdict: "rework", summary: "bug", findings: [{ file: "a.py", issue: "off by one", fix: "use <=" }] } : { verdict: "pass", summary: "ok", findings: [] } }
      : {},
  );
  assert.deepEqual(calls.map((c) => c.key), ["one-work", "one-verify-1", "one-fix-1", "one-verify-2"]);
  assert.equal(calls[2].item.resume, "run-1");
  assert.match(calls[2].item.task, /off by one -> use <=/);
  assert.equal(calls[2].item.acceptance?.verify?.[0].command, "python3 -m unittest -q", "rework is held to the gate");
  assert.equal(calls[2].item.acceptance?.preserveStagedIndex, true, "rework builds on the staged first round");
  assert.equal(calls[2].item.gate, undefined, "resume must not use the gate shorthand");
  assert.match(calls[3].item.task, /\/runs\/1\/handoff\.json.*worktree/s, "round 2 reviews the worktree, not the stale patch");
  assert.equal(result.lanes[0].state, "passed");
  assert.equal(result.lanes[0].rounds, 2);
  assert.equal(result.lanes[0].runDir, "/runs/1", "the first writer run owns the worktree and handoff");
});

test("failed gate: the run is found by key and the same worker fixes it", async () => {
  const { calls, result } = await simulate({}, (key) => (key === "one-work" ? "fail" : key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "", findings: [] } } : {}));
  assert.deepEqual(calls.map((c) => c.key), ["one-work", "one-gatefix-1", "one-verify-2"]);
  assert.equal(calls[1].item.resume, "run-1");
  assert.match(calls[1].item.task, /Acceptance verification 'gate' failed/);
  assert.equal(result.lanes[0].state, "passed");
  assert.equal(result.lanes[0].runDir, "/runs/1");
});

test("a lane that keeps failing ends as failed without sinking the other lanes", async () => {
  const lanes = planLanes([task("bad", ["a.py"]), task("good", ["b.py"])]);
  const { result } = await simulate({ lanes, maxRounds: 2 }, (key) =>
    key.startsWith("bad-") && !key.includes("verify") ? "fail" : key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "", findings: [] } } : {},
  );
  assert.deepEqual(result.lanes.map((l: { lane: string; state: string }) => [l.lane, l.state]), [["bad", "failed"], ["good", "passed"]]);
  assert.match(result.lanes[0].error, /gate/);
});

test("without a gate, rework still opts into the staged first round", async () => {
  let reviews = 0;
  const { calls } = await simulate({ gate: "" }, (key) =>
    key.includes("verify") ? { structuredOutput: ++reviews === 1 ? { verdict: "rework", summary: "", findings: [{ issue: "x" }] } : { verdict: "pass", summary: "", findings: [] } } : {},
  );
  assert.deepEqual(calls[2].item.acceptance, { level: "checked", preserveStagedIndex: true });
});

test("a crashed verifier hands the lane to a human", async () => {
  const { result } = await simulate({}, (key) => (key.includes("verify") ? "fail" : {}));
  assert.equal(result.lanes[0].state, "needs-human");
  assert.match(result.lanes[0].summary, /Verifier failed/);
});

test("gives up after maxRounds and hands the lane to a human", async () => {
  const { calls, result } = await simulate({ maxRounds: 2 }, (key) =>
    key.includes("verify") ? { structuredOutput: { verdict: "rework", summary: "still wrong", findings: [{ issue: "x" }] } } : {},
  );
  assert.deepEqual(calls.map((c) => c.key), ["one-work", "one-verify-1", "one-fix-1", "one-verify-2"]);
  assert.equal(result.lanes[0].state, "needs-human");
});

test("lanes run in parallel and are reported in plan order", async () => {
  const lanes = planLanes([task("a", ["a.py"]), task("b", ["b.py"])]);
  const { result } = await simulate({ lanes, gate: "" }, (key, item) => {
    assert.equal(item.gate, undefined, "no gate configured");
    return key.includes("verify") ? { structuredOutput: { verdict: key.startsWith("b") ? "blocked" : "pass", summary: "", findings: [] } } : {};
  });
  assert.deepEqual(result.lanes.map((l: { lane: string; state: string }) => [l.lane, l.state]), [["a", "passed"], ["b", "needs-human"]]);
});
