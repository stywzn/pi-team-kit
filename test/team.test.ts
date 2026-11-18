import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { buildTeamScript, cleanupTargets, patchesFromHandoff, patternsOverlap, planLanes, roleModels, validateTasks, worktreeFromHandoff, type TeamPlan, type TeamTask } from "../lib/team.ts";

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

test("planner mode: the planner splits the goal, overlapping tasks share a lane, models go to each role", async () => {
  const plannerTasks = [
    { key: "API auth", title: "Auth", brief: "Add token check", files: ["src/api/**"] },
    { key: "api-tests", title: "Auth tests", brief: "Test it", files: ["src/api/auth.test.ts"] },
    { key: "docs", title: "Docs", brief: "Document it", files: ["README.md"] },
    { key: "misc", title: "Unscoped", brief: "No files given", files: [] },
  ];
  const { calls, result } = await simulate({ lanes: [], models: { planner: "deepseek/deepseek-v4-pro", worker: "deepseek/deepseek-flash", verifier: "zai/glm-5-3" } }, (key) =>
    key === "plan"
      ? { structuredOutput: { tasks: plannerTasks, questions: [], notes: "" } }
      : key.includes("verify")
        ? { structuredOutput: { verdict: "pass", summary: "", findings: [] } }
        : {},
  );
  assert.equal(calls[0].key, "plan");
  assert.equal(calls[0].item.agent, "team-planner");
  assert.equal((calls[0].item as { model?: string }).model, "deepseek/deepseek-v4-pro");
  assert.ok(calls[0].item.outputSchema);
  // A task without files may touch anything, so everything ends up in one safe lane.
  assert.deepEqual(result.plan.tasks.map((t: { key: string }) => t.key), ["api-auth", "api-tests", "docs", "misc"]);
  assert.equal(result.lanes.length, 1);
  const work = calls.find((c) => c.key.endsWith("-work"));
  assert.equal((work?.item as { model?: string }).model, "deepseek/deepseek-flash");
  const verify = calls.find((c) => c.key.includes("verify"));
  assert.equal((verify?.item as { model?: string }).model, "zai/glm-5-3");
});

test("planner lanes match planLanes() for the same tasks", async () => {
  const tasks = [task("a", ["src/api/**"]), task("b", ["web/**"]), task("c", ["src/api/x.ts"]), task("d", ["README.md"]), task("e", ["web/app.css", "docs/x.md"])];
  const expected = planLanes(tasks).map((l) => l.tasks.map((t) => t.key));
  const { result } = await simulate({ lanes: [] }, (key) =>
    key === "plan" ? { structuredOutput: { tasks, questions: [], notes: "" } } : key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "", findings: [] } } : {},
  );
  assert.deepEqual(result.lanes.map((l: { tasks: string[] }) => l.tasks), expected);
});

test("planner with only questions returns needs-input instead of guessing", async () => {
  const { calls, result } = await simulate({ lanes: [] }, () => ({ structuredOutput: { tasks: [], questions: ["Which DB?"], notes: "" } }));
  assert.equal(calls.length, 1);
  assert.equal(result.state, "needs-input");
  assert.deepEqual(result.questions, ["Which DB?"]);
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

test("every child run gets the configured deadline (pi-subagents would stop it after 30 minutes), and a lane keeps why it was sent back", async () => {
  let reviews = 0;
  const { result, calls } = await simulate({ childTimeoutMs: 44 * 60_000 }, (key) =>
    key.includes("verify")
      ? { structuredOutput: ++reviews === 1 ? { verdict: "rework", summary: "bug", findings: [{ file: "a.py", issue: "off by one", fix: "use <=" }] } : { verdict: "pass", summary: "ok", findings: [] } }
      : {},
  );
  assert.deepEqual(calls.map((c) => c.key), ["one-work", "one-verify-1", "one-fix-1", "one-verify-2"]);
  for (const c of calls) assert.equal((c.item as { timeoutMs?: number }).timeoutMs, 2_640_000, `${c.key} has the deadline`);
  assert.deepEqual(result.lanes[0].history, [{ round: 1, findings: [{ file: "a.py", issue: "off by one", fix: "use <=" }] }]);
  const plain = await simulate({}, (key) => (key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "fine", findings: [] } } : {}));
  assert.equal((plain.calls[0].item as { timeoutMs?: number }).timeoutMs, undefined, "no setting: pi-subagents decides");
});

