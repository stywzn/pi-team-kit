// Playbooks: what one project taught about a kind of task (test automation, a migration...), kept as an
// Agent Skill so the next similar task starts from it. Short by design: agents skim long files, so code
// enforces the limits below. Changes after creation are small, deterministic edits to single lines
// (add / bump / replace / retire), never a model rewriting the file; long rewrites lose what was learned.
//
//   <dir>/<name>/SKILL.md           frontmatter + six short sections, one line per item
//   <dir>/<name>/playbook.json      uses and change log (written by code)
//   <dir>/<name>/references/        sources.md (the evidence it came from), retired.md; read only when needed
//   <dir>/<name>/templates/         files copied from the project (fixtures, configs) to start from

import { appendFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, join, relative, resolve } from "node:path";

export const LIMITS = { description: 200, item: 160, bodyLines: 60, templates: 10, templateBytes: 200_000 };

export const SECTIONS = [
  { key: "ask", title: "Ask first", prefix: "a", max: 5, numbered: false },
  { key: "steps", title: "Steps", prefix: "s", max: 8, numbered: true },
  { key: "done", title: "Done when", prefix: "d", max: 4, numbered: false },
  { key: "tips", title: "Tips", prefix: "t", max: 8, numbered: false },
  { key: "pitfalls", title: "Pitfalls", prefix: "p", max: 8, numbered: false },
  { key: "never", title: "Never", prefix: "n", max: 5, numbered: false },
] as const;
export type SectionKey = (typeof SECTIONS)[number]["key"];
const REQUIRED: SectionKey[] = ["steps", "done"];

export interface PlaybookDraft {
  name: string;
  description: string;
  ask?: string[];
  steps: string[];
  done: string[];
  tips?: string[];
  pitfalls?: string[];
  never?: string[];
}

const NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
export const validPlaybookName = (n: unknown): n is string => typeof n === "string" && n.length <= 64 && NAME.test(n);

// ---------- secrets: never in a playbook, its sources or its templates ----------

