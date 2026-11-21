#!/usr/bin/env node
// Batch-1 guards through pi's SDK, two lead sessions in one process (no model is called):
//   node test/e2e/guards.mjs
// - a whole-file write of a file the session has not read, or that changed on disk since, is refused;
// - a file another lead claimed cannot be edited until released; a shell command that changes it gets a note;
// - an environment failure (connection refused) gets a note not to code around it;
// - the lead changed code and ran no check: one message before the turn ends; a bigger change also asks for a review;
// - the reviewer agent's bash only reads.
// Needs pi installed with pi-team-kit in its settings (as the other SDK e2e scripts).
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { ledgerDir } from "../../lib/ledger.ts";
import { leadStatePath } from "../../lib/lead.ts";
import { globalDataDir } from "../../lib/config.ts";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(npmRoot, "@earendil-works", "pi-coding-agent");
const { createAgentSession, SessionManager } = await import(pathToFileURL(join(piRoot, "dist", "index.js")).href);
process.argv[1] = join(piRoot, "dist", "bundle", "cli.js");

const root = join(homedir(), "code", "ptk-e2e-guards");
const repo = join(root, `g${process.pid}`); // its own name: cards left by an earlier run (a crash) never match
if (existsSync(root)) {
  if (!existsSync(join(root, ".ptk-e2e"))) throw new Error(`${root} exists and was not created by this script`);
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(join(repo, "src"), { recursive: true });
writeFileSync(join(root, ".ptk-e2e"), "");
for (const f of ["README.md", "src/app.py", "src/util.py", "cases.yaml"]) writeFileSync(join(repo, f), `# ${f}\n`);
spawnSync("git", ["init", "-q", "-b", "main", repo]);
spawnSync("git", ["-C", repo, "add", "."]);
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);

let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  ok &&= Boolean(cond);
};
const text = (r) => JSON.stringify(r ?? {});

