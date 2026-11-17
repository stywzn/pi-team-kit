// pi-team-kit: one extension, five jobs.
//   guard     - bash calls get a timeout, never hang on servers/prompts, use rg/fd
//   facts     - environment detected by code + facts/pitfalls the agent saved, injected every session
//   plain     - "speak plainly" rules + a check for unexplained abbreviations
//   toolbox   - reusable helper scripts (md2pdf, shot, bg, and whatever gets saved later)
//   team      - team_run / team_integrate on top of pi-subagents (lead + workers + verifier + rework)

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, delimiter, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, createLocalBashOperations, isToolCallEventType, serializeConversation } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { agentDir, backslashSources, findRepoRoot, globalDataDir, loadConfig, localProjectDataDir, projectDataDir, type PtkConfig } from "../lib/config.ts";
import { detectEnv, formatEnv, realProbe, which, type EnvFacts, type Probe } from "../lib/env.ts";
import { applyRemember, factFilePath, formatFacts, readFactFile, writeFactFile, type CheckedFact, type RememberInput, type Scope } from "../lib/facts.ts";
import { classifyCommand, gateProgram, inspectBash, looksLikeTimeout, looksUnrunnable, NON_INTERACTIVE_ENV, resolveTimeout, withCi, type Pitfall } from "../lib/guard.ts";
import { PLAIN_TALK_RULES, unexplainedAcronyms } from "../lib/plain.ts";
import { buildTeamScript, cleanupTargets, patchesFromHandoff, planLanes, validateTasks, worktreeFromHandoff, type TeamTask } from "../lib/team.ts";
import { addTool, discoverTools, formatToolList, toolArgv, type ToolEntry } from "../lib/toolbox.ts";
import { buildNotification, compactThreshold, detectRole, sessionNameFrom, terminalTitle, type SessionRole } from "../lib/session.ts";
import { ageText, continuationMessage, findRunId, leadStatePath, readLeadState, updateLeadState, writeLeadState } from "../lib/lead.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

const HANDOFF_PROMPT = `You write the opening brief for a fresh coding session that continues work from an earlier conversation.
Include: the goal for the new session; decisions already made and why; constraints; files involved (paths); what was verified and what was not; open questions.
Leave out anything already written down (specs, commits, diffs): point to it by path instead. Do not state as fact anything the conversation did not verify.
Output only the brief, as a message the user can send. Plain words, short.`;

type HandoffEntry = { type: string; id?: string; message?: unknown; summary?: string; tokensBefore?: number; timestamp?: string; firstKeptEntryId?: string };

/** The current branch as messages, starting from the latest compaction summary if there is one. */
function handoffMessages(branch: HandoffEntry[]): unknown[] {
  const toMessage = (e: HandoffEntry) =>
    e.type === "message"
      ? e.message
      : e.type === "compaction"
        ? { role: "compactionSummary", summary: e.summary, tokensBefore: e.tokensBefore, timestamp: new Date(e.timestamp ?? Date.now()).getTime() }
        : undefined;
  let last = -1;
  for (let i = branch.length - 1; i >= 0; i--) if (branch[i].type === "compaction") {
    last = i;
    break;
  }
  if (last < 0) return branch.map(toMessage).filter(Boolean);
  const kept = branch.findIndex((e) => e.id === branch[last].firstKeptEntryId);
  return [branch[last], ...(kept >= 0 ? branch.slice(kept, last) : []), ...branch.slice(last + 1)].map(toMessage).filter(Boolean);
}

interface State {
  cwd: string;
  repo?: string;
  /** pi's project trust. Project config, facts (their check commands run!) and toolbox load only when true. */
  trusted: boolean;
  config: PtkConfig;
  configWarnings: string[];
  probe?: Probe;
  env?: EnvFacts;
  envText: string;
  facts: CheckedFact[];
  pitfalls: (Pitfall & { scope: Scope })[];
  tools: ToolEntry[];
  notes: Map<string, { notes: string[]; timeout: number }>;
  lastUserText: string;
  lastUnexplained: string[];
}

function text(content: string) {
  return { content: [{ type: "text" as const, text: content }], details: {} };
}

function clip(s: string, n: number): string {
  return s.length > n ? `${s.slice(0, n)}\n...[${s.length - n} more characters cut]` : s;
}

