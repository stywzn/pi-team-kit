import assert from "node:assert/strict";
import { test } from "node:test";
import { partTask } from "../lib/nested.ts";
import { commandKey, DEFAULT_WATCH, failureSignature, isReadOnlyCommand, ownedFiles, ownsPath, WorkerWatch } from "../lib/progress.ts";
import { buildTeamScript, planLanes } from "../lib/team.ts";

test("read-only commands: looking is not changing", () => {
  for (const c of ["cat a.py", "rg -n parse src | head -20", "git log --oneline -5", "git diff HEAD~1", "sed -n 1,40p a.py", "cd app && ls -la && wc -l *.py", "find . -name '*.py' 2>/dev/null", "awk '{print $1}' f.txt"])
    assert.equal(isReadOnlyCommand(c), true, c);
  for (const c of ["pytest -q", "sed -i s/a/b/ a.py", "echo x > a.txt", "cat a | tee b", "git checkout -b x", "python gen.py", "npm install", "awk 'BEGIN{system(\"rm x\")}'", "rm -rf build"])
    assert.equal(isReadOnlyCommand(c), false, c);
});

test("owned files come from the worker's and the sub-worker's task text", () => {
  const plan = { goal: "g", lanes: planLanes([{ key: "a", title: "A", brief: "Change src/a.py", files: ["src/a.py", "tests/**"] }]), gate: "", gateTimeoutSec: 60, maxRounds: 2, workerAgent: "w", verifierAgent: "v" };
  const script = buildTeamScript(plan);
  assert.match(script, /Files you own/);
  const work = "You are one worker...\n\nFiles you own (edit only these; new files only inside them):\n- src/a.py\n- tests/**\n\nRules: ...";
  assert.deepEqual(ownedFiles(work), ["src/a.py", "tests/**"]);
  const part = partTask("goal", { key: "p1", title: "Square", brief: "shapes/square.py", files: ["shapes/square.py", "tests/test_square.py"] }, []);
  assert.deepEqual(ownedFiles(part), ["shapes/square.py", "tests/test_square.py"]);
  assert.equal(ownedFiles("no list here"), undefined);
});

test("ownsPath: exact files, folders and globs", () => {
  const own = ["src/a.py", "docs", "tests/**", "web/*.ts", "pkg/{x,y}.go"];
  for (const p of ["src/a.py", "docs/x.md", "docs/sub/y.md", "tests/unit/test_a.py", "tests/test_b.py", "web/app.ts", "pkg/x.go", "./src/a.py"]) assert.equal(ownsPath(own, p), true, p);
  for (const p of ["src/b.py", "src/a.pyc", "docsx/y.md", "web/sub/app.ts", "pkg/z.go", "../other/a.py"]) assert.equal(ownsPath(own, p), false, p);
  assert.equal(ownsPath(["**"], "anything/at/all.txt"), true, "a task with no files given may touch anything");
});

test("failure signatures ignore times, counts and temp paths; command keys ignore cd and export", () => {
  assert.equal(failureSignature("FAILED tests/test_a.py::test_x - AssertionError: 3 != 4\n1 failed in 0.12s"), failureSignature("FAILED tests/test_a.py::test_x - AssertionError: 5 != 4\n1 failed in 0.98s"));
  assert.notEqual(failureSignature("ImportError: no module named foo"), failureSignature("AssertionError: x"));
  assert.equal(commandKey("export CI=1\ncd app && pytest -q  tests/test_a.py"), "pytest -q tests/test_a.py");
});

