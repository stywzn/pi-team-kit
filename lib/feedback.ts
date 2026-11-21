// Friction report: where the tooling itself (team runs, the guard, ptk tools, the model provider) cost time,
// read from pi's own session files. Nothing extra is recorded, so it also covers work done before this
// existed. The output is a short ranked list a person can hand to another agent to research fixes.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { patternsOverlap } from "./team.ts";
import { redact } from "./playbook.ts";

export type SignalKind =
  | "run"
  | "rework"
  | "failed-lane"
  | "serialized"
  | "conflict"
  | "gate-failed"
  | "not-removed"
  | "timeout"
  | "block"
  | "tool-error"
  | "aborted"
  | "model-error"
  | "compaction"
  | "intervened"
  | "note";

export interface Signal {
  kind: SignalKind;
  project: string;
  when: string;
  /** Groups signals of one kind into one item (a reason, a command, a tool). */
  key: string;
  /** Estimated minutes lost; time-based kinds are measured, others are estimates. */
  minutes: number;
  /** For runs: lanes and tasks. */
  lanes?: number;
  /** For runs: minutes spent per role (planner, worker, verifier, rework), from the run's child records. */
  phases?: Record<string, number>;
  tasks?: number;
}

type Finding = { file?: string; issue?: string };
type Lane = { lane: string; tasks?: string[]; state: string; rounds: number; error?: string | null; summary?: string; history?: { gate?: string; findings?: Finding[] }[] };
type RunValue = { lanes?: Lane[]; plan?: { tasks?: { key: string; files?: string[] }[] } };

