// Team run = the lead's task list turned into conflict-free lanes, executed by pi-subagents:
//   lane: worker in its own git worktree -> gate command (host-run) -> fresh verifier -> rework, at most N rounds
// Planning, lane building and script generation are plain functions so they are unit-tested;
// the workflow script itself only wires runs.run calls together.

import { ENV_FAILURE_JS } from "./envfail.ts";

export interface TeamTask {
  key: string;
  title: string;
  brief: string;
  /** Paths or globs this task owns. Two tasks that share any path end up in the same lane. */
  files: string[];
  /**
   * Keys of tasks that must be done first. Every worker branches from HEAD and cannot see another lane's
   * changes, so a task and what it depends on run in one lane, in dependency order.
   */
  dependsOn?: string[];
  /** The focused command that proves the task done and what it prints then ("1 passed"). The worker iterates with
   *  it; its output goes to the verifier as evidence, not to the lead. */
  verify?: { cmd: string; expect: string };
  /** Test case ids this task automates; the verifier checks each one. */
  caseIds?: string[];
  /** Fixtures, helpers or interfaces from other tasks this task builds on, by name. */
  uses?: string[];
}

export interface Lane {
  key: string;
  tasks: TeamTask[];
  files: string[];
  /** Lanes whose change this one needs: it starts once they are merged, from the integration branch. */
  after?: string[];
}

export interface TeamPlan {
  goal: string;
  /** Empty = let the planner agent split the goal inside the run. */
  lanes: Lane[];
  gate: string;
  gateTimeoutSec: number;
  maxRounds: number;
  workerAgent: string;
  verifierAgent: string;
  plannerAgent?: string;
  maxTasks?: number;
  models?: { planner?: string; worker?: string; verifier?: string };
  /** Deadline for each planner, worker and verifier run; pi-subagents' own default is 30 minutes. */
  childTimeoutMs?: number;
  /** How long before that deadline a child is told to stop after its current step and hand off. */
  checkpointMs?: number;
  /** Each lane's gate runs only the test files the lane owns (see narrowGate in the script). */
  laneTests?: boolean;
  /** Lanes beyond this are merged into the smallest ones: they would only queue, and each lane costs a worker and a verifier. */
  maxLanes?: number;
  /** Rules for every task, copied word for word to each worker and verifier (e.g. unique test data, cleanup in teardown). */
  constraints?: string[];
  /**
   * The merge queue: a branch and its worktree (outside the repo) that each lane is merged into as soon as it passes,
   * one at a time, with the full gate run on the combined code before the commit (bin/merge-lane.mjs does the apply).
   * A lane that depends on another starts from this branch after that one is merged. Absent: lanes are only reviewed,
   * and dependent tasks share a lane.
   */
  integration?: { branch: string; dir: string; script: string };
  mergerAgent?: string;
  /** Run the full gate once on the unchanged code before any worker starts. "stop" (or true): when it fails there,
   *  start no worker. "env": the lead said this run fixes those failures, so only an environment problem stops it
   *  (no lane fixes a missing service with code); other failures go to the workers as known. */
  baseline?: boolean | "stop" | "env";
  /** Each lane's own ports and database suffix (see team.laneEnv); run = this run's stamp. */
  laneEnv?: { portBase: number; portSpan: number; run: string };
  /** Unused since lane variables travel in the gate's env (kept so older callers still type-check). */
  windows?: boolean;
  /** A clean worktree at HEAD for the baseline check (the merge queue's, or one made just for it). Without it the
   *  baseline is skipped: it never runs in the lead's checkout, where a gate's output files would make it unclean. */
  baselineDir?: string;
  /** Workers may tell the other lanes once about something they need now (tell_lanes). */
  broadcast?: boolean;
}

const KEY = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Validate the lead's tasks. Throws one message listing every problem, so the model can fix all at once. */
const taskKey = (raw: unknown) => String(raw ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);

export function validateTasks(tasks: TeamTask[], maxTasks = 12): TeamTask[] {
  const problems: string[] = [];
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks: give at least one task");
  if (tasks.length > maxTasks) problems.push(`tasks: at most ${maxTasks}; merge small ones`);
  const seen = new Set<string>();
  const keys = new Set(tasks.map((t) => taskKey(t.key)));
  const out = tasks.map((t, i) => {
    const at = `tasks[${i}]`;
    const key = taskKey(t.key);
    if (!KEY.test(key)) problems.push(`${at}.key: use letters, digits, dashes`);
    if (seen.has(key)) problems.push(`${at}.key "${key}" is used twice`);
    seen.add(key);
    const title = String(t.title ?? "").trim();
    if (!title || title.length > 120) problems.push(`${at}.title: 1-120 characters`);
    const brief = String(t.brief ?? "").trim();
    if (brief.length < 20) problems.push(`${at}.brief: write a self-contained brief (what, where, done-when); the worker sees nothing else`);
    if (brief.length > 6000) problems.push(`${at}.brief: over 6000 characters; point to files instead of pasting them`);
    const files = (Array.isArray(t.files) ? t.files : []).map((f) => normalizePath(String(f))).filter(Boolean);
    if (files.length === 0) problems.push(`${at}.files: list the paths or globs this task owns`);
    for (const f of files) if (f.startsWith("/") || /^[A-Za-z]:/.test(f) || f.split("/").includes("..")) problems.push(`${at}.files: "${f}" must be relative to the repo root`);
    const out: TeamTask = { key, title, brief, files };
    const deps = [...new Set((Array.isArray(t.dependsOn) ? t.dependsOn : []).map(taskKey).filter(Boolean))];
    for (const d of deps) {
      if (d === key) problems.push(`${at}.dependsOn: a task cannot depend on itself`);
      else if (!keys.has(d)) problems.push(`${at}.dependsOn: no task with key "${d}"`);
    }
    if (deps.length) out.dependsOn = deps;
    if (t.verify && typeof t.verify === "object") {
      const cmd = String(t.verify.cmd ?? "").trim();
      const expect = String(t.verify.expect ?? "").trim();
      if (!cmd || cmd.length > 500 || expect.length > 300) problems.push(`${at}.verify: a focused command (under 500 characters) and what it prints when done (under 300)`);
      else out.verify = { cmd, expect };
    }
    const strings = (v: unknown, max: number) => (Array.isArray(v) ? v.map((s) => String(s).trim()).filter(Boolean).slice(0, max) : []);
    if (strings(t.caseIds, 50).length) out.caseIds = strings(t.caseIds, 50);
    if (strings(t.uses, 20).length) out.uses = strings(t.uses, 20);
    return out;
  });
  const cycle = dependencyCycle(out);
  if (cycle) problems.push(`dependsOn: ${cycle.join(" -> ")} is a cycle`);
  if (problems.length) throw new Error(problems.join("\n"));
  return out;
}

function dependencyCycle(tasks: TeamTask[]): string[] | undefined {
  const deps = new Map(tasks.map((t) => [t.key, t.dependsOn ?? []]));
  const state = new Map<string, 1 | 2>();
  const walk = (k: string, path: string[]): string[] | undefined => {
    if (state.get(k) === 2 || !deps.has(k)) return undefined;
    if (state.get(k) === 1) return [...path.slice(path.indexOf(k)), k];
    state.set(k, 1);
    for (const d of deps.get(k)!) {
      const c = walk(d, [...path, k]);
      if (c) return c;
    }
    state.set(k, 2);
    return undefined;
  };
  for (const t of tasks) {
    const c = walk(t.key, []);
    if (c) return c;
  }
  return undefined;
}

/** Dependencies first, otherwise the given order. A cycle (only possible from the planner) keeps the given order. */
function dependencyOrder(group: TeamTask[]): TeamTask[] {
  const out: TeamTask[] = [];
  const left = [...group];
  while (left.length) {
    const placed = new Set(out.map((t) => t.key));
    const i = left.findIndex((t) => (t.dependsOn ?? []).every((d) => placed.has(d) || !left.some((x) => x.key === d)));
    out.push(...left.splice(i < 0 ? 0 : i, 1));
  }
  return out;
}

/** Words that leave a worker guessing what to do. */
export const VAGUE_BRIEF = /\b(TBD|TODO|FIXME)\b|handle (all )?(the )?edge cases|add more tests|as (needed|appropriate)|and so on|待定|视情况|酌情/i;

