// Things an untrusted repo, a hostile brief or a careless model must not be able to do.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { loadConfig } from "../lib/config.ts";
import { buildTeamScript, planLanes, validateTasks } from "../lib/team.ts";
import { addTool } from "../lib/toolbox.ts";
import { withAll } from "./fakeruns.ts";

const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor as new (...args: string[]) => (...a: unknown[]) => Promise<any>;
const ROOT = resolve(import.meta.dirname, "..");

test("task text cannot break out of the generated workflow script", async () => {
  const evil = 'x"; throw new Error("pwned"); "` ${process.exit(1)} </script> \\u0022   end';
  const tasks = validateTasks([{ key: "a", title: evil.slice(0, 100), brief: `Brief with payload: ${evil}`, files: ["a.py"] }]);
  const script = buildTeamScript({ goal: evil, lanes: planLanes(tasks), gate: "true", gateTimeoutSec: 5, maxRounds: 1, workerAgent: "w", verifierAgent: "v" });
  const seen: string[] = [];
  const runs = {
    run: async (_key: string, item: { task: string }) => {
      seen.push(item.task);
      return { ok: true, runId: "r", artifactPaths: ["/r"], output: "", structuredOutput: { verdict: "pass", summary: "", findings: [] } };
    },
    status: async () => ({}),
  };
  const result = await new AsyncFunction("runs", script)(withAll(runs));
  assert.equal(result.goal, evil, "goal survives verbatim");
  assert.ok(seen[0].includes(evil), "brief reaches the worker verbatim");
});

test("lane keys and file ownership are sanitised", () => {
  const [t] = validateTasks([{ key: "../../etc; rm -rf /", title: "t", brief: "a long enough brief here", files: ["src/a.ts"] }]);
  assert.match(t.key, /^[a-z0-9-]+$/);
  assert.throws(() => validateTasks([{ key: "a", title: "t", brief: "a long enough brief here", files: ["../outside.txt"] }]), /relative/);
  assert.throws(() => validateTasks([{ key: "a", title: "t", brief: "a long enough brief here", files: ["/etc/passwd"] }]), /relative/);
});

test("toolbox names cannot escape the toolbox directory", () => {
  const root = mkdtempSync(join(tmpdir(), "ptk-sec-"));
  writeFileSync(join(root, "s.sh"), "echo hi\n");
  for (const name of ["../evil", "a/b", "..", "UPPER", ""]) assert.throws(() => addTool(join(root, "tb"), { name, description: "d", usage: "", source: "s.sh" }, root), /name/);
});

test("bg refuses names that are paths", () => {
  const r = spawnSync(process.execPath, [join(ROOT, "toolbox", "bg", "run.mjs"), "start", "../../x", "--", "true"], { encoding: "utf8" });
  assert.notEqual(r.status, 0);
  assert.match(r.stdout + r.stderr, /usage/);
});

test("an untrusted project's .pi/ptk.json is ignored", () => {
  const repo = mkdtempSync(join(tmpdir(), "ptk-untrusted-"));
  mkdirSync(join(repo, ".git"));
  mkdirSync(join(repo, ".pi"));
  writeFileSync(join(repo, ".pi", "ptk.json"), JSON.stringify({ guard: { enabled: false } }));
  const env = { PI_CODING_AGENT_DIR: join(repo, "no-agent-dir") };
  assert.equal(loadConfig(repo, env, false).config.guard.enabled, true, "untrusted: guard stays on");
  assert.equal(loadConfig(repo, env, true).config.guard.enabled, false, "trusted: project may configure it");
});

test("a lease cannot reach outside the board folder or the repo, and a hostile lease file is ignored", async () => {
  const { readdirSync } = await import("node:fs");
  const { newLease, readLeases, writeLease, removeLeases, leaseConflict } = await import("../lib/leases.ts");
  const dir = mkdtempSync(join(tmpdir(), "ptk-sec-lease-"));
  const owner = "../../etc/x:1:a";
  writeLease(dir, newLease({ owner, lead: "x", repo: "/r/.git", paths: ["a.py"], reason: "", kind: "claim" }, 10));
  assert.deepEqual(readdirSync(dir).filter((f) => f.endsWith(".json")).length, 1, "the owner id cannot steer the file name out of the folder");
  assert.ok(readdirSync(dir).every((f) => !f.includes("/") && !f.includes("..")));
  for (const p of ["../outside.py", "/etc/passwd", "C:/Windows/x", "a/../../b"]) assert.throws(() => newLease({ owner: "o", lead: "x", repo: "/r/.git", paths: [p], reason: "", kind: "claim" }, 10), /relative to the repo root/, p);
  writeFileSync(join(dir, "evil.json"), JSON.stringify({ id: "e", owner: "o", repo: "/r/.git", until: new Date(Date.now() + 60_000).toISOString(), paths: "not-an-array" }));
  writeFileSync(join(dir, "evil2.json"), JSON.stringify({ id: "e2", owner: "o", repo: "/r/.git", until: new Date(Date.now() + 60_000).toISOString(), paths: ["**", 7, null] }));
  const leases = readLeases(dir, new Set(["o", owner]));
  assert.ok(leases.every((l) => l.paths.every((p) => typeof p === "string")));
  assert.equal(leaseConflict(leases, "me", "/r/.git", "x.py")?.id, "e2", "a malformed path list is cleaned, not trusted blindly");
  assert.equal(removeLeases(dir, "someone-else"), 0, "nobody removes another session's lease");
});