test("models per role: a thinking level rides on the role's model, or on the lead's when the role has none", () => {
  const flash = "deepseek/deepseek-flash";
  assert.deepEqual(roleModels({ planner: "", worker: "", verifier: "" }, { planner: "", worker: "", verifier: "" }, flash), {}, "nothing set: the agents decide");
  assert.deepEqual(roleModels({ planner: flash, worker: flash, verifier: flash }, { planner: "max", worker: "", verifier: "max" }, flash), {
    planner: `${flash}:max`,
    worker: flash,
    verifier: `${flash}:max`,
  });
  assert.deepEqual(roleModels({}, { verifier: "xhigh" }, flash), { verifier: `${flash}:xhigh` }, "no model of its own: the lead's");
  assert.deepEqual(roleModels({ planner: `${flash}:low` }, { planner: "max" }), { planner: `${flash}:max` }, "the configured level replaces a suffix");
  assert.deepEqual(roleModels({}, { planner: "max" }), {}, "no model known at all: left to the agent");
  assert.throws(() => roleModels({}, { worker: "huge" }, flash), /team\.thinking\.worker "huge": use one of off, minimal, low, medium, high, xhigh, max/);
});

test("each lane runs only its own test files; the brief carries the verifier's checklist", async () => {
  const lanes = planLanes([task("login", ["tests/test_login.py", "pages/login_page.py"]), task("cart", ["tests/my cart_test.py"]), task("util", ["utils/*.py"])]);
  let reviews = 0;
  const run = (gate: string, laneTests = true) =>
    simulate({ lanes, gate, laneTests }, (key) =>
      key.includes("verify") ? { structuredOutput: key.startsWith("login") && ++reviews === 1 ? { verdict: "rework", summary: "x", findings: [{ issue: "y" }] } : { verdict: "pass", summary: "ok", findings: [] } } : {},
    );
  const { calls } = await run("python3 -m pytest -q");
  const gateOf = (key: string) => calls.find((c) => c.key === key)?.item.gate?.command;
  assert.equal(gateOf("login-work"), "python3 -m pytest -q tests/test_login.py");
  assert.equal(gateOf("cart-work"), "python3 -m pytest -q", "a name that would need quoting: the full gate");
  assert.equal(gateOf("util-work"), "python3 -m pytest -q", "globs: the full gate");
  const fix = calls.find((c) => c.key === "login-fix-1")!;
  assert.equal(fix.item.acceptance?.verify?.[0].command, "python3 -m pytest -q tests/test_login.py", "rework rounds keep the lane's gate");
  assert.match(fix.item.task, /re-run "python3 -m pytest -q tests\/test_login\.py"/);
  const work = calls.find((c) => c.key === "login-work")!;
  assert.match(work.item.task, /check your change the way the verifier will: it does what the tasks ask; .*no file changed outside the owned list\./);
  for (const gate of ["npm test", "pytest -q && ruff check .", "python3 -m unittest discover -s tests", "make test"])
    assert.equal((await run(gate)).calls.find((c) => c.key === "login-work")?.item.gate?.command, gate, `left as written: ${gate}`);
  assert.equal((await run("python -m unittest -q")).calls.find((c) => c.key === "login-work")?.item.gate?.command, "python -m unittest -q tests/test_login.py");
  assert.equal((await run("python3 -m pytest -q", false)).calls.find((c) => c.key === "login-work")?.item.gate?.command, "python3 -m pytest -q", "laneTests off");
});

