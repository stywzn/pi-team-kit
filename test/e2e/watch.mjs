#!/usr/bin/env node
// The worker watch through pi's SDK, as a team worker's session sees it (no model called):
//   node test/e2e/watch.mjs
// An edit outside the task's files is refused; long reading gets a note and is then refused until a change;
// a command that just failed is refused while nothing changed. Other sessions (the lead) are not watched.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(npmRoot, "@earendil-works", "pi-coding-agent");
const { createAgentSession, SessionManager } = await import(pathToFileURL(join(piRoot, "dist", "index.js")).href);
process.argv[1] = join(piRoot, "dist", "bundle", "cli.js");
const repo = mkdtempSync(join(tmpdir(), "ptk-watch-"));
spawnSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "a.py"), "x = 1\n");

let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  ok &&= Boolean(cond);
};
const task = "You are one worker in a team run. Overall goal: g\n\nYour tasks:\n1. A\nChange a.py\n\nFiles you own (edit only these; new files only inside them):\n- a.py\n- tests/**\n\nRules: ...";

async function session(child) {
  if (child) process.env.PI_SUBAGENT_CHILD = "1";
  else delete process.env.PI_SUBAGENT_CHILD;
  const { session } = await createAgentSession({ cwd: repo, sessionManager: SessionManager.inMemory() });
  await session.bindExtensions({});
  const r = session.extensionRunner;
  // The system prompt reaches handlers through the runner's options, as pi-subagents' agent prompt does in a child.
  await r.emitBeforeAgentStart({ messageType: "user", prompt: task }, { forceSystemPrompt: child ? "You are a worker in a team run. Several workers..." : "You are pi." });
  let n = 0;
  const call = async (toolName, input) => r.emitToolCall({ type: "tool_call", toolName, toolCallId: `c${++n}`, input });
  const result = async (toolName, input, isError, text) =>
    r.emitToolResult({ type: "tool_result", toolName, toolCallId: `c${n}`, input, isError, content: [{ type: "text", text }] });
  return { call, result };
}

const w = await session(true);
const outside = await w.call("edit", { path: "b.py", oldText: "x", newText: "y" });
check(outside?.block && /b\.py is outside the files this task owns \(a\.py, tests\/\*\*\)/.test(outside.reason), `an edit outside the task's files is refused (${outside?.reason?.slice(0, 80)})`);
check(!(await w.call("write", { path: join(repo, "tests", "test_a.py"), content: "" }))?.block, "a new test inside its own folder is fine (absolute path)");

let note = "";
for (let i = 0; i < 12; i++) {
  await w.call("read", { path: "a.py" });
  const r = await w.result("read", { path: "a.py" }, false, "x = 1");
  note = JSON.stringify(r ?? {});
}
check(/12 read-only calls in a row without a change/.test(note), "the 12th read-only call carries a note");
for (let i = 0; i < 13; i++) {
  await w.call("grep", { pattern: "x" });
  await w.result("grep", { pattern: "x" }, false, "a.py:1");
}
const blocked = await w.call("read", { path: "a.py" });
check(blocked?.block && /more reading is refused/.test(blocked.reason), "the 26th read is refused");
await w.call("edit", { path: "a.py", oldText: "x", newText: "y" });
await w.result("edit", { path: "a.py" }, false, "ok");
check(!(await w.call("read", { path: "a.py" }))?.block, "a change lifts it");

await w.call("bash", { command: "python -m pytest -q tests/test_a.py" });
await w.result("bash", { command: "python -m pytest -q tests/test_a.py" }, true, "FAILED tests/test_a.py::test_x - AssertionError: 1 != 2\n1 failed in 0.1s");
const again = await w.call("bash", { command: "python -m pytest -q tests/test_a.py" });
check(again?.block && /failed last time and nothing has changed since/.test(again.reason), "re-running the failing command with no change is refused");
await w.call("edit", { path: "a.py", oldText: "y", newText: "z" });
await w.result("edit", { path: "a.py" }, false, "ok");
check(!(await w.call("bash", { command: "python -m pytest -q tests/test_a.py" }))?.block, "after a change it may run again");

const lead = await session(false);
check(!(await lead.call("edit", { path: "b.py", oldText: "x", newText: "y" }))?.block, "the lead is not watched");

console.log(ok ? "watch e2e: all passed" : "watch e2e: FAILED");
process.exit(ok ? 0 : 1);
