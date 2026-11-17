// What a lead session agreed with the user and what its team runs did, saved per repository,
// so a later lead session (after /handoff, a restart, or the next morning) can take over with /continue.
// Stored under the pi agent directory, not in the repo: it never dirties the working tree.

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export interface LeadRun {
  startedAt: string;
  status: "running" | "integrated" | "integration-failed";
  lanes: string[];
  gate: string;
  /** pi-subagents async run id, when known, to check on a run that is still going. */
  runId?: string;
  result?: string;
}

export interface LeadBrief {
  goal: string;
  doneWhen: string;
  outOfScope?: string;
  assumptions?: string[];
}

export interface LeadState {
  version: 1;
  repo: string;
  updatedAt: string;
  session?: string;
  brief?: LeadBrief;
  runs: LeadRun[];
  /** Free-text handoff brief written by /handoff. */
  handoff?: string;
}

export function leadStatePath(dataDir: string, repoRoot: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 10);
  const name = basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "repo";
  return join(dataDir, "leads", `${name}-${hash}.json`);
}

export function readLeadState(file: string): LeadState | undefined {
  if (!existsSync(file)) return undefined;
  try {
    const s = JSON.parse(readFileSync(file, "utf8")) as LeadState;
    return s && s.version === 1 && Array.isArray(s.runs) ? s : undefined;
  } catch {
    return undefined;
  }
}

export function writeLeadState(file: string, state: LeadState): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

export function updateLeadState(prev: LeadState | undefined, repo: string, patch: Partial<Omit<LeadState, "version" | "repo" | "runs">> & { addRun?: LeadRun; finishRun?: Pick<LeadRun, "status" | "result"> }, now = new Date()): LeadState {
  const runs = [...(prev?.runs ?? [])];
  if (patch.addRun) runs.push(patch.addRun);
  if (patch.finishRun) {
    const open = [...runs].reverse().find((r) => r.status === "running");
    if (open) Object.assign(open, patch.finishRun);
  }
  const { addRun: _a, finishRun: _f, ...rest } = patch;
  return { version: 1, repo, runs: runs.slice(-10), ...(prev ? { brief: prev.brief, handoff: prev.handoff, session: prev.session } : {}), ...rest, updatedAt: now.toISOString() };
}

/** Pull a run id out of whatever pi-subagents returned for an async spawn. */
export function findRunId(data: unknown): string | undefined {
  return JSON.stringify(data ?? "").match(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/)?.[0];
}

export function ageText(iso: string, now = Date.now()): string {
  const min = Math.max(0, Math.round((now - new Date(iso).getTime()) / 60_000));
  return min < 60 ? `${min} min ago` : min < 48 * 60 ? `${Math.round(min / 60)} h ago` : `${Math.round(min / 1440)} days ago`;
}

/** The first message for a lead session that takes over. It asks for a status check, not new work. */
export function continuationMessage(s: LeadState, now = Date.now()): string {
  const lines = [`I'm handing you a task from an earlier lead session in this repository (last active ${ageText(s.updatedAt, now)}).`];
  if (s.brief) {
    lines.push("", `Goal: ${s.brief.goal}`, `Done when: ${s.brief.doneWhen}`);
    if (s.brief.outOfScope) lines.push(`Out of scope: ${s.brief.outOfScope}`);
    if (s.brief.assumptions?.length) lines.push(`Agreed assumptions: ${s.brief.assumptions.join("; ")}`);
  }
  if (s.runs.length) {
    lines.push("", "Team runs so far:");
    for (const r of s.runs.slice(-5))
      lines.push(`- ${r.startedAt.slice(0, 16).replace("T", " ")} ${r.status}: lanes ${r.lanes.join(", ") || "(planner)"}; gate ${r.gate ? `\`${r.gate}\`` : "none"}${r.runId ? `; run ${r.runId}` : ""}${r.result ? `\n  ${r.result.split("\n").slice(0, 3).join(" | ")}` : ""}`);
  }
  if (s.handoff) lines.push("", "Handoff notes from the previous session:", s.handoff);
  lines.push(
    "",
    "First check where things actually stand (git status and diff; for a run still marked running: subagent({ action: \"status\", id })). Then tell me in a few lines what is done, what is not, and what you propose next. Do not start new work until I confirm.",
  );
  return lines.join("\n");
}
