// pi-team-kit: one extension, six jobs.
//   guard     - bash calls get a timeout, never hang on servers/prompts, use rg/fd
//   facts     - environment detected by code + facts/pitfalls the agent saved, injected every session
//   plain     - "speak plainly" rules + a check for unexplained abbreviations
//   toolbox   - reusable helper scripts (md2pdf, shot, bg, and whatever gets saved later)
//   team      - team_run / team_integrate on top of pi-subagents (lead + workers + verifier + rework)
//   leads     - lead sessions on related tasks see each other's status and tell each other what changed

import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { homedir, hostname, tmpdir } from "node:os";
import { basename, delimiter, dirname, isAbsolute, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { BorderedLoader, convertToLlm, createLocalBashOperations, isToolCallEventType, serializeConversation } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";

import { agentDir, backslashSources, findRepoRoot, gitCommonDir, globalDataDir, loadConfig, localProjectDataDir, playbookDirs, projectDataDir, type PtkConfig } from "../lib/config.ts";
import { formatEvidence, gitEvidence, leadEvidence, readRunValue, recentSessions, sessionEvidence } from "../lib/harvest.ts";
import { formatFriction, frictionFromFiles, runPhases, sessionFiles } from "../lib/feedback.ts";
import { activateVenv, describePrep, isWorkerWorktree, mainCheckout, preferWorktreeCode, prepareWorktree } from "../lib/worktree.ts";
import { digestBlock, findDigest, listDigests, saveDigest } from "../lib/digest.ts";
import { formatRunReport, lanesNotPassed, noticeRuns, parseNumstat, runFacts, type Changed, type NoticeRun, type ReportItem } from "../lib/runreport.ts";
import { SoloWork } from "../lib/solo.ts";
import { fileUrl, linkFilePaths, piWebUrl } from "../lib/link.ts";
import {
  appendRetired,
  applyChanges,
  checkPlaybook,
  copyTemplates,
  findPlaybook,
  LIMITS,
  listPlaybooks,
  playbookBrief,
  readMeta,
  redact,
  renderPlaybook,
  validPlaybookName,
  writeMeta,
  type Change,
} from "../lib/playbook.ts";
import {
  ackInbox,
  changedBetween,
  fileKey,
  fileState,
  claimName,
  formatBoard,
  formatIncoming,
  formatLog,
  MAX_STATUS,
  MAX_WAKE_HOPS,
  OVERLAP_MS,
  overlaps,
  pathsInCommand,
  peersSection,
  readCard,
  readCards,
  readInbox,
  readLog,
  recordFile,
  removeCard,
  sendMessage,
  shouldWake,
  statusSnapshot,
  slugName,
  validName,
  writeCard,
  type ChangedFile,
  type LeadCard,
} from "../lib/board.ts";
import { detectEnv, formatEnv, realProbe, which, type EnvFacts, type Probe } from "../lib/env.ts";
import { applyRemember, factFilePath, factStatus, formatFacts, readFactFile, writeFactFile, type CheckedFact, type RememberInput, type Scope } from "../lib/facts.ts";
import { classifyCommand, gatePreflight, inspectBash, looksLikeTimeout, looksUnrunnable, NON_INTERACTIVE_ENV, resolveTimeout, withCi, type Pitfall } from "../lib/guard.ts";
import { PLAIN_TALK_RULES, unexplainedAcronyms } from "../lib/plain.ts";
import { buildTeamScript, cleanupTargets, integrationGate, parseWorktreeList, patchesFromHandoff, pathKey, patternsOverlap, planLanes, planWorktreeCleanup, resolveTeamRepo, roleModels, THINKING_LEVELS, validateTasks, worktreeFromHandoff, type TeamTask } from "../lib/team.ts";
import { addTool, discoverTools, formatToolList, toolArgv, type ToolEntry } from "../lib/toolbox.ts";
import { buildNotification, compactThreshold, detectRole, sessionNameFrom, terminalTitle, type SessionRole } from "../lib/session.ts";
import { ageText, continuationMessage, findRunId, leadStatePath, readLeadState, updateLeadState, writeLeadState } from "../lib/lead.ts";

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
/** customType of messages from other leads, so a run they start can be told apart from one a person started. */
const BOARD_MESSAGE = "ptk-lead-message";
/** The team agents' own thinking levels (agents/*.md), shown when nothing overrides them. */
const AGENT_THINKING = { planner: "max", worker: "high", verifier: "max" } as const;
type TeamRole = keyof typeof AGENT_THINKING;

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
  async function runShell(command: string, cwd: string, timeoutSec: number, signal?: AbortSignal, env: NodeJS.ProcessEnv = process.env) {
    let out = "";
    const append = (d: Buffer) => {
      if (out.length < 400_000) out += d.toString();
    };
    try {
      const ops = createLocalBashOperations();
      const r = await ops.exec(command, cwd, { onData: append, timeout: timeoutSec, signal, env });
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
    let unknown = 0;
    await Promise.all(
      withChecks.map(async (f) => {
        const r = await runShell(f.check as string, state.repo ?? state.cwd, timeoutSec);
        if (r.missingShell) noShell = true;
        const status = factStatus(r);
        f.stale = status === "stale";
        if (status === "unknown") unknown++;
      }),
    );
    factChecks = noShell
      ? "not run: no bash found (on Windows install Git for Windows)"
      : `${withChecks.length} checked${unknown ? `, ${unknown} timed out (status unknown, not marked stale)` : ""}`;
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

  // A team worker starts in a fresh worktree: activate the project's virtualenv and copy its ignored local config
  // (lib/worktree.ts) before the first turn, so it neither reinstalls dependencies nor fails on a missing .env.
  let worktreeNote = "";
  pi.on("session_start", async (_event, ctx) => {
    worktreeNote = "";
    if (!process.env.PI_SUBAGENT_CHILD || !state.config.team.linkIntoWorktrees.length || !isWorkerWorktree(ctx.cwd)) return;
    const main = mainCheckout(ctx.cwd);
    if (!main) return;
    const ignored = (rel: string) => spawnSync("git", ["-C", ctx.cwd, "check-ignore", "-q", "--", rel], { stdio: "ignore", windowsHide: true, timeout: 10_000 }).status === 0;
    try {
      const prep = prepareWorktree(main, ctx.cwd, state.config.team.linkIntoWorktrees, ignored);
      if (prep.venv) {
        activateVenv(prep.venv, process.env);
        preferWorktreeCode(ctx.cwd, process.env);
      }
      worktreeNote = describePrep(prep);
    } catch {
      /* the worker still works, only slower */
    }
  });

  // ---------- prompt sections ----------

  pi.on("before_agent_start", async (event) => {
    if (event.messageType === "user") state.lastUserText = event.prompt ?? "";
    role = detectRole(process.env, event.systemPrompt ?? "");
    // Which chain of lead messages this run belongs to: 0 when a person started it.
    const startedBy = (event as { message?: { customType?: string } }).message?.customType;
    lb.turnHops = event.messageType === "custom" && startedBy === BOARD_MESSAGE ? (lb.pendingWakeHops ?? 1) : event.messageType === "user" ? 0 : lb.turnHops;
    lb.pendingWakeHops = undefined;
    const c = state.config;
    const sections: Record<string, string> = {};
    const env = [state.envText];
    if (c.facts.enabled && (state.facts.length || state.pitfalls.length))
      env.push("Saved facts and pitfalls (from earlier sessions):", formatFacts(state.facts, state.pitfalls));
    if (c.facts.enabled)
      env.push("This is already known: do not spend tool calls rediscovering it. When something costs you several tool calls to find and will still be true next week, save it with the remember tool.");
    if (worktreeNote) env.push(worktreeNote);
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
        "Stop and ask only before something destructive or irreversible (deleting data, force-pushing, touching production, spending money). " +
        "When a playbook skill (lessons from earlier projects of the same kind) matches the task, read it first: ask its Ask-first items while clarifying, follow its Steps, take its Done-when into doneWhen, and pass playbook=<name> to team_run.";
    if (role === "lead" && lb.name) {
      const peers = peersSection(liveCards(), lb.name, Date.now(), homedir());
      if (peers) sections["leads"] = peers;
    }
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

  // File paths in a lead's reply become links (lib/link.ts): Ctrl+click in the terminal opens the file with its
  // default app (Word, a PDF viewer); in pi-web a click downloads it.
  pi.on("message_end", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD || role !== "lead") return;
    const toUrl = piWebLiveness() ? piWebUrl : ctx.mode === "tui" ? (abs: string) => fileUrl(abs) : undefined;
    const msg = event.message as { role?: string; content?: unknown };
    if (!toUrl || msg.role !== "assistant" || !Array.isArray(msg.content)) return;
    const bases = [ctx.cwd, lastTeamRepo].filter((b): b is string => Boolean(b));
    let changed = false;
    const content = msg.content.map((p: { type?: string; text?: string }) => {
      if (p?.type !== "text" || !p.text) return p;
      const text = linkFilePaths(p.text, toUrl, bases, homedir());
      if (text === p.text) return p;
      changed = true;
      return { ...p, text };
    });
    return changed ? { message: { ...event.message, content } as typeof event.message } : undefined;
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

  // ---------- subagent runs: deadline, hand-off before it, and what a run left behind when it did not finish ----------
  // Subagent runs the lead starts itself get the same deadline and checkpoint as team children (pi-subagents would
  // kill them after 30 minutes, mid-work). When a run, or a lane of a team run, ends without passing, the next turn
  // starts with what it changed and whether that stayed inside what it was allowed to touch (lib/runreport.ts).
  const runBaselines: { at: number; root: string; snap: Map<string, string> }[] = [];
  const reportedRuns = new Set<string>();
  const openedAt = Date.now();
  const repoSnapshot = async (root: string): Promise<Map<string, string> | undefined> => {
    const r = await pi.exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, timeout: 10_000 }).catch(() => undefined);
    return r?.code === 0 ? statusSnapshot(root, r.stdout) : undefined;
  };
  pi.on("tool_call", async (event) => {
    if (event.toolName !== "subagent" || process.env.PI_SUBAGENT_CHILD) return;
    const input = event.input as Record<string, unknown>;
    if (!input.task && !input.tasks && !input.chain && !input.workflow) return; // list, status and other actions
    const t = state.config.team;
    if (input.timeoutMs === undefined && input.maxRuntimeMs === undefined) input.timeoutMs = t.childTimeoutMin * 60_000;
    const deadline = Number(input.timeoutMs ?? input.maxRuntimeMs);
    if (input.checkpointBeforeDeadlineMs === undefined && t.checkpointMin > 0 && t.checkpointMin * 60_000 < deadline) input.checkpointBeforeDeadlineMs = t.checkpointMin * 60_000;
    // What the repo looked like before the run, so its own changes can be told apart afterwards.
    const root = findRepoRoot(typeof input.cwd === "string" ? resolve(state.cwd, input.cwd) : state.cwd);
    const snap = root ? await repoSnapshot(root) : undefined;
    if (root && snap) {
      runBaselines.push({ at: Date.now(), root, snap });
      if (runBaselines.length > 20) runBaselines.shift();
    }
  });
  const changesIn = async (root: string, before?: Map<string, string>): Promise<Changed[] | undefined> => {
    const now = await repoSnapshot(root);
    if (!now) return undefined;
    const files = (before ? changedBetween(before, now, (rel) => fileState(root, rel)) : [...now.keys()]).slice(0, 60);
    if (!files.length) return [];
    const ns = await pi.exec("git", ["--no-optional-locks", "diff", "--numstat", "HEAD", "--", ...files], { cwd: root, timeout: 10_000 }).catch(() => undefined);
    const stats = parseNumstat(ns?.code === 0 ? ns.stdout : "");
    return files.map((path) => {
      const s = stats.get(path);
      if (s) return { path, ...s };
      try {
        const st = statSync(join(root, path));
        if (st.isFile() && st.size <= 2_000_000) return { path, newLines: readFileSync(join(root, path), "utf8").split("\n").length };
      } catch {
        /* deleted */
      }
      return { path };
    });
  };
  const laneWorktree = (runDir?: string): string | undefined => {
    if (!runDir) return undefined;
    try {
      const wt = worktreeFromHandoff(readFileSync(join(runDir, "handoff.json"), "utf8"))?.path;
      if (wt && existsSync(wt)) return wt;
    } catch {
      /* no handoff: a run that did not finish */
    }
    try {
      const wt = runFacts(JSON.parse(readFileSync(join(runDir, "status.json"), "utf8"))).worktree;
      return wt && existsSync(wt) ? wt : undefined;
    } catch {
      return undefined;
    }
  };
  const reportRun = async (run: NoticeRun): Promise<ReportItem[]> => {
    if (!run.asyncDir) return [];
    let status: unknown;
    try {
      status = JSON.parse(readFileSync(join(run.asyncDir, "status.json"), "utf8"));
    } catch {
      return [];
    }
    if (run.agent === "workflow") {
      const items: ReportItem[] = [];
      for (const lane of lanesNotPassed((status as { workflow?: { value?: unknown } }).workflow?.value)) {
        const wt = laneWorktree(lane.runDir);
        const changed = (wt && (await changesIn(wt))) || [];
        const outside = lane.files.length ? changed.map((c) => c.path).filter((p) => !lane.files.some((f) => f === "**" || patternsOverlap(f, p))) : [];
        items.push({ title: `team lane ${lane.lane}: ${lane.state}`, where: wt, changed, outside, lastTools: [], note: wt ? undefined : "its worktree is gone or was never made" });
      }
      if (!items.length && run.status !== "completed") items.push({ title: `team run ${run.status}`, changed: [], outside: [], lastTools: [], error: runFacts(status).error });
      return items;
    }
    if (run.status === "completed") return [];
    const f = runFacts(status);
    const root = f.worktree ?? (f.cwd ? findRepoRoot(f.cwd) : undefined);
    if (!root) return [{ title: `subagent ${run.agent} ${run.status}`, changed: [], outside: [], lastTools: f.lastTools, error: f.error }];
    const before = f.worktree ? undefined : [...runBaselines].reverse().find((b) => pathKey(b.root) === pathKey(root) && b.at <= (f.startedAt ?? Date.now()) + 5_000)?.snap;
    const changed = (await changesIn(root, before)) ?? [];
    const minutes = run.durationMs ? ` after ${Math.round(run.durationMs / 60_000)} min` : "";
    return [
      {
        title: `subagent ${run.agent} ${run.status}${minutes}`,
        where: root,
        changed,
        outside: [],
        lastTools: f.lastTools,
        error: f.error,
        note: f.worktree || before ? undefined : "no snapshot from before the run: this lists every uncommitted change in the repo, yours included",
      },
    ];
  };
  pi.on("before_agent_start", async (event, ctx) => {
    if (process.env.PI_SUBAGENT_CHILD) return;
    try {
      const runs: NoticeRun[] = [];
      const ev = event as { messageType?: string; message?: { customType?: string; details?: unknown } };
      if (ev.messageType === "custom" && ev.message?.customType === "subagent-notify") runs.push(...noticeRuns(ev.message.details));
      // A notice that arrived during a turn joined that turn; it is picked up from the session at the next one.
      for (const e of ctx.sessionManager.getEntries().slice(-40) as Array<{ type?: string; customType?: string; details?: unknown; timestamp?: string }>)
        if (e.type === "custom_message" && e.customType === "subagent-notify" && Date.parse(e.timestamp ?? "") >= openedAt) runs.push(...noticeRuns(e.details));
      const items: ReportItem[] = [];
      for (const run of runs) {
        if (reportedRuns.has(run.runId)) continue;
        reportedRuns.add(run.runId);
        items.push(...(await reportRun(run)));
      }
      if (!items.length) return;
      return { message: { customType: "ptk-run-report", content: formatRunReport(items), display: true } };
    } catch {
      return; // a report is a convenience; never block the turn
    }
  });

  // ---------- team mode by default: a big task goes to workers, not one session (lib/solo.ts) ----------
  const solo = new SoloWork({ enabled: true, files: 6, nudgeCalls: 40 });
  let soloOff = false; // /team-auto off, for this session
  const soloFile = (p: unknown) => (typeof p === "string" && p.trim() ? resolve(state.cwd, p.replace(/^@/, "").replace(/^~(?=$|[\\/])/, homedir())) : undefined);
  pi.on("input", async (event) => {
    if (event.source !== "extension") solo.userInput();
  });
  pi.on("tool_call", async (event) => {
    if (process.env.PI_SUBAGENT_CHILD) return;
    const a = state.config.team.auto;
    solo.opts = { enabled: a.enabled && !soloOff, files: a.files, nudgeCalls: a.nudgeCalls };
    const why = solo.before(event.toolName, soloFile((event.input as { path?: unknown }).path));
    if (why) return { block: true, reason: why };
  });
  pi.on("tool_result", async (event) => {
    if (process.env.PI_SUBAGENT_CHILD) return;
    const note = solo.after(event.toolName, soloFile((event.input as { path?: unknown }).path), event.isError);
    if (!note) return;
    return { content: [...(event.content ?? []), { type: "text" as const, text: `\n[ptk] ${note}` }], structuredContent: event.structuredContent };
  });
  pi.registerCommand("team-auto", {
    description: "Team mode for this session: on (default) hands a big task to workers past a few files; off lets the lead do it alone",
    handler: async (args, ctx) => {
      const v = (args ?? "").trim().toLowerCase();
      if (v === "off" || v === "on") soloOff = v === "off";
      const a = state.config.team.auto;
      ctx.ui.notify(
        soloOff || !a.enabled
          ? `Team mode is off${soloOff ? " for this session (/team-auto on)" : " (team.auto.enabled in ptk.json)"}: the lead may change any number of files itself.`
          : `Team mode is on: past ${a.files} files in one request the lead hands the rest to workers (team_run). /team-auto off to turn it off for this session.`,
        "info",
      );
    },
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
      const argv = toolArgv(tool, params.args ?? [], state.env?.python);
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

  // pi is often started in the home folder and pointed at a project: the repo a run works in comes from the
  // `repo` parameter, the session folder, or the previous run in this session.
  let lastTeamRepo: string | undefined;
  const workRepo = (cwd: string) => findRepoRoot(cwd) ?? lastTeamRepo;

  // pi-web closes a session idle for 10 minutes. A lead whose team run is still going in the background must
  // stay open to get the result: pi-web's liveness registry (absent anywhere else, then nothing happens).
  let teamRunUntil = 0;
  let releaseLiveness = () => {};
  type Liveness = { version?: number; register?: (p: { name: string; sessionId: string; sessionFile?: string; isActive: () => boolean }) => () => void };
  const piWebLiveness = () => (globalThis as Record<symbol, Liveness | undefined>)[Symbol.for("@agegr/pi-web/session-liveness/v1")];
  pi.on("session_start", async (_event, ctx) => {
    releaseLiveness();
    releaseLiveness = () => {};
    const reg = piWebLiveness();
    if (reg?.version !== 1 || typeof reg.register !== "function" || process.env.PI_SUBAGENT_CHILD) return;
    try {
      let release = () => {};
      release = reg.register({
        name: "pi-team-kit",
        sessionId: ctx.sessionManager.getSessionId(),
        sessionFile: ctx.sessionManager.getSessionFile() || undefined,
        isActive: () => {
          try {
            ctx.isIdle(); // throws once the host disposed the session, also without session_shutdown
          } catch {
            queueMicrotask(() => typeof release === "function" && release());
            return false;
          }
          return Date.now() < teamRunUntil;
        },
      });
      if (typeof release === "function") releaseLiveness = release;
    } catch {
      /* an older or changed registry: pi-web's own idle rule applies */
    }
  });
  pi.on("session_shutdown", async () => {
    releaseLiveness();
    releaseLiveness = () => {};
  });

  // Thinking per role for this session only, said in the conversation: over ptk.json, over the agents' defaults.
  // Kept as a session entry, so it survives /reload and /resume of this session but no other session sees it.
  let sessionThinking: Partial<Record<TeamRole, string>> = {};
  const effectiveThinking = (): Partial<Record<TeamRole, string>> => {
    const out: Partial<Record<TeamRole, string>> = {};
    for (const r of ["planner", "worker", "verifier"] as const) {
      const level = sessionThinking[r] || state.config.team.thinking[r];
      if (level) out[r] = level;
    }
    return out;
  };
  const thinkingTable = () => (["planner", "worker", "verifier"] as const).map((r) => `${r} ${effectiveThinking()[r] ?? AGENT_THINKING[r]}${sessionThinking[r] ? " (this session)" : ""}`).join(", ");
  const setSessionThinking = (patch: Partial<Record<TeamRole, string>> | "reset") => {
    if (patch === "reset") sessionThinking = {};
    else
      for (const [r, level] of Object.entries(patch) as [TeamRole, string][]) {
        if (!level) continue;
        if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new Error(`"${level}" is not a thinking level; use one of ${THINKING_LEVELS.join(", ")}`);
        sessionThinking[r] = level;
      }
    pi.appendEntry("ptk-team-thinking", { ...sessionThinking });
  };
  pi.on("session_start", async (_event, ctx) => {
    sessionThinking = {};
    try {
      for (const e of ctx.sessionManager.getBranch() as { type?: string; customType?: string; data?: Partial<Record<TeamRole, string>> }[])
        if (e.type === "custom" && e.customType === "ptk-team-thinking" && e.data) sessionThinking = { ...e.data };
    } catch {
      /* no session history */
    }
  });

  pi.registerTool({
    name: "team_thinking",
    label: "Team thinking",
    description:
      "Change how hard the team-run roles think, for this session only, when the user asks (\"workers can think less\", \"max for everything\"). Levels: off, minimal, low, medium, high, xhigh, max. Defaults: planner max, worker high, verifier max. reset=true goes back to the defaults.",
    parameters: Type.Object({
      planner: Type.Optional(StringEnum(THINKING_LEVELS)),
      worker: Type.Optional(StringEnum(THINKING_LEVELS)),
      verifier: Type.Optional(StringEnum(THINKING_LEVELS)),
      reset: Type.Optional(Type.Boolean()),
    }),
    async execute(_id, params) {
      setSessionThinking(params.reset ? "reset" : { planner: params.planner, worker: params.worker, verifier: params.verifier });
      return text(`Team thinking for this session: ${thinkingTable()}.`);
    },
  });

  pi.registerCommand("team-thinking", {
    description: "Team-run thinking for this session: /team-thinking [planner=max] [worker=high] [verifier=max] | reset",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      try {
        if (words[0] === "reset") setSessionThinking("reset");
        else if (words.length) {
          const patch: Partial<Record<TeamRole, string>> = {};
          for (const w of words) {
            const [role, level] = w.split("=");
            if (!["planner", "worker", "verifier"].includes(role) || !level) throw new Error(`"${w}": write role=level, e.g. worker=medium`);
            patch[role as TeamRole] = level;
          }
          setSessionThinking(patch);
        }
        ctx.ui.notify(`Team thinking: ${thinkingTable()}`, "info");
      } catch (error) {
        ctx.ui.notify((error as Error).message, "error");
      }
    },
  });
  /** Environment for running the project's gate from the lead: its virtualenv active when it has one (as in workers). */
  const gateEnv = (root: string): NodeJS.ProcessEnv => {
    const venv = state.config.team.linkIntoWorktrees.map((n) => join(root, n)).find((p) => existsSync(join(p, "pyvenv.cfg")));
    if (!venv) return process.env;
    const env = { ...process.env };
    activateVenv(venv, env);
    return env;
  };
  const repoFor = (cwd: string, repo?: string) => resolveTeamRepo(cwd, repo, lastTeamRepo, findRepoRoot, homedir(), resolve);
  const envCache = new Map<string, EnvFacts>();
  /** Environment facts of the run's repo (for the detected test command), not of the session folder. */
  const envFor = (root: string): EnvFacts | undefined => {
    if (root === state.repo) return state.env;
    if (!envCache.has(root)) {
      try {
        envCache.set(root, detectEnv({ ...realProbe(root, root, [join(agentDir(), "bin"), join(globalDataDir(), "bin")]), env: process.env }));
      } catch {
        return undefined;
      }
    }
    return envCache.get(root);
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
      "Start a team run: each lane gets a worker in its own git worktree, the gate command must pass, a fresh read-only verifier checks the patch, and failed checks go back to the same worker (bounded rounds). Tasks that share files are merged into one lane so lanes never conflict. Runs in the background; you are notified when it finishes, then call team_integrate. " +
      "Use it whenever the work has independent parts, not only for big features: N cases to write, N questions to check in the source (each lane writes its findings to its own file), N files to fix. A running worker can be redirected with subagent action steer.",
    promptSnippet: "Run a goal with a planner, parallel workers, a verifier and automatic rework",
    promptGuidelines: [
      "Before team_run, settle the brief with the user: goal, doneWhen (the checks that prove it), outOfScope and your assumptions. Ask about anything unclear and wait; team_run shows the brief to the user for confirmation.",
      "The user often names a project by a keyword, not a path: find its folder yourself, pass it as repo, and say which folder you picked in the brief.",
      "For a small, clear goal (one to three tasks whose files you already know), pass tasks yourself: it skips the planner run. Leave tasks out for anything larger or unclear.",
      "Leave gate out unless the detected test command is wrong. Do not work around the environment in it: workers' worktrees already have the project's virtualenv active and its ignored local files (.env) copied, and each lane runs only its own test files with a plain test command (a compound command runs whole in every lane).",
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
      playbook: Type.Optional(Type.String({ description: "Name of a matching playbook (lessons from earlier projects of this kind); its steps, tips, pitfalls and never-list travel with the goal" })),
      repo: Type.Optional(Type.String({ description: "Path of the project's git repository, when this session was started in another folder" })),
      digests: Type.Optional(Type.Array(Type.String(), { description: "Topics of reader digests (digest tool) to hand to the planner and workers, so they skip reading the same material again" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const root = repoFor(ctx.cwd, params.repo);
      const pbName = params.playbook?.trim();
      const pb = pbName ? findPlaybook(playbookDirs(state.config), pbName) : undefined;
      if (pbName && !pb) throw new Error(`No playbook named "${pbName}". Available: ${listPlaybooks(playbookDirs(state.config)).map((p) => p.name).join(", ") || "none"}.`);
      const dirty = await dirtyFiles(root);
      if (dirty.length) {
        const shared = dirty.some((f) => f.startsWith(".pi/ptk")) ? "\n.pi/ptk holds team-shared facts/tools: commit it (or move it away) first." : "";
        throw new Error(`Commit or stash these first; workers branch from a clean HEAD:\n${dirty.slice(0, 20).join("\n")}${shared}`);
      }
      await rpc("ping", {}, 5_000);
      const t = state.config.team;
      const tasks = params.tasks?.length ? validateTasks(params.tasks as TeamTask[], t.maxTasks) : [];
      const lanes = planLanes(tasks);
      const gate = (params.gate ?? t.gate ?? "").trim() || envFor(root)?.testCommand || "";
      // A gate that cannot even start here (python3 being a Store alias, a missing tool) would fail every lane
      // after a full round of work. Check its program once, now; a timeout or a failing test suite is fine.
      if (gate) {
        const pre = gatePreflight(gate);
        if (pre.kind === "file") {
          // A script would run the whole suite even with --version: only check that it is there.
          const base = resolve(root, pre.path);
          const exts = process.platform === "win32" ? ["", ".exe", ".cmd", ".bat", ".sh", ".ps1"] : [""];
          if (!exts.some((e) => existsSync(base + e))) throw new Error(`The gate \`${gate}\` cannot run here: ${pre.path} does not exist (relative to ${root}).`);
        } else if (pre.kind === "command") {
          const prog = pre.program;
          // Quote the name: it came out of the gate with its quotes removed, so `a;b` must not become two commands.
          const r = await runShell(`'${prog.replace(/'/g, `'\\''`)}' --version`, root, 20, undefined, gateEnv(root));
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
      const briefText = [brief.goal, `Done when: ${brief.doneWhen}`, brief.outOfScope ? `Out of scope: ${brief.outOfScope}` : "", brief.assumptions?.length ? `Assumptions: ${brief.assumptions.join("; ")}` : ""]
        .filter(Boolean)
        .join("\n");
      // A playbook is short by construction, so it can travel with the goal to planner, workers and verifier.
      const digestBlock = digestsFor(root, params.digests ?? []);
      const fullGoal = [briefText, pb ? playbookBrief(readFileSync(join(pb.dir, "SKILL.md"), "utf8"), pb.name).block : "", digestBlock].filter(Boolean).join("\n");
      const models = roleModels(t.models, effectiveThinking(), ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined);
      const modelText = (["planner", "worker", "verifier"] as const).map((r) => `${r} ${models[r] ?? `default (${AGENT_THINKING[r]})`}`).join(", ");
      if (t.confirm && ctx.hasUI) {
        const summary = [
          `Repository: ${root}`,
          ...briefText.split("\n"),
          ...(pb ? [`Playbook: ${pb.name} (${pb.uses} earlier use(s))`] : []),
          ...(params.digests?.length ? [`Reader digests: ${params.digests.join(", ")}`] : []),
          "",
          `Gate: ${gate || "(none: verifier only)"}${gate && t.laneTests ? " (each lane runs only its own test files; the full gate runs after integration)" : ""}`,
          `Models: ${modelText}`,
          lanes.length ? `Lanes: ${lanes.map((l) => l.key).join(", ")}` : "Tasks: the team-planner splits the goal",
          `Up to ${t.maxParallel} workers, ${Math.round(t.maxRounds)} review round(s) max, deadline ${t.runTimeoutMin} min (${t.childTimeoutMin} min per worker run). It runs unattended after you confirm.`,
        ].join(piWebLiveness() ? "\n\n" : "\n"); // pi-web renders the dialog as markdown, where one newline is a space
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
        models,
        childTimeoutMs: t.childTimeoutMin * 60_000,
        checkpointMs: t.checkpointMin * 60_000,
        laneTests: t.laneTests,
      };
      const data = await rpc("spawn", {
        script: buildTeamScript(plan),
        cwd: root,
        globalConcurrencyLimit: t.maxParallel,
        options: { timeoutMs: t.runTimeoutMin * 60_000 },
      });
      lastTeamRepo = root;
      teamRunUntil = Date.now() + (t.runTimeoutMin + 10) * 60_000;
      saveLead(root, { brief, addRun: { startedAt: new Date().toISOString(), status: "running", lanes: lanes.map((l) => l.key), gate, runId: findRunId(data), ...(pb ? { playbook: pb.name } : {}) } }, ctx.sessionManager.getSessionFile());
      const elsewhere = root !== findRepoRoot(ctx.cwd) ? `Repository: ${root} (this session runs elsewhere; team_integrate uses it too).\n` : "";
      if (lb.name) setLeadStatus(`team run going: ${brief.goal.slice(0, 140)}`);
      const laneLines = lanes.map((l) => `- ${l.key}: ${l.tasks.map((x) => x.title).join(" + ")} [${l.files.join(", ")}]`);
      const roles = Object.entries(plan.models ?? {}).filter(([, m]) => m).map(([r, m]) => `${r}=${m}`).join(", ");
      return {
        content: [
          {
            type: "text" as const,
            text:
              `Team run started in the background: ${lanes.length ? `${lanes.length} lane(s)` : "the team-planner splits the goal first"}, up to ${t.maxParallel} at once, gate ${gate ? `\`${gate}\`` : "(none: verifier only)"}, max ${plan.maxRounds} round(s)${roles ? `, models ${roles}` : ""}.\n` +
              (laneLines.length ? `${laneLines.join("\n")}\n` : "") +
              (lanes.length && lanes.length < tasks.length ? "Tasks sharing files were merged into one lane.\n" : "") +
              elsewhere +
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
      "Apply the patches of finished team lanes onto the current checkout in order (git apply), then run the gate once on the combined result (by default the same gate the team run used). Pass the runDir values from the team run result. Stops at the first patch that does not apply and says why.",
    promptSnippet: "Merge finished team lanes into the working tree and run the gate on the result",
    parameters: Type.Object({
      runDirs: Type.Array(Type.String(), { minItems: 1 }),
      gate: Type.Optional(Type.String()),
      skipGate: Type.Optional(Type.Boolean()),
      keepWorktrees: Type.Optional(Type.Boolean({ description: "Keep the workers' worktrees after a passing integration" })),
      repo: Type.Optional(Type.String({ description: "Path of the project's git repository, when this session runs in another folder (default: the repo of the last team_run)" })),
    }),
    async execute(_id, params, signal, _onUpdate, ctx) {
      teamRunUntil = 0; // the run is back; a browser host may close this session when idle again
      const root = repoFor(ctx.cwd, params.repo);
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
            saveLead(root, { finishRun: { status: "integration-failed", result: lines.join("\n").slice(0, 1500) } });
            return text(`${lines.join("\n")}\n\nStopped. Earlier patches stay applied. Resolve the conflict or send the lane back to a worker.`);
          }
          lines.push(`applied ${p.branch ?? p.path}${p.diffStat ? `: ${p.diffStat.split("\n").pop()?.trim()}` : ""}`);
        }
      }
      const lf = leadFile(root);
      const openRun = lf ? [...(readLeadState(lf.file)?.runs ?? [])].reverse().find((r) => r.status === "running") : undefined;
      const gate = integrationGate({ skip: params.skipGate, explicit: params.gate, runGate: openRun?.gate, configured: state.config.team.gate, detected: envFor(root)?.testCommand });
      let gatePassed = true;
      if (gate) {
        const r = await runShell(gate, root, state.config.team.gateTimeoutSec, signal, gateEnv(root));
        gatePassed = r.code === 0;
        const tail = clip(r.output.trim().split("\n").slice(-30).join("\n"), 4000);
        const why = r.missingShell ? "no bash found (on Windows install Git for Windows)" : `exit ${r.code ?? "?"}${r.timedOut ? ", timed out" : ""}`;
        lines.push(`gate \`${gate}\`: ${gatePassed ? "PASSED" : `FAILED (${why})`}\n${tail}`);
      }
      if (gatePassed && params.keepWorktrees !== true) {
        // Patches are in the checkout now; the workers' retained worktrees and branches are just clutter.
        // Only touch worktrees git itself lists for this repo and that pi-subagents created (see planWorktreeCleanup).
        const listed = await pi.exec("git", ["worktree", "list", "--porcelain"], { cwd: root, timeout: 30_000 });
        const targets = handoffs.flatMap((h) => cleanupTargets(readFileSync(h, "utf8")));
        const plan = planWorktreeCleanup(targets, parseWorktreeList(listed.stdout), root);
        const failed = [...plan.skipped];
        let removed = 0;
        for (const wt of plan.remove) {
          const w = await pi.exec("git", ["worktree", "remove", "--force", wt.path], { cwd: root, timeout: 30_000 });
          if (w.code !== 0) {
            failed.push({ path: wt.path, reason: `git worktree remove failed: ${(w.stderr || w.stdout).trim().split("\n")[0]}` });
            continue;
          }
          removed++;
          if (wt.branch) await pi.exec("git", ["branch", "-D", wt.branch], { cwd: root, timeout: 30_000 });
        }
        await pi.exec("git", ["worktree", "prune"], { cwd: root, timeout: 30_000 });
        if (removed) lines.push(`removed ${removed} worker worktree(s) and their branches`);
        // Say exactly what was left behind and why, so nobody reports "kept them" for a cleanup that failed.
        if (failed.length) lines.push(`NOT removed (${failed.length}):\n${failed.map((f) => `- ${f.path}: ${f.reason}`).join("\n")}\nRemove by hand with git worktree remove --force <path> if they are not needed.`);
      } else if (!gatePassed) lines.push("Worker worktrees kept so the lanes can be reworked.");
      if (lb.name) {
        // The board learns which files this lead now changed; files another lead changed recently are flagged.
        const st = await pi.exec("git", ["status", "--porcelain", "--untracked-files=all"], { cwd: root, timeout: 15_000 });
        const changed = st.code === 0 ? st.stdout.split("\n").map((l) => (l.slice(3).split(" -> ").pop() ?? "").trim().replace(/^"|"$/g, "")).filter((f) => f && !f.startsWith(".pi/subagents")) : [];
        const now = Date.now();
        const cards = liveCards();
        const clash = new Map<string, string[]>();
        const key = repoKey(root);
        for (const f of changed) {
          for (const c of overlaps(cards, lb.name, key, f, now)) clash.set(c.name, [...(clash.get(c.name) ?? []), f]);
          lb.files = recordFile(lb.files, f, now, key);
        }
        const goal = lf ? readLeadState(lf.file)?.brief?.goal : undefined;
        setLeadStatus(`integrated${goal ? `: ${goal.slice(0, 140)}` : ` ${params.runDirs.length} lane(s)`}, gate ${gate ? (gatePassed ? "passed" : "FAILED") : "skipped"}, not committed yet`);
        if (clash.size)
          lines.push(`Other leads changed some of the same files in the last 30 minutes: ${[...clash].map(([n, fs]) => `${n} (${fs.slice(0, 5).join(", ")})`).join("; ")}. Tell them with leads send and agree on the result before you commit.`);
      }
      if (openRun?.playbook) {
        // Record the use and ask for the lesson while it is fresh; the user decides what goes in.
        const used = findPlaybook(playbookDirs(state.config), openRun.playbook);
        if (used) {
          try {
            const meta = readMeta(used.dir);
            meta.uses.push({ at: new Date().toISOString(), repo: basename(root), outcome: gate ? (gatePassed ? "gate passed" : "gate failed") : "no gate", minutes: Math.round((Date.now() - Date.parse(openRun.startedAt)) / 60_000) });
            writeMeta(used.dir, meta);
          } catch {
            /* stats are a convenience */
          }
          lines.push(`Playbook "${used.name}" was used. End your report with at most 3 one-line changes to it from this run (a new pitfall or tip, an item that held again, an item that was wrong). Apply them with the playbook tool only after the user agrees.`);
        }
      }
      lines.push(
        "Changes are uncommitted: review with `git diff` (new files show as untracked), then commit. Do not edit these files yourself now: the verifier checked exactly this; put anything that looks wrong in your report, or start another team run.",
      );
      saveLead(root, { finishRun: { status: gatePassed ? "integrated" : "integration-failed", result: lines.join("\n").slice(0, 1500) } });
      return text(lines.join("\n"));
    },
  });

  // ---------- terminal: title with session name and directory, notification when a long run ends ----------

  let runStarted = 0;
  // Terminal only: in a browser host (pi-web runs sessions in RPC mode) the escape sequences would end up in
  // the server's log, and the host has its own titles and notifications.
  const inTerminal = (ctx: ExtensionContext) => ctx.hasUI && ctx.mode === "tui";
  const setTitle = (ctx: ExtensionContext, working: boolean) => {
    if (state.config.terminal.title && inTerminal(ctx)) ctx.ui.setTitle(terminalTitle(pi.getSessionName(), basename(state.cwd), working));
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
    if (!inTerminal(ctx)) return;
    runStarted = Date.now();
    setTitle(ctx, true);
  });

  pi.on("agent_settled", async (event, ctx) => {
    if (!inTerminal(ctx) || !runStarted) return;
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
      saveLead(workRepo(ctx.cwd) ?? ctx.cwd, { handoff: edited }, parentSession);
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
    description: "Take over the task an earlier lead session left in this repository (brief, team runs, handoff notes): /continue [repo path]",
    handler: async (args, ctx) => {
      // From the home folder, name the project: /continue D:\dev\shop-tests
      const where = args.trim() ? resolve(ctx.cwd, args.trim().replace(/^~(?=$|[\\/])/, homedir())) : (workRepo(ctx.cwd) ?? ctx.cwd);
      const lf = leadFile(where);
      const s = lf && readLeadState(lf.file);
      if (!s) return ctx.ui.notify(`No earlier lead session recorded for ${lf ? lf.root : `${where} (not a git repository; name the project: /continue <repo path>)`}.`, "info");
      lastTeamRepo = lf.root;
      const message = continuationMessage(s);
      // Terminal or pi-web: let the person read it before sending. Other clients may ignore the editor text.
      if (ctx.mode === "tui" || (ctx.hasUI && piWebLiveness())) {
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

  // ---------- playbooks: what one project taught, reused by the next one of the same kind ----------
  // Saved by /harvest from evidence (lib/harvest.ts), kept short by code (lib/playbook.ts), loaded as skills.

  // pi lists playbooks like any skill (name + description), so a matching one gets read without being asked.
  pi.on("resources_discover", async () => ({ skillPaths: playbookDirs(state.config).filter((d) => existsSync(d)) }));

  let lastEvidence = "";
  const limitsText = `Limits: description under ${LIMITS.description} characters; ask ≤5, steps ≤8, done ≤4, tips ≤8, pitfalls ≤8, never ≤5 items; one line each, under ${LIMITS.item} characters.`;
  const Items = (what: string) => Type.Optional(Type.Array(Type.String(), { description: `create: ${what}` }));

  pi.registerTool({
    name: "playbook",
    label: "Playbook",
    description:
      "Playbooks are short lessons for a kind of task (test automation, a migration...), saved as skills so the next similar task starts from them. list: what exists. evidence: what actually happened in this project (corrections, failures, reviewer findings, commits) to write one from. create: save a new one. update: small changes to one line at a time (add, bump = it held again, replace, retire).",
    promptSnippet: "Turn a finished project into a short reusable playbook, or refine one",
    promptGuidelines: [
      "Write a playbook only from playbook evidence: what this team learned (corrections, failures, reviewer findings, the checks that proved done). Leave out generic advice the model already knows.",
      "Keep playbooks short: one line per item, fewer and sharper items. A full section takes a replace or retire, not a longer list.",
      "Call playbook update only after the user agreed to the proposed changes.",
    ],
    parameters: Type.Object({
      action: StringEnum(["list", "evidence", "create", "update"] as const),
      name: Type.Optional(Type.String({ description: "The kind of task, lowercase-with-dashes, e.g. web-e2e-automation" })),
      description: Type.Optional(Type.String({ description: "create: one sentence: what kind of task, and when to use it" })),
      ask: Items("what to ask the user before starting"),
      steps: Items("the order of work that worked"),
      done: Items("the checks that proved it was done"),
      tips: Items("what worked"),
      pitfalls: Items("what went wrong and how to avoid it"),
      never: Items("what must not be done"),
      files: Type.Optional(Type.Array(Type.String(), { description: "create: project files worth starting from next time (fixtures, config), relative to the repo" })),
      changes: Type.Optional(
        Type.Array(
          Type.Object({
            op: StringEnum(["add", "bump", "replace", "retire"] as const),
            section: Type.Optional(StringEnum(["ask", "steps", "done", "tips", "pitfalls", "never"] as const)),
            id: Type.Optional(Type.String({ description: "bump/replace/retire: the item id, the (x1) mark at the end of its line" })),
            text: Type.Optional(Type.String({ description: "add/replace: the new line" })),
          }),
          { description: "update: the changes, at most 5" },
        ),
      ),
      days: Type.Optional(Type.Number({ description: "evidence: how many days back to look (default 30)" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const dirs = playbookDirs(state.config);
      if (params.action === "list") {
        const all = listPlaybooks(dirs);
        return text(all.length ? all.map((p) => `- ${p.name}: ${p.description} (${p.uses} use(s)${p.lastUsed ? `, last ${p.lastUsed.slice(0, 10)}` : ""}) ${p.dir}`).join("\n") : `No playbooks yet. /harvest <name> saves one to ${dirs[0]}.`);
      }
      if (params.action === "evidence") {
        const sessionFile = ctx.sessionManager.getSessionFile();
        if (!sessionFile) throw new Error("this session is not saved to disk (--no-session), so there is no history to read");
        const days = Math.max(1, Math.min(365, Math.round(params.days ?? 30)));
        const files = recentSessions(dirname(sessionFile), days);
        const items = files.flatMap((f) => {
          try {
            return sessionEvidence(readFileSync(f, "utf8"), readRunValue);
          } catch {
            return [];
          }
        });
        const lf = leadFile(workRepo(ctx.cwd) ?? ctx.cwd);
        items.push(...leadEvidence(lf ? readLeadState(lf.file) : undefined));
        const root = workRepo(ctx.cwd);
        if (root) {
          const since = `--since=${days}.days`;
          const log = await pi.exec("git", ["log", since, "-n", "30", "--format=%h %s"], { cwd: root, timeout: 15_000 });
          const added = await pi.exec("git", ["log", since, "--diff-filter=A", "--name-only", "--format="], { cwd: root, timeout: 15_000 });
          items.push(...gitEvidence(log.code === 0 ? log.stdout : "", added.code === 0 ? added.stdout : ""));
        }
        const pack = formatEvidence(items);
        lastEvidence = pack.text;
        return text(
          `${pack.count} evidence items from ${files.length} session(s) in the last ${days} days${pack.cut ? ` (${pack.cut} less useful ones cut)` : ""}, plus the lead record and git.\n` +
            `Write the playbook from these only: every item must trace to one of them. ${limitsText}\n\n${pack.text || "(nothing found)"}`,
        );
      }
      const name = params.name?.trim() ?? "";
      if (!validPlaybookName(name)) throw new Error("name: the kind of task, lowercase letters, digits and single dashes (e.g. web-e2e-automation)");
      if (params.action === "create") {
        const dir = join(dirs[0], name);
        if (existsSync(join(dir, "SKILL.md"))) throw new Error(`playbook ${name} exists already; change it with action update`);
        let body = renderPlaybook({
          name,
          description: params.description ?? "",
          ask: params.ask,
          steps: params.steps ?? [],
          done: params.done ?? [],
          tips: params.tips,
          pitfalls: params.pitfalls,
          never: params.never,
        });
        if (state.config.playbooks.confirm && ctx.hasUI) {
          const edited = await ctx.ui.editor(`Playbook ${name}: edit if needed, then save (empty to cancel)`, body);
          if (!edited?.trim()) throw new Error("The user cancelled saving the playbook.");
          const check = checkPlaybook(edited);
          if (check.errors.length) throw new Error(`Not saved; the edited playbook breaks the limits:\n- ${check.errors.join("\n- ")}`);
          body = edited.endsWith("\n") ? edited : `${edited}\n`;
        }
        mkdirSync(join(dir, "references"), { recursive: true });
        writeFileSync(join(dir, "SKILL.md"), body);
        writeMeta(dir, { version: 1, created: new Date().toISOString(), uses: [], log: [] });
        if (lastEvidence) writeFileSync(join(dir, "references", "sources.md"), `# Evidence this playbook was written from\n\nRepo: ${basename(workRepo(ctx.cwd) ?? ctx.cwd)}, ${new Date().toISOString().slice(0, 10)}\n\n${lastEvidence}\n`);
        const root = workRepo(ctx.cwd);
        const t = root && params.files?.length ? copyTemplates(root, params.files, join(dir, "templates")) : { copied: [], skipped: [] };
        const lines = body.split("\n").filter((l) => l.trim()).length;
        return text(
          `Saved ${join(dir, "SKILL.md")} (${lines} lines). Later sessions load it as a skill (open ones after /reload).` +
            (t.copied.length ? `\nTemplates: ${t.copied.join(", ")}` : "") +
            (t.skipped.length ? `\nNot copied: ${t.skipped.join("; ")}` : ""),
        );
      }
      // update
      const pb = findPlaybook(dirs, name);
      if (!pb) throw new Error(`No playbook named "${name}". Available: ${listPlaybooks(dirs).map((p) => p.name).join(", ") || "none"}.`);
      const changes = (params.changes ?? []).slice(0, 5) as Change[];
      if (!changes.length) throw new Error("changes is required: e.g. [{op: \"add\", section: \"pitfalls\", text: \"...\"}] or [{op: \"bump\", id: \"p2\"}]");
      const file = join(pb.dir, "SKILL.md");
      const r = applyChanges(readFileSync(file, "utf8"), changes);
      if (state.config.playbooks.confirm && ctx.hasUI) {
        const ok = await ctx.ui.confirm(`Update playbook ${pb.name}?`, r.log.map((l) => `${l.op} ${l.id}: ${l.text}`).join("\n"), { timeout: 120_000 });
        if (!ok) throw new Error("Not applied: the user declined or did not answer within 2 minutes. List the proposed changes in your report instead.");
      }
      writeFileSync(file, r.text.endsWith("\n") ? r.text : `${r.text}\n`);
      appendRetired(pb.dir, r.retired);
      const meta = readMeta(pb.dir);
      meta.log.push(...r.log);
      writeMeta(pb.dir, meta);
      return text(`Updated ${pb.name}: ${r.log.map((l) => `${l.op} ${l.id}`).join(", ")}. Now ${r.text.split("\n").filter((l) => l.trim()).length} lines.`);
    },
  });

  // ---------- reader: the team-reader agent's digests, cached (lib/digest.ts) ----------
  // Off by default: the lead uses the reader only when the user asks. Digests live under <agentDir>/ptk/digests,
  // never in the project, and stay valid while the files they name are unchanged.

  const digestDir = () => join(globalDataDir(), "digests");
  const digestsFor = (root: string, topics: string[]): string => {
    if (!topics.length) return "";
    const found = topics.map((t) => {
      const d = findDigest(digestDir(), t, root);
      if (!d) throw new Error(`No reader digest "${t}" for ${root}. Saved for this project: ${listDigests(digestDir(), root).map((m) => m.topic).join(", ") || "none"}.`);
      return d;
    });
    return digestBlock(found);
  };

  pi.registerTool({
    name: "digest",
    label: "Reader digest",
    description:
      "Cache of what the team-reader agent extracted from documents or a codebase. find: the saved digest for a topic, and whether its sources changed since. save: keep the reader's output (it ends with a ## Sources list). list: digests saved for this project. The reader is off by default: use it only when the user asks for it.",
    promptSnippet: "Reuse what the team-reader agent extracted instead of reading the same material again",
    promptGuidelines: [
      "The team-reader agent is off by default. Use it only when the user asks for the reader (\"阅读 agent\", \"have the reader look at X\"): call digest find first; when there is none or its sources changed, run subagent with agent team-reader in the foreground (async false) with the topic and where to look, then digest save its output. Give the user the facts and resources it found.",
      "Asked about a topic the reader already covered (\"what are the test conventions?\", \"have the reader look at it again\"), call digest find and answer from it. Run the reader again only when its sources changed or the user asks for a fresh read in so many words.",
      "When a team run should build on what the reader found, pass the topics as digests to team_run, so the planner and workers do not read the same material again.",
    ],
    parameters: Type.Object({
      action: StringEnum(["find", "save", "list"] as const),
      topic: Type.Optional(Type.String({ description: "What was read, in a few words, e.g. \"login test cases\" or \"test framework conventions\"" })),
      text: Type.Optional(Type.String({ description: "save: the reader's digest, as it returned it" })),
      repo: Type.Optional(Type.String({ description: "The project's folder, when this session was started elsewhere" })),
    }),
    async execute(_id, params, _signal, _onUpdate, ctx) {
      const asked = params.repo?.trim() ? resolve(ctx.cwd, params.repo.trim().replace(/^~(?=$|[\\/])/, homedir())) : undefined;
      const root = asked ? (findRepoRoot(asked) ?? asked) : (workRepo(ctx.cwd) ?? ctx.cwd);
      if (params.action === "list") {
        const all = listDigests(digestDir(), root);
        return text(all.length ? all.map((m) => `- "${m.topic}" (${m.created.slice(0, 10)}, ${m.sources.length} source file(s))`).join("\n") : `No reader digests for ${root} yet.`);
      }
      const topic = params.topic?.trim();
      if (!topic) throw new Error("topic is required: what was read, in a few words");
      if (params.action === "save") {
        const meta = saveDigest(digestDir(), topic, root, params.text ?? "");
        return text(`Saved reader digest "${meta.topic}" for ${root} (${meta.sources.length} source file(s)). It stays valid while those files are unchanged; pass the topic as digests to team_run to hand it to the team.`);
      }
      const d = findDigest(digestDir(), topic, root);
      if (!d) return text(`No digest for "${topic}" in ${root}. Run subagent with agent team-reader (async false) on it, then digest save.`);
      if (d.changed.length) return text(`Saved digest for "${topic}" from ${d.meta.created.slice(0, 10)} is out of date: changed since: ${d.changed.slice(0, 10).join(", ")}. Run the reader again on these, then digest save.\n\n${d.text}`);
      return text(`Saved digest for "${topic}" (${d.meta.created.slice(0, 10)}; its ${d.meta.sources.length} source file(s) are unchanged):\n\n${d.text}`);
    },
  });

  // ---------- friction: where the tooling itself cost time, for improving pi-team-kit ----------
  // The report reads pi's session files (lib/feedback.ts); the only thing written is an optional note entry.

  if (!process.env.PI_SUBAGENT_CHILD)
    pi.registerTool({
      name: "friction",
      label: "Friction",
      description:
        "Note one line when the tooling itself cost time or got in the way: a team run, the planner's split, the guard, a ptk tool, pi or the model. Not for bugs in the project. Kept in this session for the /feedback report the user uses to improve the tools.",
      promptSnippet: "Note where the tooling (not the project) cost time",
      parameters: Type.Object({ text: Type.String({ description: "What happened and what it cost, one line" }) }),
      async execute(_id, params) {
        const t = params.text.replace(/\s+/g, " ").trim();
        if (!t) throw new Error("text is empty");
        if (t.length > 200) throw new Error("one line, under 200 characters");
        pi.appendEntry("ptk-friction", { text: redact(t) });
        return text("Noted for /feedback.");
      },
    });

  const frictionReport = (cwd: string, days: number, all: boolean) => {
    const files = sessionFiles(join(agentDir(), "sessions"), days);
    const { signals, sessions } = frictionFromFiles(files, all ? undefined : basename(findRepoRoot(cwd) ?? cwd), readRunValue, runPhases);
    return formatFriction(signals, { days, sessions });
  };

  pi.registerCommand("feedback", {
    description: "Where the tooling cost time in this project (rework, serialized lanes, timeouts, refusals, tool errors...): /feedback [days] [all]",
    handler: async (args, ctx) => {
      const words = args.trim().split(/\s+/).filter(Boolean);
      const days = Math.max(1, Math.min(365, Number(words.find((w) => /^\d+$/.test(w)) ?? 30)));
      const report = frictionReport(ctx.cwd, days, words.includes("all"));
      const file = join(globalDataDir(), "feedback.md");
      try {
        mkdirSync(globalDataDir(), { recursive: true });
        writeFileSync(file, `${report}\n`);
      } catch {
        /* the report is shown anyway */
      }
      ctx.ui.notify(`${report}\n\nSaved to ${file}`, "info");
    },
  });

  // ---------- leads: lead sessions on related tasks tell each other what changed ----------
  // Plain files under <agentDir>/ptk/board (lib/board.ts), no daemon. Only lead sessions join: workers and
  // other subagents talk to their own lead. Mail is checked every 2 s: a busy lead gets it before its next
  // model call (steer, nothing is interrupted); an idle lead is woken only for an update request.

  const isChildProcess = Boolean(process.env.PI_SUBAGENT_CHILD);
  const lb = {
    dir: join(globalDataDir(), "board"),
    name: "",
    // host:pid:instance — one process can host many sessions (pi-web), each its own lead
    owner: `${hostname()}:${process.pid}:${randomUUID().slice(0, 8)}`,
    startedAt: new Date().toISOString(),
    root: undefined as string | undefined,
    repo: undefined as string | undefined,
    /** Repos this lead changed files in: where its shell commands are watched (see SHELL_TOOLS). */
    roots: new Set<string>(),
    status: "",
    files: [] as ChangedFile[],
    busy: false,
    /** Chain position of the current run (see MAX_WAKE_HOPS); messages it sends carry this. */
    turnHops: 0,
    pendingWakeHops: undefined as number | undefined,
    /** When this lead last messaged each other lead: telling them first unlocks a file they changed. */
    told: new Map<string, number>(),
    timer: undefined as ReturnType<typeof setInterval> | undefined,
    lastBeat: 0,
    ctx: undefined as ExtensionContext | undefined,
  };
  const boardOn = () => state.config.leads.enabled && !isChildProcess;
  const sessionFile = () => {
    try {
      return lb.ctx?.sessionManager.getSessionFile();
    } catch {
      return undefined;
    }
  };
  const liveCards = (): LeadCard[] => {
    try {
      return readCards(lb.dir);
    } catch {
      return [];
    }
  };
  const myCard = (): Omit<LeadCard, "name"> => ({
    owner: lb.owner,
    cwd: state.cwd,
    repo: lb.repo,
    title: pi.getSessionName() || undefined,
    session: sessionFile(),
    status: lb.status,
    working: lb.busy,
    files: lb.files,
    startedAt: lb.startedAt,
    updatedAt: new Date().toISOString(),
  });
  /**
   * Still the owner of our name? A session suspended (Ctrl+Z) or stalled past the stale limit can find its name
   * taken by a newer session. Then it moves to a free name instead of overwriting that card or reading its mail.
   */
  const ensureSeat = (): boolean => {
    if (!lb.name) return false;
    const c = readCard(lb.dir, lb.name);
    if (!c || c.owner === lb.owner) return true;
    const old = lb.name;
    try {
      lb.name = claimName(lb.dir, state.config.leads.name || (lb.root ? basename(lb.root) : "lead"), myCard());
      lb.lastBeat = Date.now();
    } catch {
      lb.name = "";
      return false;
    }
    try {
      lb.ctx?.ui.notify(`Another session took the lead name "${old}" while this one was paused; this lead is now "${lb.name}".`, "warning");
    } catch {
      /* ignore */
    }
    return true;
  };
  const beat = () => {
    try {
      if (!ensureSeat()) return;
      writeCard(lb.dir, { ...myCard(), name: lb.name });
      lb.lastBeat = Date.now();
    } catch {
      /* the board is a convenience; a failed write is retried on the next beat */
    }
  };
  const setLeadStatus = (s: string) => {
    lb.status = s.replace(/\s+/g, " ").trim().slice(0, MAX_STATUS);
    beat();
  };
  const isIdle = () => {
    try {
      return lb.ctx ? lb.ctx.isIdle() : !lb.busy;
    } catch {
      return !lb.busy;
    }
  };

  let delivering = false;
  let failedDeliveries = 0;
  async function deliverMail() {
    if (delivering) return;
    delivering = true;
    try {
      if (!ensureSeat()) return;
      // Read without removing: the files go only after pi accepted the message, so a failure is retried.
      const box = readInbox(lb.dir, lb.name);
      if (!box.files.length) return;
      const mail = box.messages;
      if (!mail.length) return ackInbox(box.files); // only broken files
      const idle = isIdle() && !lb.busy;
      const wakers = mail.filter((m) => shouldWake(m, idle, state.config.leads.wake));
      if (wakers.length) {
        lb.busy = true; // the next poll must not start a second run before agent_start arrives
        // The run this starts is part of the chain; set it here too, not only in before_agent_start.
        lb.pendingWakeHops = lb.turnHops = Math.max(...wakers.map((m) => m.hops)) + 1;
      }
      try {
        // Busy: steered into the running turn. Idle without a wake: stored for the next turn.
        await pi.sendMessage({ customType: BOARD_MESSAGE, content: formatIncoming(mail), display: true, details: { messages: mail } }, { deliverAs: "steer", triggerTurn: !idle || wakers.length > 0 });
      } catch (error) {
        if (wakers.length) lb.busy = false;
        // Retried on the next polls; after 3 failures they are dropped (they stay readable in /leads).
        if (++failedDeliveries >= 3) {
          failedDeliveries = 0;
          ackInbox(box.files);
        }
        try {
          lb.ctx?.ui.notify(`Could not deliver lead messages (${(error as Error).message}); see /leads.`, "warning");
        } catch {
          /* ignore */
        }
        return;
      }
      failedDeliveries = 0;
      ackInbox(box.files);
      try {
        if (lb.ctx?.hasUI) lb.ctx.ui.notify(`Message from lead ${[...new Set(mail.map((m) => m.from))].join(", ")}: ${mail[mail.length - 1].text.replace(/\s+/g, " ").slice(0, 140)}`, "info");
      } catch {
        /* stale context after a session switch */
      }
    } catch {
      /* board files unreadable right now: next poll */
    } finally {
      delivering = false;
    }
  }

  const repoKeys = new Map<string, string>();
  const repoKey = (root: string) => {
    if (!repoKeys.has(root)) repoKeys.set(root, pathKey(gitCommonDir(root)));
    return repoKeys.get(root)!;
  };
  /**
   * An edit/write target as (its repository, its path there). The file's own repository counts, not the
   * session folder's: a lead started in the home folder works in projects elsewhere.
   */
  const fileInRepo = (p: unknown): { rel: string; repo: string } | undefined => {
    if (typeof p !== "string") return undefined;
    const abs = resolve(state.cwd, p.replace(/^@/, "").replace(/^~(?=$|[\\/])/, homedir()));
    const root = findRepoRoot(dirname(abs));
    if (!root) return undefined;
    lb.roots.add(root);
    const rel = relative(root, abs);
    return rel && !rel.startsWith("..") && !isAbsolute(rel) ? { rel: rel.replace(/\\/g, "/"), repo: repoKey(root) } : undefined;
  };

  pi.on("session_start", async (_event, ctx) => {
    lb.ctx = ctx;
    if (!boardOn()) return;
    // Every session is its own lead, also when one process hosts many (pi-web runs all its sessions in its
    // server process): each extension instance has its own owner id, so no session can take another's name
    // or mail. (pi-subagents' in-process foreground subagents load no ambient extensions, checked in 0.88.)
    lb.root = findRepoRoot(ctx.cwd);
    lb.repo = lb.root ? pathKey(gitCommonDir(lb.root)) : undefined;
    if (!lb.name) {
      try {
        lb.name = claimName(lb.dir, state.config.leads.name || (lb.root ? basename(lb.root) : "lead"), myCard());
        lb.lastBeat = Date.now();
      } catch {
        return; // read-only home or similar: run without the board
      }
    } else beat();
    twinsWarned.clear();
    warnTwins();
    if (!lb.timer) {
      let ticks = 0;
      lb.timer = setInterval(() => {
        // A host that disposes a session without session_shutdown (one server process, many sessions) must
        // not leave this timer heartbeating a card for a session that is gone.
        try {
          if (!ctxAlive()) return leaveBoard();
          void deliverMail();
          if (Date.now() - lb.lastBeat > 30_000) beat();
          if (++ticks % 5 === 0) warnTwins();
        } catch {
          /* never let a bad card or file take down the process (pi-web hosts every session in it) */
        }
      }, 2_000);
      lb.timer.unref?.();
    }
  });

  // One conversation open in two places (a terminal and the browser, or two terminals): each keeps its own
  // copy and both append to the same session file. Said on both sides, once per other window.
  const twinsWarned = new Set<string>();
  const warnTwins = () => {
    const mine = sessionFile();
    if (!mine || !lb.name) return;
    for (const c of liveCards()) {
      if (c.owner === lb.owner || !c.session || pathKey(c.session) !== pathKey(mine) || twinsWarned.has(c.owner)) continue;
      twinsWarned.add(c.owner);
      try {
        lb.ctx?.ui.notify(
          `This conversation is also open in another window (lead ${c.name}, ${c.working ? "working" : "idle"}). The two do not see each other's turns and both write to the same session: carry on in one and close the other, or start a new session here.`,
          "warning",
        );
      } catch {
        /* stale context */
      }
    }
  };

  /** False once pi has invalidated this session's context (disposed, replaced or reloaded). */
  const ctxAlive = () => {
    try {
      lb.ctx?.isIdle();
      return true;
    } catch {
      return false;
    }
  };
  const leaveBoard = () => {
    if (lb.timer) clearInterval(lb.timer);
    lb.timer = undefined;
    if (lb.name) {
      try {
        removeCard(lb.dir, lb.name, lb.owner); // unread mail stays for the next session with this name
      } catch {
        /* ignore */
      }
    }
    lb.name = "";
  };

  pi.on("session_shutdown", async () => leaveBoard());

  pi.on("agent_start", async () => {
    lb.busy = true;
    beat();
  });
  // A person typing starts a new chain (also covered in before_agent_start; this does not depend on it).
  pi.on("input", async (event) => {
    if (event.source !== "extension") lb.turnHops = 0;
  });
  pi.on("agent_settled", async () => {
    lb.busy = false;
    beat();
  });

  // Changing a file another lead changed in the last 30 minutes: tell them first, then it goes through.
  pi.on("tool_call", async (event) => {
    if (!lb.name || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const target = fileInRepo((event.input as { path?: unknown }).path);
    if (!target) return;
    const rel = target.rel;
    const now = Date.now();
    const others = overlaps(liveCards(), lb.name, target.repo, rel, now).filter((c) => now - (lb.told.get(c.name) ?? 0) > OVERLAP_MS);
    if (!others.length) return;
    const names = others.map((c) => c.name).join(", ");
    return {
      block: true,
      reason: `${rel} was changed in the last 30 minutes by lead ${others.map((c) => `${c.name} (status: ${c.status || "none"})`).join(", ")}. Tell ${names} first with the leads tool (action send: what you will change in this file and why; update=true if they must adjust), then retry this change.`,
    };
  });

  pi.on("tool_result", async (event) => {
    if (!lb.name || event.isError || (event.toolName !== "edit" && event.toolName !== "write")) return;
    const target = fileInRepo((event.input as { path?: unknown }).path);
    if (!target) return;
    lb.files = recordFile(lb.files, target.rel, Date.now(), target.repo);
    beat();
  });

  // Shell commands change files too (sed -i, scripts, PowerShell Set-Content). A lead's shell call is bracketed
  // by git status in the repos it may touch that another running lead works in too: what changed is recorded
  // like an edit. A shell command cannot be held back beforehand, so a file another lead changed recently gets
  // a note in the result instead.
  const SHELL_TOOLS = new Set(["bash", "powershell"]);
  type Snaps = { started: number; roots: Map<string, Map<string, string>> };
  const shellSnaps = new Map<string, Snaps>();
  /** Repos too big or too slow to snapshot: not tried again in this session. */
  const skipRoots = new Set<string>();
  const snapshotAll = async (roots: string[]): Promise<Snaps["roots"]> => {
    const out: Snaps["roots"] = new Map();
    await Promise.all(
      roots.map(async (root) => {
        // No optional locks: a status here must never make another lead's git commit fail on index.lock.
        // No fsmonitor: a repo's own config must not start a program because a command named the repo.
        const r = await pi.exec("git", ["--no-optional-locks", "-c", "core.fsmonitor=false", "status", "--porcelain", "-z", "--untracked-files=all"], { cwd: root, timeout: 5_000 }).catch(() => undefined);
        const snap = r?.code === 0 ? statusSnapshot(root, r.stdout) : undefined;
        if (snap) out.set(root, snap);
        else skipRoots.add(root);
      }),
    );
    return out;
  };
  const shellRoots = (command: string, others: LeadCard[]): string[] => {
    const shared = new Set(others.flatMap((c) => [c.repo, ...c.files.map((f) => f.repo ?? c.repo)]).filter(Boolean));
    const named: string[] = [];
    for (const p of pathsInCommand(command)) {
      const abs = resolve(state.cwd, p.replace(/^~(?=$|[\\/])/, homedir()));
      let dir = abs;
      try {
        if (!statSync(abs).isDirectory()) dir = dirname(abs);
      } catch {
        dir = dirname(abs);
      }
      const root = findRepoRoot(dir);
      if (root) named.push(root);
    }
    const all = [...named, ...(lb.root ? [lb.root] : []), ...(lastTeamRepo ? [lastTeamRepo] : []), ...lb.roots];
    return [...new Set(all)].filter((r) => !skipRoots.has(r) && pathKey(r) !== pathKey(homedir()) && shared.has(repoKey(r))).slice(0, 4);
  };
  pi.on("tool_call", async (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    shellSnaps.delete(event.toolCallId);
    if (!lb.name) return;
    const others = liveCards().filter((c) => c.owner !== lb.owner);
    if (!others.length) return;
    const roots = shellRoots(String((event.input as { command?: unknown }).command ?? ""), others);
    if (!roots.length) return;
    if (shellSnaps.size > 20) shellSnaps.clear(); // calls another handler blocked never get a result
    const started = Date.now();
    shellSnaps.set(event.toolCallId, { started, roots: await snapshotAll(roots) });
  });
  pi.on("tool_result", async (event) => {
    if (!SHELL_TOOLS.has(event.toolName)) return;
    const before = shellSnaps.get(event.toolCallId);
    if (!before) return;
    shellSnaps.delete(event.toolCallId);
    if (!lb.name) return;
    const after = await snapshotAll([...before.roots.keys()]);
    const now = Date.now();
    const cards = liveCards();
    const clash = new Map<string, string[]>();
    let changed = 0;
    for (const [root, snap] of before.roots) {
      const later = after.get(root);
      if (!later) continue;
      const key = repoKey(root);
      // Another lead in the same checkout may have changed a file while this command ran: theirs, not ours.
      const theirs = (f: string) => cards.some((c) => c.owner !== lb.owner && c.files.some((x) => (x.repo ?? c.repo) === key && fileKey(x.path) === fileKey(f) && Date.parse(x.at) >= before.started));
      for (const f of changedBetween(snap, later, (rel) => fileState(root, rel))) {
        if (theirs(f)) continue;
        changed++;
        for (const c of overlaps(cards, lb.name, key, f, now)) if (now - (lb.told.get(c.name) ?? 0) > OVERLAP_MS) clash.set(c.name, [...(clash.get(c.name) ?? []), f]);
        lb.files = recordFile(lb.files, f, now, key);
      }
    }
    if (changed) beat();
    if (!clash.size) return;
    const names = [...clash.keys()].join(", ");
    const note = `Note: this command changed ${[...clash].map(([n, fs]) => `${fs.slice(0, 5).join(", ")} (changed by lead ${n} in the last 30 minutes)`).join("; ")}. Tell ${names} now with the leads tool: what you changed and why, update=true if they must adjust.`;
    return { content: [...event.content, { type: "text" as const, text: `\n\n${note}` }] };
  });

  if (!isChildProcess)
    pi.registerTool({
      name: "leads",
      label: "Leads",
      description:
        'Talk to the other lead sessions on this machine: pi sessions working on related tasks, in this repo or another. list: who is running, where, and their status. status: set the one line others see about you. send: tell another lead (or "all") what you changed; update=true asks them to check the impact and update their code, docs and status now (an idle session is woken for it).',
      promptSnippet: "See the other lead sessions and tell them what you changed",
      parameters: Type.Object({
        action: StringEnum(["list", "status", "send"] as const),
        text: Type.Optional(Type.String({ description: "status: your new one-line status. send: what changed and where, in one or two lines" })),
        to: Type.Optional(Type.String({ description: 'send: a lead name from list, or "all"' })),
        update: Type.Optional(Type.Boolean({ description: "send: ask them to update their code, docs and status now" })),
      }),
      async execute(_id, params) {
        if (role !== "lead") throw new Error("only lead sessions use the board; report to your lead instead");
        if (!boardOn() || !lb.name) throw new Error("the lead board is off here (leads.enabled in ptk.json, a subagent session, or the home directory is not writable)");
        const now = Date.now();
        if (params.action === "list")
          return text(`${formatBoard(liveCards(), lb.name, now, homedir())}\n\nRecent messages:\n${formatLog(readLog(lb.dir, 8))}`);
        if (params.action === "status") {
          if (!params.text?.trim()) throw new Error("text is required: one line on what you are doing or what is done");
          setLeadStatus(params.text);
          return text(`Status set: "${lb.status}"`);
        }
        if (!params.to?.trim()) throw new Error('to is required: a lead name from leads list, or "all"');
        const update = params.update === true;
        const r = sendMessage(lb.dir, { from: lb.name, to: params.to.trim(), text: params.text ?? "", update, hops: lb.turnHops }, now);
        for (const n of r.delivered) lb.told.set(n, now);
        const notes = [
          r.offline.length ? `Not running now: ${r.offline.join(", ")}; they get it when a session takes that name.` : "",
          update && lb.turnHops >= MAX_WAKE_HOPS ? "This reply chain is long enough, so idle leads are not woken; they see it on their next turn." : "",
        ].filter(Boolean);
        return text(`Sent to ${r.delivered.join(", ")}.${notes.length ? ` ${notes.join(" ")}` : ""}`);
      },
    });

  pi.registerCommand("leads", {
    description: "Lead sessions on this machine and their recent messages. /leads name <name> renames this lead",
    handler: async (args, ctx) => {
      if (!boardOn() || !lb.name) return ctx.ui.notify("The lead board is off here (leads.enabled: false in ptk.json, or this is a subagent).", "info");
      const [sub, ...rest] = args.trim().split(/\s+/);
      if (sub === "name") {
        const want = slugName(rest.join(" "));
        if (!rest.length || !validName(want)) return ctx.ui.notify("Usage: /leads name <name> (lowercase letters, digits, . _ -)", "error");
        if (want === lb.name) return ctx.ui.notify(`This lead is already "${want}".`, "info");
        await deliverMail(); // nothing unread is left behind under the old name
        const got = claimName(lb.dir, want, myCard());
        if (got !== want) {
          if (got !== lb.name) removeCard(lb.dir, got, lb.owner); // undo the fallback claim, never our current card
          return ctx.ui.notify(`"${want}" belongs to a running lead; pick another name.`, "error");
        }
        removeCard(lb.dir, lb.name, lb.owner);
        lb.name = got;
        return ctx.ui.notify(`This lead is now "${got}" on the board.`, "info");
      }
      ctx.ui.notify(`Leads (you are "${lb.name}"):\n${formatBoard(liveCards(), lb.name, Date.now(), homedir())}\n\nRecent messages:\n${formatLog(readLog(lb.dir, 10))}`, "info");
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
        `guard: ${g.enabled ? `on, timeout ${g.defaultTimeoutSec}s / tests ${g.testTimeoutSec}s / builds ${g.buildTimeoutSec}s (max ${g.maxTimeoutSec}s), search=${g.preferFastSearch}` : "off"}`,
        `pi-subagents: ${subagents}; team gate: ${state.config.team.gate || state.env?.testCommand || "(none)"}; models: ${Object.entries(state.config.team.models).map(([r, m]) => `${r}=${m || "default"}`).join(", ")}`,
        `leads: ${lb.name ? `you are "${lb.name}", ${liveCards().filter((c) => c.name !== lb.name).length} other lead(s) running (/leads)` : "off"}`,
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
