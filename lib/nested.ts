// Nested workers, at most two levels: a team worker whose lane holds several independent pieces hands up to
// `max` of them to sub-workers that work at the same time in its own worktree, waits for them, then checks the
// result itself (the lane's verifier still reviews it). Sub-workers cannot start more: their agent has no subtasks
// tool, and pi-subagents' default depth limit is 2 as well. Same deadline and hand-off as every child.

import { patternsOverlap } from "./team.ts";

export interface Part {
  title: string;
  brief: string;
  files: string[];
  verify?: { cmd: string; expect?: string };
}

const norm = (p: string) => p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");

/** Check the parts; throws one message listing every problem. `owned`: the worker's own files, when known. */
export function validateParts(parts: Part[], max: number, owned?: string[]): Part[] {
  const problems: string[] = [];
  if (!Array.isArray(parts) || parts.length < 2) throw new Error("give at least 2 parts: one part is just doing it yourself");
  if (parts.length > max) problems.push(`at most ${max} parts at once`);
  const out = parts.map((p, i) => {
    const at = `parts[${i}]`;
    const title = String(p.title ?? "").trim().slice(0, 120);
    const brief = String(p.brief ?? "").trim();
    const files = (Array.isArray(p.files) ? p.files : []).map((f) => norm(String(f))).filter(Boolean);
    if (!title) problems.push(`${at}.title: name the part`);
    if (brief.length < 20) problems.push(`${at}.brief: say what to change, where, and how to tell it is done; the sub-worker sees nothing else`);
    if (!files.length) problems.push(`${at}.files: the files this part may change`);
    for (const f of files) {
      if (f.startsWith("/") || /^[A-Za-z]:/.test(f) || f.split("/").includes("..")) problems.push(`${at}.files: "${f}" must be relative to the repo root`);
      else if (owned?.length && !owned.some((o) => o === "**" || patternsOverlap(o, f))) problems.push(`${at}.files: "${f}" is not one of your own files (${owned.join(", ")})`);
    }
    const verify = p.verify && String(p.verify.cmd ?? "").trim() ? { cmd: String(p.verify.cmd).trim().slice(0, 500), expect: String(p.verify.expect ?? "").trim().slice(0, 300) } : undefined;
    return { title, brief, files, ...(verify ? { verify } : {}) };
  });
  for (let i = 0; i < out.length; i++)
    for (let j = i + 1; j < out.length; j++) {
      const shared = out[i].files.find((a) => out[j].files.some((b) => patternsOverlap(a, b)));
      if (shared) problems.push(`parts ${i} and ${j} share ${shared}: parts that touch the same file cannot run at the same time; merge them or do that one yourself`);
    }
  if (problems.length) throw new Error(problems.join("\n"));
  return out;
}

/** What one sub-worker is told. */
export function partTask(goal: string, part: Part, others: Part[]): string {
  return (
    `You are a sub-worker in a team run: one part of a worker's task, in the worker's own folder. Overall goal: ${goal}\n\n` +
    `Your part: ${part.title}\n${part.brief}` +
    (part.verify ? `\nDone when: ${JSON.stringify(part.verify.cmd)}${part.verify.expect ? ` prints ${JSON.stringify(part.verify.expect)}` : " passes"}` : "") +
    `\n\nFiles you own (edit only these; new files only inside them):\n${part.files.map((f) => `- ${f}`).join("\n")}\n\n` +
    (others.length ? `Other sub-workers are changing these at the same time; do not touch them: ${others.flatMap((o) => o.files).join(", ")}.\n` : "") +
    "Do not commit, push or switch branches. When a check fails, find the cause before changing anything; never re-run without a change. " +
    "After three real attempts, stop and report BLOCKED.\n" +
    "Finish with exactly these parts:\nStatus: DONE, DONE_WITH_CONCERNS or BLOCKED\nChanged files: ...\nEvidence: the command you ran and the last lines of its output\nConcerns: open risks; for BLOCKED, what you tried and the likely cause"
  );
}

/**
 * A worker's subagent call for an approved part: the part id becomes the part's task, and the agent, folder,
 * 2-hour deadline and hand-off are set here (whatever the call said). Returns why the call is refused, or
 * undefined after rewriting `input` in place. An approved id is used once.
 */
export function approvePartCall(
  input: Record<string, unknown>,
  approved: Map<string, { task: string; model?: string }>,
  opts: { cwd: string; timeoutMs: number; checkpointMs: number; subworker: boolean },
): string | undefined {
  if (typeof input.action === "string" && ["list", "get", "status", "lane.status", "doctor"].includes(input.action)) return undefined;
  const id = typeof input.task === "string" ? input.task.trim() : "";
  const part = approved.get(id);
  if (opts.subworker || input.agent !== "team-subworker" || !part)
    return 'Sub-workers start only through subtasks: approve the parts there, then call subagent with {"agent": "team-subworker", "task": "<the part id it gave>"}.';
  approved.delete(id);
  for (const k of ["tasks", "chain", "workflow", "maxRuntimeMs", "action"]) delete input[k];
  Object.assign(input, { agent: "team-subworker", task: part.task, async: true, cwd: opts.cwd, timeoutMs: opts.timeoutMs, ...(part.model ? { model: part.model } : {}) });
  if (opts.checkpointMs > 0 && opts.checkpointMs < opts.timeoutMs) input.checkpointBeforeDeadlineMs = opts.checkpointMs;
  else delete input.checkpointBeforeDeadlineMs;
  return undefined;
}
