#!/usr/bin/env node
// Two lead sessions in ONE process, the way a browser host (pi-web) runs them, through pi's SDK with this
// package loaded from pi's settings. No model is called. Needs pi installed (its SDK is imported from the
// global node_modules) and pi-team-kit installed in pi.
//   node test/e2e/multisession.mjs
// Asserts: each session joins the lead board under its own name; a message to one reaches that session and
// not the other; files changed by shell commands count; closing them removes their cards; one conversation
// open in two windows is flagged in both.
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { sendMessage } from "../../lib/board.ts";

const fail = (m) => {
  console.error(`\x1b[1;31mFAIL\x1b[0m ${m}`);
  process.exit(1);
};
const npmRoot = execFileSync("npm", ["root", "-g"], { encoding: "utf8" }).trim();
const sdkPath = join(npmRoot, "@earendil-works", "pi-coding-agent", "dist", "index.js");
if (!existsSync(sdkPath)) fail(`pi's SDK not found at ${sdkPath}`);
const { createAgentSession, SessionManager } = await import(pathToFileURL(sdkPath).href);

const agent = process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent");
const board = join(agent, "ptk", "board");
const root = join(homedir(), "code", "ptk-e2e-multisession");
const repo = join(root, "shop");
if (existsSync(root)) {
  if (!existsSync(join(root, ".ptk-e2e"))) fail(`${root} exists and was not created by this script`);
  rmSync(root, { recursive: true, force: true });
}
mkdirSync(repo, { recursive: true });
writeFileSync(join(root, ".ptk-e2e"), "");
writeFileSync(join(repo, "README.md"), "# shop\n");
spawnSync("git", ["init", "-q", "-b", "main", repo]);
for (const n of ["shop", "shop-2"]) if (existsSync(join(board, `${n}.json`))) fail(`a lead named ${n} is on the board already`);

const cards = () =>
  existsSync(board)
    ? readdirSync(board)
        .filter((f) => /^shop(-\d+)?\.json$/.test(f))
        .map((f) => JSON.parse(readFileSync(join(board, f), "utf8")))
    : [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let ok = true;
const check = (cond, msg) => {
  console.log(`${cond ? "  ok  " : "  FAIL"} ${msg}`);
  ok &&= Boolean(cond);
};

// pi-web's liveness registry: a lead registers so pi-web keeps it open while its team run is going.
const leases = [];
const released = [];
globalThis[Symbol.for("@agegr/pi-web/session-liveness/v1")] = {
  version: 1,
  register: (p) => (leases.push(p), () => released.push(p.sessionId)),
};

const open = async () => {
  const { session } = await createAgentSession({ cwd: repo, sessionManager: SessionManager.inMemory() });
  await session.bindExtensions({});
  return session;
};
const a = await open();
const b = await open();
await sleep(2500);
const live = cards();
check(live.length === 2, `both sessions joined the board: ${live.map((c) => c.name).join(", ")}`);
check(new Set(live.map((c) => c.owner)).size === 2, "each under its own owner id");
check(new Set(live.map((c) => c.owner.split(":")[1])).size === 1, "in one process");
const ptkLeases = leases.filter((l) => l.name === "pi-team-kit");
check(ptkLeases.length === 2 && ptkLeases.every((l) => l.sessionId && l.isActive() === false), "each session registered with pi-web's liveness registry, not active without a team run");

const target = live.find((c) => c.name === "shop-2") ?? live[1];
sendMessage(board, { from: "shop-e2e-sender", to: target.name, text: "multisession check: hello", update: false, hops: 0 });
await sleep(4500);
const got = (s) => JSON.stringify(s.messages ?? s.agent?.state?.messages ?? []).includes("multisession check: hello");
const [first, second] = target.name === "shop-2" ? [a, b] : [b, a];
check(got(second) && !got(first), "the message reached that session only");

// A file changed by a shell command (sed -i), not the edit tool, is on the lead's card too. The tool hooks are
// driven the way pi drives them around a bash call; the command itself runs here.
writeFileSync(join(repo, "login.js"), 'fetch("/login")\n');
spawnSync("git", ["-C", repo, "add", "."]);
spawnSync("git", ["-C", repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init"]);
const command = `cd ${repo} && sed -i 's|/login|/v2/login|' login.js`;
const call = { type: "tool_call", toolName: "bash", toolCallId: "ms-1", input: { command } };
await first.extensionRunner.emitToolCall(call);
spawnSync("bash", ["-c", command]);
await first.extensionRunner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "ms-1", input: call.input, content: [{ type: "text", text: "" }], details: undefined, isError: false });
const firstName = live.find((c) => c.name !== target.name).name;
check(cards().find((c) => c.name === firstName)?.files.some((f) => f.path === "login.js"), "a file changed with sed is recorded on that lead's card");
// The other lead changes the same file with sed: its result carries a note to tell the first lead.
const command2 = `sed -i 's|v2|v3|' ${join(repo, "login.js")}`;
const call2 = { type: "tool_call", toolName: "bash", toolCallId: "ms-2", input: { command: command2 } };
await second.extensionRunner.emitToolCall(call2);
spawnSync("bash", ["-c", command2]);
const res2 = await second.extensionRunner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "ms-2", input: call2.input, content: [{ type: "text", text: "" }], details: undefined, isError: false });
check(JSON.stringify(res2 ?? {}).includes(`Tell ${firstName} now`), "a shell change to a file another lead just changed says to tell that lead");
// While the first lead's command runs, the second writes a file in the same checkout: not the first lead's change.
const call3 = { type: "tool_call", toolName: "bash", toolCallId: "ms-3", input: { command: "npm test" } };
await first.extensionRunner.emitToolCall(call3);
writeFileSync(join(repo, "other.js"), "by the second lead\n");
await second.extensionRunner.emitToolResult({ type: "tool_result", toolName: "write", toolCallId: "ms-4", input: { path: join(repo, "other.js"), content: "" }, content: [{ type: "text", text: "ok" }], details: undefined, isError: false });
await first.extensionRunner.emitToolResult({ type: "tool_result", toolName: "bash", toolCallId: "ms-3", input: call3.input, content: [{ type: "text", text: "" }], details: undefined, isError: false });
check(!cards().find((c) => c.name === firstName)?.files.some((f) => f.path === "other.js"), "a file another lead wrote while the command ran is not put on this lead's card");

