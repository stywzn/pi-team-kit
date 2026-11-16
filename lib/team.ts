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
  lanes: Lane[];
  gate: string;
  gateTimeoutSec: number;
  maxRounds: number;
  workerAgent: string;
  verifierAgent: string;
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
  return `const PLAN = ${JSON.stringify(plan)};
const GATE = PLAN.gate ? { command: PLAN.gate, timeoutMs: PLAN.gateTimeoutSec * 1000 } : undefined;
// Resumed children reject the gate shorthand but accept the explicit form, so rework is held to the same check.
// pi-subagents stages the first round's changes when it captures the patch; preserveStagedIndex lets rework continue on top.
const RESUME_ACCEPTANCE = GATE
  ? { level: "verified", preserveStagedIndex: true, verify: [{ id: "gate", command: GATE.command, timeoutMs: GATE.timeoutMs }] }
  : { level: "checked", preserveStagedIndex: true };
const VERDICT_SCHEMA = ${JSON.stringify(VERDICT_SCHEMA)};
${WORKFLOW_BODY}`;
}

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
    findings: (review && review.findings) || []
  };
}

function resumeItem(writer, label, task) {
  return { resume: writer.runId, label: label, task: task, acceptance: RESUME_ACCEPTANCE };
}

function afterWrite(lane, writer, round) {
  if (writer.ok) return review(lane, writer, round);
  if (round >= PLAN.maxRounds || !writer.runId) return finish(lane, writer, null, round, "failed");
  var key = lane.key + "-gatefix-" + round;
  return settle(key, runs.run(key, resumeItem(writer, "Fix checks: " + lane.key, gateFixTask(lane, writer))))
    .then(function (next) { if (!next.runId) next.runId = writer.runId; return afterWrite(lane, next, round + 1); });
}

function review(lane, writer, round) {
  var key = lane.key + "-verify-" + round;
  return settle(key, runs.run(key, { agent: PLAN.verifierAgent, label: "Verify " + lane.key + " #" + round, task: verifyTask(lane, writer, round), outputSchema: VERDICT_SCHEMA }))
    .then(function (v) {
      if (!v.ok && !v.structuredOutput) return finish(lane, writer, { summary: "Verifier failed: " + v.error, findings: [] }, round, "needs-human");
      var out = v.structuredOutput || {};
      var verdict = out.verdict || "rework";
      if (verdict === "pass") return finish(lane, writer, out, round, "passed");
      if (verdict === "blocked") return finish(lane, writer, out, round, "needs-human");
      if (round >= PLAN.maxRounds || !writer.runId) return finish(lane, writer, out, round, "needs-human");
      var fixKey = lane.key + "-fix-" + round;
      return settle(fixKey, runs.run(fixKey, resumeItem(writer, "Rework " + lane.key + " #" + round, fixTask(lane, out, round))))
        .then(function (next) { if (!next.runId) next.runId = writer.runId; return afterWrite(lane, next, round + 1); });
    });
}

function startLane(lane) {
  var item = { agent: PLAN.workerAgent, label: "Implement " + lane.key, task: workTask(lane), worktree: true };
  if (GATE) item.gate = GATE;
  var key = lane.key + "-work";
  return settle(key, runs.run(key, item)).then(function (w) {
    lane.origin = runDir(w);
    return afterWrite(lane, w, 1);
  });
}

const results = await Promise.all(PLAN.lanes.map(startLane));
return {
  goal: PLAN.goal,
  gate: PLAN.gate || null,
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
