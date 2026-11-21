import assert from "node:assert/strict";
import { test } from "node:test";
import { classifyCommand, commandTimeoutSec, inspectBash, sleepSeconds, longRunnerReason, looksLikeTimeout, resolveTimeout, stripPyVersion, trimPassingTest, unsafeRegex, withCi, type GuardOptions } from "../lib/guard.ts";
import { splitSegments } from "../lib/shell.ts";

const base: GuardOptions = {
  blockLongRunners: true,
  preferFastSearch: "block",
  sudoNonInteractive: true,
  hasRg: true,
  hasFd: true,
  builtinSearch: { grep: false, find: false },
  pitfalls: [],
  cwd: "/home/u/repo",
};

const blocked = (cmd: string, opts: Partial<GuardOptions> = {}) => inspectBash(cmd, { ...base, ...opts }).kind === "block";

test("shell splitting honours quotes, redirections and background", () => {
  const segs = splitSegments(`echo "a && b" && npm test 2>&1 | tee log; sleep 5 & echo done # comment && x`);
  assert.deepEqual(segs.map((s) => s.text), ['echo "a && b"', "npm test 2>&1", "tee log", "sleep 5", "echo done"]);
  assert.equal(segs[3].background, true);
  assert.deepEqual(segs[0].argv, ["echo", "a && b"]);
});

test("here-document bodies are data, not commands", () => {
  const cmd = "cat > run.sh <<'EOF'\nnpm run dev\ntail -f log\nEOF\nchmod +x run.sh && echo ok";
  assert.deepEqual(splitSegments(cmd).map((s) => s.text), ["cat > run.sh <<'EOF'", "chmod +x run.sh", "echo ok"]);
  assert.ok(!blocked(cmd));
  assert.ok(blocked("cat <<-END > x\n\tnpm run dev\n\tEND\nnpm run dev"), "commands after the body still count");
  assert.ok(!blocked("python3 - <<EOF\nimport http.server\nEOF"));
});

test("servers, watchers, followers, REPLs and TUIs are blocked", () => {
  for (const cmd of [
    "npm run dev",
    "pnpm dev",
    "yarn start",
    "cd web && npm run serve",
    "npx vite",
    "npx -y next dev",
    "vite --port 3000",
    "nodemon server.js",
    "tsc --watch",
    "jest --watchAll",
    "tail -f /var/log/syslog",
    "docker compose up",
    "docker-compose up web",
    "docker run -it ubuntu bash",
    "kubectl logs -f pod/x",
    "python -m http.server 8000",
    "python3 manage.py runserver",
    "uvicorn app:app --reload",
    "flask run",
    "python",
    "node",
    "psql -h localhost mydb",
    "ssh build-box",
    "vim README.md",
    "less log.txt",
    "watch -n1 ls",
    "FOO=1 sudo npm run dev",
  ])
    assert.ok(blocked(cmd), `expected block: ${cmd}`);
});

test("bounded, detached or one-shot commands are allowed", () => {
  for (const cmd of [
    "npm test",
    "npm run build",
    "npm run dev &",
    "nohup npm run dev > dev.log 2>&1 &",
    "timeout 20 npm run dev",
    "vite build",
    "npx vitest run",
    "docker compose up -d",
    "docker run --rm alpine echo hi",
    "tail -n 50 app.log",
    "python script.py",
    "python -c 'print(1)'",
    "node build.js",
    "psql -c 'select 1' mydb",
    "sqlite3 db.sqlite 'select 1'",
    "ssh build-box uptime",
    "uvicorn --help",
    "git log --oneline -5",
  ])
    assert.ok(!blocked(cmd), `expected allow: ${cmd}`);
});

test("recursive grep / simple find suggest rg and fd", () => {
  assert.ok(blocked("grep -rn TODO ."));
  assert.ok(blocked("grep -R --include=*.ts foo src"));
  assert.ok(blocked("find . -name '*.md'"));
  assert.ok(blocked("find src -type f -iname '*.py' -not -path '*/node_modules/*'"));
  assert.ok(!blocked("ls -R src"), "ls -R only gets a hint, it is not worth a blocked call");
  const lsr = inspectBash("ls -R src", base);
  assert.match(lsr.kind === "allow" ? lsr.notes.join(" ") : "", /fd \./);
  assert.ok(!blocked("grep foo file.txt"));
  assert.ok(!blocked("git diff | grep -n foo"));
  assert.ok(!blocked("find . -mtime -1 -name '*.log'"), "complex find stays allowed");
  assert.ok(!blocked("find . -name '*.tmp' -delete"));
  assert.ok(!blocked("grep -rn TODO .", { hasRg: false }), "no rg, no nagging");
  const warn = inspectBash("grep -rn TODO .", { ...base, preferFastSearch: "warn" });
  assert.equal(warn.kind, "allow");
  assert.match(warn.kind === "allow" ? warn.notes[0] : "", /rg -n/);
  const reason = inspectBash("grep -rn TODO .", { ...base, builtinSearch: { grep: true, find: true } });
  assert.match(reason.kind === "block" ? reason.reason : "", /built-in `grep` tool/);
});

