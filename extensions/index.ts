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
import { isToolCallEventType } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { agentDir, findRepoRoot, globalDataDir, loadConfig, projectDataDir, type PtkConfig } from "../lib/config.ts";
import { detectEnv, formatEnv, realProbe, which, type EnvFacts, type Probe } from "../lib/env.ts";
import { applyRemember, factFilePath, formatFacts, readFactFile, writeFactFile, type CheckedFact, type RememberInput, type Scope } from "../lib/facts.ts";
import { inspectBash, looksLikeTimeout, NON_INTERACTIVE_ENV, resolveTimeout, type Pitfall } from "../lib/guard.ts";
import { PLAIN_TALK_RULES, unexplainedAcronyms } from "../lib/plain.ts";
import { buildTeamScript, cleanupTargets, patchesFromHandoff, planLanes, validateTasks, worktreeFromHandoff, type TeamTask } from "../lib/team.ts";
import { addTool, discoverTools, formatToolList, toolArgv, type ToolEntry } from "../lib/toolbox.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
    const project = state.repo && state.trusted;
    const layers: [Scope, string][] = [["global", globalDataDir()], ...(project ? [["project", projectDataDir(state.cwd)] as [Scope, string]] : [])];
    state.facts = [];
    state.pitfalls = [];
    for (const [scope, dir] of layers) {
      const file = readFactFile(factFilePath(dir));
      state.facts.push(...file.facts.map((f) => ({ ...f, scope, stale: false })));
      state.pitfalls.push(...file.pitfalls.map((p) => ({ ...p, scope })));
    }
  }

  async function checkFacts() {
    if (process.platform === "win32") return;
    const timeout = state.config.facts.checkTimeoutMs;
    await Promise.all(
      state.facts
        .filter((f) => f.check)
        .map(async (f) => {
          try {
            const r = await pi.exec("sh", ["-c", f.check as string], { cwd: state.repo ?? state.cwd, timeout });
            f.stale = r.code !== 0 || r.killed === true;
          } catch {
            f.stale = true;
          }
        }),
    );
  }

  function loadTools() {
    state.tools = discoverTools([
      { dir: join(PACKAGE_ROOT, "toolbox"), layer: "bundled" },
      { dir: join(globalDataDir(), "toolbox"), layer: "global" },
      ...(state.repo && state.trusted ? [{ dir: join(projectDataDir(state.cwd), "toolbox"), layer: "project" as const }] : []),
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
        `bash calls are stopped after ${c.guard.defaultTimeoutSec}s unless you pass "timeout" (max ${c.guard.maxTimeoutSec}s); pass a bigger timeout only for work that really needs it. ` +
        "Servers, watchers and anything that waits forever go through the toolbox bg tool, never the foreground. " +
        "Search with the grep/find/ls tools or rg/fd, not grep -r or find -name. Prefer one command with && over several calls, and run independent tool calls in parallel.";
    if (c.toolbox.enabled && state.tools.length)
      sections["toolbox"] =
        "Ready-made helpers, run with the toolbox tool. Check here before writing a one-off script; save new reusable helpers with toolbox action add.\n" +
        formatToolList(state.tools);
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
    event.input.command = decision.command;
    const t = resolveTimeout(event.input.timeout, g.defaultTimeoutSec, g.maxTimeoutSec);
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
      scope: Type.Optional(StringEnum(["project", "global"] as const, { description: "project = this repo (commit .pi/ptk/facts.json to share); global = every repo" })),
    }),
    async execute(_id, params) {
      const scope: Scope = params.scope ?? (state.repo ? "project" : "global");
      if (scope === "project" && !state.repo) throw new Error("not inside a git repo; use scope global");
      const file = factFilePath(scope === "project" ? projectDataDir(state.cwd) : globalDataDir());
      // Parallel tool calls must not interleave read-modify-write on the same file.
      const run = factWrites.then(() => {
        const { file: next, result } = applyRemember(readFactFile(file), params as RememberInput, state.config.facts.maxFacts);
        writeFactFile(file, next);
        loadFacts();
        return result;
      });
      factWrites = run.catch(() => undefined);
      const result = await run;
      const note = scope === "project" && !state.trusted ? " This project is not trusted in pi yet, so project facts load only after you trust it." : "";
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
        if (scope === "project" && !state.repo) throw new Error("not inside a git repo; use scope global");
        const root = join(scope === "project" ? projectDataDir(ctx.cwd) : globalDataDir(), "toolbox");
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

  pi.registerTool({
    name: "team_run",
    label: "Team run",
    description:
      "Start a team run: each lane gets a worker in its own git worktree, the gate command must pass, a fresh read-only verifier checks the patch, and failed checks go back to the same worker (bounded rounds). Tasks that share files are merged into one lane so lanes never conflict. Runs in the background; you are notified when it finishes, then call team_integrate.",
    promptSnippet: "Run a planned set of tasks with parallel workers, a verifier and automatic rework",
    promptGuidelines: [
      "Use team_run only after splitting the goal into tasks with disjoint file ownership and self-contained briefs; ask the user first if the goal is unclear.",
      "When a team_run finishes, call team_integrate with the runDir of every passed lane, then report results in plain words.",
    ],
    parameters: Type.Object({
      goal: Type.String({ description: "The overall goal in one or two sentences" }),
      tasks: Type.Array(TaskSchema, { minItems: 1, maxItems: 12 }),
      gate: Type.Optional(Type.String({ description: "Command that must pass in every worktree; default: configured or detected test command" })),
      maxRounds: Type.Optional(Type.Number({ description: "Verifier rounds per lane before a human decides" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = findRepoRoot(ctx.cwd);
      if (!root) throw new Error("team_run needs a git repository (workers use git worktrees).");
      const dirty = await dirtyFiles(root);
      if (dirty.length) throw new Error(`Commit or stash these first; workers branch from a clean HEAD:\n${dirty.slice(0, 20).join("\n")}`);
      await rpc("ping", {}, 5_000);
      const t = state.config.team;
      const tasks = validateTasks(params.tasks as TeamTask[]);
      const lanes = planLanes(tasks);
      const gate = (params.gate ?? t.gate ?? "").trim() || state.env?.testCommand || "";
      const plan = {
        goal: params.goal.trim(),
        lanes,
        gate,
        gateTimeoutSec: t.gateTimeoutSec,
        maxRounds: Math.max(1, Math.min(10, Math.round(params.maxRounds ?? t.maxRounds))),
        workerAgent: t.workerAgent,
        verifierAgent: t.verifierAgent,
      };
      const data = await rpc("spawn", {
        script: buildTeamScript(plan),
        cwd: root,
        globalConcurrencyLimit: t.maxParallel,
        options: { timeoutMs: t.runTimeoutMin * 60_000 },
      });
      const laneLines = lanes.map((l) => `- ${l.key}: ${l.tasks.map((x) => x.title).join(" + ")} [${l.files.join(", ")}]`);
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Team run started in the background: ${lanes.length} lane(s), up to ${t.maxParallel} at once, gate ${gate ? `\`${gate}\`` : "(none: verifier only)"}, max ${plan.maxRounds} round(s).\n` +
              `${laneLines.join("\n")}\n` +
              (lanes.length < tasks.length ? "Tasks sharing files were merged into one lane.\n" : "") +
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
            return text(`${lines.join("\n")}\n\nStopped. Earlier patches stay applied. Resolve the conflict or send the lane back to a worker.`);
          }
          lines.push(`applied ${p.branch ?? p.path}${p.diffStat ? `: ${p.diffStat.split("\n").pop()?.trim()}` : ""}`);
        }
      }
      const gate = params.skipGate ? "" : (params.gate ?? state.config.team.gate ?? "").trim() || state.env?.testCommand || "";
      let gatePassed = true;
      if (gate) {
        const r = await pi.exec("sh", ["-c", gate], { cwd: root, timeout: state.config.team.gateTimeoutSec * 1000, signal });
        gatePassed = r.code === 0;
        const tail = clip(`${r.stdout}\n${r.stderr}`.trim().split("\n").slice(-30).join("\n"), 4000);
        lines.push(`gate \`${gate}\`: ${gatePassed ? "PASSED" : `FAILED (exit ${r.code}${r.killed ? ", timed out" : ""})`}\n${tail}`);
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
      return text(lines.join("\n"));
    },
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
        `guard: ${g.enabled ? `on, timeout ${g.defaultTimeoutSec}s (max ${g.maxTimeoutSec}s), search=${g.preferFastSearch}` : "off"}`,
        `pi-subagents: ${subagents}; team gate: ${state.config.team.gate || state.env?.testCommand || "(none)"}`,
        `toolbox: ${state.tools.map((t) => `${t.name}[${t.layer}]`).join(", ") || "empty"}`,
        `facts: ${state.facts.length} (${state.facts.filter((f) => f.stale).length} stale), pitfalls: ${state.pitfalls.length}`,
        "",
        state.envText,
      ].join("\n");
      ctx.ui.notify(report, "info");
    },
  });
}
