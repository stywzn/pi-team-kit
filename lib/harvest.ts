// Evidence for /harvest: what actually happened in a project, pulled from pi's session files, the lead
// state and git, so a playbook is written from facts (corrections, failures, reviewer findings) and not
// from what a model imagines the task needs. Secrets are redacted; the pack is capped so it stays readable.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { LeadState } from "./lead.ts";
import { redact } from "./playbook.ts";

export type EvidenceKind = "brief" | "user" | "review" | "error" | "guard" | "team" | "integrate" | "commit" | "files" | "lead-msg";

export interface Evidence {
  kind: EvidenceKind;
  when: string;
  text: string;
}

// Most useful first: when the pack is cut, the tail goes.
const PRIORITY: EvidenceKind[] = ["brief", "review", "user", "error", "guard", "team", "integrate", "lead-msg", "files", "commit"];
const ITEM_CHARS = 240;

const clip = (s: string, n = ITEM_CHARS) => {
  const t = s.replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const stamp = (ts: unknown) => {
  const d = typeof ts === "number" ? new Date(ts) : typeof ts === "string" ? new Date(ts) : undefined;
  return d && !Number.isNaN(d.getTime()) ? d.toISOString().slice(5, 16).replace("T", " ") : "";
};
const textOf = (content: unknown): string =>
  typeof content === "string"
    ? content
    : Array.isArray(content)
      ? content.map((p: { type?: string; text?: string }) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n")
      : "";

/**
 * Evidence from one session file (pi's JSONL). `readRunValue` gets the return value of a finished team run
 * from its receipt directory (status.json), where the verifier findings are.
 */
export function sessionEvidence(jsonl: string, readRunValue: (runDir: string) => unknown = () => undefined): Evidence[] {
  const out: Evidence[] = [];
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; timestamp?: unknown; customType?: string; content?: unknown; message?: Record<string, unknown> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const when = stamp(e.timestamp);
    const m = e.message ?? {};
    if (e.type === "custom_message") {
      const body = textOf(e.content);
      if (e.customType === "ptk-lead-message") {
        // Drop the tags and the framing line; keep what the other lead said.
        const said = body.replace(/<\/?lead-messages>/g, "").split("\n").filter((l) => l.trim()).slice(1).join(" ");
        if (said) out.push({ kind: "lead-msg", when, text: clip(said) });
      }
      const receipt = body.match(/(\S+)[\\/]workflow-receipt\.json/);
      if (receipt) {
        type Finding = { file?: string; issue?: string; fix?: string };
        const value = readRunValue(receipt[1]) as
          | { lanes?: { lane: string; state: string; rounds: number; findings?: Finding[]; history?: { round: number; gate?: string; findings?: Finding[] }[] }[] }
          | undefined;
        const finding = (lane: string, f: Finding, round?: number) =>
          out.push({ kind: "review", when, text: clip(`verifier on ${lane}${round ? ` round ${round}` : ""}: ${f.file ? `${f.file}: ` : ""}${f.issue}${f.fix ? ` -> fix: ${f.fix}` : ""}`) });
        for (const lane of value?.lanes ?? []) {
          out.push({ kind: "team", when, text: `lane ${lane.lane}: ${lane.state} after ${lane.rounds} round(s)` });
          // Earlier rounds: why the lane was sent back (the final round's findings are empty when it passed).
          for (const h of lane.history ?? []) {
            if (h.gate) out.push({ kind: "review", when, text: clip(`checks failed on ${lane.lane} round ${h.round}: ${h.gate}`) });
            for (const f of h.findings ?? []) if (f?.issue) finding(lane.lane, f, h.round);
          }
          for (const f of lane.findings ?? []) if (f?.issue) finding(lane.lane, f);
        }
      }
      continue;
    }
    if (m.role === "user") {
      const t = textOf(m.content).trim();
      if (t && !t.startsWith("<lead-messages>")) out.push({ kind: "user", when, text: clip(t) });
    } else if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const p of m.content as { type?: string; name?: string; arguments?: Record<string, unknown> }[]) {
        if (p?.type !== "toolCall" || p.name !== "team_run") continue;
        const a = p.arguments ?? {};
        out.push({ kind: "team", when, text: clip(`team run: ${a.goal ?? ""}${a.doneWhen ? ` | done when: ${a.doneWhen}` : ""}${a.gate ? ` | gate: ${a.gate}` : ""}`) });
      }
    } else if (m.role === "toolResult") {
      const body = textOf(m.content);
      const tool = String(m.toolName ?? "tool");
      for (const g of body.match(/\[ptk\][^\n]*/g) ?? []) out.push({ kind: "guard", when, text: clip(g) });
      if (tool === "team_integrate") {
        const keep = body.split("\n").filter((l) => /^(applied|FAILED|gate|no changes|NOT removed)/.test(l));
        if (keep.length) out.push({ kind: "integrate", when, text: clip(keep.join(" | ")) });
      } else if (m.isError === true) {
        out.push({ kind: "error", when, text: clip(`${tool} failed: ${body.split("\n").find((l) => l.trim()) ?? ""}`) });
      }
    }
  }
  return out;
}

