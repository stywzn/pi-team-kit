// Regression tests for the issues found running pi-team-kit on a company Windows machine.
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { backslashSources, gitCommonDir, localProjectDataDir } from "../lib/config.ts";
import { factStatus, mergeFactFiles } from "../lib/facts.ts";
import { gatePreflight, gateProgram, isPathLike, looksUnrunnable } from "../lib/guard.ts";
import { buildTeamScript, integrationGate, parseWorktreeList, pathKey, planWorktreeCleanup, validateTasks } from "../lib/team.ts";

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

test("C1: worktree cleanup matches git's forward-slash paths to pi-subagents' backslash paths", () => {
  const porcelain = [
    "worktree C:/Users/U/code/shop",
    "HEAD 1111111",
    "branch refs/heads/main",
    "",
    "worktree C:/Users/U/code/worktrees/shop/pi-worktree-aaa-s0-0",
    "HEAD 2222222",
    "branch refs/heads/pi-subagents/calc-aaa-s0-t0",
    "",
    "worktree C:/Users/U/code/worktrees/shop/pi-worktree-bbb-s0-0",
    "HEAD 3333333",
    "detached",
    "",
    "worktree C:/Users/U/code/shop.wt/my-feature",
    "branch refs/heads/wt/my-feature",
  ].join("\r\n");
  const listed = parseWorktreeList(porcelain, true);
  assert.equal(listed.size, 4, "CRLF output parses");
  const plan = planWorktreeCleanup(
    [
      { path: "c:\\users\\u\\code\\worktrees\\shop\\PI-WORKTREE-aaa-s0-0\\", branch: "pi-subagents/calc-aaa-s0-t0" },
      { path: "C:\\Users\\U\\code\\worktrees\\shop\\pi-worktree-bbb-s0-0", branch: "pi-subagents/x-bbb-s0-t0" },
      { path: "C:\\Users\\U\\code\\worktrees\\shop\\pi-worktree-gone-s0-0", branch: "pi-subagents/gone" },
      { path: "C:\\Users\\U\\code\\shop", branch: "pi-subagents/x" },
      { path: "C:\\Users\\U\\code\\shop.wt\\my-feature", branch: "pi-subagents/x" },
      { path: "C:\\Users\\U\\code\\worktrees\\shop\\pi-worktree-aaa-s0-0", branch: "pi-subagents/calc-aaa-s0-t0" },
    ],
    listed,
    "C:\\Users\\U\\code\\shop",
    true,
  );
  assert.deepEqual(plan.remove.map((w) => [w.path, w.branch]), [["C:/Users/U/code/worktrees/shop/pi-worktree-aaa-s0-0", "pi-subagents/calc-aaa-s0-t0"]], "matched despite slashes and case, git's own spelling used, duplicates once");
  assert.deepEqual(plan.skipped.map((s) => s.reason), [
    "detached HEAD, not on the recorded branch",
    "not registered with git (already removed?)",
    "is the main checkout",
    "not a pi-subagents worktree",
  ], "the rest is reported, never silently ignored");
});

test("C1: a reused path or a foreign branch is never deleted on a name match", () => {
  const listed = parseWorktreeList("worktree /home/u/wt/pi-worktree-old-s0-0\nbranch refs/heads/pi-subagents/new-run\n", false);
  const plan = planWorktreeCleanup([{ path: "/home/u/wt/pi-worktree-old-s0-0", branch: "pi-subagents/old-run" }], listed, "/home/u/repo", false);
  assert.equal(plan.remove.length, 0);
  assert.match(plan.skipped[0].reason, /now on branch pi-subagents\/new-run, not the recorded pi-subagents\/old-run/);
  const mine = planWorktreeCleanup([{ path: "/home/u/wt/pi-worktree-old-s0-0" }], listed, "/home/u/repo", false);
  assert.match(mine.skipped[0].reason, /no pi-subagents branch recorded/);
});