test("a worker's report cannot inject code into the workflow through Discoveries or an environment error", async () => {
  const evil = '"); process.exit(1); ("` ${globalThis.pwned = 1}';
  const tasks = validateTasks([{ key: "a", title: "A", brief: "Change a.py: add the function f.", files: ["a.py"] }]);
  const script = buildTeamScript({ goal: "g", lanes: planLanes(tasks), gate: "true", gateTimeoutSec: 5, maxRounds: 1, workerAgent: "w", verifierAgent: "v", baseline: true });
  const runs = {
    run: async (key: string) => {
      if (key === "baseline") return { ok: true, runId: "b", artifactPaths: ["/b"], output: "" };
      return { ok: true, runId: "r", artifactPaths: ["/r"], output: `Status: DONE\nDiscoveries:\n- ${evil}\n- Error: listen EADDRINUSE ${evil}\nEvidence: x`, structuredOutput: { verdict: "pass", summary: "", findings: [] } };
    },
    status: async () => ({}),
  };
  const result = await new AsyncFunction("runs", script)(withAll(runs));
  assert.equal((globalThis as { pwned?: number }).pwned, undefined);
  assert.equal(result.lanes[0].discoveries[0], evil, "kept as text, verbatim");
});

test("lane variables never carry shell code: values that are not plain words are left out", async () => {
  const lanes = planLanes(validateTasks([{ key: "a", title: "A", brief: "Change a.py: add the function f.", files: ["a.py"] }]));
  // a forged run stamp (the extension makes it from Date.now) and a lane key that validateTasks would never allow
  const evil = [{ ...lanes[0], key: 'a$(touch /tmp/pwned)"' }];
  const script = buildTeamScript({ goal: "g", lanes: evil, gate: "pytest -q", gateTimeoutSec: 5, maxRounds: 1, workerAgent: "w", verifierAgent: "v", laneEnv: { portBase: 20000, portSpan: 100, run: "x; rm -rf /" } });
  const gates: string[] = [];
  const envs: Record<string, string>[] = [];
  const tasks: string[] = [];
  const runs = {
    run: async (_key: string, item: { task: string; gate?: { command: string; env?: Record<string, string> } }) => {
      if (item.gate) {
        gates.push(item.gate.command);
        envs.push(item.gate.env ?? {});
        tasks.push(item.task);
      }
      return { ok: true, runId: "r", artifactPaths: ["/r"], output: "", structuredOutput: { verdict: "pass", summary: "", findings: [] } };
    },
    status: async () => ({}),
  };
  await new AsyncFunction("runs", script)(withAll(runs));
  assert.equal(gates.length, 1);
  assert.equal(gates[0], "pytest -q", "nothing is put in front of the command");
  assert.deepEqual(envs[0], { PTK_LANE_INDEX: "0", PTK_PORT_BASE: "20000", PTK_PORT_SPAN: "100", PTK_DB_SUFFIX: "_a_touch_tmp_pwned_" }, "the forged run stamp and lane key are left out; the suffix is made a plain word");
  assert.doesNotMatch((tasks[0].split("[ptk-lane-env]")[1] ?? "").split("\n")[0], /rm -rf|\$\(|;|"/, "nor do they reach the worker's environment line");
});

test("ledger ids, task ids and message ids cannot reach outside their folders", async () => {
  const { addEntry, dropEntry, ledgerDir } = await import("../lib/ledger.ts");
  const { finishTask, dropTask } = await import("../lib/xtasks.ts");
  const { readReceipt, markDelivered } = await import("../lib/board.ts");
  const data = mkdtempSync(join(tmpdir(), "ptk-sec-ids-"));
  const dir = ledgerDir(data, "/r");
  assert.throws(() => addEntry(dir, { kind: "rule", text: "x", id: "../../evil", by: "a" }), /lowercase letters/);
  assert.equal(dropEntry(dir, "../../../etc/passwd"), false);
  assert.throws(() => finishTask(data, "../../x", "a"), /no task/);
  assert.equal(dropTask(data, "../../x", "a"), false);
  assert.equal(readReceipt(data, "../../etc/passwd"), undefined);
  markDelivered(data, ["../../etc/passwd", "a/b"]); // never throws, never writes outside
});