// A host closes a session the way pi-web does: session_shutdown first, then dispose.
await a.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
a.dispose();
await sleep(500);
check(cards().length === 1, "a session closed with session_shutdown removed its card at once");
check(released.includes(a.sessionId), "and released its liveness lease");
// ...or disposes it without the event: the card must not be kept alive by a leftover timer.
b.dispose();
await sleep(3500);
check(cards().length === 0, "a session disposed without session_shutdown leaves the board within seconds");
rmSync(join(board, `${target.name}.inbox`), { recursive: true, force: true });

// One conversation open twice (a terminal and the browser): both windows are told.
const sessionDir = join(root, "sessions");
const sessionFile = join(sessionDir, "same.jsonl");
const notes = [];
// A plain object: pi spreads the host's UI context, so a Proxy would lose its methods.
const ui = (who) => {
  const u = { notify: (msg) => notes.push(`${who}: ${msg}`) };
  for (const k of ["setStatus", "setWidget", "setTitle", "setFooter", "setHeader", "setEditorText", "setWorkingMessage", "onTerminalInput"]) u[k] = () => undefined;
  for (const k of ["select", "confirm", "input", "editor", "custom"]) u[k] = async () => undefined;
  return u;
};
const openFile = async (who) => {
  const { session } = await createAgentSession({ cwd: repo, sessionManager: SessionManager.open(sessionFile, sessionDir, repo) });
  await session.bindExtensions({ uiContext: ui(who), mode: "rpc" });
  return session;
};
const t1 = await openFile("terminal");
await sleep(500);
const t2 = await openFile("browser");
await sleep(11_000); // the first window rechecks every 10 s
const twin = (who) => notes.some((n) => n.startsWith(`${who}:`) && n.includes("also open in another window"));
check(twin("browser") && twin("terminal"), "the same session open twice warns in both windows");
check(cards().every((c) => c.session === sessionFile), "cards carry the session file");
for (const s of [t1, t2]) {
  await s.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
  s.dispose();
}
await sleep(300);
check(cards().length === 0, "both left the board");
if (ok) console.log("\x1b[1;32mPASS\x1b[0m e2e multisession");
process.exit(ok ? 0 : 1);
