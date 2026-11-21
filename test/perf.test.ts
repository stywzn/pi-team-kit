// The guard runs before every bash call and env detection at every session start: both must stay cheap.
// Budgets are generous (CI machines are slow); a failure here means something went quadratic or started spawning.
import assert from "node:assert/strict";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { findRepoRoot } from "../lib/config.ts";
import { detectEnv, realProbe } from "../lib/env.ts";
import { classifyCommand, inspectBash } from "../lib/guard.ts";
import { buildTeamScript, planLanes, validateTasks } from "../lib/team.ts";
import { unexplainedAcronyms } from "../lib/plain.ts";

const opts = {
  blockLongRunners: true,
  preferFastSearch: "block" as const,
  sudoNonInteractive: true,
  hasRg: true,
  hasFd: true,
  builtinSearch: { grep: true, find: true },
  pitfalls: Array.from({ length: 40 }, (_, i) => ({ id: `p${i}`, match: `tool${i} --flag`, action: "warn" as const, message: "m" })),
  cwd: "/repo",
};

const COMMANDS = [
  "npm test",
  "git status && git diff --stat",
  "cd web && npm run build 2>&1 | tail -20",
  `bash -c "pytest -q tests/test_api.py"`,
  "cat > x.sh <<'EOF'\nnpm run dev\nEOF\nchmod +x x.sh",
  "docker compose up -d && sleep 2 && curl -s localhost:8080/health",
  `python - <<'PY'\nimport json\nprint(json.dumps({"a": 1}))\nPY`,
  "rg -n 'TODO|FIXME' src | head -50",
];

function avgMs(fn: () => void, n: number): number {
  for (let i = 0; i < 50; i++) fn(); // warm up
  const t0 = performance.now();
  for (let i = 0; i < n; i++) fn();
  return (performance.now() - t0) / n;
}

test("guard decision per bash call stays well under a millisecond", () => {
  let i = 0;
  const ms = avgMs(() => {
    const cmd = COMMANDS[i++ % COMMANDS.length];
    inspectBash(cmd, opts);
    classifyCommand(cmd);
  }, 5000);
  assert.ok(ms < 0.5, `inspect+classify took ${ms.toFixed(4)} ms per command`);
});

test("a 20 KB command does not slow the guard down", () => {
  const big = `echo ${"x".repeat(20_000)} && npm test`;
  const ms = avgMs(() => inspectBash(big, opts), 200);
  assert.ok(ms < 5, `20 KB command took ${ms.toFixed(3)} ms`);
});

test("environment detection at session start is fast and spawns nothing", () => {
  const cwd = process.cwd();
  const ms = avgMs(() => detectEnv(realProbe(cwd, findRepoRoot(cwd), [])), 20);
  // Windows runners stat a long PATH slowly (~110 ms seen). Spawning anything would cost far more than either budget.
  const budget = process.platform === "win32" ? 400 : 150;
  assert.ok(ms < budget, `detectEnv took ${ms.toFixed(1)} ms (budget ${budget})`);
});

test("planning and script generation for 12 tasks is instant", () => {
  const tasks = validateTasks(Array.from({ length: 12 }, (_, i) => ({ key: `t${i}`, title: `Task ${i}`, brief: "Do the thing and add a test.", files: [`src/m${i % 7}/**`] })));
  const ms = avgMs(() => buildTeamScript({ goal: "g", lanes: planLanes(tasks), gate: "npm test", gateTimeoutSec: 60, maxRounds: 3, workerAgent: "w", verifierAgent: "v" }), 500);
  assert.ok(ms < 2, `plan+script took ${ms.toFixed(3)} ms`);
});

test("acronym check on a long reply is cheap", () => {
  const reply = "The API returns JSON; see RFC 9110 and the QA notes. ".repeat(400);
  const ms = avgMs(() => unexplainedAcronyms(reply), 50);
  assert.ok(ms < 20, `acronym check took ${ms.toFixed(2)} ms`);
});

test("the worker watch adds almost nothing to a tool call", async () => {
  const { WorkerWatch, DEFAULT_WATCH, isReadOnlyCommand } = await import("../lib/progress.ts");
  const w = new WorkerWatch(DEFAULT_WATCH, ["src/**", "tests/test_api.py"]);
  let i = 0;
  const ms = avgMs(() => {
    const cmd = COMMANDS[i++ % COMMANDS.length];
    w.before("bash", { command: cmd });
    w.after("bash", { command: cmd }, i % 5 === 0, "FAILED tests/test_api.py::test_x - AssertionError: 1 != 2\n".repeat(20));
    w.before("edit", {}, "src/app/main.py");
    w.after("edit", {}, false, "ok");
  }, 2000);
  assert.ok(ms < 0.5, `four watch checks took ${ms.toFixed(3)} ms`);
  assert.ok(avgMs(() => isReadOnlyCommand("cd app && rg -n parse src | head -20 && git log --oneline -5"), 2000) < 0.1);
});