test("C1: POSIX paths keep their case; trailing slashes and doubled slashes do not matter", () => {
  assert.equal(pathKey("/home/U/repo/", false), "/home/U/repo");
  assert.equal(pathKey("/home/U//repo", false), "/home/U/repo");
  assert.notEqual(pathKey("/home/U/Repo", false), pathKey("/home/U/repo", false));
  assert.notEqual(pathKey("//tmp/Repo", false), pathKey("//tmp/repo", false), "a leading // on Linux/macOS is not a case-insensitive share");
  assert.equal(pathKey("C:\\A\\b\\", false), "c:/a/b", "drive paths are Windows paths wherever they come from");
  assert.equal(pathKey("\\\\server\\Share\\x", false), "//server/share/x", "UNC written with backslashes");
  assert.equal(pathKey("//server/Share/x", true), "//server/share/x");
  assert.equal(pathKey("/", false), "/");
  assert.notEqual(pathKey("/home/u/wt/pi-worktree-x ", false), pathKey("/home/u/wt/pi-worktree-x", false), "trailing spaces are part of a path");
  const spaced = parseWorktreeList("worktree /home/u/my repo/pi-worktree-a \nbranch refs/heads/pi-subagents/a\n", false);
  assert.ok(spaced.has("/home/u/my repo/pi-worktree-a "), "porcelain paths are taken byte for byte");
});

test("C2: the gate preflight never runs a script, and looks past shell builtins", () => {
  assert.equal(gateProgram("source .venv/bin/activate && pytest -q"), "pytest");
  assert.equal(gateProgram(". venv/bin/activate; python -m unittest"), "python");
  assert.equal(gateProgram("cd api && export CI=1 && npm test"), "npm");
  assert.equal(gateProgram("./run_tests.sh"), "./run_tests.sh");
  for (const p of ["./run_tests.sh", "scripts/test", ".venv/bin/pytest", "C:\\tools\\t.bat", "./gradlew"]) assert.ok(isPathLike(p), p);
  for (const p of ["python", "py", "npm", "pytest", "go"]) assert.ok(!isPathLike(p), p);
  assert.deepEqual(gatePreflight("python -m unittest -q"), { kind: "command", program: "python" });
  assert.deepEqual(gatePreflight("./run_tests.sh"), { kind: "file", path: "./run_tests.sh" }, "a script is only checked for existence, never run");
  assert.equal(gatePreflight("source .venv/bin/activate && pytest").kind, "skip", "pytest only exists after the venv is activated");
  assert.equal(gatePreflight("cd api && ./run.sh").kind, "skip", "a path after cd cannot be resolved from the repo root");
  assert.equal(gatePreflight("export CI=1 && npm test").kind, "skip");
  assert.deepEqual(gatePreflight("CI=1 npm test"), { kind: "command", program: "npm" }, "an inline VAR=x is part of the command, not a setup step");
  assert.equal(gatePreflight("$PYTHON -m pytest").kind, "skip", "quoting would stop $PYTHON from expanding");
  assert.equal(gatePreflight("~/venv/bin/pytest").kind, "skip");
  assert.equal(gatePreflight("").kind, "skip");
  assert.equal(gatePreflight("2>test.log pytest").kind, "skip", "a leading redirection is not the program");
  assert.equal(gatePreflight(">out.txt npm test").kind, "skip");
  assert.ok(!looksUnrunnable(0, "warning: /etc/x: No such file or directory\nPython 3.12"), "exit 0 always runs");
  assert.ok(!looksUnrunnable(2, "flag provided but not defined: -version"), "go has no --version flag but runs");
});

test("integration reuses the gate the team run used, unless told otherwise", () => {
  assert.equal(integrationGate({ runGate: "npm run test:e2e", configured: "npm test", detected: "npm test" }), "npm run test:e2e");
  assert.equal(integrationGate({ explicit: "make ci", runGate: "npm run test:e2e" }), "make ci");
  assert.equal(integrationGate({ runGate: "", configured: "", detected: "python -m unittest -q" }), "python -m unittest -q");
  assert.equal(integrationGate({ skip: true, runGate: "npm test" }), "");
  assert.equal(integrationGate({}), "");
});

test("C3: a timed-out fact check is unknown, not stale", () => {
  assert.equal(factStatus({ code: null, timedOut: true, missingShell: false }), "unknown");
  assert.equal(factStatus({ code: null, timedOut: false, missingShell: true }), "unknown");
  assert.equal(factStatus({ code: null, timedOut: false, missingShell: false }), "unknown", "aborted: no exit code, no verdict");
  assert.equal(factStatus({ code: 1, timedOut: false, missingShell: false }), "stale");
  assert.equal(factStatus({ code: 0, timedOut: false, missingShell: false }), "fresh");
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
