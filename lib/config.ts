// Settings for every pi-team-kit module, merged from:
//   built-in defaults  <  <agentDir>/ptk.json  <  <repo>/.pi/ptk.json
// The defaults below are the documentation: each key says what it does.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type SearchPolicy = "block" | "warn" | "off";

export interface PtkConfig {
  guard: {
    enabled: boolean;
    /** Seconds a bash call may run when the model passes no timeout. pi itself has no default. */
    defaultTimeoutSec: number;
    /** Hard ceiling, even when the model asks for more. */
    maxTimeoutSec: number;
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
  team: {
    /** Workers running at the same time. */
    maxParallel: number;
    /** Verifier rounds per lane before a human has to decide. */
    maxRounds: number;
    /** Shell command that must pass in every worker's worktree. Auto-detected when empty. */
    gate: string;
    gateTimeoutSec: number;
    /** Deadline for one whole team run. */
    runTimeoutMin: number;
    workerAgent: string;
    verifierAgent: string;
  };
}

export const DEFAULTS: PtkConfig = {
  guard: {
    enabled: true,
    defaultTimeoutSec: 180,
    maxTimeoutSec: 1200,
    nonInteractiveEnv: true,
    blockLongRunners: true,
    preferFastSearch: "block",
    sudoNonInteractive: true,
  },
  facts: { enabled: true, checkTimeoutMs: 1500, maxFacts: 40 },
  plainTalk: { enabled: true, acronymCheck: true, allow: [] },
  toolbox: { enabled: true, runTimeoutSec: 300 },
  team: {
    maxParallel: 4,
    maxRounds: 3,
    gate: "",
    gateTimeoutSec: 600,
    runTimeoutMin: 60,
    workerAgent: "team-worker",
    verifierAgent: "team-verifier",
  },
};

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

/** Project data lives next to pi's own project config: `<repo>/.pi/ptk/`. */
export function projectDataDir(cwd: string): string {
  return join(findRepoRoot(cwd) ?? resolve(cwd), ".pi", "ptk");
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
  config.team.maxParallel = clamp(Math.round(config.team.maxParallel), 1, 8);
  config.team.maxRounds = clamp(Math.round(config.team.maxRounds), 1, 10);
  return { config, files, warnings };
}

export function clamp(value: number, min: number, max: number): number {
  if (!Number.isFinite(value)) return min;
  return Math.min(max, Math.max(min, value));
}
