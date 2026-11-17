// Team run = the lead's task list turned into conflict-free lanes, executed by pi-subagents:
//   lane: worker in its own git worktree -> gate command (host-run) -> fresh verifier -> rework, at most N rounds
// Planning, lane building and script generation are plain functions so they are unit-tested;
// the workflow script itself only wires runs.run calls together.

export interface TeamTask {
  key: string;
  title: string;
  brief: string;
  /** Paths or globs this task owns. Two tasks that share any path end up in the same lane. */
  files: string[];
}

export interface Lane {
  key: string;
  tasks: TeamTask[];
  files: string[];
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
}

const KEY = /^[a-z0-9][a-z0-9-]{0,30}$/;

export function normalizePath(p: string): string {
  return p.trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** Validate the lead's tasks. Throws one message listing every problem, so the model can fix all at once. */
export function validateTasks(tasks: TeamTask[], maxTasks = 12): TeamTask[] {
  const problems: string[] = [];
  if (!Array.isArray(tasks) || tasks.length === 0) throw new Error("tasks: give at least one task");
  if (tasks.length > maxTasks) problems.push(`tasks: at most ${maxTasks}; merge small ones`);
  const seen = new Set<string>();
  const out = tasks.map((t, i) => {
    const at = `tasks[${i}]`;
    const key = String(t.key ?? "").trim().toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 31);
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
    return { key, title, brief, files };
  });
  if (problems.length) throw new Error(problems.join("\n"));
  return out;
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

/** Merge tasks that share files into one lane (one worker), so parallel lanes never edit the same file. */
export function planLanes(tasks: TeamTask[]): Lane[] {
  const parent = tasks.map((_, i) => i);
  const find = (i: number): number => (parent[i] === i ? i : (parent[i] = find(parent[i])));
  for (let i = 0; i < tasks.length; i++)
    for (let j = i + 1; j < tasks.length; j++)
      if (tasks[i].files.some((a) => tasks[j].files.some((b) => patternsOverlap(a, b)))) parent[find(j)] = find(i);
  const groups = new Map<number, TeamTask[]>();
  tasks.forEach((t, i) => {
    const root = find(i);
    groups.set(root, [...(groups.get(root) ?? []), t]);
  });
  return [...groups.values()].map((group) => ({
    key: group.length === 1 ? group[0].key : `${group[0].key}-plus${group.length - 1}`,
    tasks: group,
    files: [...new Set(group.flatMap((t) => t.files))],
  }));
}

/** The pi-subagents workflow script for a plan. Data is embedded as JSON; logic is fixed. */
export function buildTeamScript(plan: TeamPlan): string {
  const full = { plannerAgent: "team-planner", maxTasks: 8, models: {}, ...plan };
  return `const PLAN = ${JSON.stringify(full)};
const PLAN_SCHEMA = ${JSON.stringify(PLAN_SCHEMA)};
const GATE = PLAN.gate ? { command: PLAN.gate, timeoutMs: PLAN.gateTimeoutSec * 1000 } : undefined;
// Resumed children reject the gate shorthand but accept the explicit form, so rework is held to the same check.
// pi-subagents stages the first round's changes when it captures the patch; preserveStagedIndex lets rework continue on top.
const RESUME_ACCEPTANCE = GATE
  ? { level: "verified", preserveStagedIndex: true, verify: [{ id: "gate", command: GATE.command, timeoutMs: GATE.timeoutMs }] }
  : { level: "checked", preserveStagedIndex: true };
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
        },
        required: ["key", "title", "brief", "files"],
      },
    },
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
        properties: { file: { type: "string" }, issue: { type: "string" }, fix: { type: "string" } },
        required: ["issue"],
      },
    },
  },
  required: ["verdict", "summary", "findings"],
};

// Plain functions and promise chains only: pi-subagents rejects async functions inside workflow scripts.
const WORKFLOW_BODY = String.raw`
function clip(text, n) { text = String(text || ""); return text.length > n ? text.slice(0, n) + " ...[cut]" : text; }
function taskList(lane) { return lane.tasks.map(function (t, i) { return (i + 1) + ". " + t.title + "\n" + t.brief; }).join("\n\n"); }
function owned(lane) { return lane.files.map(function (f) { return "- " + f; }).join("\n"); }
function runDir(r) { return (r && r.artifactPaths && r.artifactPaths[0]) || ""; }

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

function withModel(item, role) { var m = PLAN.models && PLAN.models[role]; if (m) item.model = m; return bounded(item); }
// Each child gets the configured deadline (pi-subagents would stop it after 30 minutes otherwise).
function bounded(item) { if (PLAN.childTimeoutMs) item.timeoutMs = PLAN.childTimeoutMs; return item; }

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
  var parent = tasks.map(function (_, i) { return i; });
  function find(i) { while (parent[i] !== i) i = parent[i] = parent[parent[i]]; return i; }
  for (var i = 0; i < tasks.length; i++) for (var j = i + 1; j < tasks.length; j++)
    if (tasks[i].files.some(function (a) { return tasks[j].files.some(function (b) { return overlap(a, b); }); })) parent[find(j)] = find(i);
  var groups = [], index = {};
  tasks.forEach(function (t, i) { var r = find(i); if (!(r in index)) { index[r] = groups.length; groups.push([]); } groups[index[r]].push(t); });
  return groups.map(function (g) {
    var files = []; g.forEach(function (t) { t.files.forEach(function (f) { if (files.indexOf(f) < 0) files.push(f); }); });
    return { key: g.length === 1 ? g[0].key : g[0].key + "-plus" + (g.length - 1), tasks: g, files: files };
  });
}
function cleanTasks(raw) {
  var seen = {};
  return (raw || []).map(function (t, i) {
    var key = String(t.key || "").toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 28) || "task-" + (i + 1);
    while (seen[key]) key = key + "-" + (i + 1);
    seen[key] = true;
    var files = (Array.isArray(t.files) ? t.files : []).map(norm).filter(function (f) { return f && f.charAt(0) !== "/" && f.split("/").indexOf("..") < 0; });
    // No ownership given: assume it may touch anything, so it shares a lane with everything.
    return { key: key, title: String(t.title || key).slice(0, 120), brief: String(t.brief || t.title || ""), files: files.length ? files : ["**"] };
  });
}