export default function piTeamKit(pi: ExtensionAPI) {
  const state: State = {
    cwd: process.cwd(),
    trusted: false,
    config: loadConfig(process.cwd(), process.env, false).config,
    configWarnings: [],
    envText: "",
    facts: [],
    pitfalls: [],
    tools: [],
    notes: new Map(),
    lastUserText: "",
    lastUnexplained: [],
  };

  // ---------- setup ----------

  function applyEnvDefaults() {
    if (!state.config.guard.nonInteractiveEnv) return;
    for (const [k, v] of Object.entries(NON_INTERACTIVE_ENV)) if (process.env[k] === undefined) process.env[k] = v;
  }

  /** Make rg/fd callable from bash: pi downloads them to <agentDir>/bin, Debian names fd "fdfind". */
  function exposeFastSearch(probe: Probe) {
    const dirs: string[] = [];
    const piBin = join(agentDir(), "bin");
    if (existsSync(piBin)) dirs.push(piBin);
    const shimDir = join(globalDataDir(), "bin");
    const fdfind = which(probe, "fdfind");
    if (process.platform !== "win32" && fdfind && !which({ ...probe, extraBin: dirs }, "fd")) {
      try {
        mkdirSync(shimDir, { recursive: true });
        if (!existsSync(join(shimDir, "fd"))) symlinkSync(fdfind, join(shimDir, "fd"));
        dirs.push(shimDir);
      } catch {
        /* read-only home: leave fd missing, the guard then stays quiet about fd */
      }
    }
    const path = (process.env.PATH ?? "").split(delimiter);
    const add = dirs.filter((d) => !path.includes(d));
    if (add.length) process.env.PATH = [...path, ...add].filter(Boolean).join(delimiter);
  }

  function loadFacts() {
    // team facts come from the repo (only once pi trusts it); project facts live in .git/ptk on this machine.
    const local = localProjectDataDir(state.cwd);
    const layers: [Scope, string][] = [
      ["global", globalDataDir()],
      ...(state.repo && state.trusted ? [["team", projectDataDir(state.cwd)] as [Scope, string]] : []),
      ...(local ? [["project", local] as [Scope, string]] : []),
    ];
    state.facts = [];
    state.pitfalls = [];
    for (const [scope, dir] of layers) {
      const file = readFactFile(factFilePath(dir));
      state.facts.push(...file.facts.map((f) => ({ ...f, scope, stale: false })));
      state.pitfalls.push(...file.pitfalls.map((p) => ({ ...p, scope })));
    }
  }

  /**
   * Run a shell command the way pi's own bash tool does (Git Bash on Windows, bash elsewhere),
   * instead of assuming `sh` is on PATH. `missingShell` means no bash could be started at all.
   */
  async function runShell(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal) {
    let out = "";
    const append = (d: Buffer) => {
      if (out.length < 400_000) out += d.toString();
    };
    try {
      const ops = createLocalBashOperations();
      const r = await ops.exec(command, cwd, { onData: append, timeout: timeoutSec, signal, env: process.env });
      return { code: r.exitCode, output: out, timedOut: false, missingShell: false };
    } catch (error) {
      const msg = String((error as Error)?.message ?? error);
      return { code: null, output: `${out}\n${msg}`.trim(), timedOut: looksLikeTimeout(msg), missingShell: /ENOENT|spawn|not found/i.test(msg) && !out };
    }
  }

  let factChecks = "not run yet";
  async function checkFacts() {
    const timeoutSec = state.config.facts.checkTimeoutMs / 1000;
    const withChecks = state.facts.filter((f) => f.check);
    if (!withChecks.length) return void (factChecks = "no facts with checks");
    let noShell = false;
    await Promise.all(
      withChecks.map(async (f) => {
        const r = await runShell(f.check as string, state.repo ?? state.cwd, timeoutSec);
        if (r.missingShell) noShell = true;
        f.stale = r.code !== 0;
      }),
    );
    factChecks = noShell ? "not run: no bash found (on Windows install Git for Windows)" : `${withChecks.length} checked`;
    if (noShell) for (const f of withChecks) f.stale = false; // unknown, not stale
  }

  function loadTools() {
    state.tools = discoverTools([
      { dir: join(PACKAGE_ROOT, "toolbox"), layer: "bundled" },
      { dir: join(globalDataDir(), "toolbox"), layer: "global" },
      ...(state.repo && state.trusted ? [{ dir: join(projectDataDir(state.cwd), "toolbox"), layer: "project" as const }] : []),
      ...(localProjectDataDir(state.cwd) ? [{ dir: join(localProjectDataDir(state.cwd) as string, "toolbox"), layer: "project" as const }] : []),
    ]);
  }

  function refresh(cwd: string, trusted: boolean) {
    state.cwd = cwd;
    state.trusted = trusted;
    state.repo = findRepoRoot(cwd);
    const loaded = loadConfig(cwd, process.env, trusted);
    state.config = loaded.config;
    state.configWarnings = loaded.warnings;
    applyEnvDefaults();
    const probe = realProbe(cwd, state.repo, [join(agentDir(), "bin"), join(globalDataDir(), "bin")]);
    exposeFastSearch(probe);
    state.probe = { ...probe, env: process.env };
    state.env = detectEnv(state.probe);
    state.envText = formatEnv(state.env);
    loadFacts();
    loadTools();
  }

  const isTrusted = (ctx: ExtensionContext) => {
    try {
      return ctx.isProjectTrusted();
    } catch {
      return false;
    }
  };

  refresh(process.cwd(), false);

  pi.on("session_start", async (_event, ctx) => {
    refresh(ctx.cwd, isTrusted(ctx));
    void checkFacts();
    const warn = state.configWarnings.length ? ` (${state.configWarnings.length} config warning(s), see /ptk)` : "";
    if (ctx.hasUI) ctx.ui.setStatus("ptk", `ptk: ${state.tools.length} tools, ${state.facts.length} facts${warn}`);
  });

  // ---------- prompt sections ----------

  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") state.lastUserText = event.prompt ?? "";
    role = detectRole(process.env, event.systemPrompt ?? "");
    const c = state.config;
    const sections: Record<string, string> = {};
    const env = [state.envText];
    if (c.facts.enabled && (state.facts.length || state.pitfalls.length))
      env.push("Saved facts and pitfalls (from earlier sessions):", formatFacts(state.facts, state.pitfalls));
    if (c.facts.enabled)
      env.push("This is already known: do not spend tool calls rediscovering it. When something costs you several tool calls to find and will still be true next week, save it with the remember tool.");
    sections["environment"] = env.join("\n");
    if (c.guard.enabled)
      sections["command-rules"] =
        `bash calls without "timeout" stop after ${c.guard.defaultTimeoutSec}s (tests ${c.guard.testTimeoutSec}s, installs/builds ${c.guard.buildTimeoutSec}s, max ${c.guard.maxTimeoutSec}s); ` +
        "run the narrowest test that proves the point (one file or one test name) before the full suite. Test commands run with CI=1. " +
        "Servers, watchers and anything that waits forever go through the toolbox bg tool, never the foreground. " +
        "Search with the grep/find/ls tools or rg/fd, not grep -r or find -name. Prefer one command with && over several calls, and run independent tool calls in parallel.";
    if (c.toolbox.enabled && state.tools.length)
      sections["toolbox"] =
        "Ready-made helpers, run with the toolbox tool. Check here before writing a one-off script; save new reusable helpers with toolbox action add.\n" +
        formatToolList(state.tools);
    if (role === "lead")
      sections["working-agreement"] =
        "Clarify first, then run unattended. Before work that changes files, restate the task in one line with how you will know it is done. " +
        "If the goal, the done-criteria or the scope is unclear, ask at most 3 short questions and wait; do not start on guesses. " +
        "Once the user has confirmed, work to the end without asking again: the user may be away. Take the conservative option on minor decisions and list them in your final report. " +
        "Stop and ask only before something destructive or irreversible (deleting data, force-pushing, touching production, spending money).";
    if (c.plainTalk.enabled) {
      const reminder = state.lastUnexplained.length
        ? `\nYour previous reply used ${state.lastUnexplained.join(", ")} without explaining it. Explain terms like that in plain words this time.`
        : "";
      sections["output-style"] = PLAIN_TALK_RULES + reminder;
    }
    const opts = event.systemPromptOptions as { sections?: Record<string, string> } | undefined;
    if (opts?.sections) {
      Object.assign(opts.sections, sections);
      return;
    }
    const block = Object.entries(sections)
      .map(([k, v]) => `<${k}>\n${v}\n</${k}>`)
      .join("\n\n");
    return { systemPrompt: `${event.systemPrompt}\n\n${block}` };
  });

  pi.on("message_end", async (event, ctx) => {
    const c = state.config.plainTalk;
    if (!c.enabled || !c.acronymCheck) return;
    const msg = event.message as { role?: string; content?: unknown };
    if (msg.role !== "assistant" || !Array.isArray(msg.content)) return;
    const reply = msg.content
      .filter((p: { type?: string }) => p?.type === "text")
      .map((p: { text?: string }) => p.text ?? "")
      .join("\n");
    if (!reply.trim()) return;
    state.lastUnexplained = unexplainedAcronyms(reply, state.lastUserText, c.allow);
    if (ctx.hasUI) ctx.ui.setStatus("ptk-plain", state.lastUnexplained.length ? `unexplained: ${state.lastUnexplained.join(", ")}` : "");
  });

  // ---------- guard ----------

  pi.on("tool_call", async (event) => {
    const g = state.config.guard;
    if (!g.enabled || !isToolCallEventType("bash", event)) return;
    const probe = state.probe;
    const decision = inspectBash(event.input.command, {
      blockLongRunners: g.blockLongRunners,
      preferFastSearch: g.preferFastSearch,
      sudoNonInteractive: g.sudoNonInteractive,
      hasRg: Boolean(probe && which(probe, "rg")),
      hasFd: Boolean(probe && which(probe, "fd")),
      builtinSearch: { grep: pi.getActiveTools().includes("grep"), find: pi.getActiveTools().includes("find") },
      pitfalls: state.pitfalls,
      cwd: state.cwd,
    });
    if (decision.kind === "block") return { block: true, reason: decision.reason };
    const cls = classifyCommand(decision.command);
    event.input.command = cls === "test" && g.ciForTests ? withCi(decision.command, process.env) : decision.command;
    const classDefault = cls === "test" ? g.testTimeoutSec : cls === "build" ? g.buildTimeoutSec : g.defaultTimeoutSec;
    const t = resolveTimeout(event.input.timeout, classDefault, g.maxTimeoutSec);
    event.input.timeout = t.timeout;
    const notes = [...decision.notes];
    if (t.capped) notes.push(`Timeout capped at ${g.maxTimeoutSec}s. For longer jobs use toolbox bg and poll its logs.`);
    state.notes.set(event.toolCallId, { notes, timeout: t.timeout });
  });

  pi.on("tool_result", async (event) => {
    if (event.toolName !== "bash") return;
    const info = state.notes.get(event.toolCallId);
    state.notes.delete(event.toolCallId);
    const body = (event.content ?? []).map((c: { type: string; text?: string }) => (c.type === "text" ? (c.text ?? "") : "")).join("\n");
    const extra = [...(info?.notes ?? [])];
    if (event.isError && looksLikeTimeout(body))
      extra.push(`Stopped after ${info?.timeout ?? "?"}s by the ptk guard. If it is a server or watcher, use toolbox bg. If it is real work, rerun with a larger timeout (max ${state.config.guard.maxTimeoutSec}s) or narrow it (one test file, one package).`);
    if (!extra.length) return;
    return {
      content: [...(event.content ?? []), { type: "text" as const, text: `\n[ptk] ${extra.join("\n[ptk] ")}` }],
      structuredContent: event.structuredContent,
    };
  });

  // ---------- facts ----------

  let factWrites: Promise<unknown> = Promise.resolve();

  pi.registerTool({
    name: "remember",
    label: "Remember",
    description:
      "Save an environment fact or a pitfall for future sessions (stored as JSON, not docs). kind=fact: something that took several tool calls to find and will stay true (service port, working mirror, where test data lives); add `check`, a cheap shell command that exits 0 while the fact holds. kind=pitfall: a command pattern that keeps failing; `match` is a regex for the command, action warn or block. kind=forget removes an id.",
    promptSnippet: "Save environment facts and pitfalls so later sessions skip the rediscovery",
    promptGuidelines: [
      "Use remember only for facts that cost several tool calls to find and will still be true next week; never for task progress or opinions.",
      "Use remember with kind pitfall after a command pattern failed in a way that will happen again, so the guard warns next time.",
    ],
    parameters: Type.Object({
      kind: StringEnum(["fact", "pitfall", "forget"] as const),
      text: Type.Optional(Type.String({ description: "One sentence, plain words, under 300 characters" })),
      id: Type.Optional(Type.String({ description: "Short id; reuse an id to update, required for forget" })),
      check: Type.Optional(Type.String({ description: "fact only: shell command that exits 0 while the fact is true" })),
      match: Type.Optional(Type.String({ description: "pitfall only: regex tested against bash commands" })),
      when: Type.Optional(Type.String({ description: "pitfall only: regex the working directory must match" })),
      action: Type.Optional(StringEnum(["warn", "block"] as const)),
      scope: Type.Optional(StringEnum(["project", "global"] as const, { description: "project = this repo on this machine (kept in .git/ptk, never dirties the working tree); global = every repo" })),
    }),
    async execute(_id, params) {
      const scope: Scope = params.scope ?? (state.repo ? "project" : "global");
      const local = localProjectDataDir(state.cwd);
      if (scope === "project" && !local) throw new Error("not inside a git repo; use scope global");
      const file = factFilePath(scope === "project" ? (local as string) : globalDataDir());
      // Parallel tool calls must not interleave read-modify-write on the same file.
      const run = factWrites.then(() => {
        const { file: next, result } = applyRemember(readFactFile(file), params as RememberInput, state.config.facts.maxFacts);
        writeFactFile(file, next);
        loadFacts();
        return result;
      });
      factWrites = run.catch(() => undefined);
      const result = await run;
      const note = scope === "project" ? " To share it with the team: `ptk facts share`, then commit .pi/ptk/facts.json." : "";
      return text(`${result} Stored in ${file}.${note}`);
    },
  });

  // ---------- toolbox ----------

  pi.registerTool({
    name: "toolbox",
    label: "Toolbox",
    description:
      "Reusable helper scripts shared across sessions. action=list shows them, show prints usage, run executes one with args, add saves a script you wrote (source = its path) so the next session can reuse it instead of rewriting it.",
    promptSnippet: "Run or save reusable helpers: md2pdf, shot (screenshots), bg (background servers), saved scripts",
    promptGuidelines: [
      "Before writing a script for a conversion, report or screenshot, look in the toolbox section and use the toolbox tool if a helper fits.",
      "After writing a helper script that another session could reuse, save it with the toolbox tool, action add.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "show", "run", "add"] as const),
      name: Type.Optional(Type.String()),
      args: Type.Optional(Type.Array(Type.String(), { description: "run: arguments passed to the helper" })),
      timeoutSec: Type.Optional(Type.Number()),
      source: Type.Optional(Type.String({ description: "add: path of the script or directory to save" })),
      description: Type.Optional(Type.String({ description: "add: what it does and when to use it" })),
      usage: Type.Optional(Type.String({ description: "add: one-line usage, e.g. `csv2xlsx <in.csv> [out.xlsx]`" })),
      scope: Type.Optional(StringEnum(["global", "project"] as const)),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      loadTools();
      if (params.action === "list") return text(formatToolList(state.tools, 200) || "Toolbox is empty.");
      const tool = params.name ? state.tools.find((t) => t.name === params.name) : undefined;
      if (params.action === "add") {
        if (!params.name || !params.source || !params.description) throw new Error("add needs name, source and description");
        const scope = params.scope ?? "global";
        const local = localProjectDataDir(ctx.cwd);
        if (scope === "project" && !local) throw new Error("not inside a git repo; use scope global");
        // Project helpers go to .git/ptk/toolbox so saving one never dirties the working tree.
        const root = join(scope === "project" ? (local as string) : globalDataDir(), "toolbox");
        const saved = addTool(root, { name: params.name, description: params.description, usage: params.usage ?? params.name, source: params.source }, ctx.cwd);
        loadTools();
        return text(`Saved "${saved.name}" to ${saved.dir}. Run it with toolbox action run.`);
      }
      if (!tool) throw new Error(`no toolbox helper named "${params.name ?? ""}". Available: ${state.tools.map((t) => t.name).join(", ")}`);
      if (params.action === "show") return text(`${tool.name} (${tool.layer}, ${tool.dir})\n${tool.description}\nUsage: ${tool.usage}`);
      const argv = toolArgv(tool, params.args ?? []);
      const timeoutSec = Math.min(params.timeoutSec ?? state.config.toolbox.runTimeoutSec, state.config.guard.maxTimeoutSec);
      const r = await pi.exec(argv[0], argv.slice(1), { cwd: ctx.cwd, timeout: timeoutSec * 1000, signal });
      const out = clip(`${r.stdout ?? ""}${r.stderr ? `\n${r.stderr}` : ""}`.trim(), 20_000);
      if (r.code !== 0) throw new Error(`${tool.name} exited with ${r.code}${r.killed ? ` (stopped after ${timeoutSec}s)` : ""}\n${out}`);
      return text(out || `${tool.name} finished.`);
    },
  });

  // ---------- team ----------

  function rpc(method: string, params: Record<string, unknown>, timeoutMs = 15_000): Promise<unknown> {
    const requestId = randomUUID();
    return new Promise((resolvePromise, reject) => {
      const off = pi.events.on(`subagents:rpc:v1:reply:${requestId}`, (reply) => {
        clearTimeout(timer);
        off();
        const r = reply as { success?: boolean; data?: unknown; error?: { message?: string } };
        if (r.success) resolvePromise(r.data);
        else reject(new Error(r.error?.message ?? "pi-subagents returned an error"));
      });
      const timer = setTimeout(() => {
        off();
        reject(new Error("pi-subagents did not answer. Install it with: pi install npm:pi-subagents (then /reload)."));
      }, timeoutMs);
      pi.events.emit("subagents:rpc:v1:request", { version: 1, requestId, method, params });
    });
  }

  async function dirtyFiles(root: string): Promise<string[]> {
    const r = await pi.exec("git", ["status", "--porcelain", "--untracked-files=normal"], { cwd: root, timeout: 15_000 });
    if (r.code !== 0) throw new Error(`git status failed: ${r.stderr}`);
    return r.stdout
      .split("\n")
      .map((l) => l.slice(3).trim())
      .filter((f) => f && !f.startsWith(".pi/subagents"));
  }

  const TaskSchema = Type.Object({
    key: Type.String({ description: "short id, e.g. api-auth" }),
    title: Type.String(),
    brief: Type.String({ description: "Self-contained: what to change, where, and how to tell it is done. The worker sees nothing else." }),
    files: Type.Array(Type.String(), { description: "Paths or globs this task owns (relative to repo root). Tasks sharing a path run in one lane." }),
  });

  const leadFile = (cwd: string) => {
    const root = findRepoRoot(cwd);
    return root ? { root, file: leadStatePath(globalDataDir(), root) } : undefined;
  };
  const saveLead = (cwd: string, patch: Parameters<typeof updateLeadState>[2], session?: string) => {
    const lf = leadFile(cwd);
    if (!lf) return;
    try {
      writeLeadState(lf.file, updateLeadState(readLeadState(lf.file), lf.root, { ...patch, ...(session ? { session } : {}) }));
    } catch {
      /* state is a convenience; never fail the tool because of it */
    }
  };

  pi.registerTool({
    name: "team_run",
    label: "Team run",
    description:
      "Start a team run: each lane gets a worker in its own git worktree, the gate command must pass, a fresh read-only verifier checks the patch, and failed checks go back to the same worker (bounded rounds). Tasks that share files are merged into one lane so lanes never conflict. Runs in the background; you are notified when it finishes, then call team_integrate.",
    promptSnippet: "Run a goal with a planner, parallel workers, a verifier and automatic rework",
    promptGuidelines: [
      "Before team_run, settle the brief with the user: goal, doneWhen (the checks that prove it), outOfScope and your assumptions. Ask about anything unclear and wait; team_run shows the brief to the user for confirmation.",
      "Once a team run is confirmed it runs unattended: the user may be away. Never wait for the user during it. Answer workers' supervisor questions yourself from the brief and the code; when a product decision is truly needed, take the conservative option and record it for the final report.",
      "When a team_run finishes, call team_integrate with the runDir of every passed lane right away, then write the final report. If it returned state needs-input, answer the planner's questions from the brief where you can (otherwise take the conservative option and say so) and run again with tasks.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "The overall goal in one or two sentences" }),
      doneWhen: Type.String({ description: "How to tell it is done: the tests or checks that must pass, the behaviour to observe" }),
      outOfScope: Type.Optional(Type.String({ description: "What must not be changed or done" })),
      assumptions: Type.Optional(Type.Array(Type.String(), { description: "Defaults you chose where the user did not decide" })),
      tasks: Type.Optional(Type.Array(TaskSchema, { minItems: 1, maxItems: 12, description: "Omit to let the team-planner agent split the goal inside the run. At most team.maxTasks (default 8)." })),
      gate: Type.Optional(Type.String({ description: "Command that must pass in every worktree; default: configured or detected test command" })),
      maxRounds: Type.Optional(Type.Number({ description: "Verifier rounds per lane before a human decides" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = findRepoRoot(ctx.cwd);
      if (!root) throw new Error("team_run needs a git repository (workers use git worktrees).");
      const dirty = await dirtyFiles(root);
      if (dirty.length) {
        const shared = dirty.some((f) => f.startsWith(".pi/ptk")) ? "\n.pi/ptk holds team-shared facts/tools: commit it (or move it away) first." : "";
        throw new Error(`Commit or stash these first; workers branch from a clean HEAD:\n${dirty.slice(0, 20).join("\n")}${shared}`);
      }
      await rpc("ping", {}, 5_000);
      const t = state.config.team;
      const tasks = params.tasks?.length ? validateTasks(params.tasks as TeamTask[], t.maxTasks) : [];
      const lanes = planLanes(tasks);
      const gate = (params.gate ?? t.gate ?? "").trim() || state.env?.testCommand || "";
      // A gate that cannot even start here (python3 being a Store alias, a missing tool) would fail every lane
      // after a full round of work. Check its program once, now; a timeout or a failing test suite is fine.
      if (gate) {
        const prog = gateProgram(gate);
        if (prog) {
          const r = await runShell(`${prog} --version`, root, 20);
          if (r.missingShell) throw new Error("No bash found to run the gate. On Windows install Git for Windows (pi's bash tool needs it too).");
          if (!r.timedOut && looksUnrunnable(r.code, r.output))
            throw new Error(`The gate \`${gate}\` cannot run here: \`${prog} --version\` said:\n${r.output.trim().slice(0, 500)}\nPass a working gate (for example with python instead of python3, or py -3) or set team.gate in .pi/ptk.json.`);
        }
      }
      const brief = {
        goal: params.goal.trim(),
        doneWhen: params.doneWhen.trim(),
        ...(params.outOfScope?.trim() ? { outOfScope: params.outOfScope.trim() } : {}),
        ...(params.assumptions?.length ? { assumptions: params.assumptions.map((a) => a.trim()).filter(Boolean) } : {}),
      };
      // The goal text travels to planner, workers and verifier, so the done-criteria and limits travel with it.
      const fullGoal = [brief.goal, `Done when: ${brief.doneWhen}`, brief.outOfScope ? `Out of scope: ${brief.outOfScope}` : "", brief.assumptions?.length ? `Assumptions: ${brief.assumptions.join("; ")}` : ""]
        .filter(Boolean)
        .join("\n");
      if (t.confirm && ctx.hasUI) {
        const summary = [
          fullGoal,
          "",
          `Gate: ${gate || "(none: verifier only)"}`,
          lanes.length ? `Lanes: ${lanes.map((l) => l.key).join(", ")}` : "Tasks: the team-planner splits the goal",
          `Up to ${t.maxParallel} workers, ${Math.round(t.maxRounds)} review round(s) max, deadline ${t.runTimeoutMin} min. It runs unattended after you confirm.`,
        ].join("\n");
        const ok = await ctx.ui.confirm("Start this team run?", summary);
        if (!ok) throw new Error("The user did not confirm the brief. Ask what to change, update the brief, then call team_run again.");
      }
      const plan = {
        goal: fullGoal,
        lanes,
        gate,
        gateTimeoutSec: t.gateTimeoutSec,
        maxRounds: Math.max(1, Math.min(10, Math.round(params.maxRounds ?? t.maxRounds))),
        workerAgent: t.workerAgent,
        verifierAgent: t.verifierAgent,
        plannerAgent: t.plannerAgent,
        maxTasks: t.maxTasks,
        models: t.models,
      };
      const data = await rpc("spawn", {
        script: buildTeamScript(plan),
        cwd: root,
        globalConcurrencyLimit: t.maxParallel,
        options: { timeoutMs: t.runTimeoutMin * 60_000 },
      });
      saveLead(ctx.cwd, { brief, addRun: { startedAt: new Date().toISOString(), status: "running", lanes: lanes.map((l) => l.key), gate, runId: findRunId(data) } }, ctx.sessionManager.getSessionFile());
      const laneLines = lanes.map((l) => `- ${l.key}: ${l.tasks.map((x) => x.title).join(" + ")} [${l.files.join(", ")}]`);
      const roles = Object.entries(t.models).filter(([, m]) => m).map(([r, m]) => `${r}=${m}`).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Team run started in the background: ${lanes.length ? `${lanes.length} lane(s)` : "the team-planner splits the goal first"}, up to ${t.maxParallel} at once, gate ${gate ? `\`${gate}\`` : "(none: verifier only)"}, max ${plan.maxRounds} round(s)${roles ? `, models ${roles}` : ""}.\n` +
              (laneLines.length ? `${laneLines.join("\n")}\n` : "") +
              (lanes.length && lanes.length < tasks.length ? "Tasks sharing files were merged into one lane.\n" : "") +
              "You will be woken when it finishes. Meanwhile the fleet view shows progress; workers may ask you questions through the supervisor channel.",
          },
        ],
        details: { lanes, gate, rpc: data },
      };
    },
  });

  pi.registerTool({
    name: "team_integrate",
    label: "Team integrate",
    description:
      "Apply the patches of finished team lanes onto the current checkout in order (git apply), then run the gate once on the combined result. Pass the runDir values from the team run result. Stops at the first patch that does not apply and says why.",
    promptSnippet: "Merge finished team lanes into the working tree and run the gate on the result",
    parameters: Type.Object({
      runDirs: Type.Array(Type.String(), { minItems: 1 }),
      gate: Type.Optional(Type.String()),
      skipGate: Type.Optional(Type.Boolean()),
      keepWorktrees: Type.Optional(Type.Boolean({ description: "Keep the workers' worktrees after a passing integration" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      const root = findRepoRoot(ctx.cwd);
      if (!root) throw new Error("not inside a git repository");
      const dirty = await dirtyFiles(root);
      if (dirty.length) throw new Error(`The checkout has uncommitted changes; commit or stash them first so patches apply cleanly:\n${dirty.slice(0, 20).join("\n")}`);
      const lines: string[] = [];
      const handoffs: string[] = [];
      for (const dir of params.runDirs) {
        const handoff = join(dir, "handoff.json");
        if (!existsSync(handoff)) throw new Error(`no handoff.json in ${dir}; pass the runDir that team_run reported for the lane`);
        handoffs.push(handoff);
        const json = readFileSync(handoff, "utf8");
        let patches = patchesFromHandoff(dir, json).filter((x) => x.changed);
        const wt = worktreeFromHandoff(json);
        if (wt && existsSync(wt.path)) {
          // Current worktree state = every round, including rework the recorded patch does not contain.
          await pi.exec("git", ["-C", wt.path, "add", "-A"], { cwd: root, timeout: 60_000 });
          const d = await pi.exec("git", ["-C", wt.path, "diff", "--cached", "--binary", wt.baseCommit ?? "HEAD"], { cwd: root, timeout: 60_000 });
          if (d.code === 0) {
            if (!d.stdout.trim()) {
              lines.push(`no changes in ${wt.path}`);
              continue;
            }
            const file = join(tmpdir(), `ptk-${basename(dir)}-${Date.now()}.patch`);
            writeFileSync(file, d.stdout.endsWith("\n") ? d.stdout : `${d.stdout}\n`);
            patches = [{ runDir: dir, path: file, branch: basename(wt.path), changed: true }];
          }
        }
        for (const p of patches) {
          let r = await pi.exec("git", ["apply", "--whitespace=nowarn", p.path], { cwd: root, timeout: 60_000, signal });
          if (r.code !== 0) r = await pi.exec("git", ["apply", "--3way", "--whitespace=nowarn", p.path], { cwd: root, timeout: 60_000, signal });
          if (r.code !== 0) {
            lines.push(`FAILED ${p.path}\n${r.stderr.trim()}`);
            saveLead(ctx.cwd, { finishRun: { status: "integration-failed", result: lines.join("\n").slice(0, 1500) } });
            return text(`${lines.join("\n")}\n\nStopped. Earlier patches stay applied. Resolve the conflict or send the lane back to a worker.`);
          }
          lines.push(`applied ${p.branch ?? p.path}${p.diffStat ? `: ${p.diffStat.split("\n").pop()?.trim()}` : ""}`);
        }
      }
      const gate = params.skipGate ? "" : (params.gate ?? state.config.team.gate ?? "").trim() || state.env?.testCommand || "";
      let gatePassed = true;
      if (gate) {
        const r = await runShell(gate, root, state.config.team.gateTimeoutSec, signal);
        gatePassed = r.code === 0;
        const tail = clip(r.output.trim().split("\n").slice(-30).join("\n"), 4000);
        const why = r.missingShell ? "no bash found (on Windows install Git for Windows)" : `exit ${r.code ?? "?"}${r.timedOut ? ", timed out" : ""}`;
        lines.push(`gate \`${gate}\`: ${gatePassed ? "PASSED" : `FAILED (${why})`}\n${tail}`);
      }
      if (gatePassed && params.keepWorktrees !== true) {
        // Patches are in the checkout now; the workers' retained worktrees and branches are just clutter.
        // Only touch worktrees git itself lists for this repo and that pi-subagents created.
        const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd: root, timeout: 30_000 });
        const known = new Map<string, string | undefined>();
        let current = "";
        for (const l of listed.stdout.split("\n")) {
          if (l.startsWith("worktree ")) known.set((current = l.slice(9).trim()), undefined);
          else if (l.startsWith("branch refs/heads/") && current) known.set(current, l.slice(18).trim());
        }
        let removed = 0;
        for (const handoff of handoffs)
          for (const t of cleanupTargets(readFileSync(handoff, "utf8"))) {
            const branch = known.get(t.path);
            if (!known.has(t.path) || t.path === root || !/pi-worktree-/.test(t.path)) continue;
            if (branch && !branch.startsWith("pi-subagents/")) continue;
            const w = await pi.exec("git", ["worktree", "remove", "--force", t.path], { cwd: root, timeout: 30_000 });
            if (w.code !== 0) continue;
            removed++;
            if (branch) await pi.exec("git", ["branch", "-D", branch], { cwd: root, timeout: 30_000 });
          }
        await pi.exec("git", ["worktree", "prune"], { cwd: root, timeout: 30_000 });
        if (removed) lines.push(`removed ${removed} worker worktree(s) and their branches`);
      } else if (!gatePassed) lines.push("Worker worktrees kept so the lanes can be reworked.");
      lines.push("Changes are uncommitted: review with `git diff` (new files show as untracked), then commit.");
      saveLead(ctx.cwd, { finishRun: { status: gatePassed ? "integrated" : "integration-failed", result: lines.join("\n").slice(0, 1500) } });
      return text(lines.join("\n"));
    },
  });

  // ---------- terminal: title with session name and directory, notification when a long run ends ----------

  let runStarted = 0;
  const setTitle = (ctx: ExtensionContext, working: boolean) => {
    if (state.config.terminal.title && ctx.hasUI) ctx.ui.setTitle(terminalTitle(pi.getSessionName(), basename(state.cwd), working));
  };

  pi.on("session_start", async (_event, ctx) => setTitle(ctx, false));

  pi.on("input", async (event, ctx) => {
    if (!state.config.terminal.autoName || event.source !== "interactive" || pi.getSessionName()) return;
    const name = sessionNameFrom(event.text);
    if (name) {
      pi.setSessionName(name);
      setTitle(ctx, false);
    }
  });

  pi.on("agent_start", async (_event, ctx) => {
    if (!ctx.hasUI) return;
    runStarted = Date.now();
    setTitle(ctx, true);
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!ctx.hasUI || !runStarted) return;
    const secs = (Date.now() - runStarted) / 1000;
    runStarted = 0;
    setTitle(ctx, false);
    const after = state.config.terminal.notifyAfterSec;
    if (after <= 0 || secs < after || event.aborted) return;
    const where = pi.getSessionName() ? `${pi.getSessionName()} · ${basename(state.cwd)}` : basename(state.cwd);
    const n = buildNotification(`pi · ${where}`, `Done after ${Math.round(secs)}s, waiting for you`, process.platform, process.env, Boolean(state.probe && which(state.probe, "notify-send")));
    if (n.kind === "osc") process.stdout.write(n.sequence);
    else pi.exec(n.command, n.args, { timeout: 15_000 }).catch(() => undefined);
  });

  // ---------- context budget per kind of session ----------

  let role: SessionRole = "lead";
  let compacting = false;
  let compactions = 0;
  const COMPACT_FOCUS: Record<SessionRole, string> = {
    lead: "Keep the user's goals, decisions and constraints, every team run result (lanes, states, runDirs, findings), open questions and what is left. Drop tool output that was already acted on.",
    planner: "Keep the goal, the code locations found and the task split so far. Drop file contents already summarised.",
    worker: "Keep the brief, the owned files, what was changed so far, failing checks with their causes and any reviewer findings. Drop file contents already edited and old command output.",
    verifier: "Keep the brief, the patch under review and the findings so far.",
    child: "Keep the task, the findings so far and what is left.",
  };

  let cooldown = 0; // runs to skip after a compaction: what is kept verbatim can sit near the budget
  pi.on("session_compact", async () => {
    compacting = false;
    compactions++;
    cooldown = 2;
  });
  pi.on("session_compact_failed", async () => {
    compacting = false;
  });

  // Only ever compact an idle session. Tested: ctx.compact() during a run aborts that run.
  // Subagents (planner/worker/verifier) are not compacted here: they start fresh per task, and `ptk caps`
  // gives their models a smaller context window so pi's own between-turn compaction keeps them in budget.
  function checkContext(ctx: ExtensionContext) {
    const c = state.config.context;
    if (!c.enabled || compacting || role !== "lead" || !ctx.isIdle()) return;
    if (cooldown > 0) {
      cooldown--;
      return;
    }
    const usage = ctx.getContextUsage();
    if (!usage?.tokens) return;
    const limit = compactThreshold(role, c, usage.contextWindow);
    if (usage.tokens < limit) return;
    compacting = true;
    ctx.compact({
      customInstructions: COMPACT_FOCUS[role],
      onComplete: () => {
        if (!ctx.hasUI) return;
        ctx.ui.notify(`Context passed ${Math.round(limit / 1000)}k tokens (${role} budget) and was compacted.`, "info");
        if (role === "lead" && compactions >= c.handoffAfterCompactions)
          ctx.ui.notify(`Compacted ${compactions} times; summaries of summaries lose detail. For the next step, /handoff <what comes next> starts a fresh session with a focused brief.`, "warning");
      },
      onError: () => {
        compacting = false;
      },
    });
  }

  pi.on("agent_settled", async (event, ctx) => {
    if (!event.aborted) checkContext(ctx);
  });

  // /handoff: the "start fresh" path. Adapted from pi's examples/extensions/handoff.ts (MIT).
  pi.registerCommand("handoff", {
    description: "Start a fresh session with a focused brief generated from this one: /handoff <what the new session should do>",
    handler: async (args, ctx) => {
      if (ctx.mode !== "tui") return ctx.ui.notify("/handoff needs the interactive terminal", "error");
      if (!ctx.model) return ctx.ui.notify("No model selected", "error");
      const goal = args.trim();
      if (!goal) return ctx.ui.notify("Usage: /handoff <what the new session should do>", "error");
      const messages = handoffMessages(ctx.sessionManager.getBranch() as HandoffEntry[]);
      if (messages.length === 0) return ctx.ui.notify("Nothing to hand off yet", "error");
      const conversation = serializeConversation(convertToLlm(messages as never));
      const parentSession = ctx.sessionManager.getSessionFile();
      const draft = await ctx.ui.custom<string | null>((tui, theme, _kb, done) => {
        const loader = new BorderedLoader(tui, theme, "Writing the handoff brief...");
        loader.onAbort = () => done(null);
        ctx.modelRegistry
          .complete(
            ctx.model!,
            {
              systemPrompt: HANDOFF_PROMPT,
              messages: [{ role: "user", content: [{ type: "text", text: `## Conversation\n\n${conversation}\n\n## Goal for the new session\n\n${goal}` }], timestamp: Date.now() }],
            },
            { signal: loader.signal, cacheRetention: "none", sessionId: randomUUID() },
          )
          .then((r) => done(r.stopReason === "aborted" ? null : r.content.filter((c) => c.type === "text").map((c) => (c as { text: string }).text).join("\n")))
          .catch(() => done(null));
        return loader;
      });
      if (!draft) return ctx.ui.notify("Handoff cancelled", "info");
      const edited = await ctx.ui.editor("Edit the handoff brief, then submit it in the new session", draft);
      if (edited === undefined) return ctx.ui.notify("Handoff cancelled", "info");
      saveLead(ctx.cwd, { handoff: edited }, parentSession);
      await ctx.newSession({
        parentSession,
        withSession: async (next) => {
          next.ui.setEditorText(edited);
          next.ui.notify("Fresh session ready: review the brief and press Enter.", "info");
        },
      });
    },
  });

  // ---------- inheritance: a new lead session takes over with /continue ----------

  pi.registerCommand("continue", {
    description: "Take over the task an earlier lead session left in this repository (brief, team runs, handoff notes)",
    handler: async (_args, ctx) => {
      const lf = leadFile(ctx.cwd);
      const s = lf && readLeadState(lf.file);
      if (!s) return ctx.ui.notify("No earlier lead session recorded for this repository.", "info");
      const message = continuationMessage(s);
      if (ctx.mode === "tui") {
        ctx.ui.setEditorText(message);
        ctx.ui.notify("Takeover message is in the editor: review it and press Enter.", "info");
      } else pi.sendUserMessage(message);
    },
  });

  pi.on("session_start", async (event, ctx) => {
    if (!ctx.hasUI || (event.reason !== "startup" && event.reason !== "new")) return;
    const lf = leadFile(ctx.cwd);
    const s = lf && readLeadState(lf.file);
    if (!s || Date.now() - new Date(s.updatedAt).getTime() > 7 * 86_400_000) return;
    if (s.session && s.session === ctx.sessionManager.getSessionFile()) return;
    const open = s.runs.some((r) => r.status === "running");
    ctx.ui.notify(`An earlier lead session left work here (${ageText(s.updatedAt)}${open ? ", a team run may still be running" : ""}): ${s.brief?.goal ?? "see /continue"}. Type /continue to take it over.`, "info");
  });

  // ---------- /ptk ----------

  pi.registerCommand("ptk", {
    description: "pi-team-kit status: config, environment, facts, toolbox, team setup",
    handler: async (_args, ctx: ExtensionContext) => {
      refresh(ctx.cwd, isTrusted(ctx));
      await checkFacts();
      let subagents = "missing (pi install npm:pi-subagents)";
      try {
        await rpc("ping", {}, 3_000);
        subagents = "ready";
      } catch {
        /* keep message */
      }
      const g = state.config.guard;
      const report = [
        `config: ${loadConfig(ctx.cwd, process.env, state.trusted).files.join(", ") || "defaults"}${state.configWarnings.length ? `\n  warnings: ${state.configWarnings.join("; ")}` : ""}`,
        `project trust: ${state.trusted ? "yes (project config, facts and toolbox loaded)" : "no (project .pi/ptk.json, facts and toolbox ignored)"}`,
        `guard: ${g.enabled ? `on, timeout ${g.defaultTimeoutSec}s / tests ${g.testTimeoutSec}s / builds ${g.buildTimeoutSec}s (max ${g.maxTimeoutSec}s), search=${g.preferFastSearch}` : "off"}`,
        `pi-subagents: ${subagents}; team gate: ${state.config.team.gate || state.env?.testCommand || "(none)"}; models: ${Object.entries(state.config.team.models).map(([r, m]) => `${r}=${m || "default"}`).join(", ")}`,
        `toolbox: ${state.tools.map((t) => `${t.name}[${t.layer}]`).join(", ") || "empty"}`,
        `facts: ${state.facts.length} (${state.facts.filter((f) => f.stale).length} stale; checks ${factChecks}), pitfalls: ${state.pitfalls.length}`,
        ...(() => {
          const settingsFile = join(agentDir(), "settings.json");
          const bad = existsSync(settingsFile) ? backslashSources(readFileSync(settingsFile, "utf8")) : [];
          return bad.length ? [`WARNING package path with backslashes (${bad.join(", ")}): pi-subagents cannot load this package's agents. Run: node <pi-team-kit>/bin/ptk.ts doctor --fix`] : [];
        })(),
        "",
        state.envText,
      ].join("\n");
      ctx.ui.notify(report, "info");
    },
  });
}