const BLOCKS: [string, RegExp][] = [
  ["a command that never ends (server, watcher)", /^This command would not finish on its own/],
  ["a saved pitfall", /^Known pitfall/],
  ["slow recursive search", /^(Recursive grep is slow|Use .*`fd |`ls -R` dumps)/],
  ["a file another lead was changing", /was changed in the last 30 minutes by lead/],
];

const head = (s: string, n = 70) => {
  const t = redact(s).replace(/\s+/g, " ").trim();
  return t.length > n ? `${t.slice(0, n - 1)}…` : t;
};
const textOf = (content: unknown): string =>
  typeof content === "string" ? content : Array.isArray(content) ? content.map((p: { type?: string; text?: string }) => (p?.type === "text" ? (p.text ?? "") : "")).join("\n") : "";
const ms = (ts: unknown) => (typeof ts === "number" ? ts : typeof ts === "string" ? Date.parse(ts) : Number.NaN);
/** A reason without the parts that differ every time (numbers, paths), so repeats group together. */
const reasonKey = (s: string) => head(s.replace(/\d+/g, "N").replace(/\S+\.(py|ts|js|tsx|go|java|rb|md|json)\b/g, "<file>"), 80);

const isGlob = (p: string) => /[*?[{]/.test(p);
/** Name the concrete file when one side is a glob (tests/fixtures/auth.ts, not tests/fixtures/**). */
const pickName = (a: string, b: string) => (isGlob(a) !== isGlob(b) ? (isGlob(a) ? b : a) : a.length <= b.length ? a : b);

/** Files that made tasks of one lane share it: patterns of different tasks that overlap. */
function sharedFiles(lane: Lane, plan: RunValue["plan"]): string[] {
  const tasks = (plan?.tasks ?? []).filter((t) => lane.tasks?.includes(t.key));
  const out = new Set<string>();
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++)
      for (const a of tasks[i].files ?? []) for (const b of tasks[j].files ?? []) if (patternsOverlap(a, b)) out.add(pickName(a, b));
  return [...out];
}

/** Signals from one session file. `readRunValue` returns a finished team run's value from its receipt directory. */
/** The command a timeout belongs to: the first segment that does real work, not `cd`, `export` or `set -e`. */
export function mainCommand(cmd: string): string {
  const segs = cmd.split(/&&|\|\||;|\n/).map((s) => s.trim()).filter(Boolean);
  return segs.find((s) => !/^(cd|pushd|set|export|source|\.|echo|true)(\s|$)/.test(s)) ?? segs[0] ?? "";
}

/** Who a failed tool call is for: a tool's limit (pi or ptk), arguments the model got wrong, or the tool failing. */
export function errorSource(body: string): "limit" | "arguments" | "failed" {
  if (/output token|max_?tokens|keep a message under|at most \d+|too (long|large|many)|over \d+ characters/i.test(body)) return "limit";
  if (/validat|must be|is required|required property|expected|invalid|not a |unknown (option|parameter|tool)|is not one of|not found/i.test(body)) return "arguments";
  return "failed";
}

export function sessionSignals(
  jsonl: string,
  readRunValue: (dir: string) => unknown = () => undefined,
  readPhases: (dir: string) => Record<string, number> | undefined = () => undefined,
  readLanes: (dir: string) => number | undefined = () => undefined,
): Signal[] {
  const out: Signal[] = [];
  let project = "unknown";
  const calls = new Map<string, { name: string; args: Record<string, unknown> }>();
  let runStart = Number.NaN;
  let userDuringRun = 0;
  const add = (kind: SignalKind, when: number, key: string, minutes = 0, extra: Partial<Signal> = {}) =>
    out.push({ kind, project, when: Number.isNaN(when) ? "" : new Date(when).toISOString(), key, minutes, ...extra });
  for (const line of jsonl.split("\n")) {
    if (!line.trim()) continue;
    let e: { type?: string; timestamp?: unknown; cwd?: string; customType?: string; content?: unknown; data?: { text?: string }; message?: Record<string, unknown> };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    const t = ms(e.timestamp);
    if (e.type === "session" && e.cwd) project = basename(e.cwd.replace(/[\\/]+$/, "")) || project;
    else if (e.type === "compaction") add("compaction", t, "context compacted");
    else if (e.type === "custom" && e.customType === "ptk-friction" && e.data?.text) add("note", t, head(e.data.text, 160), 2);
    else if (e.type === "custom_message" && e.customType === "subagent-notify") {
      const body = textOf(e.content);
      const receipt = body.match(/Workflow receipt:\s*(.+?)[\\/]workflow-receipt\.json/);
      if (!receipt) continue;
      let value = readRunValue(receipt[1].trim()) as RunValue | undefined;
      if (!value) {
        // status.json gone (temp folder cleaned): the notice carries the value, unless it was cut.
        try {
          value = JSON.parse(body.slice(body.indexOf("Return:") + 7)) as RunValue;
        } catch {
          value = undefined;
        }
      }
      const minutes = Number.isNaN(runStart) ? 0 : Math.max(0, (t - runStart) / 60_000);
      const lanes = value?.lanes ?? [];
      const phases = readPhases(receipt[1].trim());
      // A run stopped before it returned (or whose status.json was cleaned up) has no value: count its started lanes.
      const started = lanes.length ? lanes.length : (readLanes(receipt[1].trim()) ?? 0);
      add("run", t, "team run", 0, { lanes: started, tasks: value?.plan?.tasks?.length ?? (lanes.length ? lanes.reduce((n, l) => n + (l.tasks?.length ?? 1), 0) : started), ...(phases ? { phases } : {}) });
      const maxRounds = Math.max(1, ...lanes.map((l) => l.rounds || 1));
      for (const lane of lanes) {
        if (lane.rounds > 1) {
          const reasons = (lane.history ?? []).flatMap((h) => [...(h.gate ? [`checks failed: ${h.gate}`] : []), ...(h.findings ?? []).map((f) => f.issue ?? "")]).filter(Boolean);
          add("rework", t, reasons[0] ? reasonKey(reasons[0]) : "reason not recorded (run from before 0.5.0)", (minutes * (lane.rounds - 1)) / maxRounds);
        }
        if (lane.state === "failed" || lane.state === "needs-human") add("failed-lane", t, reasonKey(`${lane.state}: ${lane.error || lane.summary || ""}`), minutes / Math.max(1, lanes.length));
        if ((lane.tasks?.length ?? 1) > 1) {
          const shared = sharedFiles(lane, value?.plan);
          add("serialized", t, shared.length ? shared.slice(0, 3).join(", ") : `${lane.tasks?.length} tasks`, minutes * (1 - 1 / (lane.tasks?.length ?? 1)));
        }
      }
      if (userDuringRun) add("intervened", t, "a person had to step in during an unattended run", 3 * userDuringRun);
      runStart = Number.NaN;
      userDuringRun = 0;
      continue;
    }
    const m = e.message ?? {};
    if (m.role === "user" && !Number.isNaN(runStart)) userDuringRun++;
    if (m.role === "assistant") {
      if (m.stopReason === "aborted") add("aborted", t, "a run stopped by hand (Esc)", 2);
      if (m.stopReason === "error") add("model-error", t, head(String(m.errorMessage ?? "provider error"), 80), 1);
      for (const p of (Array.isArray(m.content) ? m.content : []) as { type?: string; id?: string; name?: string; arguments?: Record<string, unknown> }[]) {
        if (p?.type !== "toolCall") continue;
        if (p.id) calls.set(p.id, { name: p.name ?? "", args: p.arguments ?? {} });
        if (p.name === "team_run" && Number.isNaN(runStart)) runStart = t;
      }
    }
    if (m.role === "toolResult") {
      const body = textOf(m.content);
      const tool = String(m.toolName ?? "");
      const call = calls.get(String(m.toolCallId ?? ""));
      const cmd = typeof call?.args.command === "string" ? call.args.command : "";
      const stopped = body.match(/\[ptk\] Stopped after (\d+)s/);
      if (stopped) add("timeout", t, head(mainCommand(cmd) || tool, 60), Number(stopped[1]) / 60);
      if (tool === "team_run" && m.isError === true) runStart = Number.NaN; // refused or not confirmed: no run started
      const block = m.isError === true ? BLOCKS.find(([, re]) => re.test(body.trim())) : undefined;
      if (block) add("block", t, block[0], 1);
      else if (tool === "team_integrate") {
        if (/^FAILED /m.test(body)) add("conflict", t, "a lane's patch did not apply", 10);
        if (/^gate `.*`: FAILED/m.test(body)) add("gate-failed", t, "lanes passed alone, the combined code failed the gate", 10);
        if (/^NOT removed/m.test(body)) add("not-removed", t, "worker worktrees left behind", 1);
      } else if (m.isError === true && tool !== "bash") add("tool-error", t, `${tool} (${errorSource(body)}): ${head(body.split("\n").find((l) => l.trim()) ?? "", 70)}`, 1);
    }
  }
  return out;
}

/** Read session files and collect their signals; `project` keeps only sessions started in that folder name. */
export function frictionFromFiles(
  files: string[],
  project?: string,
  readRun: (dir: string) => unknown = () => undefined,
  readPhases: (dir: string) => Record<string, number> | undefined = () => undefined,
  readLanes: (dir: string) => number | undefined = () => undefined,
): { signals: Signal[]; sessions: number } {
  const signals: Signal[] = [];
  let sessions = 0;
  for (const f of files) {
    let text: string;
    try {
      text = readFileSync(f, "utf8");
    } catch {
      continue;
    }
    let cwd = "";
    try {
      cwd = (JSON.parse(text.slice(0, text.indexOf("\n") >>> 0)) as { cwd?: string }).cwd ?? "";
    } catch {
      /* no header */
    }
    if (project && basename(cwd.replace(/[\\/]+$/, "")) !== project) continue;
    sessions++;
    signals.push(...sessionSignals(text, readRun, readPhases, readLanes));
  }
  return { signals, sessions };
}

/** Top-level session files (lead sessions) of every project, changed within `days`. Subagent files live deeper. */
export function sessionFiles(sessionsRoot: string, days: number, now = Date.now()): string[] {
  if (!existsSync(sessionsRoot)) return [];
  const out: string[] = [];
  for (const dir of readdirSync(sessionsRoot)) {
    const full = join(sessionsRoot, dir);
    try {
      if (!statSync(full).isDirectory()) continue;
      for (const f of readdirSync(full)) if (f.endsWith(".jsonl") && now - statSync(join(full, f)).mtimeMs <= days * 86_400_000) out.push(join(full, f));
    } catch {
      /* unreadable folder */
    }
  }
  return out;
}

const IDEAS: Partial<Record<SignalKind, [string, string]>> = {
  rework: ["Lanes sent back for rework", "make the top reason a gate check, a playbook pitfall or a planner rule"],
  serialized: ["Shared files put tasks into one lane (no parallelism)", "two-phase runs: build the shared files first, then the parallel lanes"],
  "failed-lane": ["Lanes that failed or needed a person", "read the lanes' errors; if they repeat, the brief or the planner is the problem"],
  conflict: ["Patches that did not apply at integration", "lanes changed files the planner did not give them"],
  "gate-failed": ["Lanes passed alone but failed together", "check the combined code earlier, or add an integration lane"],
  timeout: ["Commands stopped by the timeout", "raise that kind's timeout, run a narrower test, or start it with bg"],
  block: ["Commands the guard refused", "the model keeps trying them: a prompt rule or a toolbox helper"],
  "tool-error": ["Tool calls that failed", "fix the tool, its description or its limits"],
  intervened: ["You stepped in during unattended runs", "clarify more before the run starts (a playbook's Ask-first helps)"],
  aborted: ["Runs stopped by hand", "look at what they were doing when you stopped them"],
  "model-error": ["Model or provider errors", "retries, rate limits, or another model for that role"],
  compaction: ["Context compactions", "sessions run long: /handoff earlier or split the task"],
  "not-removed": ["Worker worktrees left behind", "see the reasons team_integrate printed"],
};

export interface FrictionItem {
  kind: SignalKind;
  title: string;
  idea: string;
  count: number;
  minutes: number;
  top: [string, number][];
}

export function frictionItems(signals: Signal[]): FrictionItem[] {
  const by = new Map<SignalKind, Signal[]>();
  for (const s of signals) if (s.kind !== "run" && s.kind !== "note") by.set(s.kind, [...(by.get(s.kind) ?? []), s]);
  const items: FrictionItem[] = [];
  for (const [kind, list] of by) {
    const [title, idea] = IDEAS[kind] ?? [kind, ""];
    const keys = new Map<string, number>();
    for (const s of list) keys.set(s.key, (keys.get(s.key) ?? 0) + 1);
    items.push({ kind, title, idea, count: list.length, minutes: list.reduce((n, s) => n + s.minutes, 0), top: [...keys].sort((a, b) => b[1] - a[1]).slice(0, 3) });
  }
  return items.sort((a, b) => b.minutes - a.minutes || b.count - a.count);
}

const median = (xs: number[]) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : 0);

/** The report: a few lines per item, most costly first. */
export function formatFriction(signals: Signal[], opts: { days: number; sessions: number; limit?: number }): string {
  const runs = signals.filter((s) => s.kind === "run");
  const projects = [...new Set(signals.map((s) => s.project))];
  const lines = [
    `pi-team-kit friction, last ${opts.days} day${opts.days === 1 ? "" : "s"}: ${opts.sessions} session(s), ${projects.length} project(s)${projects.length ? ` (${projects.slice(0, 5).join(", ")})` : ""}, ${runs.length} team run(s)` +
      (runs.length ? `, most lanes in one run: ${Math.max(...runs.map((r) => r.lanes ?? 0))}, median tasks per run: ${median(runs.map((r) => r.tasks ?? 0))}` : "") +
      ".",
    "",
  ];
  const phase: Record<string, number> = {};
  for (const r of runs) for (const [k, v] of Object.entries(r.phases ?? {})) phase[k] = (phase[k] ?? 0) + v;
  const total = Object.values(phase).reduce((a, b) => a + b, 0);
  if (total > 0)
    lines.splice(
      1,
      0,
      `Time by role in team runs: ${Object.entries(phase)
        .sort((a, b) => b[1] - a[1])
        .map(([k, v]) => `${k} ${v < 10 ? v.toFixed(1) : Math.round(v)} min (${Math.round((100 * v) / total)}%)`)
        .join(", ")}.`,
    );
  const items = frictionItems(signals).slice(0, opts.limit ?? 8);
  if (!items.length) lines.push("Nothing found: no rework, timeouts, refusals, tool errors or interruptions in this period.");
  items.forEach((it, i) => {
    const cost = it.minutes >= 1 ? `, ≈${Math.round(it.minutes)} min` : "";
    lines.push(`${i + 1}. ${it.title}: ${it.count}${cost}. ${it.top.map(([k, n]) => `"${k}"${n > 1 ? ` ×${n}` : ""}`).join("; ")}`);
    if (it.idea) lines.push(`   Try: ${it.idea}.`);
  });
  const notes = [...new Set(signals.filter((s) => s.kind === "note").map((s) => s.key))].slice(-8);
  if (notes.length) lines.push("", "Noted by leads:", ...notes.map((n) => `- ${n}`));
  lines.push("", "Minutes are estimates (rework and serialization share a run's time). To improve the tool, hand this to an agent: \"For the top items, find the cause in pi-team-kit and propose the smallest fix for each.\"");
  return lines.join("\n");
}

/**
 * Minutes per role in one finished team run: each child's start and end from its own status.json, named by the
 * workflow key (plan, <lane>-work, <lane>-verify-N, <lane>-fix-N / -gatefix-N). Undefined when the records are gone.
 */
export function runPhases(runDir: string): Record<string, number> | undefined {
  let lines: string[];
  try {
    lines = readFileSync(join(runDir, "workflow-children.jsonl"), "utf8").split("\n");
  } catch {
    return undefined;
  }
  const out: Record<string, number> = {};
  for (const line of lines) {
    let e: { type?: string; key?: string; result?: { runId?: string; asyncDir?: string } };
    try {
      e = JSON.parse(line);
    } catch {
      continue;
    }
    if (e.type !== "settle" || !e.key || !e.result?.runId) continue;
    const dir = e.result.asyncDir || join(dirname(runDir), e.result.runId);
    try {
      const st = JSON.parse(readFileSync(join(dir, "status.json"), "utf8")) as { startedAt?: string | number; endedAt?: string | number };
      const a = typeof st.startedAt === "number" ? st.startedAt : Date.parse(String(st.startedAt));
      const b = typeof st.endedAt === "number" ? st.endedAt : Date.parse(String(st.endedAt));
      if (!Number.isFinite(a) || !Number.isFinite(b) || b < a) continue;
      const role = e.key === "plan" ? "planner" : /-verify-\d+$/.test(e.key) ? "verifier" : /-(fix|gatefix)-\d+$/.test(e.key) ? "rework" : "worker";
      out[role] = (out[role] ?? 0) + (b - a) / 60_000;
    } catch {
      /* child record gone */
    }
  }
  return Object.keys(out).length ? out : undefined;
}

/** Lanes a run started (its <lane>-work children), from workflow-children.jsonl: known also for runs that never returned. */
export function runLanes(runDir: string): number | undefined {
  let text: string;
  try {
    text = readFileSync(join(runDir, "workflow-children.jsonl"), "utf8");
  } catch {
    return undefined;
  }
  const keys = new Set<string>();
  for (const line of text.split("\n")) {
    try {
      const e = JSON.parse(line) as { key?: unknown };
      if (typeof e.key === "string" && /-work$/.test(e.key)) keys.add(e.key);
    } catch {
      /* partial line */
    }
  }
  return keys.size || undefined;
}
