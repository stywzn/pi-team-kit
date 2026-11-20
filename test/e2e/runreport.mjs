#!/usr/bin/env node
// pi-team-kit's subagent hooks through pi's SDK, no model called:
//   node test/e2e/runreport.mjs
// A subagent call the lead makes gets the deadline and the hand-off before it; a run that ended without finishing
// makes the next turn start with what it changed (and not what was dirty before it), once.
import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const { createAgentSession, SessionManager } = await import(pathToFileURL(join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js")).href);
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
session.dispose();
console.log(ok ? "\x1b[1;32mPASS\x1b[0m e2e runreport" : "\x1b[1;31mFAIL\x1b[0m e2e runreport");
process.exit(ok ? 0 : 1);
