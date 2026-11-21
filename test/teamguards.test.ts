import assert from "node:assert/strict";
import { test } from "node:test";
import { buildTeamScript, planLanes, type TeamPlan, type TeamTask } from "../lib/team.ts";
import { teamNotes } from "../lib/runreport.ts";
import { withAll } from "./fakeruns.ts";

// The generated workflow against a fake pi-subagents `runs` object (as in mergequeue.test.ts).
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<any>;
type Item = { agent?: string; cwd?: string; task: string; acceptance?: { level: string; verify?: { id: string; command: string }[] } };
type Answer = Record<string, unknown> | { fail: string };

async function run(plan: Partial<TeamPlan>, respond: (key: string, item: Item) => Answer = () => ({})) {
  const full: TeamPlan = { goal: "goal", lanes: [], gate: "pytest -q", gateTimeoutSec: 60, maxRounds: 3, workerAgent: "team-worker", verifierAgent: "team-verifier", ...plan };
  const calls: { key: string; item: Item; at: number }[] = [];
  const done: string[] = [];
  const runs = {
    run: async (key: string, item: Item) => {
      calls.push({ key, item, at: done.length });
      await new Promise((r) => setTimeout(r, key === "baseline" ? 15 : 1));
      done.push(key);
      const custom = respond(key, item);
      const r = key.includes("verify") && !("structuredOutput" in custom) && !("fail" in custom) ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : custom;
      if ("fail" in r) {
        // a failed check comes back with its output, as pi-subagents' runs.all reports it (acceptance.verifyRuns)
        const e = new Error(String(r.fail)) as Error & { results?: unknown };
        if ("out" in r) e.results = [{ acceptance: { verifyRuns: [{ id: "gate", command: "pytest -q", status: "failed", exitCode: 1, stdout: String(r.out) }] } }];
        throw e;
      }
      return { ok: true, runId: `run-${calls.length}`, artifactPaths: [`/runs/${calls.length}`], output: "Status: DONE\nChanged files: a.py\nDiscoveries: none\nEvidence: ok", ...r };
    },
    status: async (key: string) => ({ runId: `run-${calls.findIndex((c) => c.key === key) + 1}`, artifactPaths: [`/runs/${calls.findIndex((c) => c.key === key) + 1}`], output: "" }),
  };
  const result = await new AsyncFunction("runs", buildTeamScript(full))(withAll(runs));
  return { result, calls, done };
}
const task = (key: string, files: string[]): TeamTask => ({ key, title: `Task ${key}`, brief: `Change ${files[0]}.`, files, verify: { cmd: "pytest -q", expect: "passed" } });

test("baseline: the full gate runs once on the unchanged code; when it fails there no worker starts", async () => {
  const { result, calls } = await run({ baseline: true, baselineDir: "/tmp/ptk-integration/b", lanes: planLanes([task("a", ["a.py"]), task("b", ["b.py"])]) }, (key) =>
    key === "baseline" ? { fail: "Run 'baseline' failed: Acceptance verification 'baseline' failed: E   psycopg2.OperationalError: connection to server at \"localhost\" port 5432 failed: Connection refused" } : {},
  );
  const b = calls.find((c) => c.key === "baseline")!;
  assert.equal(b.item.agent, "team-merger");
  assert.deepEqual(b.item.acceptance!.verify, [{ id: "baseline", command: "pytest -q", timeoutMs: 60_000 }]);
  assert.ok(!calls.some((c) => c.key.endsWith("-work")), "no worker was spent");
  assert.equal(result.state, "baseline-failed");
  assert.equal(result.baseline.envProblem.kind, "service not reachable");
  assert.match(result.next, /already fails on the unchanged code.*environment problem.*baseline: false/);
  const notes = teamNotes(result);
  assert.match(notes, /started no worker: its gate already fails on the unchanged code \(looks like an environment problem: service not reachable\)/);
});

test("baseline: it runs in the integration worktree, at the same time as the planner, and lanes wait for it", async () => {
  const tasks = [task("a", ["a.py"])];
  const { calls } = await run({ baseline: true, lanes: [], integration: { branch: "ptk/run-x", dir: "/tmp/ptk-integration/r-x", script: "/m.mjs" } }, (key) =>
    key === "plan" ? { structuredOutput: { tasks, questions: [], notes: "" } } : {},
  );
  const b = calls.find((c) => c.key === "baseline")!;
  const plan = calls.find((c) => c.key === "plan")!;
  assert.equal(b.item.cwd, "/tmp/ptk-integration/r-x");
  assert.equal(b.at, 0);
  assert.equal(plan.at, 0, "planner started before the baseline finished");
  assert.ok(calls.find((c) => c.key === "a-work")!.at >= 2, "the lane started after both");
});

