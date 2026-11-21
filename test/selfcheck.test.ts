import assert from "node:assert/strict";
import { test } from "node:test";
import { isCheckCommand, isCodeFile, LeadSelfCheck } from "../lib/selfcheck.ts";

test("self-check: changed code and no check since gets one message before the turn ends", () => {
  const s = new LeadSelfCheck({ enabled: true, reviewAfter: 3 });
  s.userInput();
  s.edited("src/login.py", "/r");
  const m = s.beforeEnd("fix the lockout");
  assert.match(m ?? "", /You changed src\/login\.py and ran no check since.*narrowest check/);
  assert.equal(s.beforeEnd("fix the lockout"), undefined, "once per request");
  s.userInput();
  s.edited("src/login.py");
  s.ran("python -m pytest tests/test_login.py -q");
  assert.equal(s.beforeEnd("x"), undefined, "a check after the change: nothing to say");
  s.edited("src/login.py");
  assert.match(s.beforeEnd("x") ?? "", /src\/login\.py/, "a change after the last check counts again");
});

test("self-check: docs do not count, a team run counts as checked, a failing check is still a check", () => {
  const s = new LeadSelfCheck({ enabled: true, reviewAfter: 3 });
  s.edited("README.md");
  s.edited("docs/guide.rst");
  assert.equal(s.beforeEnd("docs"), undefined);
  s.userInput();
  s.edited("app.ts");
  s.delegated();
  assert.equal(s.beforeEnd("x"), undefined);
  s.userInput();
  s.edited("app.ts");
  s.ran("npx tsc --noEmit");
  assert.equal(s.beforeEnd("x"), undefined);
  s.userInput();
  s.edited("app.ts");
  s.ran("cat app.ts");
  assert.ok(s.beforeEnd("x"), "reading is not checking");
  const off = new LeadSelfCheck({ enabled: false, reviewAfter: 3 });
  off.edited("a.py");
  assert.equal(off.beforeEnd("x"), undefined);
});

test("self-check: more than reviewAfter code files asks for a fresh-context review of the diff, in the repo, with the request", () => {
  const s = new LeadSelfCheck({ enabled: true, reviewAfter: 3 });
  for (const f of ["a.py", "b.py", "c.py", "d.py"]) s.edited(f, "/home/u/shop");
  s.ran("pytest -q");
  const m = s.beforeEnd("add rate limiting to the login endpoint") ?? "";
  assert.doesNotMatch(m, /ran no check/);
  assert.match(m, /changed 4 code files.*"agent": "team-reviewer", "cwd": "\/home\/u\/shop".*add rate limiting/s);
  s.userInput();
  for (const f of ["a.py", "b.py", "c.py", "d.py"]) s.edited(f);
  s.ran("pytest -q");
  s.reviewStarted();
  assert.equal(s.beforeEnd("x"), undefined, "a review already ran");
});

test("what counts as code and as a check", () => {
  assert.ok(isCodeFile("src/a.py") && isCodeFile("config.yaml") && isCodeFile("Makefile"));
  assert.ok(!isCodeFile("notes.md") && !isCodeFile("shot.PNG") && !isCodeFile("report.docx"));
  for (const c of ["pytest -q", "npm test", "go test ./...", "cargo clippy", "npx eslint src", "ruff check .", "mypy app", "npm run lint", "pnpm typecheck", "node --check bin/x.mjs", "make test", "tsc -p ."])
    assert.ok(isCheckCommand(c), c);
  for (const c of ["cat a.py", "git status", "ls", "echo test", "python script.py"]) assert.ok(!isCheckCommand(c), c);
});

test("self-check keeps the checks that ran and the files changed since, across requests, for a takeover", () => {
  const s = new LeadSelfCheck({ enabled: true, reviewAfter: 3 });
  s.edited("src/a.py");
  s.ran("pytest -q tests/test_a.py", false);
  s.edited("src/b.py");
  s.userInput(); // a new request does not verify src/b.py
  s.ran("cat src/b.py");
  assert.deepEqual(s.uncheckedFiles(), ["src/b.py"]);
  s.ran("npm run lint", true);
  assert.deepEqual(s.uncheckedFiles(), []);
  assert.deepEqual(s.checks.map((c) => [c.command, c.ok]), [["pytest -q tests/test_a.py", true], ["npm run lint", false]]);
  for (let i = 0; i < 15; i++) s.ran(`pytest -q t${i}`);
  assert.equal(s.checks.length, 10, "bounded");
});

test("the reviewer may read and run checks, part by part; nothing that writes gets through a compound command", async () => {
  const { reviewerMayRun } = await import("../lib/selfcheck.ts");
  for (const ok of ["git diff HEAD", "git status --short && git diff HEAD -- src", "python -m pytest -q tests", "npx tsc --noEmit", "ruff check .", "black --check .", "prettier --check src", "cat a.py | head -20", "npm test 2>&1 | tail -20"])
    assert.ok(reviewerMayRun(ok), ok);
  for (const bad of ["rm -rf src && pytest", "git checkout -- . ; tsc --noEmit", "black .", "prettier --write .", "ruff check --fix .", "echo x > a.txt; eslint .", "pytest > out.txt", "eslint --fix src", "cargo fmt", "isort src", "sed -i s/a/b/ x.py"])
    assert.ok(!reviewerMayRun(bad), bad);
});

test("the reviewer's test commands as the guard rewrites them (export CI=1 first) still run; assignments with code do not", async () => {
  const { reviewerMayRun } = await import("../lib/selfcheck.ts");
  assert.ok(reviewerMayRun("export CI=1\npython -m pytest -q tests"));
  assert.ok(reviewerMayRun("CI=1 FOO=bar && npm test"));
  assert.ok(!reviewerMayRun("export X=$(rm -rf /)\npytest"));
  assert.ok(!reviewerMayRun("export X=`touch a`; pytest"));
});
