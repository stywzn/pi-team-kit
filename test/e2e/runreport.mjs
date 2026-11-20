#!/usr/bin/env node
// pi-team-kit's subagent hooks through pi's SDK, no model called:
//   node test/e2e/runreport.mjs
// A subagent call the lead makes gets the deadline and the hand-off before it; a run that ended without finishing
// makes the next turn start with what it changed (and not what was dirty before it), once.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const piRoot = join(npmRoot, "@earendil-works", "pi-coding-agent");
const { createAgentSession, SessionManager } = await import(pathToFileURL(join(piRoot, "dist", "index.js")).href);
// As when pi runs: its entry file is argv[1], from which its own packages (yaml) are found.
process.argv[1] = join(piRoot, "dist", "bundle", "cli.js");
const repo = mkdtempSync(join(tmpdir(), "ptk-rr-"));
spawnSync("git", ["init", "-q", repo]);
writeFileSync(join(repo, "a.py"), "x = 1\n");
writeFileSync(join(repo, "mine.py"), "dirty before\n");
spawnSync("git", ["-C", repo, "add", "."]);
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
writeFileSync(join(repo, "mine.py"), "the lead's own change, before the run\n");

let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  ok &&= Boolean(cond);
};

const { session } = await createAgentSession({ cwd: repo, sessionManager: SessionManager.inMemory() });
await session.bindExtensions({});
const r = session.extensionRunner;
const input = { agent: "team-worker", task: "make the word report", async: true };
await r.emitToolCall({ type: "tool_call", toolName: "subagent", toolCallId: "s1", input });
check(input.timeoutMs === 7_200_000 && input.checkpointBeforeDeadlineMs === 600_000, `a subagent run gets 2 h and a hand-off 10 min before (${input.timeoutMs}, ${input.checkpointBeforeDeadlineMs})`);
const own = { agent: "w", task: "t", timeoutMs: 60_000 };
await r.emitToolCall({ type: "tool_call", toolName: "subagent", toolCallId: "s2", input: own });
check(own.timeoutMs === 60_000 && own.checkpointBeforeDeadlineMs === undefined, "a deadline the lead chose is kept (and too short for a checkpoint)");
const list = { action: "list" };
await r.emitToolCall({ type: "tool_call", toolName: "subagent", toolCallId: "s3", input: list });
check(!("timeoutMs" in list), "other subagent actions are left alone");

// The run edits a file and adds one, then times out.
const started = Date.now();
writeFileSync(join(repo, "a.py"), "x = 1\ny = 2\nz = 3\n");
mkdirSync(join(repo, "lib"));
writeFileSync(join(repo, "lib", "seed.py"), "class SeedPac:\n    pass\n");
const dir = mkdtempSync(join(tmpdir(), "ptk-rr-run-"));
writeFileSync(join(dir, "status.json"), JSON.stringify({ cwd: repo, startedAt: started, steps: [{ error: "Subagent timed out after 7200000ms.", recentTools: [{ tool: "write", args: { path: "lib/seed.py" } }] }] }));
const message = { role: "custom", customType: "subagent-notify", content: "done", display: true, details: { runs: [{ runId: "run-1", agent: "team-worker", status: "failed", asyncDir: dir, durationMs: 7_200_000 }] }, timestamp: Date.now() };
const out = await r.emitBeforeAgentStart({ messageType: "custom", message }, {});
const report = JSON.stringify(out ?? {});
check(/ptk-run-report/.test(report), "the next turn starts with a run report");
check(/a\.py \+2 -0/.test(report) && /lib\/seed\.py \(new, 3 lines\)/.test(report), "it lists the run's changes with sizes");
check(!/mine\.py/.test(report), "not what was dirty before the run");
check(/timed out/.test(report) && /write \{\\"path\\":\\"lib\/seed\.py\\"\}/.test(report), "with the error and the last tool calls");
const again = await r.emitBeforeAgentStart({ messageType: "custom", message }, {});
check(!JSON.stringify(again ?? {}).includes("ptk-run-report"), "a run is reported once");
const okRun = { ...message, details: { runs: [{ runId: "run-2", agent: "team-worker", status: "completed", asyncDir: dir }] } };
check(!JSON.stringify((await r.emitBeforeAgentStart({ messageType: "custom", message: okRun }, {})) ?? {}).includes("ptk-run-report"), "a run that finished is not reported");

