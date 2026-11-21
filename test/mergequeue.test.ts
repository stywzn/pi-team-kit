import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { buildTeamScript, planLanes, type TeamPlan, type TeamTask } from "../lib/team.ts";

const here = dirname(fileURLToPath(import.meta.url));
const script = join(here, "..", "bin", "merge-lane.mjs");
const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", ...args], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};

test("merge-lane.mjs: applies a lane's worktree (staged and unstaged, new files) on the integration worktree, refuses a conflict cleanly", () => {
  const base = mkdtempSync(join(tmpdir(), "ptk-mq-"));
  const repo = join(base, "repo");
  mkdirSync(repo);
  git(repo, "init", "-q");
  writeFileSync(join(repo, "calc.py"), "def add(a, b):\n    return a + b\n");
  writeFileSync(join(repo, "README.md"), "# demo\n");
  git(repo, "add", ".");
  git(repo, "commit", "-qm", "init");
  const head = git(repo, "rev-parse", "HEAD");
  const int = join(base, "int");
  git(repo, "worktree", "add", "-q", "-b", "ptk/run-test", int, "HEAD");
  const lane = (name: string, edit: (wt: string) => void) => {
    const wt = join(base, name);
    git(repo, "worktree", "add", "-q", "-b", `w-${name}`, wt, "HEAD");
    edit(wt);
    const dir = join(base, `${name}-run`);
    mkdirSync(dir);
    writeFileSync(join(dir, "handoff.json"), JSON.stringify({ groups: [{ baseCommit: head, cleanup: { tasks: [{ path: wt, worktreeRemoved: false }] } }] }));
    return join(dir, "handoff.json");
  };
  const merge = (handoff: string, key: string) => spawnSync(process.execPath, [script, handoff, key], { cwd: int, encoding: "utf8" });

  const a = lane("a", (wt) => {
    writeFileSync(join(wt, "calc.py"), "def add(a, b):\n    return a + b\n\n\ndef sub(a, b):\n    return a - b\n");
    git(wt, "add", "calc.py"); // staged, as pi-subagents leaves the first round
    writeFileSync(join(wt, "test_calc.py"), "from calc import sub\nassert sub(3, 1) == 2\n"); // untracked
  });
  const ra = merge(a, "a");
  assert.equal(ra.status, 0, ra.stderr);
  assert.match(ra.stdout, /merge a: applied \(2 files changed/);
  git(int, "commit", "-qm", "ptk: a");
  assert.match(readFileSync(join(int, "calc.py"), "utf8"), /def sub/);
  assert.match(readFileSync(join(int, "test_calc.py"), "utf8"), /sub\(3, 1\)/);

  const b = lane("b", (wt) => writeFileSync(join(wt, "README.md"), "# demo\n\nUsage: add, sub.\n"));
  assert.equal(merge(b, "b").status, 0, "a lane on other files applies on top of the first");
  git(int, "commit", "-qm", "ptk: b");

  const c = lane("c", (wt) => writeFileSync(join(wt, "calc.py"), "def add(a, b):\n    return b + a  # changed differently\n\n\ndef mul(a, b):\n    return a * b\n"));
  const rc = merge(c, "c");
  assert.equal(rc.status, 1);
  assert.match(rc.stderr, /merge c: does not apply on top of the lanes merged before it/);
  assert.equal(git(int, "status", "--porcelain"), "", "a refused lane leaves the integration worktree clean");
  assert.equal(git(int, "log", "--format=%s", "-2"), "ptk: b\nptk: a");

  // A lane that failed its gate after applying leaves changes behind: the next merge starts from the last commit.
  writeFileSync(join(int, "leftover.txt"), "from a lane whose gate failed\n");
  writeFileSync(join(int, "README.md"), "dirty\n");
  const d = lane("d", (wt) => writeFileSync(join(wt, "notes.md"), "notes\n"));
  assert.equal(merge(d, "d").status, 0);
  assert.equal(git(int, "status", "--porcelain"), "A  notes.md", "only the new lane's change is there");
  const empty = lane("e", () => {});
  assert.match(merge(empty, "e").stdout, /merge e: no changes/);
  assert.match(spawnSync(process.execPath, [script, join(base, "missing.json"), "x"], { cwd: int, encoding: "utf8" }).stderr, /cannot read/);
});

const task = (key: string, files: string[], dependsOn?: string[]): TeamTask => ({ key, title: `Task ${key}`, brief: `Change ${files[0]} for ${key}.`, files, ...(dependsOn ? { dependsOn } : {}) });

test("with the merge queue a dependent task gets its own lane that waits for the other; circles become one lane", () => {
  const tasks = [task("core", ["src/core.py"]), task("bench", ["bench/run.py"], ["core"]), task("docs", ["README.md"]), task("cli", ["src/cli.py"], ["core", "docs"])];
  const lanes = planLanes(tasks, Infinity, false);
  assert.deepEqual(lanes.map((l) => [l.key, l.after ?? []]), [["core", []], ["bench", ["core"]], ["docs", []], ["cli", ["core", "docs"]]]);
  assert.deepEqual(planLanes(tasks).map((l) => l.key), ["core-plus3"], "without it, tasks that depend on each other share one lane (as before)");
  const circle = planLanes([task("a", ["a.py"], ["d"]), task("b", ["b.py"]), task("c", ["a.py"]), task("d", ["d.py"], ["c"])], Infinity, false);
  // a and c share a.py (one lane) and wait on d, which waits on c: one lane for all three.
  assert.deepEqual(circle.map((l) => [l.tasks.map((t) => t.key).sort(), l.after ?? []]), [[["a", "c", "d"], []], [["b"], []]]);
});

// ---- the generated workflow with the merge queue, against a fake pi-subagents `runs` object ----
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<any>;
type Call = { key: string; item: { agent?: string; cwd?: string; baseRef?: string; gate?: { command: string }; acceptance?: { level: string; evidence?: string[]; verify?: { command: string }[] }; task: string } };

async function run(plan: Partial<TeamPlan>, respond: (key: string) => Record<string, unknown> | "fail" = () => ({})) {
  const full: TeamPlan = {
    goal: "goal",
    lanes: [],
    gate: "python3 -m pytest -q",
    gateTimeoutSec: 60,
    maxRounds: 2,
    workerAgent: "team-worker",
    verifierAgent: "team-verifier",
    integration: { branch: "ptk/run-abc", dir: "/tmp/ptk-integration/demo-abc", script: "/pkg/bin/merge-lane.mjs" },
    ...plan,
  };
  const calls: Call[] = [];
  const order: string[] = [];
  const byKey = new Map<string, number>();
  const runs = {
    run: async (key: string, item: Call["item"]) => {
      calls.push({ key, item });
      byKey.set(key, calls.length);
      await new Promise((r) => setTimeout(r, key.endsWith("-merge") ? 5 : 1));
      order.push(key);
      const r = key.includes("verify") ? { structuredOutput: { verdict: "pass", summary: "ok", findings: [] } } : respond(key);
      if (r === "fail") throw new Error(`Run '${key}' failed: Acceptance verification 'gate' failed.`);
      return { ok: true, runId: `run-${calls.length}`, artifactPaths: [`/runs/${calls.length}`], output: "done", ...r };
    },
    status: async (key: string) => ({ runId: `run-${byKey.get(key)}`, artifactPaths: [], output: "" }),
  };
  const result = await new AsyncFunction("runs", buildTeamScript(full))(runs);
  return { result, calls, order };
}

test("merge queue: passed lanes are merged one at a time in the integration worktree, with the full gate and a commit", async () => {
  const { result, calls } = await run({ lanes: planLanes([task("a", ["a.py"]), task("b", ["b.py"])], Infinity, false) });
  const merges = calls.filter((c) => c.key.endsWith("-merge"));
  assert.deepEqual(merges.map((m) => m.key).sort(), ["a-merge", "b-merge"]);
  for (const m of merges) {
    assert.equal(m.item.cwd, "/tmp/ptk-integration/demo-abc");
    assert.equal(m.item.agent, "team-merger");
    assert.equal(m.item.gate, undefined, "no gate shorthand: the merge is the acceptance check");
    assert.deepEqual([m.item.acceptance!.level, m.item.acceptance!.evidence], ["verified", ["manual-notes"]]);
    assert.match(m.item.acceptance!.verify![0].command, /^node "\/pkg\/bin\/merge-lane\.mjs" "\/runs\/\d+\/handoff\.json" [ab] && python3 -m pytest -q && git -c user\.name=pi-team-kit .* commit -q --no-verify --allow-empty -m "ptk: [ab]"$/);
  }
  assert.ok(result.lanes.every((l: { merged: boolean }) => l.merged));
  assert.deepEqual(result.integration.merged.sort(), ["a", "b"]);
  assert.equal(result.integration.runDirs.length, 2);
  assert.match(result.next, /merged one at a time into branch ptk\/run-abc.*integration\.runDirs/);
});

test("merge queue: a lane that needs another starts after it is merged, from the integration branch", async () => {
  const lanes = planLanes([task("core", ["src/core.py"]), task("bench", ["bench/run.py"], ["core"]), task("docs", ["README.md"])], Infinity, false);
  const { calls, order, result } = await run({ lanes });
  const benchWork = calls.find((c) => c.key === "bench-work")!;
  assert.equal(benchWork.item.baseRef, "refs/heads/ptk/run-abc");
  assert.equal(calls.find((c) => c.key === "core-work")!.item.baseRef, undefined, "independent lanes start from HEAD");
  assert.ok(order.indexOf("core-merge") >= 0, "core was merged");
  assert.ok(calls.findIndex((c) => c.key === "bench-work") > calls.findIndex((c) => c.key === "core-merge"), "bench starts only after core is merged");
  assert.deepEqual(result.integration.merged.slice(-1), ["bench"], "the dependent lane is merged last");
});

test("merge queue: a lane whose gate fails on the combined code is not merged, and what needs it is skipped", async () => {
  const lanes = planLanes([task("core", ["src/core.py"]), task("bench", ["bench/run.py"], ["core"]), task("docs", ["README.md"])], Infinity, false);
  const { result, calls } = await run({ lanes }, (key) => (key === "core-merge" ? "fail" : {}));
  const byLane = Object.fromEntries(result.lanes.map((l: { lane: string }) => [l.lane, l]));
  assert.equal(byLane.core.state, "passed");
  assert.equal(byLane.core.merged, false);
  assert.match(byLane.core.mergeError, /gate/);
  assert.equal(byLane.bench.state, "skipped");
  assert.deepEqual(byLane.bench.waitedFor, ["core"]);
  assert.ok(!calls.some((c) => c.key === "bench-work"), "no worker is spent on a lane whose base is missing");
  assert.equal(byLane.docs.merged, true, "other lanes go on");
  assert.deepEqual(result.integration.merged, ["docs"]);
});

test("without the merge queue nothing is merged in the run and the result says to integrate as before", async () => {
  const { result, calls } = await run({ integration: undefined, lanes: planLanes([task("a", ["a.py"])]) });
  assert.ok(!calls.some((c) => c.key.endsWith("-merge")));
  assert.equal(result.integration, null);
  assert.match(result.next, /runDir of each passed lane/);
});

test("planner lanes match planLanes() with the merge queue too", async () => {
  const tasks = [task("core", ["src/core.py"]), task("bench", ["bench/run.py"], ["core"]), task("ui", ["web/a.ts"]), task("cli", ["src/cli.py"], ["core"])].map((t) => ({ ...t, verify: { cmd: "pytest -q", expect: "passed" } }));
  const expected = planLanes(tasks, 4, false).map((l) => [l.key, l.after ?? []]);
  const { calls } = await run({ lanes: [], maxLanes: 4 }, (key) => (key === "plan" ? { structuredOutput: { tasks, questions: [], notes: "" } } : {}));
  const started = calls.filter((c) => c.key.endsWith("-work")).map((c) => c.key.replace(/-work$/, ""));
  assert.deepEqual(started.sort(), expected.map((e) => e[0] as string).sort());
  assert.equal(calls.find((c) => c.key === "bench-work")!.item.baseRef, "refs/heads/ptk/run-abc");
});
