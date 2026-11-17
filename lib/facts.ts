// Facts the agent had to dig for (where a service runs, which mirror works, how to log in to the test DB)
// and pitfalls it fell into. Stored as small JSON so they are checked by code instead of rotting in docs:
//   - a fact may carry a `check` command; a failing check marks it stale instead of feeding the model old news
//   - a pitfall carries a `match` regex; the guard warns or blocks matching commands

import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { unsafeRegex, type Pitfall } from "./guard.ts";

export interface Fact {
  id: string;
  text: string;
  check?: string;
  added: string;
}

export interface FactFile {
  version: 1;
  facts: Fact[];
  pitfalls: Pitfall[];
}

/** global = every repo on this machine; project = this repo on this machine (in .git/ptk, written by the agent);
 *  team = this repo for everyone (.pi/ptk/facts.json, committed by a human via `ptk facts share`). */
export type Scope = "project" | "global" | "team";

export function factFilePath(dataDir: string): string {
  return join(dataDir, "facts.json");
}

export function emptyFactFile(): FactFile {
  return { version: 1, facts: [], pitfalls: [] };
}

export function readFactFile(file: string): FactFile {
  if (!existsSync(file)) return emptyFactFile();
  try {
    const data = JSON.parse(readFileSync(file, "utf8")) as Partial<FactFile>;
    return {
      version: 1,
      facts: Array.isArray(data.facts) ? data.facts.filter(isFact) : [],
      pitfalls: Array.isArray(data.pitfalls) ? data.pitfalls.filter(isPitfall) : [],
    };
  } catch {
    return emptyFactFile();
  }
}

export function writeFactFile(file: string, data: FactFile): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2) + "\n");
  renameSync(tmp, file);
}

function isFact(v: unknown): v is Fact {
  const f = v as Fact;
  return typeof f?.id === "string" && typeof f.text === "string";
}

function isPitfall(v: unknown): v is Pitfall {
  const p = v as Pitfall;
  return typeof p?.id === "string" && typeof p.match === "string" && typeof p.message === "string" && (p.action === "warn" || p.action === "block");
}

export function slug(text: string): string {
  const s = text
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40);
  return s || `item-${Date.now().toString(36)}`;
}

export interface RememberInput {
  kind: "fact" | "pitfall" | "forget";
  id?: string;
  text?: string;
  check?: string;
  match?: string;
  when?: string;
  action?: "warn" | "block";
}

/** Apply one remember/forget request to a fact file. Returns the new file and a one-line result. */
export function applyRemember(file: FactFile, input: RememberInput, maxItems: number, today = new Date().toISOString().slice(0, 10)): { file: FactFile; result: string } {
  const next: FactFile = { version: 1, facts: [...file.facts], pitfalls: [...file.pitfalls] };
  if (input.kind === "forget") {
    if (!input.id) throw new Error("forget needs the id to remove");
    const before = next.facts.length + next.pitfalls.length;
    next.facts = next.facts.filter((f) => f.id !== input.id);
    next.pitfalls = next.pitfalls.filter((p) => p.id !== input.id);
    if (before === next.facts.length + next.pitfalls.length) throw new Error(`no fact or pitfall with id "${input.id}"`);
    return { file: next, result: `Forgot "${input.id}".` };
  }
  const text = input.text?.trim();
  if (!text) throw new Error("text is required");
  if (text.length > 300) throw new Error("keep it under 300 characters: one fact, not a document");
  const id = input.id?.trim() || slug(text);
  if (input.kind === "fact") {
    const fact: Fact = { id, text, added: today, ...(input.check?.trim() ? { check: input.check.trim() } : {}) };
    const i = next.facts.findIndex((f) => f.id === id);
    if (i >= 0) next.facts[i] = fact;
    else if (next.facts.length >= maxItems) throw new Error(`already ${maxItems} facts; forget a stale one first`);
    else next.facts.push(fact);
    return { file: next, result: `${i >= 0 ? "Updated" : "Saved"} fact "${id}".` };
  }
  if (!input.match) throw new Error("a pitfall needs `match`: a regex for the commands that trigger it");
  if (unsafeRegex(input.match) || (input.when && unsafeRegex(input.when)))
    throw new Error("regex too complex (nested quantifiers or over 300 characters); it runs on every command, keep it simple");
  try {
    new RegExp(input.match);
    if (input.when) new RegExp(input.when);
  } catch (error) {
    throw new Error(`invalid regex: ${(error as Error).message}`);
  }
  const pitfall: Pitfall = { id, match: input.match, action: input.action ?? "warn", message: text, ...(input.when ? { when: input.when } : {}) };
  const i = next.pitfalls.findIndex((p) => p.id === id);
  if (i >= 0) next.pitfalls[i] = pitfall;
  else if (next.pitfalls.length >= maxItems) throw new Error(`already ${maxItems} pitfalls; forget one first`);
  else next.pitfalls.push(pitfall);
  return { file: next, result: `${i >= 0 ? "Updated" : "Saved"} pitfall "${id}" (${pitfall.action} on /${pitfall.match}/).` };
}

export interface CheckedFact extends Fact {
  scope: Scope;
  stale: boolean;
}

/** Merge facts and pitfalls from `from` into `into` by id (`from` wins). Used to share local facts with the team. */
export function mergeFactFiles(into: FactFile, from: FactFile): { file: FactFile; added: number; updated: number } {
  const facts = new Map(into.facts.map((f) => [f.id, f]));
  const pitfalls = new Map(into.pitfalls.map((p) => [p.id, p]));
  let added = 0;
  let updated = 0;
  for (const f of from.facts) {
    facts.has(f.id) ? updated++ : added++;
    facts.set(f.id, f);
  }
  for (const p of from.pitfalls) {
    pitfalls.has(p.id) ? updated++ : added++;
    pitfalls.set(p.id, p);
  }
  return { file: { version: 1, facts: [...facts.values()], pitfalls: [...pitfalls.values()] }, added, updated };
}

export function formatFacts(facts: CheckedFact[], pitfalls: (Pitfall & { scope: Scope })[]): string {
  const lines: string[] = [];
  for (const f of facts) lines.push(`- [${f.scope}/${f.id}]${f.stale ? " (check failed, may be outdated)" : ""} ${f.text}`);
  for (const p of pitfalls) lines.push(`- [${p.scope}/${p.id}] pitfall, ${p.action}s on /${p.match}/: ${p.message}`);
  return lines.join("\n");
}