// Team mode by default: the lead's 7th file in one request goes to workers.
let n = 0;
const edit = async (path) => {
  const id = `e${++n}`;
  const call = await r.emitToolCall({ type: "tool_call", toolName: "edit", toolCallId: id, input: { path } });
  if (call?.block) return call.reason;
  await r.emitToolResult({ type: "tool_result", toolName: "edit", toolCallId: id, input: { path }, content: [{ type: "text", text: "ok" }], details: undefined, isError: false });
  return undefined;
};
await r.emitInput?.({ type: "input", text: "do the big thing", source: "interactive" });
for (let i = 1; i <= 6; i++) await edit(join(repo, `f${i}.py`));
const blocked = await edit(join(repo, "f7.py"));
check(/7th file[\s\S]*team_run/.test(blocked ?? ""), "the 7th file of a request is handed to workers");
check((await edit(join(repo, "f1.py"))) === undefined, "a file it already changed may be finished");
await r.emitToolResult({ type: "tool_result", toolName: "team_run", toolCallId: "t1", input: {}, content: [{ type: "text", text: "started" }], details: undefined, isError: false });
check((await edit(join(repo, "f8.py"))) === undefined, "after team_run the lead may fix up anything");

// An edit that breaks a .json/.yaml/.py file is put back as it was, and the result says why.
const breakWith = async (name, good, bad) => {
  const file = join(repo, name);
  writeFileSync(file, good);
  const id = `b${++n}`;
  await r.emitToolCall({ type: "tool_call", toolName: "write", toolCallId: id, input: { path: file, content: bad } });
  writeFileSync(file, bad); // what the write tool does
  const res = await r.emitToolResult({ type: "tool_result", toolName: "write", toolCallId: id, input: { path: file, content: bad }, content: [{ type: "text", text: "written" }], details: undefined, isError: false });
  return { now: readFileSync(file, "utf8"), res: JSON.stringify(res ?? {}) };
};
const json = await breakWith("S1.json", '{"验证时间": "2026-11-19"}\n', '{"验证时间": 2026-11-19}\n');
check(json.now === '{"验证时间": "2026-11-19"}\n' && /put back exactly as it was/.test(json.res) && /"isError":true/.test(json.res), "a JSON file an edit broke is put back, and the result is an error");
const yaml = await breakWith("cases.yaml", "cases:\n  - id: KH1\n    依据: a\n", "cases:\n  - id: KH1\n    依据: \u0001\n");
check(yaml.now.includes("依据: a") && /control character U\+0001/.test(yaml.res), "a YAML file with a control character is put back (pi's own yaml package found)");
const yamlIndent = await breakWith("c2.yaml", "a:\n  b: 1\n", "a:\n  b: 1\n c: [\n");
check(yamlIndent.now === "a:\n  b: 1\n" && /put back/.test(yamlIndent.res), "a YAML file with broken indentation is put back");
const py = await breakWith("test_70.py", 'MSG = "line one\\nline two"\n', 'MSG = "line one\nline two"\n');
check(py.now.includes("\\n") && /put back/.test(py.res), "a Python file whose \\n became a real newline is put back (checked with the real python)");
const fine = await breakWith("ok.json", "{}\n", '{"a": 1}\n');
check(fine.now === '{"a": 1}\n' && !/put back/.test(fine.res), "a valid edit is left alone");

// Guard: ssh that runs a command or prints something is allowed; a command's own timeout raises the tool's.
const bash = async (command) => {
  const input = { command };
  const res = await r.emitToolCall({ type: "tool_call", toolName: "bash", toolCallId: `g${++n}`, input });
  return { blocked: Boolean(res?.block), input };
};
check(!(await bash("ssh -V")).blocked && !(await bash('ssh -i ~/.ssh/k bench "echo ok"')).blocked, "ssh -V and ssh with a remote command run");
check((await bash("ssh bench")).blocked, "ssh without a command is still stopped");
const slow = await bash("timeout 700 python tools/remote_bench.py --expr KH15");
check(slow.input.timeout === 760, `timeout 700 in the command: the tool waits 760s (${slow.input.timeout})`);
session.dispose();
console.log(ok ? "\x1b[1;32mPASS\x1b[0m e2e runreport" : "\x1b[1;31mFAIL\x1b[0m e2e runreport");
process.exit(ok ? 0 : 1);