async function open(systemPrompt = "You are pi.", child = false, prompt = "change the app") {
  if (child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  const { session } = await createAgentSession({ cwd: repo, sessionManager: SessionManager.inMemory() });
  await session.bindExtensions({});
  const r = session.extensionRunner;
  await r.emit({ type: "session_start", reason: "startup" });
  await r.emitInput(prompt, undefined, "interactive");
  await r.emitBeforeAgentStart({ messageType: "user", prompt }, { forceSystemPrompt: systemPrompt });
  let n = 0;
  const call = (toolName, input) => r.emitToolCall({ type: "tool_call", toolName, toolCallId: `${toolName}-${++n}`, input });
  const result = (toolName, input, isError = false, out = "ok") =>
    r.emitToolResult({ type: "tool_result", toolName, toolCallId: `${toolName}-${n}`, input, isError, content: [{ type: "text", text: out }], details: undefined });
  const settle = () =>
    r.emitBoundary({ type: "agent_before_settle", outcome: "completed" }, () => ({ contextEntries: [], contextMessages: [], llmMessages: [], pendingMessages: [], canContinue: true }));
  const tool = (name) => r.getToolDefinition(name);
  return { r, call, result, settle, tool, close: () => r.emit({ type: "session_shutdown", reason: "quit" }) };
}

const a = await open();
const b = await open();
// the names the board gave them (guards, guards-2... depending on who else is running)
const nameOf = async (s) => /- (\S+) \(you\)/.exec(JSON.stringify(await s.tool("leads").execute("n", { action: "list" })))?.[1];
const A = await nameOf(a);
const B = await nameOf(b);
console.log(`  leads: A=${A} B=${B}`);

// stale writes
const blind = await a.call("write", { path: "cases.yaml", content: "x" });
check(blind?.block && /has not read it/.test(blind.reason), "writing a file the session never read is refused");
await a.call("read", { path: "cases.yaml" });
await a.result("read", { path: "cases.yaml" }, false, "# cases.yaml");
check(!(await a.call("write", { path: "cases.yaml", content: "x" }))?.block, "after reading it, the write goes through");
writeFileSync(join(repo, "cases.yaml"), "# cases.yaml\nchanged by another session\n");
const stale = await a.call("write", { path: "cases.yaml", content: "x" });
check(stale?.block && /changed on disk since/.test(stale.reason), "a file changed on disk since it was read is refused");
check(!(await a.call("write", { path: "src/new_module.py", content: "x" }))?.block, "a new file is fine");
check(!(await a.call("edit", { path: "cases.yaml", oldText: "#", newText: "##" }))?.block, "an edit (applies to current content) is not held");

// leases
const leads = a.tool("leads");
check(Boolean(leads), "the leads tool is there");
const claim = await leads.execute("l1", { action: "claim", paths: ["src/app.py"], text: "refactoring login", minutes: 20 });
check(/Claimed src\/app\.py/.test(text(claim)), "lead A claims src/app.py");
const held = await b.call("edit", { path: "src/app.py", oldText: "#", newText: "##" });
check(held?.block && /claimed by lead \S+ until \d\d:\d\d \(refactoring login\)/.test(held.reason), `lead B's edit of it is refused (${held?.reason?.slice(0, 90)})`);
check(!(await b.call("edit", { path: "src/util.py", oldText: "#", newText: "##" }))?.block, "lead B's edit of another file goes through");
let second = "";
try {
  await b.tool("leads").execute("l2", { action: "claim", paths: ["src/**"], text: "x" });
} catch (e) {
  second = String(e.message);
}
check(/Already claimed by another lead/.test(second), "lead B cannot claim files overlapping A's claim");
check(/Claimed files.*src\/app\.py.*refactoring login/s.test(text(await b.tool("leads").execute("l3", { action: "list" }))), "list shows the claim");
const bash = { command: `printf x >> ${join(repo, "src", "app.py")}` };
await b.call("bash", bash);
writeFileSync(join(repo, "src", "app.py"), "# changed by B's shell\n");
const shellNote = await b.result("bash", bash, false, "");
check(/changed files another lead holds: src\/app\.py/.test(text(shellNote)), "a shell command that changed the claimed file gets a note");
spawnSync("git", ["-C", repo, "checkout", "--", "src/app.py"]);
check(/Released 1 claim/.test(text(await leads.execute("l4", { action: "release" }))), "A releases");
check(!(await b.call("edit", { path: "src/app.py", oldText: "#", newText: "##" }))?.block, "then B's edit goes through");

// environment failure note
const envRes = await a.result("bash", { command: "pytest -q tests/test_db.py" }, true, "E   psycopg2.OperationalError: could not connect to server: Connection refused\n1 failed");
check(/environment problem \(service not reachable.*tell the user what is missing/s.test(text(envRes)), "an environment failure gets a note for the lead");

// self-check: changed code, no check
await a.r.emitInput("fix login", undefined, "interactive");
await a.call("edit", { path: "src/util.py", oldText: "#", newText: "##" });
await a.result("edit", { path: "src/util.py" });
const s1 = await a.settle();
check(s1.continue && /You changed src\/util\.py and ran no check since/.test(text(s1.entries)), "changed code and no check: one message, and the turn continues");
const s2 = await a.settle();
check(!s2.continue, "only once per request");
await a.r.emitInput("again", undefined, "interactive");
await a.call("edit", { path: "src/util.py", oldText: "#", newText: "##" });
await a.result("edit", { path: "src/util.py" });
await a.call("bash", { command: "python -m pytest -q" });
await a.result("bash", { command: "python -m pytest -q" }, false, "1 passed");
check(!(await a.settle()).continue, "a check after the change: nothing to say");
await a.r.emitInput("bigger", undefined, "interactive");
for (const f of ["src/a.py", "src/b.py", "src/c.py", "src/d.py"]) {
  await a.call("write", { path: f, content: "x = 1\n" });
  await a.result("write", { path: f });
}
await a.call("bash", { command: "python -m pytest -q" });
await a.result("bash", { command: "python -m pytest -q" }, false, "4 passed");
const s3 = await a.settle();
check(s3.continue && /changed 4 code files.*team-reviewer/s.test(text(s3.entries)), "four changed code files: a fresh-context review is asked for");
await a.r.emitInput("docs", undefined, "interactive");
await a.call("edit", { path: "README.md", oldText: "#", newText: "##" });
await a.result("edit", { path: "README.md" });
check(!(await a.settle()).continue, "a docs-only change is not held to a check");

// batch 2: the ledger reaches the lead's prompt; messages have receipts and answers; duplicates are refused; await
const ledger = a.tool("ledger");
check(/Recorded \[.*\] decision: Sessions stay server-side/.test(text(await ledger.execute("g1", { action: "add", kind: "decision", text: "Sessions stay server-side; no JWT", why: "the user decided" }))), "ledger add records a decision");
await ledger.execute("g2", { action: "add", kind: "tried", text: "freezegun for the clock: flaky under xdist" });
const prompt = await a.r.emitBeforeAgentStart({ messageType: "user", prompt: "next" }, { forceSystemPrompt: "You are pi." });
check(/decision ledger of .*Sessions stay server-side; no JWT \(the user decided\).*Already tried and did not work.*freezegun/s.test(text(prompt)), "the ledger is in the lead's prompt every turn");
const ids = await a.tool("leads").execute("m1", { action: "send", to: B, text: "Renamed login() to sign_in() in src/app.py", update: false });
const id = /\[([0-9a-z]{12})\]/.exec(text(ids))?.[1];
check(Boolean(id), `the sender gets the message id (${text(ids).slice(0, 120)})`);
let dupErr = "";
try {
  await a.tool("leads").execute("m2", { action: "send", to: B, text: "renamed login() to sign_in() in  src/app.py", update: true });
} catch (e) {
  dupErr = String(e.message);
}
check(/You sent exactly this/.test(dupErr), "the same message again is refused");
await new Promise((r) => setTimeout(r, 4500)); // B's board timer takes the message in
check(/read, not answered yet/.test(text(await a.tool("leads").execute("m3", { action: "list" }))), "after B took it in, A sees it as read");
await b.tool("leads").execute("m4", { action: "send", to: A, text: "sign_in() is used in web/login.ts now", re: id });
check(/answered .*sign_in\(\) is used in web\/login\.ts now/.test(text(await a.tool("leads").execute("m5", { action: "list" }))), "B's answer marks it answered for A");
check(/idle already/.test(text(await a.tool("leads").execute("m6", { action: "await", to: B }))), "await on an idle lead says so at once");

// batch 3: a task of B's waits for a task of A's; when A marks it done, B is told (here B has gone: it waits in B's inbox)
const tA = /\[(t[0-9a-z]+)\]/.exec(text(await a.tool("leads").execute("x1", { action: "task", text: "POST /v2/login returns a session cookie" })))?.[1];
const tB = await b.tool("leads").execute("x2", { action: "task", text: "login page uses /v2/login", after: [tA] });
check(/- waiting\. You will be told/.test(text(tB)), `B's task waits for A's (${tA})`);
check(new RegExp(`login page uses /v2/login - waiting, waits for ${tA} \\(${A}, open\\)`).test(text(await a.tool("leads").execute("x3", { action: "list" }))), "list shows who waits for what");
await b.close(); // B stops; the news must still reach the next session with its name
const done = await a.tool("leads").execute("x4", { action: "done", id: tA, text: "cookie name is sid" });
check(new RegExp(`Told: ${B} \\(task t`).test(text(done)), "marking it done tells B");
const boardDir = join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "ptk", "board");
const inbox = existsSync(join(boardDir, `${B}.inbox`)) ? readdirSync(join(boardDir, `${B}.inbox`)).filter((f) => f.endsWith(".json")).map((f) => readFileSync(join(boardDir, `${B}.inbox`, f), "utf8")).join("\n") : "";
check(/is done: cookie name is sid\..*waited for it and can start now/.test(inbox), "the message waits in B's inbox for the next session with that name");
await a.close();

// batch 3: a worker gets its lane's own resources in its environment and tells the other lanes once
const laneTask = (lane, i) => `You are one worker in a team run. Overall goal: g\n\nFiles you own (edit only these; new files only inside them):\n- ${lane}.py\n\n[ptk-lane-env] PTK_RUN=e2e${process.pid} PTK_LANE=${lane} PTK_LANE_INDEX=${i} PTK_PORT_BASE=${20000 + i * 100} PTK_PORT_SPAN=100 PTK_DB_SUFFIX=_${lane}\n`;
const w1 = await open("You are a worker in a team run. Several workers...", true, laneTask("api", 0));
check(process.env.PTK_LANE === "api" && process.env.PTK_PORT_BASE === "20000" && process.env.PTK_DB_SUFFIX === "_api", "the lane's variables are in the worker's environment before its first command");
check(/Told the other lanes/.test(text(await w1.tool("tell_lanes").execute("b1", { kind: "environment", text: "port 5432 is taken here; the test database runs on 5433" }))), "tell_lanes once");
let twice = "";
try {
  await w1.tool("tell_lanes").execute("b2", { kind: "environment", text: "again" });
} catch (e) {
  twice = String(e.message);
}
check(/told the other lanes once already/.test(twice), "a second tell_lanes is refused");
const w2 = await open("You are a worker in a team run. Several workers...", true, laneTask("web", 1));
check(process.env.PTK_LANE === "web" && process.env.PTK_PORT_BASE === "20100", "the next lane gets its own");
const seen = await w2.result("read", { path: "web.py" }, false, "x");
check(/Lane api tells the other lanes \(environment\): port 5432 is taken here/.test(text(seen)), "the other lane sees it with its next tool result");
check(!/Lane api tells/.test(text(await w2.result("read", { path: "web.py" }, false, "x"))), "once");
await w1.close();
await w2.close();
for (const k of Object.keys(process.env)) if (k.startsWith("PTK_")) delete process.env[k];

// the reviewer reads only
const rv = await open("You review an uncommitted change with fresh eyes. You did not write it...", true);
const rm = await rv.call("bash", { command: "rm -rf src" });
check(rm?.block && /reviewer only reads/.test(rm.reason), "the reviewer cannot run a command that changes files");
check(!(await rv.call("bash", { command: "git diff HEAD && git status --short" }))?.block, "it can read the diff");
check(!(await rv.call("bash", { command: "python -m pytest -q tests" }))?.block, "it can run the tests");
check((await rv.call("edit", { path: "src/app.py", oldText: "#", newText: "##" }))?.block, "it cannot edit");
await rv.close();

// only the team run's own completion ends it: another workflow finishing leaves its merge-queue worktree alone
const lead = await open();
const runBranch = `ptk/run-g${process.pid}`;
const intDir = join(tmpdir(), "ptk-integration", `g${process.pid}-int`);
spawnSync("git", ["-C", repo, "worktree", "add", "-q", "-b", runBranch, intDir, "HEAD"]);
const RID = "11111111-2222-3333-4444-555555555555";
const stateFile = leadStatePath(globalDataDir(), repo);
mkdirSync(join(stateFile, ".."), { recursive: true });
writeFileSync(stateFile, JSON.stringify({ version: 1, repo, updatedAt: new Date().toISOString(), runs: [{ startedAt: new Date().toISOString(), status: "running", lanes: ["a"], gate: "x", runId: RID, integration: { branch: runBranch, dir: intDir } }] }));
const statusDir = (value) => {
  const d = mkdtempSync(join(tmpdir(), "ptk-notice-"));
  writeFileSync(join(d, "status.json"), JSON.stringify({ cwd: repo, workflow: { value } }));
  return d;
};
const notice = (runId, asyncDir, status = "completed") =>
  lead.r.emitBeforeAgentStart({ messageType: "custom", message: { customType: "subagent-notify", details: { runs: [{ runId, agent: "workflow", status, asyncDir }] } } }, { forceSystemPrompt: "You are pi." });
const runState = () => JSON.parse(readFileSync(stateFile, "utf8")).runs.at(-1).status;
await notice("99999999-8888-7777-6666-555555555555", statusDir({ summary: "another workflow" }));
check(existsSync(intDir) && runState() === "running", "another workflow finishing does not end the team run (its worktree stays)");
await notice(RID, statusDir({ lanes: [{ lane: "a", state: "passed" }], integration: { merged: [] } }), "paused");
check(existsSync(intDir) && runState() === "running", "a paused notice of the run does not end it");
await notice(RID, statusDir({ lanes: [{ lane: "a", state: "failed" }], integration: { merged: [] } }));
check(!existsSync(intDir) && runState() === "ended", "its own notice with nothing to integrate ends it: run branch and worktree removed");
check(!spawnSync("git", ["-C", repo, "branch", "--list", runBranch], { encoding: "utf8" }).stdout.trim(), "the run branch is gone");
await lead.close();
rmSync(stateFile, { force: true });

rmSync(root, { recursive: true, force: true });
// what this run left on the real board: its leads' inboxes and their tasks
for (const n of [A, B]) rmSync(join(boardDir, `${n}.inbox`), { recursive: true, force: true });
for (const f of existsSync(join(boardDir, "tasks")) ? readdirSync(join(boardDir, "tasks")) : []) {
  try {
    const t = JSON.parse(readFileSync(join(boardDir, "tasks", f), "utf8"));
    if (t.lead === A || t.lead === B) rmSync(join(boardDir, "tasks", f), { force: true });
  } catch {
    /* not ours */
  }
}
rmSync(ledgerDir(join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "ptk"), repo), { recursive: true, force: true });
console.log(ok ? "guards e2e: all passed" : "guards e2e: FAILED");
process.exit(ok ? 0 : 1);
