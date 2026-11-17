#!/usr/bin/env node
// ptk: the same logic the extension uses, for humans and CI.
//   ptk doctor [--strict] [--fix]   check pi, pi-subagents, conflicts, rg/fd, browser, config (--fix: package paths)
//   ptk facts [share]           facts saved on this machine; share = copy them into .pi/ptk/facts.json to commit
//   ptk env                     print what the agent is told about this machine and repo
//   ptk tools | ptk run <name> [args...]
//   ptk caps [--apply]          per-role context windows through pi's model overrides
//   ptk demo [dir]              create a throwaway repo to try /team on
//   ptk plan <tasks.json> [--script]   show how tasks become lanes (and the workflow script)
//   ptk leads [n]               lead sessions running on this machine, their status and the last n messages
//   ptk playbooks [check [dir]] list playbooks; check = enforce the length limits (for a team playbook repo's CI)
//   ptk feedback [days] [--repo name]  where the tooling cost time (from pi's session files), to hand to an agent

import { spawnSync } from "node:child_process";
import { copyFileSync, cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { formatBoard, formatLog, readCards, readLog } from "../lib/board.ts";
import { checkPlaybook, listPlaybooks } from "../lib/playbook.ts";
import { formatFriction, frictionFromFiles, sessionFiles } from "../lib/feedback.ts";
import { readRunValue } from "../lib/harvest.ts";
import { fileURLToPath, pathToFileURL } from "node:url";
import { agentDir, backslashSources, findRepoRoot, globalDataDir, loadConfig, localProjectDataDir, playbookDirs, projectDataDir } from "../lib/config.ts";
import { factFilePath, mergeFactFiles, readFactFile, writeFactFile } from "../lib/facts.ts";
import { detectEnv, formatEnv, realProbe, which } from "../lib/env.ts";
import { buildTeamScript, planLanes, roleModels, validateTasks, type TeamTask } from "../lib/team.ts";
import { discoverTools, formatToolList, toolArgv } from "../lib/toolbox.ts";
import { modelCaps } from "../lib/session.ts";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cwd = process.cwd();
const [cmd, ...rest] = process.argv.slice(2);

function tools() {
  const repo = findRepoRoot(cwd);
  return discoverTools([
    { dir: join(ROOT, "toolbox"), layer: "bundled" },
    { dir: join(globalDataDir(), "toolbox"), layer: "global" },
    ...(repo ? [{ dir: join(projectDataDir(cwd), "toolbox"), layer: "project" as const }] : []),
  ]);
}

function probe() {
  return realProbe(cwd, findRepoRoot(cwd), [join(agentDir(), "bin"), join(globalDataDir(), "bin")]);
}

function doctor(strict: boolean, fix: boolean): number {
  let bad = 0;
  const line = (ok: boolean | "warn", label: string, detail = "") => {
    if (ok === false) bad++;
    console.log(`${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  line(major > 22 || (major === 22 && minor >= 19), "Node.js >= 22.19", process.version);
  // On Windows `pi` is pi.cmd, which only runs through a shell.
  const pi = spawnSync("pi", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], shell: process.platform === "win32" });
  line(pi.status === 0, "pi installed", pi.status === 0 ? pi.stdout.trim() : "npm i -g @earendil-works/pi-coding-agent");
  const settingsFile = join(agentDir(), "settings.json");
  let settings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
  const slashed = backslashSources(settings);
  if (slashed.length && fix) {
    copyFileSync(settingsFile, `${settingsFile}.bak-${Date.now()}`);
    const s = JSON.parse(settings) as { packages: (string | { source?: string })[] };
    s.packages = s.packages.map((p) => (typeof p === "string" ? p.replace(/\\/g, "/") : { ...p, source: p.source?.replace(/\\/g, "/") }));
    settings = JSON.stringify(s, null, 2) + "\n";
    writeFileSync(settingsFile, settings);
    line(true, "package paths use forward slashes", `fixed ${slashed.length} path(s) in ${settingsFile}; restart pi`);
  } else
    line(!slashed.length, "package paths use forward slashes", slashed.length ? `${slashed.join(", ")}: pi-subagents cannot load this package's agents. Run: ptk doctor --fix` : "");
  const subagentsDir = join(agentDir(), "npm", "node_modules", "pi-subagents");
  line(/pi-subagents/.test(settings) || existsSync(subagentsDir), "pi-subagents installed", "pi install npm:pi-subagents");
  line(/pi-team-kit/.test(settings), "pi-team-kit registered in pi", "pi install git:github.com/stywzn/pi-team-kit");
  const oldExample = join(agentDir(), "extensions", "subagent");
  const conflict = existsSync(join(oldExample, "index.ts")) || existsSync(join(oldExample, "index.js"));
  line(!conflict, "no conflicting subagent extension", conflict ? `${oldExample} also registers "subagent"; move it away` : "");
  const userAgents = join(agentDir(), "agents");
  const shadow = existsSync(userAgents) ? readdirSync(userAgents).filter((f) => ["worker.md", "reviewer.md", "scout.md"].includes(f)) : [];
  line(shadow.length ? "warn" : true, "built-in subagents not shadowed", shadow.length ? `${userAgents}: ${shadow.join(", ")} override pi-subagents built-ins` : "");
  const p = probe();
  const ensure = `pi downloads it on first use; to install now: bash ${join(ROOT, "skills", "fast-search", "scripts", "ensure-rg-fd.sh")}`;
  line(which(p, "rg") ? true : "warn", "ripgrep (rg)", which(p, "rg") ?? ensure);
  line(which(p, "fd") || which(p, "fdfind") ? true : "warn", "fd", which(p, "fd") ?? which(p, "fdfind") ?? ensure);
  // ESM import() needs a file:// URL; a bare C:\ path fails on Windows.
  const browserUrl = pathToFileURL(join(ROOT, "toolbox", "_lib", "browser.mjs")).href;
  const browser = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(browserUrl)}).then(m=>{const b=m.findBrowser();console.log(b?b.path:"")})`], { encoding: "utf8" });
  const b = browser.stdout.trim();
  line(b ? true : "warn", "browser for md2pdf/shot", b || "none found (only needed for md2pdf/shot)");
  line(existsSync(join(ROOT, "node_modules", "marked")) ? true : "warn", "md2pdf dependency (marked)", "run npm install in the package directory");
  const { files, warnings } = loadConfig(cwd);
  line(warnings.length ? "warn" : true, "config", [...files, ...warnings].join("; ") || "defaults");
  console.log(bad ? `\n${bad} problem(s).` : "\nAll good.");
  return strict && bad ? 1 : 0;
}

switch (cmd) {
  case "doctor":
    process.exit(doctor(rest.includes("--strict"), rest.includes("--fix")));
  case "env": {
    console.log(formatEnv(detectEnv(probe())));
    break;
  }
  case "tools":
    console.log(formatToolList(tools(), 500) || "toolbox is empty");
    break;
  case "run": {
    const [name, ...args] = rest;
    const tool = tools().find((t) => t.name === name);
    if (!tool) {
      console.error(`no tool "${name ?? ""}". Try: ptk tools`);
      process.exit(2);
    }
    const argv = toolArgv(tool, args, detectEnv(probe()).python);
    const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
    process.exit(r.status ?? 1);
  }
  case "facts": {
    // Facts the agent saved live in .git/ptk (never dirty the tree). `share` copies them into .pi/ptk/facts.json to commit.
    const local = localProjectDataDir(cwd);
    if (!local) {
      console.error("not inside a git repository");
      process.exit(2);
    }
    const localFile = factFilePath(local);
    const sharedFile = factFilePath(projectDataDir(cwd));
    const mine = readFactFile(localFile);
    if (rest[0] === "share") {
      const { file, added, updated } = mergeFactFiles(readFactFile(sharedFile), mine);
      writeFactFile(sharedFile, file);
      console.log(`${sharedFile}: ${added} added, ${updated} updated. Review and commit it to share with the team.`);
      break;
    }
    const shared = readFactFile(sharedFile);
    console.log(`This machine (${localFile}): ${mine.facts.length} facts, ${mine.pitfalls.length} pitfalls`);
    console.log(`Team (${sharedFile}): ${shared.facts.length} facts, ${shared.pitfalls.length} pitfalls`);
    for (const f of mine.facts) console.log(`  [project/${f.id}] ${f.text}`);
    for (const p of mine.pitfalls) console.log(`  [project/${p.id}] pitfall /${p.match}/: ${p.message}`);
    console.log("\n`ptk facts share` copies this machine's facts into the team file.");
    break;
  }
  case "caps": {
    // Per-role context caps through pi's own model overrides: pi then compacts subagents between turns at their budget.
    const { config } = loadConfig(cwd);
    const settingsPath = join(agentDir(), "settings.json");
    const settings = existsSync(settingsPath) ? (JSON.parse(readFileSync(settingsPath, "utf8")) as { defaultProvider?: string; defaultModel?: string }) : {};
    const lead = settings.defaultProvider && settings.defaultModel ? `${settings.defaultProvider}/${settings.defaultModel}` : "";
    const m = config.team.models;
    const roles = { lead, planner: m.planner || lead, worker: m.worker || lead, verifier: m.verifier || lead };
    const caps = modelCaps(roles, config.context);
    if (Object.keys(caps).length === 0) {
      console.error("No models known: set team.models in ptk.json or defaultProvider/defaultModel in pi settings.");
      process.exit(2);
    }
    console.log("Roles:", Object.entries(roles).map(([r, s]) => `${r}=${s || "?"}`).join(", "));
    console.log("Context window per model (role budget + 16k compaction reserve):");
    for (const [p, ids] of Object.entries(caps)) for (const [id, v] of Object.entries(ids)) console.log(`  ${p}/${id}: ${v.contextWindow}`);
    if (!rest.includes("--apply")) {
      console.log("\nNothing changed. Run `ptk caps --apply` to merge this into ~/.pi/agent/models.json (a backup is kept).");
      break;
    }
    const modelsPath = join(agentDir(), "models.json");
    const current = existsSync(modelsPath) ? JSON.parse(readFileSync(modelsPath, "utf8")) : {};
    if (existsSync(modelsPath)) copyFileSync(modelsPath, `${modelsPath}.bak-${Date.now()}`);
    current.providers ??= {};
    for (const [p, ids] of Object.entries(caps)) {
      current.providers[p] ??= {};
      current.providers[p].modelOverrides ??= {};
      for (const [id, v] of Object.entries(ids)) current.providers[p].modelOverrides[id] = { ...current.providers[p].modelOverrides[id], ...v };
    }
    writeFileSync(modelsPath, JSON.stringify(current, null, 2) + "\n");
    console.log(`\nWrote ${modelsPath}. Restart pi (or /reload) to apply.`);
    break;
  }
  case "demo": {
    // A throwaway git repo to try /team on, without touching real work.
    const target = resolve(rest[0] ?? join(process.env.HOME ?? process.env.USERPROFILE ?? ".", "code", "ptk-demo"));
    if (existsSync(target)) {
      console.error(`${target} already exists; pass another directory: ptk demo <dir>`);
      process.exit(2);
    }
    cpSync(join(ROOT, "examples", "demo-repo"), target, { recursive: true });
    writeFileSync(join(target, ".gitignore"), "__pycache__/\n.pi/subagents/\n");
    const git = (...a: string[]) => spawnSync("git", ["-C", target, ...a], { stdio: "ignore" }).status;
    git("init", "-q", "-b", "main");
    git("add", "-A");
    if (git("commit", "-q", "-m", "ptk demo") !== 0) git("-c", "user.name=ptk-demo", "-c", "user.email=ptk-demo@localhost", "commit", "-q", "-m", "ptk demo");
    console.log(`Demo repo ready: ${target}\n\nNext:\n  cd ${target} && pi\n\nThen paste the /team line from README.md, or type your own goal after /team.`);
    break;
  }
  case "plan": {
    const file = rest.find((a) => !a.startsWith("--"));
    if (!file) {
      console.error("usage: ptk plan <tasks.json> [--script]");
      process.exit(2);
    }
    const input = JSON.parse(readFileSync(file, "utf8")) as { goal?: string; tasks: TeamTask[]; gate?: string };
    const lanes = planLanes(validateTasks(input.tasks, loadConfig(cwd).config.team.maxTasks));
    for (const l of lanes) console.log(`${l.key}: ${l.tasks.map((t) => t.key).join(" + ")}  [${l.files.join(", ")}]`);
    if (rest.includes("--script")) {
      // Same plan fields team_run builds, so the printed script matches what would really run.
      const t = loadConfig(cwd).config.team;
      const gate = (input.gate ?? t.gate).trim() || detectEnv(probe()).testCommand || "";
      console.log(
        buildTeamScript({
          goal: input.goal ?? "",
          lanes,
          gate,
          gateTimeoutSec: t.gateTimeoutSec,
          maxRounds: t.maxRounds,
          workerAgent: t.workerAgent,
          verifierAgent: t.verifierAgent,
          plannerAgent: t.plannerAgent,
          maxTasks: t.maxTasks,
          models: roleModels(t.models, t.thinking),
          childTimeoutMs: t.childTimeoutMin * 60_000,
        }),
      );
    }
    break;
  }
  case "leads": {
    const dir = join(globalDataDir(), "board");
    console.log(`${formatBoard(readCards(dir), "", Date.now(), homedir())}\n\nRecent messages:\n${formatLog(readLog(dir, Number(rest[0]) || 15))}`);
    break;
  }
  case "playbooks": {
    const dirs = rest[0] === "check" && rest[1] ? [resolve(rest[1])] : playbookDirs(loadConfig(cwd).config);
    const all = listPlaybooks(dirs);
    if (rest[0] !== "check") {
      console.log(all.length ? all.map((p) => `${p.name}: ${p.description} (${p.uses} use(s)${p.lastUsed ? `, last ${p.lastUsed.slice(0, 10)}` : ""})\n  ${p.dir}`).join("\n") : `no playbooks in ${dirs.join(", ")}`);
      break;
    }
    let bad = 0;
    for (const p of all) {
      const c = checkPlaybook(readFileSync(join(p.dir, "SKILL.md"), "utf8"));
      console.log(`${c.errors.length ? "FAIL" : "ok  "} ${p.name}${[...c.errors, ...c.warnings.map((w) => `warning: ${w}`)].map((e) => `\n     ${e}`).join("")}`);
      if (c.errors.length) bad++;
    }
    if (!all.length) console.log(`no playbooks in ${dirs.join(", ")}`);
    process.exit(bad ? 1 : 0);
  }
  case "feedback": {
    const days = Math.max(1, Math.min(365, Number(rest.find((a) => /^\d+$/.test(a)) ?? 30)));
    const r = rest.indexOf("--repo");
    const repo = r >= 0 ? rest[r + 1] : undefined;
    const { signals, sessions } = frictionFromFiles(sessionFiles(join(agentDir(), "sessions"), days), repo, readRunValue);
    console.log(formatFriction(signals, { days, sessions }));
    break;
  }
  default:
    console.log("usage: ptk doctor [--strict] [--fix] | env | tools | run <name> [args...] | facts [share] | caps [--apply] | demo [dir] | plan <tasks.json> [--script] | leads [n] | playbooks [check [dir]] | feedback [days] [--repo name]");
    process.exit(cmd ? 2 : 0);
}
