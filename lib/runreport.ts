// After a subagent or team run that did not finish cleanly (timed out, failed, stopped, a lane that did not pass),
// the lead is shown what the run changed, whether that stayed inside what it was allowed to touch, and its last
// tool calls, instead of digging with git diff. Facts come from pi-subagents' completion notice ("subagent-notify")
// and the run's status.json.

export interface NoticeRun {
  runId: string;
  agent: string;
  status: string;
  asyncDir?: string;
  durationMs?: number;
}

/** Runs announced by one pi-subagents completion notice. */
export function noticeRuns(details: unknown): NoticeRun[] {
  const runs = (details as { runs?: unknown } | undefined)?.runs;
  if (!Array.isArray(runs)) return [];
  return runs
    .filter((r): r is Record<string, unknown> => Boolean(r) && typeof (r as { runId?: unknown }).runId === "string")
    .map((r) => ({
      runId: r.runId as string,
      agent: String(r.agent ?? ""),
      status: String(r.status ?? ""),
      asyncDir: typeof r.asyncDir === "string" ? r.asyncDir : undefined,
      durationMs: Number(r.durationMs) || undefined,
    }));
}

export interface RunFacts {
  cwd?: string;
  worktree?: string;
  error?: string;
  startedAt?: number;
  lastTools: string[];
}

const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n)}…` : s);

/** Where a single run worked, how it ended, and its last tool calls, from its status.json. */
export function runFacts(status: unknown): RunFacts {
  const s = (status ?? {}) as { cwd?: unknown; startedAt?: unknown; error?: unknown; steps?: Array<Record<string, unknown>> };
  const step = (Array.isArray(s.steps) ? s.steps[0] : undefined) ?? {};
  const tools = Array.isArray(step.recentTools) ? (step.recentTools as Array<{ tool?: unknown; args?: unknown }>) : [];
  const started = typeof s.startedAt === "number" ? s.startedAt : Date.parse(String(s.startedAt ?? ""));
  const error = step.error ?? s.error;
  return {
    cwd: typeof s.cwd === "string" ? s.cwd : undefined,
    worktree: typeof step.worktreePath === "string" ? step.worktreePath : undefined,
    error: error ? clip(String(error), 300) : undefined,
    startedAt: Number.isFinite(started) ? started : undefined,
    lastTools: tools.slice(-5).map((t) => clip(`${String(t.tool ?? "?")} ${JSON.stringify(t.args ?? {})}`, 160)),
  };
}

export interface LaneFacts {
  lane: string;
  state: string;
  runDir?: string;
  files: string[];
}

/** Lanes of a team run result (the workflow's value) that did not pass. */
export function lanesNotPassed(value: unknown): LaneFacts[] {
  const lanes = (value as { lanes?: unknown } | undefined)?.lanes;
  if (!Array.isArray(lanes)) return [];
  return lanes
    .filter((l) => l && typeof l === "object" && (l as { state?: unknown }).state !== "passed")
    .map((l) => {
      const x = l as { lane?: unknown; state?: unknown; runDir?: unknown; files?: unknown };
      return {
        lane: String(x.lane ?? "?"),
        state: String(x.state ?? "?"),
        runDir: typeof x.runDir === "string" ? x.runDir : undefined,
        files: Array.isArray(x.files) ? x.files.map(String) : [],
      };
    });
}

export interface Changed {
  path: string;
  added?: number;
  deleted?: number;
  /** Untracked: a new file, with its line count. */
  newLines?: number;
}

/** `git diff --numstat` lines: added, deleted, path ("-" for binary). */
export function parseNumstat(out: string): Map<string, { added?: number; deleted?: number }> {
  const m = new Map<string, { added?: number; deleted?: number }>();
  for (const line of out.split("\n")) {
    const [a, d, ...rest] = line.split("\t");
    const path = rest.join("\t").trim();
    if (!path) continue;
    m.set(path, { added: a === "-" ? undefined : Number(a), deleted: d === "-" ? undefined : Number(d) });
  }
  return m;
}

export interface ReportItem {
  title: string;
  where?: string;
  changed: Changed[];
  /** Changed files outside what the run was allowed to touch (team lanes: their owned files). */
  outside: string[];
  lastTools: string[];
  error?: string;
  note?: string;
}

const MAX_LISTED = 20;

/** The note the lead gets: one block per run, short. */
export function formatRunReport(items: ReportItem[]): string {
  const lines = ["[ptk] What these runs left behind (nothing below was reviewed; look before retrying, integrating or committing):"];
  for (const it of items) {
    lines.push(`- ${it.title}${it.where ? `, in ${it.where}` : ""}`);
    if (it.changed.length) {
      const shown = it.changed.slice(0, MAX_LISTED).map((c) =>
        c.newLines !== undefined ? `${c.path} (new, ${c.newLines} lines)` : c.added !== undefined ? `${c.path} +${c.added} -${c.deleted ?? 0}` : c.path,
      );
      lines.push(`  changed: ${shown.join(", ")}${it.changed.length > MAX_LISTED ? `, and ${it.changed.length - MAX_LISTED} more` : ""}`);
    } else lines.push("  changed: nothing");
    if (it.outside.length) lines.push(`  OUTSIDE what it was allowed to change: ${it.outside.slice(0, MAX_LISTED).join(", ")}`);
    if (it.error) lines.push(`  error: ${it.error}`);
    if (it.lastTools.length) lines.push(`  last tool calls: ${it.lastTools.join(" | ")}`);
    if (it.note) lines.push(`  note: ${it.note}`);
  }
  lines.push("Tell the user what was left, then decide with them: keep and finish it, or undo it (git checkout / git clean on those files).");
  return lines.join("\n");
}