test("sudo becomes sudo -n, other sudo flags untouched", () => {
  const d = inspectBash("sudo apt-get install -y jq && echo ok", base);
  assert.equal(d.kind, "allow");
  assert.equal(d.kind === "allow" && d.command, "sudo -n apt-get install -y jq && echo ok");
  const same = inspectBash("sudo -n true; echo pseudo", base);
  assert.equal(same.kind === "allow" && same.command, "sudo -n true; echo pseudo");
});

test("wrapper options with values are skipped correctly; sudo after env assignments still gets -n", () => {
  assert.ok(blocked("sudo -u www-data npm run dev"));
  assert.ok(blocked("env -C web npm run dev"));
  assert.ok(blocked("nice -n 10 tail -f app.log"));
  const d = inspectBash("DEBIAN_FRONTEND=noninteractive sudo apt-get install -y jq", base);
  assert.equal(d.kind === "allow" && d.command, "DEBIAN_FRONTEND=noninteractive sudo -n apt-get install -y jq");
});

test("pitfall regexes prone to catastrophic backtracking are ignored", () => {
  assert.ok(unsafeRegex("(a+)+$"));
  assert.ok(unsafeRegex("(x*y*)*"));
  assert.ok(!unsafeRegex("npm (i|install)\\b"));
  const evil = [{ id: "evil", match: "(a+)+$", action: "block" as const, message: "x" }];
  assert.ok(!blocked("a".repeat(40) + "!", { pitfalls: evil }));
});

test("pitfalls warn or block, optionally only in matching directories", () => {
  const pitfalls = [
    { id: "mnt-install", match: "npm (i|install)\\b", when: "^/mnt/", action: "warn" as const, message: "slow on /mnt" },
    { id: "prod-db", match: "psql .*prod", action: "block" as const, message: "never touch prod" },
  ];
  assert.ok(blocked("psql -h prod-db -c 'select 1'", { pitfalls }));
  const atMnt = inspectBash("npm install", { ...base, pitfalls, cwd: "/mnt/c/work" });
  assert.equal(atMnt.kind === "allow" && atMnt.notes.length, 1);
  const atHome = inspectBash("npm install", { ...base, pitfalls });
  assert.equal(atHome.kind === "allow" && atHome.notes.length, 0);
});

test("timeouts: default filled in, ceiling enforced", () => {
  assert.deepEqual(resolveTimeout(undefined, 180, 1200), { timeout: 180, capped: false });
  assert.deepEqual(resolveTimeout(600, 180, 1200), { timeout: 600, capped: false });
  assert.deepEqual(resolveTimeout(3600, 180, 1200), { timeout: 1200, capped: true });
  assert.deepEqual(resolveTimeout(-1, 180, 1200), { timeout: 180, capped: false });
  assert.ok(looksLikeTimeout("Error: timeout:180"));
  assert.ok(looksLikeTimeout("Command timed out after 180 seconds"));
  assert.ok(!looksLikeTimeout("all tests passed"));
});

test("automated-testing hangs are blocked, one-shot test runs are not", () => {
  for (const cmd of ["npx playwright show-report", "npx playwright test --ui", "npx cypress open", "ng test", "karma start", "ptw", "pytest --looponfail", "npx vitest watch"])
    assert.ok(blocked(cmd), `expected block: ${cmd}`);
  for (const cmd of ["npx playwright test tests/login.spec.ts", "npx cypress run --spec a.cy.ts", "ng test --watch=false", "karma start --single-run", "pytest -k login -x", "npx vitest run"])
    assert.ok(!blocked(cmd), `expected allow: ${cmd}`);
});

test("wrapping in bash -c / sh -c / eval does not hide a command", () => {
  assert.ok(blocked(`bash -c "npm run dev"`));
  assert.ok(blocked(`sh -lc 'cd web && tail -f out.log'`));
  assert.ok(blocked("eval npm run dev"));
  assert.ok(blocked(`bash -c "grep -rn TODO ."`));
  assert.ok(!blocked(`bash -c "npm run dev" &`), "backgrounded wrapper is fine");
  assert.ok(!blocked(`bash -c "npm test"`));
});