test("baseline: off, or no gate, nothing extra runs", async () => {
  for (const plan of [{ baseline: false }, { baseline: true, gate: "" }]) {
    const { calls, result } = await run({ ...plan, lanes: planLanes([task("a", ["a.py"])]) });
    assert.ok(!calls.some((c) => c.key === "baseline"), JSON.stringify(plan));
    assert.equal(result.lanes[0].state, "passed");
  }
});

test("an environment problem: the rework is told not to code around it; the same one twice stops the lane for the lead", async () => {
  const env = "Run 'a-work' failed: Acceptance verification 'gate' failed: Error: listen EADDRINUSE: address already in use :::8000";
  const { result, calls } = await run({ lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "a-work" || key === "a-gatefix-1" ? { fail: env.replace("a-work", key) } : {}));
  const fix = calls.find((c) => c.key === "a-gatefix-1")!;
  assert.match(fix.item.task, /looks like an environment problem \(port in use.*Do not change code to get around it/s);
  assert.ok(!calls.some((c) => c.key === "a-gatefix-2"), "no third round for the same environment problem");
  const lane = result.lanes[0];
  assert.equal(lane.state, "needs-human");
  assert.equal(lane.envProblem.kind, "port in use");
  assert.match(lane.summary, /same environment problem twice/);
  assert.match(teamNotes(result), /Lanes stopped by the environment.*\n- a: port in use/);
});

test("a code failure still gets its rounds", async () => {
  const fail = "Run 'a-work' failed: Acceptance verification 'gate' failed: FAILED tests/test_a.py::test_x - AssertionError";
  const { result, calls } = await run({ lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key.endsWith("-work") || key.includes("gatefix") ? { fail } : {}));
  assert.ok(calls.some((c) => c.key === "a-gatefix-2"));
  assert.equal(result.lanes[0].state, "failed");
  assert.equal(result.lanes[0].envProblem, null);
});

test("workers' discoveries are taken from their reports, kept across rounds, and handed to the lead", async () => {
  const first = "Status: DONE\nChanged files: a.py\nDiscoveries:\n- the API rate limit is 5 per minute in tests (settings_test.py)\n- none\nEvidence: pytest ok\nConcerns: none";
  const second = "Status: DONE\nChanged files: a.py\nDiscoveries: \n1. port 8000 is taken by the dev proxy here; tests use 8001\nEvidence: ok";
  const { result } = await run({ lanes: planLanes([task("a", ["a.py"])]) }, (key) => {
    if (key === "a-work") return { output: first };
    if (key === "a-verify-1") return { structuredOutput: { verdict: "rework", summary: "no", findings: [{ file: "a.py:1", issue: "wrong", severity: "important" }] } };
    if (key === "a-fix-1") return { output: second };
    return {};
  });
  assert.equal(result.lanes[0].state, "passed");
  assert.deepEqual(result.lanes[0].discoveries, ["the API rate limit is 5 per minute in tests (settings_test.py)", "port 8000 is taken by the dev proxy here; tests use 8001"]);
  assert.match(result.next, /Lanes list discoveries.*remember/);
  assert.match(teamNotes(result), /Workers' discoveries \(claims.*\n- a: the API rate limit is 5 per minute/);
  const none = await run({ lanes: planLanes([task("a", ["a.py"])]) });
  assert.deepEqual(none.result.lanes[0].discoveries, []);
  assert.doesNotMatch(none.result.next, /discoveries/);
  assert.equal(teamNotes(none.result), "");
  assert.match(none.calls[0].item.task, /Discoveries: what the lead should know beyond your task/);
  assert.match(none.calls[0].item.task, /A failure from the environment .* is not yours to work around/);
});

const GATE_FAIL = "Run 'x' failed: Acceptance verification 'gate' failed.";

test("a failed check's output reaches the worker's fix round (pi-subagents' error alone says nothing)", async () => {
  const out = "FAILED tests/test_a.py::test_total - AssertionError: assert 5 == 6\n1 failed, 3 passed in 0.2s";
  const { calls, result } = await run({ lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "a-work" ? { fail: GATE_FAIL, out } : {}));
  const fix = calls.find((c) => c.key === "a-gatefix-1")!;
  assert.match(fix.item.task, /Check gate \(pytest -q\): failed, exit 1\nFAILED tests\/test_a\.py::test_total - AssertionError: assert 5 == 6/);
  assert.equal(result.lanes[0].state, "passed");
  assert.match(result.lanes[0].history[0].gate, /AssertionError: assert 5 == 6/, "the round history keeps the real failure");
});

test("the same failure in two lanes: one problem, fixed once by the lead; the second lane stops instead of another round", async () => {
  const out = "ImportError while loading conftest '/repo/tests/conftest.py'.\nE   ImportError: cannot import name 'make_user' from 'tests.factories'";
  const { result, calls } = await run({ lanes: planLanes([task("a", ["a.py"]), task("b", ["b.py"])]) }, (key) => (/^(a|b)-(work|gatefix)/.test(key) ? { fail: GATE_FAIL, out } : {}));
  const states = Object.fromEntries(result.lanes.map((l: { lane: string; state: string }) => [l.lane, l.state]));
  assert.deepEqual(states, { a: "needs-human", b: "needs-human" });
  assert.ok(result.lanes.some((l: { sameCause: string[] | null }) => l.sameCause && l.sameCause.length), "a lane names the other");
  assert.ok(calls.filter((c) => c.key.includes("gatefix")).length <= 2, `no round after the cause was seen twice: ${calls.map((c) => c.key).join(", ")}`);
  assert.equal(result.causes.length, 1);
  assert.deepEqual(result.causes[0].lanes.sort(), ["a", "b"]);
  assert.match(teamNotes(result), /The same failure in several lanes.*\n- .*cannot import name 'make_user'.* - lanes (a, b|b, a)/s);
});

test("different failures in two lanes are not one cause: each keeps its rounds", async () => {
  const { result } = await run({ lanes: planLanes([task("a", ["a.py"]), task("b", ["b.py"])]) }, (key) =>
    key === "a-work" ? { fail: GATE_FAIL, out: "FAILED tests/test_a.py::t - assert 1 == 2" } : key === "b-work" ? { fail: GATE_FAIL, out: "FAILED tests/test_b.py::t - KeyError: 'x'" } : {},
  );
  assert.deepEqual(result.lanes.map((l: { state: string }) => l.state), ["passed", "passed"]);
  assert.deepEqual(result.causes, []);
});

test("an environment problem that stopped two lanes: lanes not started yet are not started", async () => {
  const out = "E   psycopg2.OperationalError: could not connect to server: Connection refused";
  // c needs d; d passes and is merged, but by then a and b have both hit the same environment problem
  const lanes = planLanes([task("a", ["a.py"]), task("b", ["b.py"]), task("d", ["d.py"]), { ...task("c", ["c.py"]), dependsOn: ["d"] }], Infinity, false);
  const { result, calls } = await run({ lanes, integration: { branch: "ptk/run-x", dir: "/tmp/ptk-integration/r-x", script: "/m.mjs" } }, (key) => (/^(a|b)-(work|gatefix)/.test(key) ? { fail: GATE_FAIL, out } : {}));
  const by = Object.fromEntries(result.lanes.map((l: { lane: string }) => [l.lane, l]));
  assert.equal(by.d.merged, true, "d passed and was merged");
  assert.equal(by.c.state, "skipped");
  assert.match(by.c.summary, /environment problem service not reachable.*already stopped lanes (a, b|b, a)/);
  assert.ok(!calls.some((x) => x.key === "c-work"), "no worker spent on it");
  assert.equal(result.causes[0].env, true);
  // without the environment problem, c runs as usual
  const ok = await run({ lanes, integration: { branch: "ptk/run-x", dir: "/tmp/ptk-integration/r-x", script: "/m.mjs" } });
  assert.equal(ok.result.lanes.find((l: { lane: string }) => l.lane === "c").state, "passed");
});

test("a merge that fails on the combined code says why (the gate's output), not just that it failed", async () => {
  const out = "FAILED tests/test_total.py::test_sum - AssertionError: 3 != 4";
  const { result } = await run({ lanes: planLanes([task("a", ["a.py"])], Infinity, false), integration: { branch: "ptk/run-x", dir: "/tmp/ptk-integration/r-x", script: "/m.mjs" } }, (key) => (key === "a-merge" ? { fail: GATE_FAIL, out } : {}));
  assert.equal(result.lanes[0].merged, false);
  assert.match(result.lanes[0].mergeError, /AssertionError: 3 != 4/);
});

test("the baseline's failure is reported with the gate's output, and an environment problem in it is named", async () => {
  const out = "ConnectionRefusedError: [Errno 111] Connection refused\nFAILED (errors=1)";
  const { result } = await run({ baseline: true, baselineDir: "/tmp/ptk-integration/b", lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "baseline" ? { fail: "Run 'baseline' failed: Acceptance verification 'baseline' failed.", out } : {}));
  assert.match(result.baseline.error, /Connection refused/);
  assert.equal(result.baseline.envProblem.kind, "service not reachable");
});

test("baseline false: a code failure goes to the workers as known, but an environment problem still stops the run", async () => {
  const code = "FAILED tests/test_total.py::test_sum - AssertionError: 3 != 4";
  const fix = await run({ baseline: "env", baselineDir: "/tmp/ptk-integration/b", lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "baseline" ? { fail: "Run 'baseline' failed.", out: code } : {}));
  assert.equal(fix.result.lanes[0].state, "passed", "the run goes ahead: it is meant to fix that");
  assert.match(fix.calls.find((c) => c.key === "a-work")!.item.task, /The gate already fails on the unchanged code.*AssertionError: 3 != 4.*leave them alone: they are not caused by you/s);
  const env = await run({ baseline: "env", baselineDir: "/tmp/ptk-integration/b", lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "baseline" ? { fail: "Run 'baseline' failed.", out: "ConnectionRefusedError: [Errno 111] Connection refused" } : {}));
  assert.equal(env.result.state, "baseline-failed");
  assert.ok(!env.calls.some((c) => c.key === "a-work"));
  assert.match(env.result.next, /baseline: false does not cover an environment problem/);
});

test("baseline: never in the lead's checkout; without a clean worktree for it, it is skipped", async () => {
  const { calls, result } = await run({ baseline: true, lanes: planLanes([task("a", ["a.py"])]) });
  assert.ok(!calls.some((c) => c.key === "baseline"), "no worktree for it: not run in the lead's checkout");
  assert.equal(result.lanes[0].state, "passed");
  const withDir = await run({ baseline: true, baselineDir: "/tmp/ptk-integration/b-1", lanes: planLanes([task("a", ["a.py"])]) });
  assert.equal(withDir.calls.find((c) => c.key === "baseline")!.item.cwd, "/tmp/ptk-integration/b-1");
});

test("breaker: a lane that recovered frees its cause; a later lane with the same failure still gets its rounds", async () => {
  const out = "FAILED tests/test_shared.py::test_db - assert 1 == 2";
  // b starts only after a is merged: a failed once with this output, then passed
  const lanes = planLanes([task("a", ["a.py"]), { ...task("b", ["b.py"]), dependsOn: ["a"] }], Infinity, false);
  const { result, calls } = await run({ lanes, integration: { branch: "ptk/run-x", dir: "/tmp/ptk-integration/r-x", script: "/m.mjs" } }, (key) => (key === "a-work" || key === "b-work" ? { fail: GATE_FAIL, out } : {}));
  assert.ok(calls.some((c) => c.key === "b-gatefix-1"), "b got a fix round");
  assert.deepEqual(result.lanes.map((l: { state: string }) => l.state), ["passed", "passed"]);
  assert.deepEqual(result.causes, []);
});

test("breaker: failures without check output (a timeout, a provider error) are never one cause", async () => {
  const { result, calls } = await run({ lanes: planLanes([task("a", ["a.py"]), task("b", ["b.py"])]) }, (key) => (/-(work|gatefix-1)$/.test(key) ? { fail: "Run 'x' failed: child timed out after 7200000ms" } : {}));
  assert.ok(calls.some((c) => c.key === "a-gatefix-1") && calls.some((c) => c.key === "b-gatefix-1"), "each lane keeps its rounds");
  assert.deepEqual(result.causes, []);
});

test("breaker: lane variables in the gate do not hide a shared failure (the signature is the check's output)", async () => {
  const out = "ImportError while loading conftest '/repo/tests/conftest.py'.\nE   ImportError: cannot import name 'make_user'";
  const { result } = await run({ lanes: planLanes([task("a", ["a.py"]), task("b", ["b.py"])]), laneEnv: { portBase: 20000, portSpan: 100, run: "r" } }, (key) => (/^(a|b)-(work|gatefix)/.test(key) ? { fail: GATE_FAIL, out } : {}));
  assert.equal(result.causes.length, 1);
  assert.deepEqual(result.causes[0].lanes.sort(), ["a", "b"]);
});

test("an uncertain environment match (a missing module could be the project's own) is a hint, never a stop", async () => {
  const out = "E   ModuleNotFoundError: No module named 'httpx'";
  const lane = await run({ lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "a-work" || key === "a-gatefix-1" ? { fail: GATE_FAIL, out } : {}));
  assert.ok(lane.calls.some((c) => c.key === "a-gatefix-2"), "the same uncertain match twice does not stop the lane");
  assert.match(lane.calls.find((c) => c.key === "a-gatefix-1")!.item.task, /looks like an environment problem \(package missing/, "it is still named as a hint");
  const base = await run({ baseline: "env", baselineDir: "/tmp/ptk-integration/b", lanes: planLanes([task("a", ["a.py"])]) }, (key) => (key === "baseline" ? { fail: "x", out } : {}));
  assert.equal(base.result.lanes[0].state, "passed", "baseline false: an uncertain match goes to the workers as known");
});