test("reading without changing: a note, then more reading is refused until a change, a check or a question", () => {
  const w = new WorkerWatch(DEFAULT_WATCH, ["src/a.py"]);
  let note: string | undefined;
  for (let i = 1; i <= 12; i++) {
    assert.equal(w.before("read", {}).block, undefined);
    note = w.after("read", {}, false, "text");
    if (i < 12) assert.equal(note, undefined);
  }
  assert.match(note!, /12 read-only calls in a row without a change\. The brief says where: src\/a\.py\. Start the change now/);
  for (let i = 13; i <= 25; i++) w.after(i % 2 ? "grep" : "bash", { command: "rg parse src" }, false, "");
  assert.match(w.before("read", {}).block!, /25 read-only calls in a row without changing anything, so more reading is refused.*contact_supervisor/);
  assert.equal(w.before("edit", {}, "src/a.py").block, undefined, "changing is always allowed");
  assert.equal(w.before("bash", { command: "pytest -q" }).block, undefined, "running a check is allowed");
  w.after("edit", {}, false, "ok");
  assert.equal(w.before("read", {}).block, undefined, "a change lifts it");
  for (let i = 0; i < 25; i++) w.after("read", {}, false, "");
  assert.ok(w.before("ls", {}).block);
  w.after("contact_supervisor", {}, false, "answer");
  assert.equal(w.before("ls", {}).block, undefined, "asking the lead lifts it");
});

test("a command that just failed is refused while nothing changed; the third identical failure asks for the cause", () => {
  const w = new WorkerWatch(DEFAULT_WATCH, undefined);
  const fail = "FAILED tests/test_a.py::test_x - AssertionError: 3 != 4";
  w.after("bash", { command: "pytest -q tests/test_a.py" }, true, fail);
  assert.match(w.before("bash", { command: "export CI=1\npytest -q tests/test_a.py" }).block!, /failed last time and nothing has changed since/);
  assert.equal(w.before("bash", { command: "pytest -q tests/test_b.py" }).block, undefined, "another command is fine");
  w.after("edit", {}, false, "ok");
  assert.equal(w.before("bash", { command: "pytest -q tests/test_a.py" }).block, undefined, "after a change it may run again");
  assert.equal(w.after("bash", { command: "pytest -q tests/test_a.py" }, true, fail.replace("3", "5")), undefined);
  w.after("bash", { command: "pip install requests" }, false, "ok"); // another command changed things
  assert.equal(w.before("bash", { command: "pytest -q tests/test_a.py" }).block, undefined);
  assert.match(w.after("bash", { command: "pytest -q tests/test_a.py" }, true, fail)!, /Third time `pytest -q tests\/test_a\.py` failed the same way.*report BLOCKED/);
  w.after("edit", {}, false, "ok");
  w.after("bash", { command: "pytest -q tests/test_a.py" }, false, "1 passed");
  assert.equal(w.before("bash", { command: "pytest -q tests/test_a.py" }).block, undefined, "a pass clears it");
  w.after("bash", { command: "rg nope" }, true, "");
  assert.equal(w.before("bash", { command: "rg nope" }).block, undefined, "reading commands are not tracked");
});

test("an edit outside the task's files is refused with the way to ask", () => {
  const w = new WorkerWatch(DEFAULT_WATCH, ["src/a.py", "tests/**"]);
  assert.equal(w.before("write", {}, "tests/test_new.py").block, undefined);
  assert.match(w.before("edit", {}, "src/b.py").block!, /src\/b\.py is outside the files this task owns \(src\/a\.py, tests\/\*\*\).*contact_supervisor with reason "need_decision"/);
  assert.equal(new WorkerWatch(DEFAULT_WATCH, undefined).before("edit", {}, "any.py").block, undefined, "no list known: not checked");
});

test("time without a change: a note after stallMin, reading refused after twice that; a passing check is not a change", () => {
  let now = 0;
  const w = new WorkerWatch({ ...DEFAULT_WATCH, stallMin: 20 }, ["a.py"], () => now);
  now = 19 * 60_000;
  assert.equal(w.after("read", {}, false, ""), undefined);
  now = 21 * 60_000;
  assert.match(w.after("bash", { command: "pytest -q" }, false, "3 passed")!, /21 minutes without changing a file.*contact_supervisor/);
  now = 41 * 60_000;
  assert.match(w.before("read", {}).block!, /41 minutes without changing anything/);
  w.after("bash", { command: "python tools/gen_fixtures.py" }, false, "wrote 3 files");
  assert.equal(w.before("read", {}).block, undefined, "a command that changed files counts");
});