test("security: a test file name that a shell could read as code never reaches the gate (sh or cmd.exe)", async (t) => {
  // pi-subagents runs gates with shell: true, which is cmd.exe on Windows: no quoting is safe in both shells.
  const hostile = ["tests/test_a';touch PWNED;'.py", "tests/test_$(touch PWNED).py", "tests/test_`touch PWNED`.py", "tests/test_a&calc&.py", "tests/test_%PATH%.py", "tests/test_x\";touch PWNED;\".py", "tests/test_with space.py"];
  const pass = (key: string) => (key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : {});
  for (const name of hostile) {
    const lanes = planLanes([task("evil", [name, "tests/test_ok.py"])]);
    const { calls } = await simulate({ lanes, gate: "python3 -m pytest -q", laneTests: true }, pass);
    assert.equal(calls.find((c) => c.key === "evil-work")!.item.gate!.command, "python3 -m pytest -q", `full gate, name left out: ${name}`);
  }
  const option = await simulate({ lanes: planLanes([task("opt", ["-p_evil_test.py", "tests/test_ok.py"])]), gate: "python3 -m pytest -q", laneTests: true }, pass);
  assert.equal(option.calls.find((c) => c.key === "opt-work")!.item.gate!.command, "python3 -m pytest -q tests/test_ok.py", "a name starting with - is never passed (it would be an option)");
  // what does get through is plain words: run it through sh to be sure nothing is interpreted
  const ok = await simulate({ lanes: planLanes([task("ok", ["tests/test_a.py", "web/login.spec.ts", "tests/unit/test_b-c.py"])]), gate: "npx vitest run", laneTests: true }, pass);
  const command = ok.calls.find((c) => c.key === "ok-work")!.item.gate!.command;
  assert.equal(command, "npx vitest run tests/test_a.py web/login.spec.ts tests/unit/test_b-c.py");
  if (process.platform === "win32") return t.diagnostic("sh check skipped on Windows");
  const out = spawnSync("sh", ["-c", `printf '%s\\n' ${command.slice("npx vitest run ".length)}`], { cwd: mkdtempSync(join(tmpdir(), "ptk-quote-")), encoding: "utf8" });
  assert.deepEqual(out.stdout.trimEnd().split("\n"), ["tests/test_a.py", "web/login.spec.ts", "tests/unit/test_b-c.py"]);
  assert.equal(existsSync(join(tmpdir(), "PWNED")), false);
});

test("a lane that deletes its own test file falls back to the full gate instead of failing every round", async () => {
  const lanes = planLanes([task("cleanup", ["tests/test_old.py", "app/old.py"])]);
  let works = 0;
  const { result, calls } = await simulate({ lanes, gate: "python3 -m pytest -q", laneTests: true }, (key) => {
    if (key.includes("verify")) return { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } };
    if (key === "cleanup-work") return { ok: false, error: "Acceptance verification 'gate' failed: ERROR: file or directory not found: tests/test_old.py" };
    works++;
    return {};
  });
  assert.equal(calls.find((c) => c.key === "cleanup-work")!.item.gate!.command, "python3 -m pytest -q tests/test_old.py");
  const fix = calls.find((c) => c.key === "cleanup-gatefix-1")!;
  assert.equal(fix.item.acceptance?.verify?.[0].command, "python3 -m pytest -q", "next round: the full gate");
  assert.equal(result.lanes[0].state, "passed");
  assert.equal(works, 1);
  // an ordinary test failure keeps the lane's own gate
  const lanes2 = planLanes([task("login", ["tests/test_login.py"])]);
  const r2 = await simulate({ lanes: lanes2, gate: "python3 -m pytest -q", laneTests: true }, (key) =>
    key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : key === "login-work" ? { ok: false, error: "1 failed: tests/test_login.py::test_x - AssertionError" } : {},
  );
  assert.equal(r2.calls.find((c) => c.key === "login-gatefix-1")!.item.acceptance?.verify?.[0].command, "python3 -m pytest -q tests/test_login.py");
});