function planTask() {
  return "Split this goal into tasks for a team run. Goal: " + PLAN.goal + "\n\n" +
    "At most " + PLAN.maxTasks + " tasks; up to 4 run in parallel, each in its own git worktree. " +
    (PLAN.gate ? "Every task's result must pass " + JSON.stringify(PLAN.gate) + ". " : "") +
    "Return tasks, questions (only blocking ones; empty when you can proceed) and notes.";
}

function workTask(lane) {
  return "You are one worker in a team run. Overall goal: " + PLAN.goal + "\n\n" +
    "Your tasks:\n" + taskList(lane) + "\n\n" +
    "Files you own (edit only these; new files only inside them):\n" + owned(lane) + "\n\n" +
    "Rules: other workers are editing other files in parallel. If you must touch a file you do not own, or the brief is ambiguous, " +
    "call contact_supervisor with reason need_decision and wait for the answer. Do not commit, push, or switch branches. " +
    "Keep the change minimal and match the existing style." +
    (PLAN.gate ? " The command " + JSON.stringify(PLAN.gate) + " must pass in your worktree; run it before you finish." : "") +
    "\nFinish with: changed files, commands you ran and their results, open risks.";
}

function verifyTask(lane, writer, round) {
  var where = round === 1
    ? "The complete change is a patch. Read " + lane.origin + "/handoff.json, take groups[].children[].patch.path, and read that file. " +
      "Read surrounding code only when the patch is not enough.\n"
    : "This is a rework round. Read " + lane.origin + "/handoff.json and take groups[].cleanup.tasks[].path: that is the worker's worktree. " +
      "Read the owned files there (their current state includes every round) and compare them with the same files in the main checkout, which still holds the original version. " +
      "The patch file in handoff.json shows round 1 only.\n";
  return "Verify one lane of a team run (round " + round + "). Overall goal: " + PLAN.goal + "\n\n" +
    "The lane's tasks:\n" + taskList(lane) + "\n\nFiles the lane owns:\n" + owned(lane) + "\n\n" + where +
    "Check: it does what the tasks ask; no obvious bug or missing edge case; tests changed when behaviour changed; " +
    "no file changed outside the owned list.\n" +
    "Verdict: pass = correct and in scope. rework = list each concrete fix. blocked = only when the task itself is wrong or needs a human decision.\n\n" +
    "Writer's report:\n" + clip(writer.output, 3000);
}

function fixTask(lane, review, round) {
  var items = (review.findings || []).map(function (f, i) { return (i + 1) + ". " + (f.file ? f.file + ": " : "") + f.issue + (f.fix ? " -> " + f.fix : ""); }).join("\n");
  return "Round " + round + " review asked for changes. Fix exactly these, stay inside your files" +
    (PLAN.gate ? ", re-run " + JSON.stringify(PLAN.gate) : "") + ", then report again:\n" + (items || clip(review.summary, 2000));
}

function gateFixTask(lane, writer) {
  return "Your run did not pass its checks" + (PLAN.gate ? " (gate " + JSON.stringify(PLAN.gate) + ")" : "") +
    ". Details:\n" + clip(writer.error || writer.output, 3000) + "\nFix the cause, stay inside your files, run the check again, then report.";
}