/** Names in a brief that show where a task's change goes: an owned path, its file name, or a glob's folder. */
function anchorNames(files: string[]): string[] {
  return files
    .flatMap((f) => {
      const lit = literalPrefix(f).replace(/\/+$/, "");
      return [f, lit, f.split("/").pop() ?? "", lit.split("/").pop() ?? ""];
    })
    .filter((n) => n.length >= 3 && !/[*?[{]/.test(n));
}

/**
 * Problems that stop team_run until the lead fixes them, checked by code rather than asked for in prose:
 * every task has a check that proves it alone, its brief says where the change goes and has no placeholder,
 * and every owned path is anchored in the repo (it exists, or its folder does). A path that only exists one
 * folder down is named (docs/ meaning app/docs/); a leading ./ marks a new folder on purpose.
 */
export function taskProblems(tasks: TeamTask[], rawFiles: string[][], exists: (rel: string) => boolean, subdirs: string[], requireVerify = true): string[] {
  const out: string[] = [];
  tasks.forEach((t, i) => {
    if (requireVerify && !t.verify)
      out.push(`${t.key}: no verify. Give the focused command that proves this task alone and what it prints when done, e.g. {"cmd": "pytest tests/test_login.py -q", "expect": "3 passed"}; for docs or data any checking command works (grep -c "## Usage" docs/x.md -> 1).`);
    const names = anchorNames(t.files);
    const brief = t.brief.toLowerCase();
    if (names.length && !names.some((n) => brief.includes(n.toLowerCase())))
      out.push(`${t.key}: the brief does not say where the change goes. Name the file (and the function or section) from its files: ${t.files.slice(0, 3).join(", ")}.`);
    const vague = VAGUE_BRIEF.exec(t.brief);
    if (vague) out.push(`${t.key}: "${vague[0]}" leaves the worker guessing. Say exactly what to do, or leave it out.`);
    (rawFiles[i] ?? []).forEach((raw, j) => {
      const f = t.files[j];
      if (!f || /^\.[\\/]/.test(String(raw).trim())) return;
      const lit = literalPrefix(f).replace(/\/+$/, "");
      const glob = lit !== f;
      if (glob ? !lit || exists(lit) : exists(f)) return;
      const folder = glob ? lit : f.includes("/") ? f.slice(0, f.lastIndexOf("/")) : "";
      if (!glob && (!folder || exists(folder))) return; // a new file in a folder that exists
      const hits = subdirs.filter((d) => exists(`${d}/${glob ? lit : f}`) || (folder && exists(`${d}/${folder}`)));
      out.push(
        hits.length
          ? `${t.key}: "${f}" is not in the repo, but ${hits[0]}/${folder || f} is. Paths are relative to the repo root: write ${hits[0]}/${f}.`
          : `${t.key}: neither "${f}" nor its folder "${folder}" exists. Paths are relative to the repo root; write ./${f} if it is a new folder on purpose.`,
      );
    });
  });
  return out;
}

/** Warnings that do not stop a run: a brief long enough to read like a design document. */
export function taskWarnings(tasks: TeamTask[]): string[] {
  return tasks
    .filter((t) => t.brief.length > 3000)
    .map((t) => `${t.key}: the brief is ${t.brief.length} characters. A worker reads all of it before starting; keep what to change, where, and the check that proves it, and point to files for background.`);
}

/** `git status --porcelain -z` split into tracked changes (workers would not see them) and untracked files. */
export function splitStatus(porcelainZ: string): { tracked: string[]; untracked: string[] } {
  const tracked: string[] = [];
  const untracked: string[] = [];
  const parts = porcelainZ.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i];
    if (entry.length < 4) continue;
    const xy = entry.slice(0, 2);
    const path = entry.slice(3);
    if (/[RC]/.test(xy)) i++; // a rename or copy is followed by its old path
    if (path.startsWith(".pi/subagents")) continue;
    (xy === "??" ? untracked : tracked).push(path);
  }
  return { tracked, untracked };
}

/** A command that sets tracked changes aside and brings them back, for paths that need no quoting in sh and PowerShell. */
export function stashCommand(files: string[], untracked = false): string {
  const q = (f: string) => (/^[\w@+=:,./-]+$/.test(f) ? f : `'${f.replace(/'/g, "'\\''")}'`);
  return `git stash push${untracked ? " --include-untracked" : ""} -m ptk-team-run -- ${files.map(q).join(" ")}`;
}

function literalPrefix(pattern: string): string {
  const i = pattern.search(/[*?[{]/);
  return i < 0 ? pattern : pattern.slice(0, i);
}

/** Could two ownership patterns refer to the same file? Conservative: when unsure, yes. */
export function patternsOverlap(a: string, b: string): boolean {
  const pa = literalPrefix(normalizePath(a));
  const pb = literalPrefix(normalizePath(b));
  const globA = pa !== normalizePath(a);
  const globB = pb !== normalizePath(b);
  if (!pa || !pb) return true;
  if (!globA && !globB) return pa === pb || pa.startsWith(pb + "/") || pb.startsWith(pa + "/");
  return pa.startsWith(pb) || pb.startsWith(pa);
}

/**
 * Merge tasks that share files into one lane (one worker), so parallel lanes never edit the same file. More lanes
 * than maxLanes would only queue, and each lane costs a worker and a verifier: the smallest are merged until it fits.
 * A task that depends on another: with the merge queue (depsInOneLane false) it gets its own lane that starts after
 * the other's lane is merged (after); without it, both go to one lane, in order. Lanes that would wait on each other
 * in a circle are merged into one.
 */
export function planLanes(tasks: TeamTask[], maxLanes = Infinity, depsInOneLane = true): Lane[] {
  const parent = tasks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  const dep = (a: TeamTask, b: TeamTask) => Boolean(a.dependsOn?.includes(b.key));
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++)
      if (tasks[i].files.some((a) => tasks[j].files.some((b) => patternsOverlap(a, b))) || (depsInOneLane && (dep(tasks[i], tasks[j]) || dep(tasks[j], tasks[i]))))
        parent[find(j)] = find(i);
  const groups = new Map<number, TeamTask[]>();
  tasks.forEach((t, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), t]);
  });
  let list = [...groups.values()];
  while (list.length > Math.max(1, maxLanes)) {
    // The two smallest lanes become one; the later one joins the earlier, so task order is kept.
    const order = list.map((g, i) => i).sort((a, b) => list[a].length - list[b].length || a - b);
    const [a, b] = order.slice(0, 2).sort((x, y) => x - y);
    list[a] = [...list[a], ...list[b]];
    list.splice(b, 1);
  }
  list = mergeLaneCycles(list);
  const keyOf = (group: TeamTask[]) => {
    const ordered = dependencyOrder(group);
    return ordered.length === 1 ? ordered[0].key : `${ordered[0].key}-plus${ordered.length - 1}`;
  };
  const laneOf = new Map<string, number>();
  list.forEach((g, i) => g.forEach((t) => laneOf.set(t.key, i)));
  return list.map((group, i) => {
    const ordered = dependencyOrder(group);
    const after = [...new Set(group.flatMap((t) => (t.dependsOn ?? []).map((d) => laneOf.get(d)).filter((j): j is number => j !== undefined && j !== i)))].map((j) => keyOf(list[j]));
    return {
      key: keyOf(group),
      tasks: ordered,
      files: [...new Set(ordered.flatMap((t) => t.files))],
      ...(after.length ? { after } : {}),
    };
  });
}

/** Lanes that would wait on each other in a circle become one lane, until no circle is left. */
function mergeLaneCycles(list: TeamTask[][]): TeamTask[][] {
  for (;;) {
    const laneOf = new Map<string, number>();
    list.forEach((g, i) => g.forEach((t) => laneOf.set(t.key, i)));
    const edges = list.map((g, i) => [...new Set(g.flatMap((t) => (t.dependsOn ?? []).map((d) => laneOf.get(d)).filter((j): j is number => j !== undefined && j !== i)))]);
    const state: number[] = list.map(() => 0);
    let cycle: number[] | undefined;
    const walk = (i: number, path: number[]): void => {
      if (cycle || state[i] === 2) return;
      if (state[i] === 1) {
        cycle = path.slice(path.indexOf(i));
        return;
      }
      state[i] = 1;
      for (const j of edges[i]) walk(j, [...path, i]);
      state[i] = 2;
    };
    list.forEach((_, i) => walk(i, []));
    if (!cycle) return list;
    const keep = Math.min(...cycle);
    const merged = list.filter((_, i) => cycle!.includes(i)).flat();
    list = list.map((g, i) => (i === keep ? merged : g)).filter((_, i) => i === keep || !cycle!.includes(i));
  }
}

/** The pi-subagents workflow script for a plan. Data is embedded as JSON; logic is fixed. */
export function buildTeamScript(plan: TeamPlan): string {
  const full = { plannerAgent: "team-planner", maxTasks: 8, models: {}, ...plan };
  return `const PLAN = ${JSON.stringify(full)};
const PLAN_SCHEMA = ${JSON.stringify(PLAN_SCHEMA)};
const GATE = PLAN.gate ? { command: PLAN.gate, timeoutMs: PLAN.gateTimeoutSec * 1000 } : undefined;
// Resumed children reject the gate shorthand but accept the explicit form, so rework is held to the same check.
// pi-subagents stages the first round's changes when it captures the patch; preserveStagedIndex lets rework continue on top.
function resumeAcceptance(lane) {
  var g = laneGate(lane);
  return g
    ? { level: "verified", preserveStagedIndex: true, verify: [gateCheck(g)] }
    : { level: "checked", preserveStagedIndex: true };
}
const VERDICT_SCHEMA = ${JSON.stringify(VERDICT_SCHEMA)};
${WORKFLOW_BODY}`;
}