test("lane gates that only fail because fewer tests ran go back to the full gate; gates naming paths are kept", async () => {
  const pass = { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } };
  const firstRound = (error: string) =>
    simulate({ lanes: planLanes([task("login", ["tests/test_login.py"])]), gate: "python3 -m pytest -q", laneTests: true }, (key) =>
      key.includes("verify") ? pass : key === "login-work" ? { ok: false, error } : {},
    );
  for (const error of [
    "FAIL Required test coverage of 80% not reached. Total coverage: 12.50%",
    "ERROR: Coverage failure: total of 12 is less than fail-under=80",
    'Jest: "global" coverage threshold for lines (80%) not met: 10%',
    "No tests found, exiting with code 1",
    "no tests ran in 0.01s",
    "Error: No test files found, exiting with code 1",
  ]) {
    const { calls } = await firstRound(error);
    assert.equal(calls.find((c) => c.key === "login-gatefix-1")!.item.acceptance?.verify?.[0].command, "python3 -m pytest -q", `full gate after: ${error}`);
  }
  const keep = (gate: string, files: string[]) =>
    simulate({ lanes: planLanes([task("l", files)]), gate, laneTests: true }, (key) => (key.includes("verify") ? pass : {})).then((r) => r.calls.find((c) => c.key === "l-work")!.item.gate!.command);
  assert.equal(await keep("pytest -q tests/unit", ["tests/integration/test_db.py"]), "pytest -q tests/unit", "the gate chose its paths");
  assert.equal(await keep("pytest tests", ["tests/test_a.py"]), "pytest tests");
  assert.equal(await keep("npx playwright test", ["e2e/login.spec.ts"]), "npx playwright test e2e/login.spec.ts", "playwright's own test subcommand is not a path");
  assert.equal(await keep("uv run python -m pytest -q", ["tests/test_a.py"]), "uv run python -m pytest -q tests/test_a.py");
});

test("tasks carry a verify command, case ids and what they build on; rules reach every worker and verifier", async () => {
  const [t] = validateTasks([{ ...task("login", ["tests/test_login.py"]), verify: { cmd: "pytest tests/test_login.py -q", expect: "3 passed" }, caseIds: ["TC-101", " ", "TC-102"], uses: ["auth fixture"] }]);
  assert.deepEqual([t.verify, t.caseIds, t.uses], [{ cmd: "pytest tests/test_login.py -q", expect: "3 passed" }, ["TC-101", "TC-102"], ["auth fixture"]]);
  assert.throws(() => validateTasks([{ ...task("x", ["a.py"]), verify: { cmd: "", expect: "" } }]), /verify/);
  const { calls } = await simulate(
    { lanes: planLanes([t]), constraints: ["each test creates its own uniquely named user and deletes it in teardown"] },
    (key) => (key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : {}),
  );
  for (const key of ["login-work", "login-verify-1"]) {
    const text = calls.find((c) => c.key === key)!.item.task;
    assert.match(text, /Done when: "pytest tests\/test_login\.py -q" prints "3 passed"/, key);
    assert.match(text, /Cases: TC-101, TC-102/, key);
    assert.match(text, /Builds on: auth fixture/, key);
    assert.match(text, /- each test creates its own uniquely named user/, key);
  }
  assert.match(calls[0].item.task, /Status: DONE, DONE_WITH_CONCERNS or BLOCKED[\s\S]*Evidence:/);
});

test("the planner's rules and verify commands travel to the workers; more lanes than run at once are merged", async () => {
  const six = ["a", "b", "c", "d", "e", "f"].map((k) => ({ key: k, title: k, brief: `do ${k} and test it`, files: [`${k}.py`], verify: { cmd: `pytest test_${k}.py`, expect: "1 passed" } }));
  const { calls, result } = await simulate({ lanes: [], maxLanes: 4 }, (key) =>
    key === "plan"
      ? { structuredOutput: { tasks: six, constraints: ["no sleeps"], questions: [], notes: "" } }
      : key.includes("verify")
        ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } }
        : {},
  );
  const works = calls.filter((c) => c.key.endsWith("-work"));
  assert.equal(works.length, 4, "six independent tasks, four lanes");
  assert.equal(result.lanes.length, 4);
  assert.equal(works.reduce((n, w) => n + (w.item.task.match(/Done when:/g) ?? []).length, 0), 6, "every task keeps its verify command");
  assert.ok(works.every((w) => /- no sleeps/.test(w.item.task)));
  const lanes = planLanes(six.map((t) => ({ ...t, files: t.files })), 4);
  assert.deepEqual(lanes.map((l) => l.tasks.map((t) => t.key)), [["a", "b"], ["c", "d"], ["e"], ["f"]], "the smallest lanes are merged, order kept");
  assert.equal(planLanes(six, 1).length, 1);
});