test("the Windows py launcher is understood like python", () => {
  assert.ok(blocked("py -m http.server 8000"));
  assert.ok(blocked("py -3.12 -m http.server"));
  assert.ok(blocked("py"), "bare py opens a REPL");
  assert.ok(!blocked("py -3 script.py"));
  assert.equal(classifyCommand("py -m pytest -q"), "test");
  assert.equal(classifyCommand("py -3 -m unittest -q"), "test");
  assert.deepEqual(stripPyVersion(["-3.12-64", "-m", "x"]), ["-m", "x"]);
  assert.deepEqual(stripPyVersion(["-V:3.12", "a.py"]), ["a.py"]);
});

test("commands are classified so tests and builds get longer default timeouts", () => {
  const cases: [string, string][] = [
    ["pytest -x tests/test_login.py", "test"],
    ["python -m pytest -q", "test"],
    ["uv run pytest", "test"],
    ["npx playwright test", "test"],
    ["npm test", "test"],
    ["pnpm run test:e2e", "test"],
    ["go test ./...", "test"],
    ["./gradlew test", "test"],
    ["mvn -q verify", "test"],
    ["cd api && cargo test", "test"],
    ["make test", "test"],
    ["npm ci", "build"],
    ["pip install -r requirements.txt", "build"],
    ["docker build -t app .", "build"],
    ["npx playwright install --with-deps", "build"],
    ["npm run build", "build"],
    ["git status", "default"],
    ["rg -n foo", "default"],
    ["bash -c 'pytest -q'", "test"],
  ];
  for (const [cmd, cls] of cases) assert.equal(classifyCommand(cmd), cls, cmd);
});

test("test commands get CI=1 unless CI is already set", () => {
  assert.equal(withCi("npm test", {}), "export CI=1\nnpm test");
  assert.equal(withCi("CI=true npm test", {}), "CI=true npm test");
  assert.equal(withCi("npm test", { CI: "false" }), "npm test");
});

test("longRunnerReason explains itself", () => {
  const [seg] = splitSegments("npm run dev");
  assert.match(longRunnerReason(seg) ?? "", /server or watcher/);
});

test("ssh: version, config and query flags run; only a session without a command is stopped", () => {
  const reason = (cmd: string) => inspectBash(cmd, base).kind === "block";
  for (const ok of ["ssh -V", "ssh -G myhost", "ssh -Q cipher", "ssh -i ~/.ssh/key bench \"echo ok\"", "ssh -p 2222 -i key user@host 'ls /tmp'", "ssh host -- uptime"]) assert.equal(reason(ok), false, ok);
  for (const bad of ["ssh host", "ssh -i key user@host", "ssh -t host"]) assert.equal(reason(bad), true, bad);
});

test("a command with its own timeout gets a tool timeout longer than that", () => {
  assert.equal(commandTimeoutSec("timeout 700 python tools/remote_bench.py --expr KH15"), 700);
  assert.equal(commandTimeoutSec("timeout 10m pytest -q"), 600);
  assert.equal(commandTimeoutSec("CI=1 timeout --kill-after=5 -s KILL 90 npm test"), 90);
  assert.equal(commandTimeoutSec("gtimeout 1.5h make e2e"), 5400);
  assert.equal(commandTimeoutSec("python timeout_test.py"), undefined);
  assert.equal(commandTimeoutSec("echo timeout 700 x"), undefined, "only a leading timeout");
});

test("sleeps in a command count toward its tool timeout (sleep 178 under 180 s was killed in real use)", () => {
  assert.equal(sleepSeconds("sleep 178"), 178);
  assert.equal(sleepSeconds("cd x && sleep 30; curl -s :8080/health; sleep 1m"), 90);
  assert.equal(sleepSeconds("Start-Sleep -Seconds 45; Start-Sleep 5"), 50);
  assert.equal(sleepSeconds("Start-Sleep -Milliseconds 1500"), 2);
  assert.equal(sleepSeconds("timeout /t 60 /nobreak"), 60);
  assert.equal(sleepSeconds("python sleep_test.py && echo sleeping"), 0);
});

test("a passing test run keeps only its summary; failures and listings are never cut", () => {
  const log = Array.from({ length: 200 }, (_, i) => `tests/test_${i}.py::test_x PASSED`).concat(["===== 200 passed in 3.2s ====="]).join("\n");
  const t = trimPassingTest("python -m pytest -v", log, false)!;
  assert.match(t, /^\[ptk\] passed; the last 15 of 201 lines/);
  assert.match(t, /200 passed in 3\.2s/);
  assert.ok(t.length < log.length / 5);
  assert.equal(trimPassingTest("python -m pytest -v", log, true), undefined, "a failure keeps everything");
  assert.equal(trimPassingTest("pytest --collect-only -q", log, false), undefined, "a listing is the point");
  assert.equal(trimPassingTest("cat big.log", log, false), undefined, "only test commands");
  assert.equal(trimPassingTest("npx playwright test", "ok\n1 passed", false), undefined, "short output stays");
});
