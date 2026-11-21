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

test("batch-1 guards add almost nothing: stale-write check, leases, environment failures, self-check", async () => {
  const { mkdtempSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { SeenFiles } = await import("../lib/stale.ts");
  const { newLease, readLeases, writeLease, leaseConflict } = await import("../lib/leases.ts");
  const { envFailure } = await import("../lib/envfail.ts");
  const { LeadSelfCheck } = await import("../lib/selfcheck.ts");
  const dir = mkdtempSync(join(tmpdir(), "ptk-perf1-"));
  const big = join(dir, "big.py");
  writeFileSync(big, "x = 1\n".repeat(170_000)); // about 1 MB
  const seen = new SeenFiles();
  const stale = avgMs(() => {
    seen.saw(big);
    seen.writeProblem(big, "big.py");
  }, 50);
  assert.ok(stale < 25, `reading and checking a 1 MB file took ${stale.toFixed(2)} ms`);
  const leases = join(dir, "leases");
  const alive = new Set<string>();
  for (let i = 0; i < 100; i++) {
    alive.add(`h:${i}:x`);
    writeLease(leases, newLease({ owner: `h:${i}:x`, lead: `l${i}`, repo: "/r/.git", paths: [`src/m${i}/**`, `docs/${i}.md`], reason: "r", kind: "claim" }, 60));
  }
  const lease = avgMs(() => leaseConflict(readLeases(leases, alive), "me", "/r/.git", "src/m77/deep/file.py"), 50);
  assert.ok(lease < 30, `reading 100 leases and checking one edit took ${lease.toFixed(2)} ms`);
  const log = "PASSED tests/test_x.py::test_y\n".repeat(20_000) + "E   ConnectionRefusedError: [Errno 111] Connection refused\n";
  const env = avgMs(() => envFailure(log), 50);
  assert.ok(env < 15, `classifying a 20,000-line failure took ${env.toFixed(2)} ms`);
  const s = new LeadSelfCheck({ enabled: true, reviewAfter: 3 });
  assert.ok(avgMs(() => { s.edited("src/a.py"); s.ran("pytest -q tests/test_a.py"); }, 2000) < 0.2);
});

test("batch 2-3 stay cheap: sending with receipts and duplicate checks, tasks, the ledger, lane broadcasts", async () => {
  const { mkdtempSync, mkdirSync, writeFileSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { join } = await import("node:path");
  const { sendMessage, writeCard } = await import("../lib/board.ts");
  const { addTask, readTasks, taskState } = await import("../lib/xtasks.ts");
  const { addEntry, readLedger, ledgerBlock } = await import("../lib/ledger.ts");
  const { appendBroadcast, readBroadcasts, newBroadcasts } = await import("../lib/broadcast.ts");
  const dir = mkdtempSync(join(tmpdir(), "ptk-perf2-"));
  const now = Date.now();
  for (const n of ["api", "web"]) writeCard(dir, { name: n, owner: `h:${n}`, cwd: "/c", status: "", working: false, files: [], startedAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() });
  mkdirSync(join(dir, "receipts"), { recursive: true });
  for (let i = 0; i < 2000; i++) {
    const id = `${(now - i * 1000).toString(36).padStart(8, "0")}${String(i % 10000).padStart(4, "0")}`;
    writeFileSync(join(dir, "receipts", `${id}.json`), JSON.stringify({ id, from: i % 2 ? "api" : "web", to: "web", thread: id, n: 1, update: false, text: `m${i}`, at: new Date(now - i * 1000).toISOString(), state: "delivered" }));
  }
  let k = 0;
  const send = avgMs(() => sendMessage(dir, { from: "api", to: "web", text: `news ${k++}`, update: false, hops: 0 }, now + k), 30);
  assert.ok(send < 40, `a send with 2000 receipts on the board took ${send.toFixed(2)} ms`);
  for (let i = 0; i < 60; i++) addTask(dir, { title: `task ${i}`, lead: i % 2 ? "api" : "web" }, now + i);
  const tasks = avgMs(() => {
    const all = readTasks(dir);
    for (const t of all) taskState(t, all);
  }, 30);
  assert.ok(tasks < 20, `reading and judging 60 tasks took ${tasks.toFixed(2)} ms`);
  const ledger = join(dir, "ledger");
  for (let i = 0; i < 40; i++) addEntry(ledger, { kind: "rule", text: `rule ${i}: every test creates its own data`, by: "a" });
  assert.ok(avgMs(() => ledgerBlock(readLedger(ledger)), 30) < 15, "the ledger block for every turn is cheap");
  const bc = join(dir, "git", "broadcast.jsonl");
  for (let i = 0; i < 200; i++) appendBroadcast(bc, { run: "r", lane: `l${i % 4}`, kind: "environment", text: `fact ${i}` }, now + i);
  assert.ok(avgMs(() => newBroadcasts(readBroadcasts(bc), "r", "l0", 0, new Set()), 30) < 10, "reading 200 broadcasts is cheap");
});