function finish(lane, writer, review, rounds, state) {
  return {
    lane: lane.key,
    tasks: lane.tasks.map(function (t) { return t.key; }),
    state: state,
    rounds: rounds,
    runId: (writer && writer.runId) || null,
    // The first writer run owns the worktree and handoff.json; resumed rounds work in that same worktree.
    runDir: lane.origin || null,
    error: (writer && writer.error) || null,
    summary: clip((review && review.summary) || (writer && writer.output), 800),
    findings: (review && review.findings) || [],
    // Why earlier rounds were sent back: the lessons a playbook is made of (/harvest reads them).
    history: lane.history || [],
    report: clip(writer && writer.output, 1200)
  };
}

function noteRound(lane, entry) {
  lane.history = (lane.history || []).concat([entry]).slice(-6);
}

function resumeItem(writer, label, task) {
  return bounded({ resume: writer.runId, label: label, task: task, acceptance: RESUME_ACCEPTANCE });
}

function afterWrite(lane, writer, round) {
  if (writer.ok) return review(lane, writer, round);
  noteRound(lane, { round: round, gate: clip(writer.error || writer.output, 300) });
  if (round >= PLAN.maxRounds || !writer.runId) return finish(lane, writer, null, round, "failed");
  var key = lane.key + "-gatefix-" + round;
  return settle(key, runs.run(key, resumeItem(writer, "Fix checks: " + lane.key, gateFixTask(lane, writer))))
    .then(function (next) { if (!next.runId) next.runId = writer.runId; return afterWrite(lane, next, round + 1); });
}

function review(lane, writer, round) {
  var key = lane.key + "-verify-" + round;
  return settle(key, runs.run(key, withModel({ agent: PLAN.verifierAgent, label: "Verify " + lane.key + " #" + round, task: verifyTask(lane, writer, round), outputSchema: VERDICT_SCHEMA }, "verifier")))
    .then(function (v) {
      if (!v.ok && !v.structuredOutput) return finish(lane, writer, { summary: "Verifier failed: " + v.error, findings: [] }, round, "needs-human");
      var out = v.structuredOutput || {};
      var verdict = out.verdict || "rework";
      if (verdict === "pass") return finish(lane, writer, out, round, "passed");
      if (verdict === "blocked") return finish(lane, writer, out, round, "needs-human");
      noteRound(lane, { round: round, findings: (out.findings || []).slice(0, 5).map(function (f) { return { file: f.file, issue: clip(f.issue, 200), fix: clip(f.fix, 200) }; }) });
      if (round >= PLAN.maxRounds || !writer.runId) return finish(lane, writer, out, round, "needs-human");
      var fixKey = lane.key + "-fix-" + round;
      return settle(fixKey, runs.run(fixKey, resumeItem(writer, "Rework " + lane.key + " #" + round, fixTask(lane, out, round))))
        .then(function (next) { if (!next.runId) next.runId = writer.runId; return afterWrite(lane, next, round + 1); });
    });
}

function startLane(lane) {
  var item = withModel({ agent: PLAN.workerAgent, label: "Implement " + lane.key, task: workTask(lane), worktree: true }, "worker");
  if (GATE) item.gate = GATE;
  var key = lane.key + "-work";
  return settle(key, runs.run(key, item)).then(function (w) {
    lane.origin = runDir(w);
    return afterWrite(lane, w, 1);
  });
}

var lanes = PLAN.lanes;
var planned = null;
if (!lanes.length) {
  var p = await settle("plan", runs.run("plan", withModel({ agent: PLAN.plannerAgent, label: "Plan the team run", task: planTask(), outputSchema: PLAN_SCHEMA }, "planner")));
  var out = p.structuredOutput || {};
  var tasks = cleanTasks(out.tasks);
  if (!tasks.length) {
    return { goal: PLAN.goal, state: "needs-input", questions: out.questions || [], notes: out.notes || p.error || "planner returned no tasks", lanes: [] };
  }
  if (tasks.length > PLAN.maxTasks) {
    // Never cut silently: hand the plan back so the lead can merge tasks or split the goal into two runs.
    return { goal: PLAN.goal, state: "needs-input", questions: ["The planner proposed " + tasks.length + " tasks; the limit is " + PLAN.maxTasks + ". Merge small tasks, or split the goal into two runs, then call team_run with tasks."], notes: out.notes || "", plan: { tasks: tasks.map(function (t) { return { key: t.key, title: t.title, files: t.files }; }) }, lanes: [] };
  }
  lanes = lanesFor(tasks);
  planned = { tasks: tasks.map(function (t) { return { key: t.key, title: t.title, files: t.files }; }), questions: out.questions || [], notes: out.notes || "" };
}

const results = await Promise.all(lanes.map(startLane));
return {
  goal: PLAN.goal,
  gate: PLAN.gate || null,
  plan: planned,
  lanes: results,
  next: "Call team_integrate with runDirs = the runDir of each passed lane, in this order. Lanes marked needs-human or failed need your decision."
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