const SECRETS: [string, RegExp][] = [
  ["private key", /-----BEGIN [A-Z ]*PRIVATE KEY-----/],
  ["API key", /\b(?:sk|pk|rk)-[A-Za-z0-9_-]{16,}/],
  ["GitHub token", /\bgh[pousr]_[A-Za-z0-9]{20,}/],
  ["AWS key", /\bAKIA[0-9A-Z]{16}\b/],
  ["Slack token", /\bxox[abprs]-[A-Za-z0-9-]{10,}/],
  ["password or token", /\b(?:password|passwd|pwd|secret|token|api[_-]?key)\s*[:=]\s*["']?(?![$<{%])[^\s"'<>]{6,}/i],
  ["credentials in a URL", /:\/\/[^\s/:@]+:[^\s/@]+@/],
];

export function findSecrets(text: string): string[] {
  return SECRETS.filter(([, re]) => re.test(text)).map(([name]) => name);
}

export function redact(text: string): string {
  let out = text;
  for (const [, re] of SECRETS) out = out.replace(new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`), "[redacted]");
  return out;
}

// ---------- parse / validate ----------

const ITEM = /^(\s*)(?:-|\d+\.)\s+(.*?)(?:\s+\(([a-z]\d+)(?:,\s*(\d+)x)?\))?\s*$/;

export interface Item {
  line: number;
  text: string;
  id?: string;
  seen: number;
}

export interface Parsed {
  lines: string[];
  name?: string;
  description?: string;
  /** Index of the first line after the frontmatter. */
  bodyStart: number;
  sections: Map<string, { heading: number; end: number; items: Item[] }>;
}

const unquote = (s: string) => {
  const t = s.trim();
  if (t.startsWith('"')) {
    try {
      return JSON.parse(t) as string;
    } catch {
      return t.slice(1, -1);
    }
  }
  return t.startsWith("'") && t.endsWith("'") ? t.slice(1, -1).replace(/''/g, "'") : t;
};

export function parsePlaybook(text: string): Parsed {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  let bodyStart = 0;
  let name: string | undefined;
  let description: string | undefined;
  if (lines[0]?.trim() === "---") {
    const end = lines.indexOf("---", 1);
    if (end > 0) {
      for (const l of lines.slice(1, end)) {
        const m = l.match(/^(name|description):\s*(.*)$/);
        if (m) m[1] === "name" ? (name = unquote(m[2])) : (description = unquote(m[2]));
      }
      bodyStart = end + 1;
    }
  }
  const sections: Parsed["sections"] = new Map();
  let current: { heading: number; end: number; items: Item[] } | undefined;
  for (let i = bodyStart; i < lines.length; i++) {
    const h = lines[i].match(/^##\s+(.+?)\s*$/);
    if (h) {
      current = { heading: i, end: i + 1, items: [] };
      sections.set(h[1].toLowerCase(), current);
      continue;
    }
    if (!current) continue;
    if (lines[i].trim()) current.end = i + 1;
    const m = lines[i].match(ITEM);
    if (m && m[2]) current.items.push({ line: i, text: m[2], id: m[3], seen: m[4] ? Number(m[4]) : 1 });
  }
  return { lines, name, description, bodyStart, sections };
}

const sectionOf = (p: Parsed, key: SectionKey) => p.sections.get(SECTIONS.find((s) => s.key === key)!.title.toLowerCase());

export interface Check {
  errors: string[];
  warnings: string[];
}

export function checkPlaybook(text: string): Check {
  const p = parsePlaybook(text);
  const errors: string[] = [];
  const warnings: string[] = [];
  if (!validPlaybookName(p.name)) errors.push("name: lowercase letters, digits and single dashes, at most 64 characters");
  if (!p.description?.trim()) errors.push("description is missing: say what kind of task it is for, so it gets picked up");
  else if (p.description.length > LIMITS.description) errors.push(`description has ${p.description.length} characters; keep it under ${LIMITS.description}`);
  for (const s of SECTIONS) {
    const sec = sectionOf(p, s.key);
    if (REQUIRED.includes(s.key) && !sec?.items.length) errors.push(`"${s.title}" needs at least one item`);
    if (sec && sec.items.length > s.max) errors.push(`"${s.title}" has ${sec.items.length} items; at most ${s.max}: merge or retire some`);
    for (const it of sec?.items ?? []) if (it.text.length > LIMITS.item) errors.push(`"${s.title}" item "${it.text.slice(0, 40)}…" is ${it.text.length} characters; one line, under ${LIMITS.item}`);
  }
  const known = new Set(SECTIONS.map((s) => s.title.toLowerCase()));
  for (const title of p.sections.keys()) if (!known.has(title)) warnings.push(`section "${title}" is not one of the six; details belong in references/`);
  const bodyLines = p.lines.slice(p.bodyStart).filter((l) => l.trim()).length;
  if (bodyLines > LIMITS.bodyLines) errors.push(`${bodyLines} lines; keep the playbook under ${LIMITS.bodyLines} (agents skim long files)`);
  const secrets = findSecrets(text);
  if (secrets.length) errors.push(`looks like it contains secrets (${secrets.join(", ")}); remove them`);
  return { errors, warnings };
}

// ---------- render a new playbook ----------

const clean = (s: string) => s.replace(/\s+/g, " ").trim();
const suffix = (id: string, seen: number) => ` (${id}${seen > 1 ? `, ${seen}x` : ""})`;

export function renderPlaybook(d: PlaybookDraft): string {
  const out = [
    "---",
    `name: ${d.name}`,
    `description: ${JSON.stringify(clean(d.description))}`,
    "---",
    "<!-- Playbook from earlier projects (pi-team-kit). One line per item; details go in references/. Change it with the playbook tool so ids stay stable. -->",
  ];
  for (const s of SECTIONS) {
    const items = (d[s.key] ?? []).map(clean).filter(Boolean);
    if (!items.length) continue;
    out.push("", `## ${s.title}`);
    items.forEach((t, i) => out.push(`${s.numbered ? `${i + 1}.` : "-"} ${t}${suffix(`${s.prefix}${i + 1}`, 1)}`));
  }
  const text = out.join("\n") + "\n";
  const check = checkPlaybook(text);
  if (check.errors.length) throw new Error(`playbook not saved:\n- ${check.errors.join("\n- ")}`);
  return text;
}

// ---------- small, deterministic changes ----------

export type Change =
  | { op: "add"; section: SectionKey; text: string }
  | { op: "bump"; id: string }
  | { op: "replace"; id: string; text: string }
  | { op: "retire"; id: string };

export interface ChangeLog {
  at: string;
  op: Change["op"];
  id: string;
  text: string;
  old?: string;
}

const norm = (s: string) => s.toLowerCase().replace(/[^a-z0-9一-鿿]+/g, " ").trim();

/**
 * Apply changes line by line. Nothing else in the file moves: hand-written lines stay, ids stay.
 * A full section refuses new items until one is replaced or retired, so the playbook stays short.
 * Returns the new text, the lines taken out (for references/retired.md) and a log.
 */
export function applyChanges(text: string, changes: Change[], now = new Date()): { text: string; retired: string[]; log: ChangeLog[] } {
  const at = now.toISOString();
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  const retired: string[] = [];
  const log: ChangeLog[] = [];
  const reparse = () => parsePlaybook(lines.join("\n"));
  const findItem = (id: string) => {
    for (const [title, sec] of reparse().sections) for (const it of sec.items) if (it.id === id) return { title, it };
    throw new Error(`no item with id ${id}; ids are the (x1) marks at the end of each line`);
  };
  const lineFor = (title: string, it: Item, txt: string, seen: number) => {
    const s = SECTIONS.find((x) => x.title.toLowerCase() === title);
    const indent = lines[it.line].match(/^\s*/)?.[0] ?? "";
    const bullet = lines[it.line].trim().match(/^\d+\./) ? "1." : "-";
    return `${indent}${s?.numbered ? bullet : "-"} ${txt}${it.id ? suffix(it.id, seen) : ""}`;
  };
  const checkText = (t: string) => {
    const c = clean(t);
    if (!c) throw new Error("text is empty");
    if (c.length > LIMITS.item) throw new Error(`one line, under ${LIMITS.item} characters (got ${c.length}); details belong in references/`);
    if (findSecrets(c).length) throw new Error("that text looks like it contains a secret");
    return c;
  };
  const queue = [...changes];
  for (let q = 0; q < queue.length; q++) {
    const ch = queue[q];
    if (ch.op === "add") {
      const s = SECTIONS.find((x) => x.key === ch.section);
      if (!s) throw new Error(`section must be one of ${SECTIONS.map((x) => x.key).join(", ")}`);
      const txt = checkText(ch.text);
      const p = reparse();
      let sec = sectionOf(p, s.key);
      const dup = sec?.items.find((it) => norm(it.text) === norm(txt));
      if (dup?.id) {
        queue.push({ op: "bump", id: dup.id }); // same lesson again: count it instead of repeating it
        continue;
      }
      if (sec && sec.items.length >= s.max)
        throw new Error(`"${s.title}" is full (${s.max}); replace or retire one of ${sec.items.map((i) => i.id).filter(Boolean).join(", ")} first`);
      const used = [...p.sections.values()].flatMap((x) => x.items).map((i) => i.id).filter((id): id is string => !!id && id.startsWith(s.prefix));
      const id = `${s.prefix}${Math.max(0, ...used.map((x) => Number(x.slice(1)) || 0)) + 1}`;
      if (!sec) {
        // New section, placed in the canonical order: after the last earlier one, else before the first later one.
        const idx = SECTIONS.indexOf(s);
        const earlier = SECTIONS.slice(0, idx).map((x) => sectionOf(p, x.key)).filter(Boolean).pop();
        const later = SECTIONS.slice(idx + 1).map((x) => sectionOf(p, x.key)).find(Boolean);
        if (earlier) lines.splice(earlier.end, 0, "", `## ${s.title}`);
        else if (later) lines.splice(later.heading, 0, `## ${s.title}`, "");
        else lines.push("", `## ${s.title}`);
        sec = reparse().sections.get(s.title.toLowerCase())!;
      }
      const insertAt = sec.items.length ? sec.items[sec.items.length - 1].line + 1 : sec.heading + 1;
      lines.splice(insertAt, 0, `${s.numbered ? `${sec.items.length + 1}.` : "-"} ${txt}${suffix(id, 1)}`);
      log.push({ at, op: "add", id, text: txt });
    } else if (ch.op === "bump") {
      const { title, it } = findItem(ch.id);
      lines[it.line] = lineFor(title, it, it.text, it.seen + 1);
      log.push({ at, op: "bump", id: ch.id, text: it.text });
    } else if (ch.op === "replace") {
      const txt = checkText(ch.text);
      const { title, it } = findItem(ch.id);
      lines[it.line] = lineFor(title, it, txt, it.seen);
      retired.push(`- ${at.slice(0, 10)} replaced ${ch.id}: ${it.text}`);
      log.push({ at, op: "replace", id: ch.id, text: txt, old: it.text });
    } else if (ch.op === "retire") {
      const { it } = findItem(ch.id);
      lines.splice(it.line, 1);
      retired.push(`- ${at.slice(0, 10)} retired ${ch.id}: ${it.text}`);
      log.push({ at, op: "retire", id: ch.id, text: it.text });
    }
  }
  // Keep numbered sections numbered 1..n after inserts and removals.
  for (const s of SECTIONS.filter((x) => x.numbered)) {
    const sec = sectionOf(reparse(), s.key);
    sec?.items.forEach((it, i) => (lines[it.line] = lines[it.line].replace(/^(\s*)\d+\./, `$1${i + 1}.`)));
  }
  const out = lines.join("\n");
  const check = checkPlaybook(out);
  if (check.errors.length) throw new Error(`change not applied:\n- ${check.errors.join("\n- ")}`);
  return { text: out, retired, log };
}

/** The parts a planner needs, as one short block for the team goal. */
export function playbookBrief(text: string, name: string): { block: string; done: string[] } {
  const p = parsePlaybook(text);
  const part = (key: SectionKey) => sectionOf(p, key)?.items.map((i) => i.text) ?? [];
  const lines = [`Playbook "${name}" (lessons from earlier projects of this kind; follow it unless the goal says otherwise):`];
  for (const s of SECTIONS) {
    if (s.key === "ask") continue; // answered by the lead before the run
    const items = part(s.key);
    if (items.length) lines.push(`${s.title}: ${items.map((t, i) => (s.numbered ? `${i + 1}) ${t}` : t)).join("; ")}`);
  }
  return { block: lines.join("\n"), done: part("done") };
}

// ---------- files on disk ----------

export interface PlaybookMeta {
  version: 1;
  created: string;
  uses: { at: string; repo: string; outcome: string; minutes?: number }[];
  log: ChangeLog[];
}

export interface PlaybookEntry {
  name: string;
  description: string;
  dir: string;
  uses: number;
  lastUsed?: string;
}

export function readMeta(dir: string): PlaybookMeta {
  try {
    const m = JSON.parse(readFileSync(join(dir, "playbook.json"), "utf8")) as PlaybookMeta;
    return { version: 1, created: m.created ?? "", uses: Array.isArray(m.uses) ? m.uses : [], log: Array.isArray(m.log) ? m.log : [] };
  } catch {
    return { version: 1, created: "", uses: [], log: [] };
  }
}

export function writeMeta(dir: string, meta: PlaybookMeta): void {
  writeFileSync(join(dir, "playbook.json"), JSON.stringify({ ...meta, uses: meta.uses.slice(-50), log: meta.log.slice(-100) }, null, 2) + "\n");
}

/** Playbooks in the given directories (earlier directories win on a name clash). */
export function listPlaybooks(dirs: string[]): PlaybookEntry[] {
  const seen = new Map<string, PlaybookEntry>();
  for (const root of dirs) {
    if (!existsSync(root)) continue;
    for (const child of readdirSync(root).sort()) {
      const dir = join(root, child);
      const file = join(dir, "SKILL.md");
      if (!existsSync(file) || seen.has(child)) continue;
      const p = parsePlaybook(readFileSync(file, "utf8"));
      const meta = readMeta(dir);
      seen.set(child, { name: p.name ?? child, description: p.description ?? "", dir, uses: meta.uses.length, lastUsed: meta.uses.at(-1)?.at });
    }
  }
  return [...seen.values()];
}

export function findPlaybook(dirs: string[], name: string): PlaybookEntry | undefined {
  if (!validPlaybookName(name)) return undefined;
  return listPlaybooks(dirs).find((p) => p.name === name || basename(p.dir) === name);
}

/** Copy project files into templates/, keeping their relative paths. Only small files inside the repo, no secrets. */
export function copyTemplates(repo: string, files: string[], target: string): { copied: string[]; skipped: string[] } {
  const copied: string[] = [];
  const skipped: string[] = [];
  for (const f of files.slice(0, LIMITS.templates)) {
    const abs = resolve(repo, f);
    const rel = relative(repo, abs).replace(/\\/g, "/");
    if (!rel || rel.startsWith("..") || rel.startsWith("/") || /^[A-Za-z]:/.test(rel) || rel.split("/").includes(".git")) {
      skipped.push(`${f}: outside the repo`);
      continue;
    }
    if (!existsSync(abs) || !statSync(abs).isFile()) {
      skipped.push(`${f}: not a file`);
      continue;
    }
    if (statSync(abs).size > LIMITS.templateBytes) {
      skipped.push(`${f}: larger than ${LIMITS.templateBytes / 1000} KB`);
      continue;
    }
    if (findSecrets(readFileSync(abs, "utf8")).length) {
      skipped.push(`${f}: looks like it contains a secret`);
      continue;
    }
    mkdirSync(join(target, rel, ".."), { recursive: true });
    cpSync(abs, join(target, rel));
    copied.push(rel);
  }
  for (const f of files.slice(LIMITS.templates)) skipped.push(`${f}: more than ${LIMITS.templates} files`);
  return { copied, skipped };
}

export function appendRetired(dir: string, lines: string[]): void {
  if (!lines.length) return;
  mkdirSync(join(dir, "references"), { recursive: true });
  appendFileSync(join(dir, "references", "retired.md"), lines.join("\n") + "\n");
}