export const PLAN_SCHEMA = {
  type: "object",
  properties: {
    tasks: {
      type: "array",
      items: {
        type: "object",
        properties: {
          key: { type: "string" },
          title: { type: "string" },
          brief: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
          verify: { type: "object", properties: { cmd: { type: "string" }, expect: { type: "string" } }, required: ["cmd", "expect"] },
          caseIds: { type: "array", items: { type: "string" } },
          uses: { type: "array", items: { type: "string" } },
        },
        // verify is required: optional, the planner skipped it (seen in a real run)
        required: ["key", "title", "brief", "files", "verify"],
      },
    },
    constraints: { type: "array", items: { type: "string" } },
    questions: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
  required: ["tasks", "questions", "notes"],
};

export const VERDICT_SCHEMA = {
  type: "object",
  properties: {
    verdict: { type: "string", enum: ["pass", "rework", "blocked"] },
    summary: { type: "string" },
    findings: {
      type: "array",
      items: {
        type: "object",
        properties: {
          file: { type: "string", description: "path:line" },
          issue: { type: "string" },
          fix: { type: "string" },
          severity: { type: "string", enum: ["important", "minor"], description: "important: the task cannot be trusted until fixed (sent back); minor: noted for the lead only" },
        },
        required: ["issue"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};

// Plain functions and promise chains only: pi-subagents rejects async functions inside workflow scripts.
const WORKFLOW_BODY = String.raw`
function clip(text, n) { text = String(text || ""); return text.length > n ? text.slice(0, n) + " ...[cut]" : text; }
function taskList(lane) {
  return lane.tasks.map(function (t, i) {
    return (i + 1) + ". " + t.title + "\n" + t.brief +
      (t.caseIds && t.caseIds.length ? "\nCases: " + t.caseIds.join(", ") : "") +
      (t.uses && t.uses.length ? "\nBuilds on: " + t.uses.join(", ") : "") +
      (t.verify ? "\nDone when: " + JSON.stringify(t.verify.cmd) + (t.verify.expect ? " prints " + JSON.stringify(t.verify.expect) : " passes") : "");
  }).join("\n\n");
}
// Rules for every task, word for word from the plan (the lead's or the planner's), for workers and verifiers alike.
function rules() {
  var c = PLAN.constraints || [];
  return c.length ? "\n\nRules for every task:\n" + c.map(function (r) { return "- " + r; }).join("\n") : "";
}
// A failure without what changes on every run (times, counts, addresses): equal text means the same failure.
function failSig(text) {
  var lines = String(text || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).map(function (l) {
    // pi-subagents names the run in its error ("Run 'login-gatefix-2' failed"): not part of the failure
    return l.replace(/Run '[^']*'/g, "Run").replace(/0x[0-9a-f]+/gi, "#").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim();
  }).filter(Boolean);
  var key = lines.filter(function (l) { return /fail|error|exception|assert|traceback|panic|cannot|not found|denied/i.test(l); });
  return (key.length ? key : lines.slice(-40)).slice(0, 200).join("\n").slice(0, 4000);
}
function findingsSig(fs) {
  return (fs || []).map(function (f) { return String(f.file || "").replace(/:.*$/, "") + "|" + failSig(f.issue); }).sort().join("\n");
}
function numbered(fs) { return (fs || []).map(function (f, i) { return (i + 1) + ". " + (f.file ? f.file + ": " : "") + f.issue + (f.fix ? " -> " + f.fix : ""); }).join("\n"); }
// The worker's evidence is for the verifier; the lead gets status, files and concerns.
function forLead(output) { return String(output || "").replace(/(^|\n)Evidence:[\s\S]*?(?=\nConcerns:|$)/i, "\n").trim(); }
function blockedReport(w) { return /(^|\n)\s*Status:\s*BLOCKED\b/i.test(String((w && w.output) || "")); }
function owned(lane) { return lane.files.map(function (f) { return "- " + f; }).join("\n"); }
function runDir(r) { return (r && r.artifactPaths && r.artifactPaths[0]) || ""; }
${ENV_FAILURE_JS}
// What a worker found that the lead should know beyond its task (root causes, environment facts, workarounds,
// interface choices): taken from its report by code, kept across rounds, handed to the lead with the result.
function discoveriesOf(output) {
  var m = /(^|\n)[ \t]*Discoveries:[ \t]*([\s\S]*?)(?=\n[ \t]*(Evidence|Concerns|Changed files|Status):|$)/i.exec(String(output || ""));
  if (!m) return [];
  return m[2].split(/\r?\n/).map(function (l) { return l.replace(/^\s*([-*\u2022]|\d+[.)])\s*/, "").trim(); })
    .filter(function (l) { return l && !/^(none|n\/a|nothing( new)?|no discoveries|-)\.?$/i.test(l); }).slice(0, 8).map(function (l) { return clip(l, 300); });
}
function noteDiscoveries(lane, w) {
  var have = lane.discoveries || [];
  discoveriesOf(w && w.output).forEach(function (d) { if (have.indexOf(d) < 0) have.push(d); });
  lane.discoveries = have.slice(-12);
}

// A failed child makes runs.run reject with only a message. Look the run up by key so it can still be resumed.
function settle(key, promise) {
  return promise.then(function (r) { return r; }, function (e) {
    var error = String((e && e.message) || e);
    return runs.status(key).then(function (s) {
      var dir = (s && s.artifactPaths && s.artifactPaths[0]) || ((String((s && s.output) || "").match(/\nDir: (\S+)/) || [])[1]) || "";
      return { ok: false, error: error, runId: (s && s.runId) || null, artifactPaths: dir ? [dir] : [], output: "" };
    }, function () { return { ok: false, error: error, runId: null, artifactPaths: [], output: "" }; });
  });
}

// runs.all reports a failed child as { ok: false } with its whole result, the output of its checks included; runs.run
// only throws "Acceptance verification 'gate' failed." without it. So every child is launched as a batch of one, and a
// failed check's output (the test failures) reaches the worker, the same-failure test and the environment check.
function runChild(key, item) {
  var one = { key: key };
  for (var k in item) if (Object.prototype.hasOwnProperty.call(item, k)) one[k] = item[k];
  var p;
  try { p = runs.all([one]).then(function (rs) { return rs[0]; }); } catch (e) { p = Promise.reject(e); }
  return settle(key, p).then(function (r) {
    if (r && !r.ok) {
      var out = checkOutput(r);
      if (out) { r.checkOutput = out; r.checkBody = checkBody(r); }
    }
    return r;
  });
}
function tailText(s, n) { s = String(s || "").trim(); return s.length > n ? "...\n" + s.slice(-n) : s; }
function checkOutput(r) {
  var failed = [];
  (r.results || []).forEach(function (x) {
    ((x && x.acceptance && x.acceptance.verifyRuns) || []).forEach(function (v) { if (v && v.status !== "passed") failed.push(v); });
  });
  return failed.map(function (v) {
    return "Check " + (v.id || "?") + " (" + clip(v.command, 300) + "): " + (v.status || "failed") + (v.exitCode !== undefined && v.exitCode !== null ? ", exit " + v.exitCode : "") +
      "\n" + tailText([v.stdout, v.stderr].filter(Boolean).join("\n"), 3000);
  }).join("\n\n");
}
// Only what the failed checks printed: what a failure is recognised by (the command line differs per lane).
function checkBody(r) {
  var out = [];
  (r.results || []).forEach(function (x) {
    ((x && x.acceptance && x.acceptance.verifyRuns) || []).forEach(function (v) { if (v && v.status !== "passed") out.push([v.stdout, v.stderr].filter(Boolean).join("\n")); });
  });
  return out.join("\n");
}
// What a failed child left to go by: its checks' output when there is one, else its error and report.
function failText(w) { return w ? [w.checkOutput, w.error, w.checkOutput ? "" : w.output].filter(Boolean).join("\n") : ""; }

// Each lane checks only the test files it owns when the gate is a test runner that takes file arguments
// (pytest, unittest, jest, vitest, playwright test). The full gate still runs once on the combined code.
// Compound commands, globs, npm scripts and unittest discover are left as written.
function narrowGate(gate, files) {
  if (!PLAN.laneTests) return gate;
  // A monorepo gate such as "cd app && pytest -q": narrow the part after cd to the lane's files inside app/.
  var cd = /^cd\s+([\w.@+-]+(?:\/[\w.@+-]+)*)\/?\s*&&\s*/.exec(gate);
  if (cd) {
    var rest = gate.slice(cd[0].length), prefix = cd[1] + "/";
    var inner = (files || []).filter(function (f) { return f.indexOf(prefix) === 0; }).map(function (f) { return f.slice(prefix.length); });
    var narrowed = narrowGate(rest, inner);
    return narrowed === rest ? gate : cd[0] + narrowed;
  }
  if (/[;&|<>\`$\n]/.test(gate) || /\bdiscover\b/.test(gate)) return gate;
  var runner = /(^|\s)(pytest|py\.test)(\s|$)|-m\s+(pytest|unittest)(\s|$)|(^|\s)(npx\s+)?(jest|vitest|playwright\s+test)(\s|$)/;
  if (!runner.test(gate)) return gate;
  // A gate that already names paths (pytest tests/unit) chose what to run: adding files could run tests it left out.
  var words = gate.replace(/playwright\s+test/, "playwright").split(/\s+/).filter(function (w) { return w && w.charAt(0) !== "-"; });
  if (words.some(function (w) { return /[\/\\]/.test(w) || /\.(py|[cm]?[jt]sx?)$/.test(w) || /^(tests?|specs?|__tests__|e2e|testing)$/.test(w); })) return gate;
  var tests = (files || []).filter(function (f) {
    // a name starting with "-" would be read as an option (pytest -p loads a plugin): never passed
    return !/[*?[{]/.test(f) && !/^-/.test(f) && /(^|\/)(test_[^\/]*\.py|[^\/]*_test\.py|[^\/]*\.(test|spec)\.[cm]?[jt]sx?)$/.test(f);
  });
  if (!tests.length) return gate;
  // pi-subagents runs the gate through the system shell: sh on Linux/macOS, cmd.exe on Windows. No quoting is
  // safe in both, so names are passed only when they need none; one name that would, and the lane runs the full gate.
  if (!tests.every(function (f) { return /^[\w@+=:,.\/-]+$/.test(f); })) return gate;
  return gate + " " + tests.join(" ");
}
function laneGateBase(lane) {
  if (!GATE) return undefined;
  return lane.fullGate ? GATE.command : narrowGate(GATE.command, lane.files);
}
// The gate as the host runs it for this lane, with the lane's own ports and database suffix in its environment
// (pi-subagents' verify env: no quoting, and %VAR% / $VAR in the gate itself see them).
function laneGate(lane) {
  if (!GATE) return undefined;
  var e = laneEnv(lane);
  return e ? { command: laneGateBase(lane), timeoutMs: GATE.timeoutMs, env: e } : { command: laneGateBase(lane), timeoutMs: GATE.timeoutMs };
}
function gateCheck(g) {
  var c = { id: "gate", command: g.command, timeoutMs: g.timeoutMs };
  if (g.env) c.env = g.env;
  return c;
}
// Each lane's own resources, so lanes running at the same time never fight over one port or one test database.
// Keys and values are plain words (lane keys are [a-z0-9-], the rest digits), safe in sh and cmd.exe alike.
function laneEnv(lane) {
  if (!PLAN.laneEnv) return null;
  var i = lane.index || 0, base = PLAN.laneEnv.portBase + i * PLAN.laneEnv.portSpan;
  var e = { PTK_RUN: String(PLAN.laneEnv.run), PTK_LANE: lane.key, PTK_LANE_INDEX: String(i), PTK_PORT_BASE: String(base), PTK_PORT_SPAN: String(PLAN.laneEnv.portSpan), PTK_DB_SUFFIX: "_" + lane.key.replace(/[^a-z0-9]+/g, "_") };
  // plain words only: they also travel in the worker's task text and its environment
  Object.keys(e).forEach(function (k) { if (!/^[\w.-]+$/.test(e[k])) delete e[k]; });
  return e;
}
function laneResources(lane) {
  var e = laneEnv(lane);
  if (!e) return "";
  var last = Number(e.PTK_PORT_BASE) + Number(e.PTK_PORT_SPAN) - 1;
  return "\nThis lane's own resources (other lanes run at the same time): ports " + e.PTK_PORT_BASE + "-" + last + " (PTK_PORT_BASE, PTK_PORT_SPAN), database or schema suffix " + e.PTK_DB_SUFFIX +
    " (PTK_DB_SUFFIX), lane name PTK_LANE=" + e.PTK_LANE + ". They are set in your environment and in the gate's. Anything you start or create for testing (a server, a database, a temp folder) uses them, so lanes never collide; " +
    "where the code picks a port or a database name, read these variables (with the old value as the default) instead of hard-coding another one.\n" +
    "[ptk-lane-env] " + Object.keys(e).map(function (k) { return k + "=" + e[k]; }).join(" ") + "\n";
}
// A lane that deletes or renames one of its test files cannot pass a gate naming that file: when the lane's
// own gate fails because a named file or module is missing, later rounds run the full gate instead.
function missingNamedFile(lane, text) {
  var narrowed = laneGateBase(lane);
  if (!narrowed || narrowed === GATE.command) return false;
  text = String(text || "");
  // Coverage thresholds and "no tests found" only trip because fewer tests ran: the full gate is the fair check.
  if (/coverage[^\n]*(not reached|not met|fail)|fail[-_ ]?under|required test coverage|no tests? (were )?(ran|found|collected)|no test files found|no test suite found/i.test(text)) return true;
  if (!/no such file|not found|cannot find|could not find|does not exist|no module named|failed to import|ENOENT/i.test(text)) return false;
  return (lane.files || []).some(function (f) {
    var base = String(f).split("/").pop();
    return base && (text.indexOf(base) >= 0 || text.indexOf(base.replace(/\.[^.]+$/, "")) >= 0);
  });
}
// Shown to the worker without the lane's variables: they are in its environment already.
function gateText(lane) { var g = laneGateBase(lane); return g ? JSON.stringify(g) : ""; }
// What the verifier checks, given to the worker up front so the first round can already pass.
var CHECKLIST = "it does what the tasks ask; no obvious bug or missing edge case; tests changed when behaviour changed; " +
  "no file changed outside the owned list";
function withModel(item, role) { var m = PLAN.models && PLAN.models[role]; if (m) item.model = m; return bounded(item); }
// Each child gets the configured deadline (pi-subagents would stop it after 30 minutes otherwise), and shortly
// before it a request to finish the current step and hand off (changed files, test state, what is left) instead
// of being killed mid-work.
function bounded(item) {
  if (PLAN.childTimeoutMs) item.timeoutMs = PLAN.childTimeoutMs;
  if (PLAN.checkpointMs && (!PLAN.childTimeoutMs || PLAN.checkpointMs < PLAN.childTimeoutMs)) item.checkpointBeforeDeadlineMs = PLAN.checkpointMs;
  return item;
}

// Lane planning, same rules as planLanes() in lib/team.ts (tests check they agree).
function norm(p) { return String(p || "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, ""); }
function litPrefix(p) { var i = p.search(/[*?[{]/); return i < 0 ? p : p.slice(0, i); }
function overlap(a, b) {
  a = norm(a); b = norm(b);
  var pa = litPrefix(a), pb = litPrefix(b);
  if (!pa || !pb) return true;
  if (pa === a && pb === b) return pa === pb || pa.indexOf(pb + "/") === 0 || pb.indexOf(pa + "/") === 0;
  return pa.indexOf(pb) === 0 || pb.indexOf(pa) === 0;
}
function lanesFor(tasks) {
  var together = !PLAN.integration; // without the merge queue a task and what it depends on share a lane
  var parent = tasks.map(function (_, i) { return i; });
  function find(i) { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; }
  function dep(a, b) { return (a.dependsOn || []).indexOf(b.key) >= 0; }
  for (var i = 0; i < tasks.length; i++) for (var j = i + 1; j < tasks.length; j++)
    if (tasks[i].files.some(function (a) { return tasks[j].files.some(function (b) { return overlap(a, b); }); }) || (together && (dep(tasks[i], tasks[j]) || dep(tasks[j], tasks[i])))) parent[find(j)] = find(i);
  var groups = [], index = {};
  tasks.forEach(function (t, i) { var r = find(i); if (!(r in index)) { index[r] = groups.length; groups.push([]); } groups[index[r]].push(t); });
  while (groups.length > Math.max(1, PLAN.maxLanes || Infinity)) {
    var order = groups.map(function (g, i) { return i; }).sort(function (a, b) { return groups[a].length - groups[b].length || a - b; });
    var pair = order.slice(0, 2).sort(function (x, y) { return x - y; });
    groups[pair[0]] = groups[pair[0]].concat(groups[pair[1]]);
    groups.splice(pair[1], 1);
  }
  groups = mergeCycles(groups);
  function keyOf(g) { g = depOrder(g); return g.length === 1 ? g[0].key : g[0].key + "-plus" + (g.length - 1); }
  var laneOf = laneIndex(groups);
  return groups.map(function (g, gi) {
    var ordered = depOrder(g);
    var files = []; ordered.forEach(function (t) { t.files.forEach(function (f) { if (files.indexOf(f) < 0) files.push(f); }); });
    var lane = { key: keyOf(g), tasks: ordered, files: files };
    var after = laneEdges(g, gi, laneOf).map(function (j) { return keyOf(groups[j]); });
    if (after.length) lane.after = after;
    return lane;
  });
}
function laneIndex(groups) { var m = {}; groups.forEach(function (g, i) { g.forEach(function (t) { m[t.key] = i; }); }); return m; }
function laneEdges(g, gi, laneOf) {
  var out = [];
  g.forEach(function (t) { (t.dependsOn || []).forEach(function (d) { var j = laneOf[d]; if (j !== undefined && j !== gi && out.indexOf(j) < 0) out.push(j); }); });
  return out;
}
// Same as mergeLaneCycles() in lib/team.ts: lanes that would wait on each other in a circle become one.
function mergeCycles(groups) {
  for (;;) {
    var laneOf = laneIndex(groups);
    var edges = groups.map(function (g, i) { return laneEdges(g, i, laneOf); });
    var state = groups.map(function () { return 0; }), cycle = null;
    function walk(i, path) {
      if (cycle || state[i] === 2) return;
      if (state[i] === 1) { cycle = path.slice(path.indexOf(i)); return; }
      state[i] = 1;
      edges[i].forEach(function (j) { walk(j, path.concat([i])); });
      state[i] = 2;
    }
    groups.forEach(function (_, i) { walk(i, []); });
    if (!cycle) return groups;
    var keep = Math.min.apply(null, cycle);
    var merged = [];
    groups.forEach(function (g, i) { if (cycle.indexOf(i) >= 0) merged = merged.concat(g); });
    groups = groups.map(function (g, i) { return i === keep ? merged : g; }).filter(function (_, i) { return i === keep || cycle.indexOf(i) < 0; });
  }
}
// Dependencies first, otherwise the planner's order; a cycle keeps the planner's order.
function depOrder(group) {
  var out = [], left = group.slice();
  while (left.length) {
    var i = left.findIndex(function (t) {
      return (t.dependsOn || []).every(function (d) { return out.some(function (x) { return x.key === d; }) || !left.some(function (x) { return x.key === d; }); });
    });
    out.push(left.splice(i < 0 ? 0 : i, 1)[0]);
  }
  return out;
}
function rawKey(k) { return String(k || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28); }
function cleanTasks(raw) {
  var seen = {}, renamed = {};
  var tasks = (raw || []).map(function (t, i) {
    var key = rawKey(t.key) || "task-" + (i + 1);
    while (seen[key]) key = key + "-" + (i + 1);
    seen[key] = true;
    if (rawKey(t.key) && !(rawKey(t.key) in renamed)) renamed[rawKey(t.key)] = key;
    var files = (Array.isArray(t.files) ? t.files : []).map(norm).filter(function (f) { return f && f.charAt(0) !== "/" && f.split("/").indexOf("..") < 0; });
    // No ownership given: assume it may touch anything, so it shares a lane with everything.
    var task = { key: key, title: String(t.title || key).slice(0, 120), brief: String(t.brief || t.title || ""), files: files.length ? files : ["**"] };
    if (t.verify && String(t.verify.cmd || "").trim()) task.verify = { cmd: String(t.verify.cmd).trim().slice(0, 500), expect: String(t.verify.expect || "").trim().slice(0, 300) };
    var cases = strings(t.caseIds, 50), uses = strings(t.uses, 20);
    if (cases.length) task.caseIds = cases;
    if (uses.length) task.uses = uses;
    return { task: task, deps: Array.isArray(t.dependsOn) ? t.dependsOn : [] };
  });
  return tasks.map(function (x) {
    var deps = x.deps.map(function (d) { return renamed[rawKey(d)]; }).filter(function (d, i, all) { return d && d !== x.task.key && all.indexOf(d) === i; });
    if (deps.length) x.task.dependsOn = deps;
    return x.task;
  });
}
function strings(v, max) { return (Array.isArray(v) ? v : []).map(function (s) { return String(s).trim(); }).filter(Boolean).slice(0, max); }
// taskProblems() in lib/team.ts without the file system (the workflow has none): a check per task, a brief that
// says where, no placeholders.
var VAGUE = ${VAGUE_BRIEF.toString()};
function planProblems(tasks) {
  var out = [];
  tasks.forEach(function (t) {
    if (!t.verify) out.push(t.key + ": no verify. Give the focused command that proves this task alone and what it prints when done.");
    var names = [];
    t.files.forEach(function (f) { var lit = litPrefix(f).replace(/\/+$/, ""); [f, lit, f.split("/").pop(), lit.split("/").pop()].forEach(function (n) { if (n && n.length >= 3 && !/[*?[{]/.test(n)) names.push(n); }); });
    var brief = t.brief.toLowerCase();
    if (names.length && !names.some(function (n) { return brief.indexOf(n.toLowerCase()) >= 0; }))
      out.push(t.key + ": the brief does not say where the change goes. Name the file (and the function or section) from its files: " + t.files.slice(0, 3).join(", ") + ".");
    var v = VAGUE.exec(t.brief);
    if (v) out.push(t.key + ': "' + v[0] + '" leaves the worker guessing. Say exactly what to do, or leave it out.');
  });
  return out;
}

function planTask() {
  return "Split this goal into tasks for a team run. Goal: " + PLAN.goal + "\n\n" +
    "At most " + PLAN.maxTasks + " tasks; up to " + (PLAN.maxLanes || 4) + " run in parallel, each in its own git worktree. " +
    (PLAN.gate ? "Every task's result must pass " + JSON.stringify(PLAN.gate) + ". " : "") +
    "Give each task a verify command that proves it alone (one test file or test id) and what it prints when done. " +
    "Return tasks, constraints (rules every task follows; empty if none), questions (only blocking ones; empty when you can proceed) and notes.";
}

function workTask(lane) {
  return "You are one worker in a team run. Overall goal: " + PLAN.goal + "\n\n" +
    "Your tasks" + (lane.tasks.some(function (t) { return t.dependsOn && t.dependsOn.length; }) ? " (in this order: later ones build on earlier ones)" : "") + ":\n" + taskList(lane) + rules() + "\n\n" +
    "Files you own (edit only these; new files only inside them):\n" + owned(lane) + "\n" + laneResources(lane) + "\n" +
    (PLAN.knownFailure ? "The gate already fails on the unchanged code, before any change (this run is meant to fix that):\n" + clip(PLAN.knownFailure, 1500) + "\nIf your task is not about these failures, leave them alone: they are not caused by you.\n\n" : "") +
    (PLAN.broadcast && lanes.length > 1 ? "If you find something the other lanes need right now (an environment fact such as a port that is taken, or an interface they call that you changed), tell them once with tell_lanes. Only for that, at most once.\n" : "") +
    "Rules: other workers are editing other files in parallel. If you must touch a file you do not own, or the brief is ambiguous, " +
    "call contact_supervisor with reason need_decision and wait for the answer. Do not commit, push, or switch branches. " +
    "Keep the change minimal and match the existing style.\n" +
    "Checks: while you work, run each task's own Done-when command" + (GATE ? "; run " + gateText(lane) + " once before you finish, it must pass" : "") + ".\n" +
    "When a check fails: read the whole failure, write down the cause you believe and the evidence for it, then change one thing and run again. " +
    "Never re-run without a change and never retry a fix that already failed. A test that passes alone but fails with the others is leaking state: " +
    "give it its own data and clean up in teardown; never add sleeps or retries. If you cannot get past a failure after three real attempts, stop and " +
    "report BLOCKED with what you tried and the likely cause; the lead takes it to a person.\n" +
    "A failure from the environment (a port taken, a service down, a tool or package missing, no network, a missing setting) is not yours to work around: " +
    "check it once, then call contact_supervisor with the exact error, or report BLOCKED with it. Never change code, tests or config to get around it.\n" +
    "Before you report, check your change the way the verifier will: " + CHECKLIST + ".\n" +
    "Finish with exactly these parts:\nStatus: DONE, DONE_WITH_CONCERNS or BLOCKED\nChanged files: ...\n" +
    "Discoveries: what the lead should know beyond your task, one line each: a root cause you found, an environment fact (a port, a service, a command that works here and one that does not), a workaround, an interface choice other code will rely on; \"none\" if nothing\n" +
    "Evidence: for each task, the command you ran and the last lines of its output (read by the verifier only)\nConcerns: open risks; for BLOCKED, what you tried and the likely cause";
}

function verifyTask(lane, writer, round) {
  var claims = "\n\nWorker's report (claims, not proof):\n" + clip(writer.output, 3000);
  var worktree = "Read " + lane.origin + "/handoff.json and take groups[].cleanup.tasks[].path: that is the worker's worktree. ";
  // A re-review checks the fixes it asked for, not the whole lane again: full reviews every round are what keeps rework going.
  if (round > 1 && lane.lastFindings && lane.lastFindings.length)
    return "Re-check one lane of a team run (round " + round + "). The previous review asked for these fixes:\n" + numbered(lane.lastFindings) + "\n\n" +
      worktree + "For each fix, read the file there and decide whether it is done (tried is not done). " +
      "Review nothing else again; a new problem counts only if a fix introduced it and it is important.\n" +
      "Verdict: pass = every fix is done. rework = list only what is still not done, in the same words. blocked = needs a human decision." + claims;
  var where = round === 1
    ? "The complete change is a patch. Read " + lane.origin + "/handoff.json, take groups[].children[].patch.path, and read that file. " +
      "Read surrounding code only when the patch is not enough.\n"
    : "This is a rework round. " + worktree +
      "Read the owned files there (their current state includes every round) and compare them with the same files in " +
      (lane.baseRef && INT ? "the integration worktree " + INT.dir + ", which holds the version it started from. " : "the main checkout, which still holds the original version. ") +
      "The patch file in handoff.json shows round 1 only.\n";
  return "Verify one lane of a team run (round " + round + "). Overall goal: " + PLAN.goal + "\n\n" +
    "The lane's tasks:\n" + taskList(lane) + rules() + "\n\nFiles the lane owns:\n" + owned(lane) + "\n\n" + where +
    "Check in this order: 1. does it do each task (each case when listed): anything missing, extra or misunderstood? " +
    "2. then: " + CHECKLIST + ". For test code also: no sleeps, assertions that can fail, no dependence on test order or on data other tests leave, " +
    "no shared or hard-coded test data, not only checking mocks.\n" +
    "Read the change, not the whole codebase. The worker's Evidence must match the change (the right tests, the expected output). " +
    "Cite path:line for each finding and mark it important (the task cannot be trusted until fixed) or minor (worth noting, not worth a round).\n" +
    "Verdict: pass = every task done and no important finding. rework = at least one important finding. blocked = only when the task itself is wrong or needs a human decision." + claims;
}

function fixTask(lane, review, round, same) {
  return "Round " + round + " review asked for these fixes:\n" + (numbered(review.findings) || clip(review.summary, 2000)) + "\n\n" +
    (same ? "The review asked for the same fixes last round: the last change did not reach the cause. Find it first, with evidence; if it cannot be fixed inside your files, report BLOCKED with what you tried.\n" : "") +
    "Fix exactly these, stay inside your files" + (GATE ? ", re-run " + gateText(lane) : "") + ". Report again in the same parts; under Evidence, for each fix: what changed and the command that shows it.";
}

function gateFixTask(lane, writer, same, env) {
  return "Your run did not pass its checks" + (GATE ? " (gate " + gateText(lane) + ")" : "") + ". Details:\n" + clip(failText(writer), 3500) + "\n" +
    (env ? "This looks like an environment problem (" + env.kind + ": " + JSON.stringify(env.line) + "): " + env.check + ". Do not change code to get around it: " +
      "check it once; if it is the environment, report BLOCKED with the exact error (the lead fixes the environment). If it really is your code, fix that.\n" : "") +
    (same
      ? "This is the same failure as last round: the last change did not reach the cause, so do not try it again. Read the failure and the code path, " +
        "write down the cause and the evidence, then fix that. If it cannot be avoided inside your files, report BLOCKED with what you tried; the lead takes it to a person."
      : "Find the cause before changing anything, fix it inside your files, run the check again and report.");
}

function finish(lane, writer, review, rounds, state) {
  if (state === "passed") leaveCause(lane);
  return {
    lane: lane.key,
    tasks: lane.tasks.map(function (t) { return t.key; }),
    // what the lane was allowed to change: a lane that did not pass is checked against it
    files: lane.files,
    state: state,
    rounds: rounds,
    runId: (writer && writer.runId) || null,
    // The first writer run owns the worktree and handoff.json; resumed rounds work in that same worktree.
    runDir: lane.origin || null,
    error: (writer && (writer.checkOutput ? clip(writer.checkOutput, 1500) : writer.error)) || null,
    summary: clip((review && review.summary) || forLead(writer && writer.output), 800),
    findings: (review && review.findings) || [],
    // Why earlier rounds were sent back: the lessons a playbook is made of (/harvest reads them).
    history: lane.history || [],
    discoveries: lane.discoveries || [],
    envProblem: lane.envProblem || null,
    sameCause: lane.sameCause || null,
    report: clip(forLead(writer && writer.output), 1200)
  };
}

// The same failure in two lanes is one problem: the lead fixes it once. Further rounds for it stop, and while an
// environment problem has stopped two lanes, lanes that have not started yet are not started.
var CAUSES = {};
// Only a certain environment problem, or a failure with its check's output, can be a shared cause: a timeout or a
// provider error without output says nothing about the code. A lane that recovers leaves its cause (leaveCause).
function noteCause(lane, writer, env) {
  var useEnv = env && env.certain;
  if (!useEnv && !writer.checkBody) return null;
  var key = useEnv ? "env:" + env.kind + ":" + String(env.line).replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").trim() : "sig:" + failSig(writer.checkBody);
  leaveCause(lane);
  var c = CAUSES[key] || (CAUSES[key] = { env: Boolean(useEnv), text: useEnv ? env.kind + ": " + env.line : clip(writer.checkBody, 300), lanes: [] });
  if (c.lanes.indexOf(lane.key) < 0) c.lanes.push(lane.key);
  lane.cause = key;
  return c;
}
function leaveCause(lane) {
  if (!lane.cause || !CAUSES[lane.cause]) return;
  CAUSES[lane.cause].lanes = CAUSES[lane.cause].lanes.filter(function (k) { return k !== lane.key; });
  lane.cause = null;
}
function envBlock() {
  for (var k in CAUSES) if (CAUSES[k].env && CAUSES[k].lanes.length >= 2) return CAUSES[k];
  return null;
}

function noteRound(lane, entry) {
  lane.history = (lane.history || []).concat([entry]).slice(-6);
}

function resumeItem(lane, writer, label, task) {
  return bounded({ resume: writer.runId, label: label, task: task, acceptance: resumeAcceptance(lane) });
}

function afterWrite(lane, writer, round) {
  noteDiscoveries(lane, writer);
  // The worker found it cannot get past something inside its files: the lead decides (with a person), no review round.
  if (blockedReport(writer)) {
    var benv = envFailure(writer.output);
    if (benv) lane.envProblem = benv;
    noteRound(lane, { round: round, blocked: clip(forLead(writer.output), 300) });
    return finish(lane, writer, { summary: "Worker blocked: " + clip(forLead(writer.output), 700), findings: [] }, round, "needs-human");
  }
  if (writer.ok) return review(lane, writer, round);
  var sig = failSig(writer.checkBody || writer.error || writer.output);
  var same = lane.lastGateSig === sig;
  lane.lastGateSig = sig;
  var entry = { round: round, gate: clip(writer.checkOutput || writer.error || writer.output, 300) };
  if (same) entry.same = true;
  var env = envFailure(failText(writer));
  if (env) entry.env = env.kind;
  noteRound(lane, entry);
  if (missingNamedFile(lane, failText(writer) + "\n" + (writer.output || ""))) lane.fullGate = true;
  var cause = noteCause(lane, writer, env);
  var others = cause ? cause.lanes.filter(function (k) { return k !== lane.key; }) : [];
  if (others.length) {
    lane.sameCause = others;
    if (env) lane.envProblem = env;
    return finish(lane, writer, { summary: "Stopped: the same failure as lane " + others.join(", ") + " (" + cause.text + "). It is one problem for the lead to fix once; no more rounds for it here.", findings: [] }, round, "needs-human");
  }
  // The same certain environment problem twice: no change inside the lane's files fixes it, so the lead gets it now.
  if (env && env.certain && same) {
    lane.envProblem = env;
    return finish(lane, writer, { summary: "Stopped: the same environment problem twice (" + env.kind + ": " + env.line + "). " + env.check + ".", findings: [] }, round, "needs-human");
  }
  if (round >= PLAN.maxRounds || !writer.runId) { if (env) lane.envProblem = env; return finish(lane, writer, null, round, "failed"); }
  var key = lane.key + "-gatefix-" + round;
  return runChild(key, (resumeItem(lane, writer, "Fix checks: " + lane.key, gateFixTask(lane, writer, same, env))))
    .then(function (next) { if (!next.runId) next.runId = writer.runId; return afterWrite(lane, next, round + 1); });
}

function review(lane, writer, round) {
  var key = lane.key + "-verify-" + round;
  return runChild(key, (withModel({ agent: PLAN.verifierAgent, label: "Verify " + lane.key + " #" + round, task: verifyTask(lane, writer, round), outputSchema: VERDICT_SCHEMA }, "verifier")))
    .then(function (v) {
      if (!v.ok && !v.structuredOutput) return finish(lane, writer, { summary: "Verifier failed: " + v.error, findings: [] }, round, "needs-human");
      var out = v.structuredOutput || {};
      var verdict = out.verdict || "rework";
      // Only important findings are sent back; minor ones go to the lead with the result.
      var important = (out.findings || []).filter(function (f) { return f.severity !== "minor"; });
      if (verdict === "rework" && !important.length && (out.findings || []).length) verdict = "pass";
      if (verdict === "pass") return finish(lane, writer, out, round, "passed");
      if (verdict === "blocked") return finish(lane, writer, out, round, "needs-human");
      var sig = findingsSig(important);
      var same = lane.lastFindingsSig === sig;
      lane.lastFindingsSig = sig;
      lane.lastFindings = important;
      var entry = { round: round, findings: important.slice(0, 5).map(function (f) { return { file: f.file, issue: clip(f.issue, 200), fix: clip(f.fix, 200) }; }) };
      if (same) entry.same = true;
      noteRound(lane, entry);
      if (round >= PLAN.maxRounds || !writer.runId) return finish(lane, writer, out, round, "needs-human");
      var fixKey = lane.key + "-fix-" + round;
      return runChild(fixKey, (resumeItem(lane, writer, "Rework " + lane.key + " #" + round, fixTask(lane, { findings: important, summary: out.summary }, round, same))))
        .then(function (next) { if (!next.runId) next.runId = writer.runId; return afterWrite(lane, next, round + 1); });
    });
}

function startLane(lane) {
  var item = withModel({ agent: PLAN.workerAgent, label: "Implement " + lane.key, task: workTask(lane), worktree: true }, "worker");
  if (lane.baseRef) item.baseRef = lane.baseRef;
  var gate = laneGate(lane);
  // the explicit form of the gate shorthand (verified, one check), which also takes the lane's env
  if (gate) item.acceptance = { level: "verified", verify: [gateCheck(gate)] };
  var key = lane.key + "-work";
  return runChild(key, item).then(function (w) {
    lane.origin = runDir(w);
    return afterWrite(lane, w, 1);
  });
}

// The full gate once on the unchanged code, at the same time as planning: when it already fails there, every lane
// would hit the same failure (or "fix" it in its own way), so no worker starts and the lead gets the output.
var INT = PLAN.integration || null;
function baselineCheck() {
  var dir = PLAN.baselineDir || (INT && INT.dir);
  if (!PLAN.baseline || !GATE || !dir) return Promise.resolve(null);
  var item = withModel({ agent: PLAN.mergerAgent || "team-merger", label: "Baseline: gate on the unchanged code", task: "Baseline check before the team run: do nothing, answer with the acceptance report.",
    acceptance: { level: "verified", criteria: [], evidence: ["manual-notes"], verify: [{ id: "baseline", command: GATE.command, timeoutMs: GATE.timeoutMs }] } }, "worker");
  item.cwd = dir;
  return runChild("baseline", item).then(function (b) { return b.ok ? null : { error: clip(failText(b), 3000) }; });
}
var baselineRun = baselineCheck();
var lanes = PLAN.lanes;
var planned = null;
if (!lanes.length) {
  var p = await runChild("plan", (withModel({ agent: PLAN.plannerAgent, label: "Plan the team run", task: planTask(), outputSchema: PLAN_SCHEMA }, "planner")));
  var out = p.structuredOutput || {};
  var tasks = cleanTasks(out.tasks);
  PLAN.constraints = (PLAN.constraints || []).concat(strings(out.constraints, 10));
  if (!tasks.length) {
    return { goal: PLAN.goal, state: "needs-input", questions: out.questions || [], notes: out.notes || p.error || "planner returned no tasks", lanes: [] };
  }
  if (tasks.length > PLAN.maxTasks) {
    // Never cut silently: hand the plan back so the lead can merge tasks or split the goal into two runs.
    return { goal: PLAN.goal, state: "needs-input", questions: ["The planner proposed " + tasks.length + " tasks; the limit is " + PLAN.maxTasks + ". Merge small tasks, or split the goal into two runs, then call team_run with tasks."], notes: out.notes || "", plan: { tasks: tasks.map(function (t) { return { key: t.key, title: t.title, files: t.files }; }) }, lanes: [] };
  }
  // The same checks team_run makes on the lead's tasks: one round to fix them, then the plan goes ahead as it is.
  var issues = tasks.length ? planProblems(tasks) : [];
  if (issues.length) {
    var p2 = await runChild("plan-fix", (withModel({ agent: PLAN.plannerAgent, label: "Fix the plan", task: planTask() +
      "\n\nYour previous plan:\n" + clip(JSON.stringify(out), 12000) + "\n\nFix these problems and return the whole plan again:\n- " + issues.join("\n- "), outputSchema: PLAN_SCHEMA }, "planner")));
    var fixed = p2.structuredOutput && cleanTasks(p2.structuredOutput.tasks);
    if (fixed && fixed.length && fixed.length <= PLAN.maxTasks) { out = p2.structuredOutput; tasks = fixed; issues = planProblems(tasks); strings(out.constraints, 10).forEach(function (c) { if (PLAN.constraints.indexOf(c) < 0) PLAN.constraints.push(c); }); }
  }
  lanes = lanesFor(tasks);
  planned = { tasks: tasks.map(function (t) { return { key: t.key, title: t.title, files: t.files }; }), questions: out.questions || [], notes: out.notes || "" };
  if (issues.length) planned.unfixed = issues;
}

var baseline = await baselineRun;
var benv = baseline ? envFailure(baseline.error) : null;
// The lead may say the run is there to fix what the gate already fails on; an environment problem is never that.
if (baseline && PLAN.baseline === "env" && !(benv && benv.certain)) { PLAN.knownFailure = baseline.error; baseline = null; }
if (baseline) {
  return {
    goal: PLAN.goal, gate: PLAN.gate || null, state: "baseline-failed", plan: planned, lanes: [],
    baseline: { error: baseline.error, envProblem: benv },
    integration: INT ? { branch: INT.branch, dir: INT.dir, merged: [], runDirs: [] } : null,
    next: "The gate " + JSON.stringify(PLAN.gate) + " already fails on the unchanged code (HEAD), before any change, so no worker was started: every lane would hit the same failure. " +
      (benv ? "It looks like an environment problem (" + benv.kind + "): " + benv.check + ". Fix the environment (or tell the user what is missing), then run again; baseline: false does not cover an environment problem. " : "Fix that first (or ask the user), then run again. If the goal is to fix exactly these failures, run again with baseline: false.")
  };
}

// A lane starts when the lanes it needs are merged (from the integration branch, so it sees their change); a lane
// that passes is merged at once, one at a time, with the full gate run on the combined code before the commit.
var byKey = {}, outcome = {}, mergeOrder = [], mergeTail = Promise.resolve();
lanes.forEach(function (l, i) { byKey[l.key] = l; l.index = i; });
function laneOutcome(key) {
  if (!outcome[key]) {
    var lane = byKey[key];
    outcome[key] = Promise.all((lane.after || []).filter(function (k) { return byKey[k]; }).map(laneOutcome)).then(function (deps) {
      var missing = deps.filter(function (d) { return !d.merged; }).map(function (d) { return d.lane; });
      if (missing.length) return skipped(lane, missing);
      var blocked = envBlock();
      if (blocked) {
        var r = finish(lane, null, { summary: "Not started: the environment problem " + blocked.text + " already stopped lanes " + blocked.lanes.join(", ") + ". Fix it, then run this lane again.", findings: [] }, 0, "skipped");
        r.blockedBy = blocked.text;
        return r;
      }
      if (INT && deps.length) lane.baseRef = "refs/heads/" + INT.branch;
      return startLane(lane).then(function (r) { return INT && r.state === "passed" ? queueMerge(lane, r) : r; });
    });
  }
  return outcome[key];
}
function skipped(lane, missing) {
  var r = finish(lane, null, { summary: "Not started: it needs " + missing.join(", ") + ", which did not pass or could not be merged.", findings: [] }, 0, "skipped");
  r.waitedFor = missing;
  return r;
}
function q(s) { return '"' + s + '"'; }
function queueMerge(lane, r) {
  var p = mergeTail.then(function () { return mergeLane(lane, r); });
  mergeTail = p.then(function () {}, function () {});
  return p;
}
function mergeLane(lane, r) {
  // Only paths pi-subagents and the extension wrote reach the command, and only when no shell could read them as code.
  if (!r.runDir || /["%!\r\n$\`]/.test(r.runDir + INT.script + INT.dir)) { r.merged = false; r.mergeError = "no usable run folder to merge from"; return r; }
  var gate = !GATE ? "" : /\|\||;/.test(GATE.command) ? "(" + GATE.command + ")" : GATE.command;
  var command = "node " + q(INT.script) + " " + q(r.runDir + "/handoff.json") + " " + lane.key + (gate ? " && " + gate : "") +
    " && git -c user.name=pi-team-kit -c user.email=pi-team-kit@localhost commit -q --no-verify --allow-empty -m " + q("ptk: " + lane.key);
  var key = lane.key + "-merge";
  // The merge, the full gate and the commit are one host-run check of this child; it only answers with its report.
  var item = withModel({ agent: PLAN.mergerAgent || "team-merger", label: "Merge " + lane.key, task: "Merge step for lane " + lane.key + ": do nothing, answer with the acceptance report.", cwd: INT.dir,
    acceptance: { level: "verified", criteria: [], evidence: ["manual-notes"], verify: [{ id: "merge", command: command, timeoutMs: (GATE ? GATE.timeoutMs : 0) + 300000 }] } }, "worker");
  return runChild(key, item).then(function (m) {
    r.merged = Boolean(m.ok);
    if (m.ok) mergeOrder.push(lane.key);
    else r.mergeError = clip(failText(m), 1500);
    return r;
  });
}

const results = await Promise.all(lanes.map(function (l) { return laneOutcome(l.key); }));
var DISCOVERY_NEXT = results.some(function (r) { return r.discoveries && r.discoveries.length; })
  ? " Lanes list discoveries (what workers found beyond their task): check each against the code, save the lasting ones (environment facts, pitfalls) with remember, and act on root causes that touch other work."
  : "";
var mergedDirs = mergeOrder.map(function (k) { return results.filter(function (r) { return r.lane === k; })[0].runDir; });
return {
  goal: PLAN.goal,
  gate: PLAN.gate || null,
  plan: planned,
  lanes: results,
  integration: INT ? { branch: INT.branch, dir: INT.dir, merged: mergeOrder, runDirs: mergedDirs } : null,
  causes: Object.keys(CAUSES).filter(function (k) { return CAUSES[k].lanes.length >= 2; }).map(function (k) { return { cause: CAUSES[k].text, env: CAUSES[k].env, lanes: CAUSES[k].lanes }; }),
  next: INT
    ? "Passed lanes were merged one at a time into branch " + INT.branch + " (worktree " + INT.dir + "), with the full gate run on the combined code before each commit. " +
      "Call team_integrate with runDirs = integration.runDirs, in that order. Lanes not merged (mergeError, skipped, needs-human, failed) need your decision." + DISCOVERY_NEXT
    : "Call team_integrate with runDirs = the runDir of each passed lane, in this order. Lanes marked needs-human or failed need your decision." + DISCOVERY_NEXT
};
`;

export interface PatchRef {
  runDir: string;
  path: string;
  branch?: string;
  diffStat?: string;
  changed: boolean;
}

/**
 * The worker's worktree and the commit it branched from. Rework rounds keep editing this worktree but
 * pi-subagents records a patch only for the first round, so integration diffs the worktree itself.
 */
export function worktreeFromHandoff(handoffJson: string): { path: string; baseCommit?: string } | undefined {
  const data = JSON.parse(handoffJson) as { groups?: { baseCommit?: string; cleanup?: { tasks?: { path?: string; worktreeRemoved?: boolean }[] } }[] };
  for (const g of data.groups ?? [])
    for (const t of g.cleanup?.tasks ?? []) if (t.path && !t.worktreeRemoved) return { path: t.path, baseCommit: g.baseCommit };
  return undefined;
}

/**
 * Comparable form of a filesystem path. `git worktree list` prints C:/a/b on Windows while pi-subagents
 * records C:\a\b, so raw string comparison never matches there. Windows drive and UNC paths are also
 * case-insensitive; POSIX paths keep their case.
 */
export function pathKey(p: string, windowsHost = process.platform === "win32"): string {
  // No trim(): spaces are legal in paths, and "x " must never match a reused "x".
  const raw = p.replace(/\r$/, "");
  let k = raw.replace(/\\/g, "/").replace(/(?<!^)\/{2,}/g, "/");
  if (k.length > 1) k = k.replace(/\/+$/, "");
  // Drive paths are Windows paths wherever they come from. A leading // is a UNC share only on Windows
  // (or when written with backslashes); on Linux/macOS //tmp/Repo and //tmp/repo are different.
  const windowsPath = /^[A-Za-z]:\//.test(k) || (k.startsWith("//") && (windowsHost || raw.startsWith("\\\\")));
  return windowsPath ? k.toLowerCase() : k;
}

/**
 * Gate for the combined code after integration: an explicit one, else the gate the team run itself used
 * (recorded when it started), else the configured or detected one. Without the middle step a custom
 * per-run gate would pass in every worker and never run on the combined result.
 */
export function integrationGate(opts: { skip?: boolean; explicit?: string; runGate?: string; configured?: string; detected?: string }): string {
  if (opts.skip) return "";
  for (const g of [opts.explicit, opts.runGate, opts.configured, opts.detected]) if (g?.trim()) return g.trim();
  return "";
}

export interface ListedWorktree {
  path: string;
  branch?: string;
}

/** Parse `git worktree list --porcelain` into worktrees keyed by pathKey. */
export function parseWorktreeList(porcelain: string, windowsHost = process.platform === "win32"): Map<string, ListedWorktree> {
  const out = new Map<string, ListedWorktree>();
  let current: ListedWorktree | undefined;
  for (const raw of porcelain.split("\n")) {
    const line = raw.replace(/\r$/, "");
    if (line.startsWith("worktree ")) {
      current = { path: line.slice(9) };
      out.set(pathKey(current.path, windowsHost), current);
    } else if (line.startsWith("branch refs/heads/") && current) current.branch = line.slice(18);
  }
  return out;
}

export interface CleanupPlan {
  remove: ListedWorktree[];
  skipped: { path: string; reason: string }[];
}

/**
 * Which recorded worker worktrees may be deleted. All of these must hold: git lists it for this repo; it is
 * not the main checkout; its folder is `pi-worktree-*`; and git says it is on exactly the `pi-subagents/`
 * branch the handoff recorded for it. A detached worktree, or one whose path was later reused for another
 * branch, is never deleted on a name match. Everything not deleted is reported, not silently ignored.
 */
export function planWorktreeCleanup(targets: { path: string; branch?: string }[], listed: Map<string, ListedWorktree>, repoRoot: string, windowsHost = process.platform === "win32"): CleanupPlan {
  const plan: CleanupPlan = { remove: [], skipped: [] };
  const seen = new Set<string>();
  const rootKey = pathKey(repoRoot, windowsHost);
  for (const t of targets) {
    const key = pathKey(t.path, windowsHost);
    if (seen.has(key)) continue;
    seen.add(key);
    const wt = listed.get(key);
    if (!wt) plan.skipped.push({ path: t.path, reason: "not registered with git (already removed?)" });
    else if (key === rootKey) plan.skipped.push({ path: t.path, reason: "is the main checkout" });
    else if (!/^pi-worktree-/i.test(key.split("/").pop() ?? "")) plan.skipped.push({ path: t.path, reason: "not a pi-subagents worktree" });
    else if (!t.branch || !t.branch.startsWith("pi-subagents/")) plan.skipped.push({ path: t.path, reason: "no pi-subagents branch recorded for it" });
    else if (wt.branch !== t.branch) plan.skipped.push({ path: t.path, reason: wt.branch ? `now on branch ${wt.branch}, not the recorded ${t.branch}` : "detached HEAD, not on the recorded branch" });
    else plan.remove.push(wt);
  }
  return plan;
}

/** Worktrees and branches a handoff kept for possible rework; safe to remove once its patch is integrated. */
export function cleanupTargets(handoffJson: string): { path: string; branch?: string }[] {
  const data = JSON.parse(handoffJson) as { groups?: { cleanup?: { tasks?: { path?: string; branch?: string; worktreeRemoved?: boolean }[] } }[] };
  const out: { path: string; branch?: string }[] = [];
  for (const g of data.groups ?? [])
    for (const t of g.cleanup?.tasks ?? []) if (t.path && !t.worktreeRemoved) out.push({ path: t.path, branch: t.branch });
  return out;
}

/** Patches recorded in a pi-subagents handoff.json (one per changed child). */
export function patchesFromHandoff(runDir: string, handoffJson: string): PatchRef[] {
  const data = JSON.parse(handoffJson) as { groups?: { children?: { patch?: { path?: string; branch?: string; diffStat?: string; changed?: boolean } }[] }[] };
  const out: PatchRef[] = [];
  for (const g of data.groups ?? [])
    for (const c of g.children ?? [])
      if (c.patch?.path) out.push({ runDir, path: c.patch.path, branch: c.patch.branch, diffStat: c.patch.diffStat, changed: c.patch.changed !== false });
  return out;
}

/**
 * The git repository a team run works in. Many people start pi in their home folder and point it at a project,
 * so the session folder is not always the repo: an explicit `repo` wins, then the session folder's repo, then
 * the repo the previous run in this session used. `find` is findRepoRoot (injected for tests).
 */
export function resolveTeamRepo(cwd: string, repo: string | undefined, previous: string | undefined, find: (p: string) => string | undefined, home: string, resolvePath: (...p: string[]) => string): string {
  const asked = repo?.trim();
  if (asked) {
    const abs = resolvePath(cwd, asked.replace(/^~(?=$|[\\/])/, home));
    const root = find(abs);
    if (!root)
      throw new Error(
        `${abs} is not inside a git repository, and workers need git worktrees. If the project is not under git yet, ask the user whether to make it one (git init, then commit the current files), then call again.`,
      );
    return root;
  }
  const root = find(cwd) ?? previous;
  if (!root)
    throw new Error(`This session runs in ${cwd}, which is not a git repository, and workers need git worktrees. Call again with repo = the path of the project's git repository (for example the folder you have been working in).`);
  return root;
}

export const THINKING_LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const;
type Role = "planner" | "worker" | "verifier";

/**
 * Model per role as pi-subagents takes it ("provider/id:level"). A thinking level rides on a model name, so a
 * role without its own model uses the lead's model, which is what that child would run anyway.
 */
export function roleModels(models: Partial<Record<Role, string>>, thinking: Partial<Record<Role, string>>, leadModel?: string): Partial<Record<Role, string>> {
  const out: Partial<Record<Role, string>> = {};
  for (const role of ["planner", "worker", "verifier"] as const) {
    let model = (models[role] ?? "").trim();
    const level = (thinking[role] ?? "").trim();
    if (level) {
      if (!(THINKING_LEVELS as readonly string[]).includes(level)) throw new Error(`team.thinking.${role} "${level}": use one of ${THINKING_LEVELS.join(", ")}`);
      const base = (model || leadModel || "").replace(new RegExp(`:(${THINKING_LEVELS.join("|")})$`), "");
      if (base) model = `${base}:${level}`;
    }
    if (model) out[role] = model;
  }
  return out;
}