export function leadEvidence(s: LeadState | undefined): Evidence[] {
  if (!s) return [];
  const when = stamp(s.updatedAt);
  const out: Evidence[] = [];
  if (s.brief) {
    out.push({ kind: "brief", when, text: clip(`goal: ${s.brief.goal}`) });
    out.push({ kind: "brief", when, text: clip(`done when: ${s.brief.doneWhen}`) });
    if (s.brief.outOfScope) out.push({ kind: "brief", when, text: clip(`out of scope: ${s.brief.outOfScope}`) });
    for (const a of s.brief.assumptions ?? []) out.push({ kind: "brief", when, text: clip(`assumed: ${a}`) });
  }
  for (const r of s.runs) out.push({ kind: "integrate", when: stamp(r.startedAt), text: clip(`run ${r.status}; gate ${r.gate || "none"}${r.result ? `; ${r.result.split("\n").filter((l) => /gate|FAILED/.test(l)).slice(0, 2).join(" ")}` : ""}`) });
  if (s.handoff) out.push({ kind: "brief", when, text: clip(`handoff notes: ${s.handoff}`) });
  return out;
}

/** `git log --format=%h %s` output and `git log --diff-filter=A --name-only --format=` output. */
export function gitEvidence(log: string, added: string): Evidence[] {
  const out: Evidence[] = log
    .split("\n")
    .filter((l) => l.trim())
    .slice(0, 30)
    .map((l) => ({ kind: "commit" as const, when: "", text: clip(l) }));
  const files = [...new Set(added.split("\n").map((l) => l.trim()).filter(Boolean))];
  if (files.length) out.unshift({ kind: "files", when: "", text: clip(`files added: ${files.slice(0, 40).join(", ")}${files.length > 40 ? ` (+${files.length - 40} more)` : ""}`, 1200) });
  return out;
}

/** Session files of one project, newest first, changed within `days`. */
export function recentSessions(sessionDir: string, days: number, max = 8, now = Date.now()): string[] {
  if (!existsSync(sessionDir)) return [];
  return readdirSync(sessionDir)
    .filter((f) => f.endsWith(".jsonl"))
    .map((f) => join(sessionDir, f))
    .map((f) => ({ f, t: statSync(f).mtimeMs }))
    .filter((x) => now - x.t <= days * 86_400_000)
    .sort((a, b) => b.t - a.t)
    .slice(0, max)
    .map((x) => x.f);
}

/** status.json of a finished workflow run: its return value. */
export function readRunValue(runDir: string): unknown {
  try {
    return (JSON.parse(readFileSync(join(runDir, "status.json"), "utf8")) as { workflow?: { value?: unknown } }).workflow?.value;
  } catch {
    return undefined;
  }
}

/**
 * One numbered, deduplicated, redacted list, most useful kinds first, cut at `maxChars`.
 * This is what the model writes the playbook from, and what references/sources.md keeps.
 */
export function formatEvidence(items: Evidence[], maxChars = 12_000): { text: string; count: number; cut: number } {
  const seen = new Set<string>();
  const unique = items.filter((e) => {
    const k = `${e.kind}:${e.text.toLowerCase()}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
  unique.sort((a, b) => PRIORITY.indexOf(a.kind) - PRIORITY.indexOf(b.kind));
  const lines: string[] = [];
  let size = 0;
  for (const [i, e] of unique.entries()) {
    const line = `E${i + 1} [${e.kind}${e.when ? ` ${e.when}` : ""}] ${redact(e.text)}`;
    if (size + line.length > maxChars) break;
    lines.push(line);
    size += line.length + 1;
  }
  return { text: lines.join("\n"), count: lines.length, cut: unique.length - lines.length };
}
