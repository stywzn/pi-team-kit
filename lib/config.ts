// Settings for every pi-team-kit module, merged from:
//   built-in defaults  <  <agentDir>/ptk.json  <  <repo>/.pi/ptk.json
// The defaults below are the documentation: each key says what it does.

import { existsSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SearchPolicy = "block" | "warn" | "off";

export interface PtkConfig {
  guard: {
    enabled: boolean;
    /** Seconds a bash call may run when the model passes no timeout. pi itself has no default. */
    defaultTimeoutSec: number;
    /** Default for test runs (pytest, jest, playwright test, go test, npm test...). */
    testTimeoutSec: number;
    /** Default for installs and builds (npm ci, pip install, docker build, cargo build...). */
    buildTimeoutSec: number;
    /** Hard ceiling, even when the model asks for more. */
    maxTimeoutSec: number;
    /** Run test commands with CI=1 (unless set): no watch mode, no report server waiting for Ctrl+C. */
    ciForTests: boolean;
    /** Set pager/prompt/telemetry env vars so tools never wait for a human. */
    nonInteractiveEnv: boolean;
    /** Refuse dev servers, watchers, `tail -f`, REPLs and TUIs in the foreground. */
    blockLongRunners: boolean;
    /** What to do with `grep -r` / `find -name` / `ls -R` when rg and fd exist. */
    preferFastSearch: SearchPolicy;
    /** Rewrite `sudo x` to `sudo -n x` so a password prompt fails instead of hanging. */
    sudoNonInteractive: boolean;
  };
  facts: {
    enabled: boolean;
    /** Each learned fact may carry a shell check; slower checks count as stale. */
    checkTimeoutMs: number;
    maxFacts: number;
  };
  plainTalk: {
    enabled: boolean;
    /** Flag ALL-CAPS abbreviations that the reply never explains. */
    acronymCheck: boolean;
    /** Abbreviations that never need explaining (added to the built-in list). */
    allow: string[];
  };
  toolbox: {
    enabled: boolean;
    runTimeoutSec: number;
  };
  terminal: {
    /** Terminal title "π <session name> · <directory>", with ● while working (tmux can use it as the window name). */
    title: boolean;
    /** Name an unnamed session after its first prompt, so titles and /resume show what it is about. */
    autoName: boolean;
    /** Desktop notification when a run that took at least this many seconds finishes. 0 = off. */
    notifyAfterSec: number;
  };
  /**
   * Context budget per kind of session, in tokens. A session compacts once it passes its budget
   * (or maxWindowFraction of the model's window, whichever is smaller): long contexts are slower,
   * cost more per call and lose accuracy, long before the model's hard limit.
   * Policy: planner, worker and verifier start fresh for every task (new session, never carried over);
   * the lead compacts, and after handoffAfterCompactions compactions it is told to /handoff to a new session.
   */
  context: {
    enabled: boolean;
    lead: number;
    planner: number;
    worker: number;
    verifier: number;
    /** Other subagents (scout, reviewer, oracle...). */
    child: number;
    maxWindowFraction: number;
    handoffAfterCompactions: number;
  };
  team: {
    /** Ask the user to confirm the brief (goal, done-when, out of scope, assumptions) before a team run starts.
     *  Only in the interactive terminal; print/RPC/CI runs have no one to ask. After the confirmation the run goes unattended. */
    confirm: boolean;
    /** Workers running at the same time. */
    maxParallel: number;
    /** Most tasks one run takes, from the lead or the planner. More is an error, never a silent cut. */
    maxTasks: number;
    /** Verifier rounds per lane before a human has to decide. */
    maxRounds: number;
    /** Shell command that must pass in every worker's worktree. Auto-detected when empty. */
    gate: string;
    gateTimeoutSec: number;
    /** Deadline for one whole team run (planning, every lane and its rework rounds). */
    runTimeoutMin: number;
    /** Deadline for each planner, worker and verifier run. pi-subagents stops a child after 30 minutes by default,
     *  too short for a worker running a slow suite (UI tests). */
    childTimeoutMin: number;
    plannerAgent: string;
    workerAgent: string;
    verifierAgent: string;
    /** Model per role, "provider/model" as in `pi --list-models`; "" = the agent's default (the main session's model).
     *  A verifier from a different model family than the workers catches more of their mistakes. */
    models: { planner: string; worker: string; verifier: string };
    /** Thinking level per role (off, minimal, low, medium, high, xhigh, max); "" = the agent's own: planner and verifier
     *  think the hardest (splitting and checking decide the run), workers less (they follow a detailed brief).
     *  Levels a model does not support are clamped by pi. */
    thinking: { planner: string; worker: string; verifier: string };
  };
  /** Lead sessions on this machine see each other's status and tell each other what they changed (the leads tool, /leads). */
  leads: {
    enabled: boolean;
    /** An update request wakes an idle lead to act on it. Off: it waits for that lead's next turn. */
    wake: boolean;
    /** This lead's name on the board; "" = the repository (or folder) name. */
    name: string;
  };
  /** Playbooks: short lessons for a kind of task, saved by /harvest and loaded as skills (lib/playbook.ts). */
  playbooks: {
    /** Where /harvest saves; "" = <agentDir>/ptk/playbooks. */
    dir: string;
    /** More folders to load playbooks from, e.g. a checkout of the team's playbook repo. */
    dirs: string[];
    /** Show a new playbook in an editor before saving, and ask before changing one (2-minute timeout). */
    confirm: boolean;
  };
}

export const DEFAULTS: PtkConfig = {
  guard: {
    enabled: true,
    defaultTimeoutSec: 180,
    testTimeoutSec: 900,
    buildTimeoutSec: 600,
    maxTimeoutSec: 1800,
    ciForTests: true,
    nonInteractiveEnv: true,
    blockLongRunners: true,
    preferFastSearch: "block",
    sudoNonInteractive: true,
  },
  // Checks run in the background at session start, so a few seconds cost nothing; too short a limit only produces "unknown".
  facts: { enabled: true, checkTimeoutMs: 5000, maxFacts: 40 },
  plainTalk: { enabled: true, acronymCheck: true, allow: [] },
  toolbox: { enabled: true, runTimeoutSec: 300 },
  terminal: { title: true, autoName: true, notifyAfterSec: 30 },
  context: {
    enabled: true,
    lead: 160_000,
    planner: 80_000,
    worker: 120_000,
    verifier: 60_000,
    child: 100_000,
    maxWindowFraction: 0.5,
    handoffAfterCompactions: 2,
  },
  team: {
    confirm: true,
    maxParallel: 4,
    maxTasks: 8,
    maxRounds: 3,
    gate: "",
    gateTimeoutSec: 900,
    runTimeoutMin: 120,
    childTimeoutMin: 44,
    plannerAgent: "team-planner",
    workerAgent: "team-worker",
    verifierAgent: "team-verifier",
    models: { planner: "", worker: "", verifier: "" },
    thinking: { planner: "", worker: "", verifier: "" },
  },
  leads: { enabled: true, wake: true, name: "" },
  playbooks: { dir: "", dirs: [], confirm: true },
};

/** Playbook folders: the one /harvest writes to first, then the configured extra ones. */
export function playbookDirs(config: PtkConfig, env: NodeJS.ProcessEnv = process.env): string[] {
  const home = (p: string) => resolve(p.replace(/^~(?=$|[\\/])/, homedir()));
  return [config.playbooks.dir ? home(config.playbooks.dir) : join(globalDataDir(env), "playbooks"), ...config.playbooks.dirs.filter((d) => typeof d === "string" && d.trim()).map(home)];
}

export function agentDir(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.PI_CODING_AGENT_DIR?.trim();
  if (override) return resolve(override.replace(/^~(?=$|[\\/])/, homedir()));
  return join(homedir(), ".pi", "agent");
}

/** Nearest ancestor (inclusive) that contains `.git`, or undefined. */
export function findRepoRoot(start: string): string | undefined {
  let dir = resolve(start);
  for (;;) {
    if (existsSync(join(dir, ".git"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** Shared project data, committed with the repo: `<repo>/.pi/ptk/`. Only humans write here (e.g. `ptk facts share`). */
export function projectDataDir(cwd: string): string {
  return join(findRepoRoot(cwd) ?? resolve(cwd), ".pi", "ptk");
}

/** The repository's git directory (the main one, also from inside a linked worktree). */
export function gitCommonDir(repoRoot: string): string {
  const dotGit = join(repoRoot, ".git");
  try {
    if (statSync(dotGit).isDirectory()) return dotGit;
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return dotGit;
    const gitDir = resolve(repoRoot, pointer);
    const common = existsSync(join(gitDir, "commondir")) ? readFileSync(join(gitDir, "commondir"), "utf8").trim() : "";
    return common ? resolve(gitDir, common) : gitDir;
  } catch {
    return dotGit;
  }
}

/**
 * Data the agent writes for one repo on this machine: `<git dir>/ptk/`. Inside .git it never shows up in
 * `git status`, so it cannot block a team run (workers need a clean tree) and is never committed by accident.
 */
export function localProjectDataDir(cwd: string): string | undefined {
  const root = findRepoRoot(cwd);
  return root ? join(gitCommonDir(root), "ptk") : undefined;
}

export function globalDataDir(env: NodeJS.ProcessEnv = process.env): string {
  return join(agentDir(env), "ptk");
}

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Merge `patch` into `base`, keeping only keys that exist in `base` and match its type. */
export function mergeKnown<T>(base: T, patch: unknown, path = "", warnings: string[] = []): T {
  if (!isObject(base) || !isObject(patch)) return base;
  const out: Json = { ...(base as Json) };
  for (const [key, value] of Object.entries(patch)) {
    const at = path ? `${path}.${key}` : key;
    if (!(key in out)) {
      warnings.push(`unknown setting "${at}" ignored`);
      continue;
    }
    const current = out[key];
    if (isObject(current)) out[key] = mergeKnown(current, value, at, warnings);
    else if (Array.isArray(current) ? Array.isArray(value) : typeof current === typeof value) out[key] = value;
    else warnings.push(`setting "${at}" should be ${Array.isArray(current) ? "an array" : typeof current}`);
  }
  return out as T;
}

function readJson(file: string, warnings: string[]): unknown {
  if (!existsSync(file)) return undefined;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    warnings.push(`${file}: ${(error as Error).message}`);
    return undefined;
  }
}

export interface LoadedConfig {
  config: PtkConfig;
  files: string[];
  warnings: string[];
}

/** `includeProject` must be false until pi trusts the project: a cloned repo must not reconfigure the guard. */
export function loadConfig(cwd: string, env: NodeJS.ProcessEnv = process.env, includeProject = true): LoadedConfig {
  const warnings: string[] = [];
  const files: string[] = [];
  let config = structuredClone(DEFAULTS);
  const repo = includeProject ? findRepoRoot(cwd) : undefined;
  const candidates = [join(agentDir(env), "ptk.json"), ...(repo ? [join(repo, ".pi", "ptk.json")] : [])];
  for (const file of candidates) {
    const data = readJson(file, warnings);
    if (data === undefined) continue;
    files.push(file);
    config = mergeKnown(config, data, "", warnings);
  }
  const g = config.guard;
  g.defaultTimeoutSec = clamp(g.defaultTimeoutSec, 5, 86_400);
  g.maxTimeoutSec = clamp(g.maxTimeoutSec, g.defaultTimeoutSec, 86_400);
  g.testTimeoutSec = clamp(g.testTimeoutSec, 5, g.maxTimeoutSec);
  g.buildTimeoutSec = clamp(g.buildTimeoutSec, 5, g.maxTimeoutSec);
  const cx = config.context;
  // pi keeps the most recent 20k tokens verbatim when it compacts, so smaller budgets have nothing to compact.
  for (const k of ["lead", "planner", "worker", "verifier", "child"] as const) cx[k] = clamp(Math.round(cx[k]), 30_000, 2_000_000);
  cx.maxWindowFraction = clamp(cx.maxWindowFraction, 0.1, 0.95);
  cx.handoffAfterCompactions = clamp(Math.round(cx.handoffAfterCompactions), 1, 20);
  config.terminal.notifyAfterSec = clamp(config.terminal.notifyAfterSec, 0, 86_400);
  config.team.maxParallel = clamp(Math.round(config.team.maxParallel), 1, 8);
  config.team.maxTasks = clamp(Math.round(config.team.maxTasks), 1, 12);
  config.team.maxRounds = clamp(Math.round(config.team.maxRounds), 1, 10);
  config.team.childTimeoutMin = clamp(Math.round(config.team.childTimeoutMin), 5, 1440);
  config.team.runTimeoutMin = clamp(Math.round(config.team.runTimeoutMin), config.team.childTimeoutMin, 2880);
  return { config, files, warnings };
}

/** Package sources in pi's settings.json that contain backslashes (Windows local-path installs). pi-subagents
 *  then cannot resolve the package's agents, so team-planner/worker/verifier silently do not exist. */
export function backslashSources(settingsText: string): string[] {
  try {
    const s = JSON.parse(settingsText) as { packages?: (string | { source?: string })[] };
    return (s.packages ?? []).map((p) => (typeof p === "string" ? p : (p.source ?? ""))).filter((src) => src.includes("\\"));
  } catch {
    return [];
  }
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
