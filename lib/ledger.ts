// The decision ledger: what was decided, what was tried and did not work, and the rules that hold, per repository.
// Shared by every lead session on the repo and handed down word for word to every planner, worker and verifier, so
// nobody reopens a settled question or retries a failed approach because it was only said in one conversation.
// Real runs: workers saw only their brief; what the lead and the user had agreed, and what had already failed,
// never reached them. Kept short by code (one line each, a fixed number), like the playbooks.
// Plain files, one per entry, so two leads adding at once never overwrite each other:
//   <agentDir>/ptk/ledger/<repo>-<hash>/<id>.json

import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";

export type LedgerKind = "decision" | "tried" | "rule";

export interface LedgerEntry {
  id: string;
  kind: LedgerKind;
  text: string;
  /** Why, in a few words (optional). */
  why?: string;
  at: string;
  /** Lead name, or "team_run" for assumptions recorded by a run. */
  by: string;
}

export const LEDGER_LIMITS = { text: 240, why: 160, entries: 40 };

export function ledgerDir(dataDir: string, repoRoot: string): string {
  const hash = createHash("sha256").update(repoRoot).digest("hex").slice(0, 10);
  const name = basename(repoRoot).replace(/[^A-Za-z0-9._-]+/g, "-").slice(0, 40) || "repo";
  return join(dataDir, "ledger", `${name}-${hash}`);
}

const ID = /^[a-z0-9][a-z0-9-]{0,40}$/;
const slug = (s: string) =>
  s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 32);
const norm = (s: string) => s.replace(/\s+/g, " ").trim();

export function readLedger(dir: string): LedgerEntry[] {
  if (!existsSync(dir)) return [];
  const out: LedgerEntry[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), "utf8")) as LedgerEntry;
      if (!e || typeof e.text !== "string" || typeof e.id !== "string" || !["decision", "tried", "rule"].includes(e.kind)) continue;
      out.push({ id: e.id, kind: e.kind, text: e.text.slice(0, LEDGER_LIMITS.text), ...(typeof e.why === "string" && e.why ? { why: e.why.slice(0, LEDGER_LIMITS.why) } : {}), at: String(e.at ?? ""), by: String(e.by ?? "?") });
    } catch {
      /* a broken file is skipped, never fatal */
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/**
 * Add or replace (same id) one entry. Refused, with what to do instead, when it is long (a decision, not the
 * discussion), empty, or the ledger is full. Returns the entry as stored.
 */
export function addEntry(dir: string, e: { kind: LedgerKind; text: string; why?: string; by: string; id?: string }, now = new Date()): LedgerEntry {
  const text = norm(e.text ?? "");
  if (!text) throw new Error("text is empty: write the decision, the approach that failed, or the rule, in one line");
  if (text.length > LEDGER_LIMITS.text) throw new Error(`one line under ${LEDGER_LIMITS.text} characters: the decision itself, not the discussion (${text.length} now)`);
  const why = e.why ? norm(e.why) : "";
  if (why.length > LEDGER_LIMITS.why) throw new Error(`why: a few words, under ${LEDGER_LIMITS.why} characters`);
  if (!["decision", "tried", "rule"].includes(e.kind)) throw new Error('kind: "decision", "tried" (an approach that did not work) or "rule"');
  const id = e.id ? e.id.trim().toLowerCase() : `${slug(text) || e.kind}-${randomBytes(2).toString("hex")}`;
  if (!ID.test(id)) throw new Error(`id "${id}": lowercase letters, digits and dashes`);
  const existing = readLedger(dir);
  const same = existing.find((x) => norm(x.text).toLowerCase() === text.toLowerCase() && x.kind === e.kind);
  if (same && same.id !== id) return same; // already there, word for word
  if (!existing.some((x) => x.id === id) && existing.length >= LEDGER_LIMITS.entries)
    throw new Error(`the ledger holds ${LEDGER_LIMITS.entries} entries: drop one that no longer matters first (ledger drop), or replace one by its id`);
  const entry: LedgerEntry = { id, kind: e.kind, text, ...(why ? { why } : {}), at: now.toISOString(), by: e.by };
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(entry));
  renameSync(tmp, file);
  return entry;
}

export function dropEntry(dir: string, id: string): boolean {
  const key = id.trim().toLowerCase();
  if (!ID.test(key)) return false;
  const file = join(dir, `${key}.json`);
  if (!existsSync(file)) return false;
  rmSync(file, { force: true });
  return true;
}

/** The block that travels with a goal to the planner, every worker and every verifier. Empty when there is nothing. */
export function ledgerBlock(entries: LedgerEntry[]): string {
  const part = (kind: LedgerKind, head: string) => {
    const xs = entries.filter((e) => e.kind === kind);
    return xs.length ? [head, ...xs.map((e) => `- ${e.text}${e.why ? ` (${e.why})` : ""}`)].join("\n") : "";
  };
  return [
    part("decision", "Decisions already made (do not reopen them; if one blocks your task, ask the lead):"),
    part("tried", "Already tried and did not work (do not try these again):"),
    part("rule", "Rules that hold for this repository:"),
  ]
    .filter(Boolean)
    .join("\n");
}

/** For the lead and /leads: id, kind, text, who and when. */
export function formatLedger(entries: LedgerEntry[]): string {
  return entries.length ? entries.map((e) => `- [${e.id}] ${e.kind}: ${e.text}${e.why ? ` (${e.why})` : ""} - ${e.by}, ${e.at.slice(0, 16).replace("T", " ")}`).join("\n") : "(the ledger is empty)";
}