test("a worker that reports BLOCKED goes to the lead without a review; its evidence stays with the verifier", async () => {
  const blocked = "Status: BLOCKED\nChanged files: tests/test_login.py\nEvidence: pytest -> 1 failed (account locked)\nConcerns: the shared test account is locked by another suite; tried a new user, still locked";
  const { calls, result } = await simulate({}, (key) => (key === "one-work" ? { output: blocked } : {}));
  assert.deepEqual(calls.map((c) => c.key), ["one-work"], "no verifier run");
  const lane = result.lanes[0];
  assert.equal(lane.state, "needs-human");
  assert.match(lane.summary, /shared test account is locked/);
  assert.doesNotMatch(lane.summary + lane.report, /1 failed \(account locked\)/, "the evidence is not passed to the lead");
  const done = await simulate({}, (key) =>
    key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : { output: "Status: DONE\nChanged files: a.py\nEvidence: pytest -> 5 passed\nConcerns: none" },
  );
  assert.match(done.calls[1].item.task, /Evidence: pytest -> 5 passed/, "the verifier reads it");
  assert.doesNotMatch(done.result.lanes[0].report, /5 passed/);
  assert.match(done.result.lanes[0].report, /Concerns: none/);
});

test("the same failure again: the rework says so and asks for the cause; a different one does not", async () => {
  const same = await simulate({ maxRounds: 3 }, (key) => (key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : "fail"));
  const fixes = same.calls.filter((c) => c.key.includes("gatefix"));
  assert.equal(fixes.length, 2, "retries are kept");
  assert.doesNotMatch(fixes[0].item.task, /same failure as last round/);
  assert.match(fixes[1].item.task, /same failure as last round[\s\S]*report BLOCKED/);
  assert.deepEqual(same.result.lanes[0].history.map((h: { same?: boolean }) => Boolean(h.same)), [false, true, true]);
  let n = 0;
  const other = await simulate({ maxRounds: 3 }, (key) => (key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : { ok: false, error: ["FAILED test_a - KeyError", "FAILED test_b - TimeoutError", "x"][n++] }));
  assert.ok(other.calls.filter((c) => c.key.includes("gatefix")).every((c) => !/same failure/.test(c.item.task)));
});

test("minor findings do not cost a round; a re-review checks only the fixes it asked for", async () => {
  const minor = await simulate({}, (key) => (key.includes("verify") ? { structuredOutput: { verdict: "rework", summary: "nits", findings: [{ file: "a.py:3", issue: "name could be clearer", severity: "minor" }] } } : {}));
  assert.deepEqual(minor.calls.map((c) => c.key), ["one-work", "one-verify-1"]);
  assert.equal(minor.result.lanes[0].state, "passed");
  assert.equal(minor.result.lanes[0].findings.length, 1, "the lead still sees it");
  let reviews = 0;
  const two = await simulate({}, (key) =>
    key.includes("verify")
      ? { structuredOutput: ++reviews === 1 ? { verdict: "rework", summary: "bug", findings: [{ file: "a.py:9", issue: "off by one", fix: "use <=", severity: "important" }, { file: "a.py:1", issue: "nit", severity: "minor" }] } : { verdict: "pass", summary: "ok", findings: [] } }
      : {},
  );
  const fix = two.calls.find((c) => c.key === "one-fix-1")!.item.task;
  assert.match(fix, /1\. a\.py:9: off by one -> use <=/);
  assert.doesNotMatch(fix, /\bnit\b/, "minor findings are not sent back");
  const recheck = two.calls.find((c) => c.key === "one-verify-2")!.item.task;
  assert.match(recheck, /^Re-check one lane[\s\S]*1\. a\.py:9: off by one[\s\S]*Review nothing else again/);
  assert.doesNotMatch(recheck, /Check in this order/, "not a full review again");
});
