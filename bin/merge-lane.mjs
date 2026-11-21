#!/usr/bin/env node
// node merge-lane.mjs <handoff.json> <lane-key>
// The first step of a team run's merge queue, run by pi-subagents in the run's integration worktree (the cwd):
// put the worktree back to its last commit (a lane that failed before leaves nothing behind), then apply the
// lane's worker worktree as it is now (every round, also rework the recorded patch lacks) on top. The command
// that runs after it is the full gate on the combined code, and only then the commit.
// Exit 1 with the reason when the lane does not apply on top of the lanes merged before it.

import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

const [handoffPath, lane = "lane"] = process.argv.slice(2);
const fail = (msg) => {
  console.error(`merge ${lane}: ${msg}`);
  process.exit(1);
};
if (!handoffPath) fail("usage: merge-lane.mjs <handoff.json> <lane-key>");
const git = (args, input) => spawnSync("git", args, { encoding: "utf8", input, maxBuffer: 512 * 1024 * 1024, windowsHide: true });

let data;
try {
  data = JSON.parse(readFileSync(handoffPath, "utf8"));
} catch (e) {
  fail(`cannot read ${handoffPath}: ${e.message}`);
}
// The worker's worktree and the commit it started from (same reading as worktreeFromHandoff in lib/team.ts).
let wt;
for (const g of data.groups ?? [])
  for (const t of g.cleanup?.tasks ?? []) if (!wt && t.path && !t.worktreeRemoved) wt = { path: t.path, base: g.baseCommit };
if (!wt || !existsSync(wt.path)) fail(`no worktree kept in ${handoffPath}`);
if (!/^[0-9a-f]{7,64}$/i.test(String(wt.base ?? ""))) fail(`no base commit in ${handoffPath}`);

for (const args of [["reset", "-q", "--hard"], ["clean", "-fdq"]]) {
  const r = git(args);
  if (r.status !== 0) fail(`git ${args.join(" ")}: ${r.stderr.trim()}`);
}
const added = git(["-C", wt.path, "add", "-A"]);
if (added.status !== 0) fail(`git add in ${wt.path}: ${added.stderr.trim()}`);
const diff = git(["-C", wt.path, "diff", "--cached", "--binary", wt.base]);
if (diff.status !== 0) fail(`git diff in ${wt.path}: ${diff.stderr.trim()}`);
if (!diff.stdout.trim()) {
  console.log(`merge ${lane}: no changes`);
  process.exit(0);
}
const patch = diff.stdout.endsWith("\n") ? diff.stdout : `${diff.stdout}\n`;
let applied = git(["apply", "--index", "--whitespace=nowarn", "-"], patch);
if (applied.status !== 0) applied = git(["apply", "--3way", "--index", "--whitespace=nowarn", "-"], patch);
if (applied.status !== 0) {
  git(["reset", "-q", "--hard"]);
  fail(`does not apply on top of the lanes merged before it:\n${applied.stderr.trim()}`);
}
const stat = git(["diff", "--cached", "--shortstat"]).stdout.trim();
console.log(`merge ${lane}: applied (${stat || "no line changes"})`);
