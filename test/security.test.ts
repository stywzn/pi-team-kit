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
  const result = await new AsyncFunction("runs", script)(runs);
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
