#!/usr/bin/env node
// ptk: the same logic the extension uses, for humans and CI.
//   ptk doctor [--strict]       check pi, pi-subagents, conflicts, rg/fd, browser, config
//   ptk env                     print what the agent is told about this machine and repo
//   ptk tools | ptk run <name> [args...]
//   ptk demo [dir]              create a throwaway repo to try /team on
//   ptk plan <tasks.json> [--script]   show how tasks become lanes (and the workflow script)

import { spawnSync } from "node:child_process";
import { cpSync, existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { agentDir, findRepoRoot, globalDataDir, loadConfig, projectDataDir } from "../lib/config.ts";
import { detectEnv, formatEnv, realProbe, which } from "../lib/env.ts";
import { buildTeamScript, planLanes, validateTasks, type TeamTask } from "../lib/team.ts";
import { discoverTools, formatToolList, toolArgv } from "../lib/toolbox.ts";

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

function doctor(strict: boolean): number {
  let bad = 0;
  const line = (ok: boolean | "warn", label: string, detail = "") => {
    if (ok === false) bad++;
    console.log(`${ok === true ? "✓" : ok === "warn" ? "!" : "✗"} ${label}${detail ? `  ${detail}` : ""}`);
  };
  const major = Number(process.versions.node.split(".")[0]);
  const minor = Number(process.versions.node.split(".")[1]);
  line(major > 22 || (major === 22 && minor >= 19), "Node.js >= 22.19", process.version);
  const pi = spawnSync("pi", ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  line(pi.status === 0, "pi installed", pi.status === 0 ? pi.stdout.trim() : "npm i -g @earendil-works/pi-coding-agent");
  const settingsFile = join(agentDir(), "settings.json");
  const settings = existsSync(settingsFile) ? readFileSync(settingsFile, "utf8") : "";
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
  const browser = spawnSync(process.execPath, ["-e", `import(${JSON.stringify(join(ROOT, "toolbox", "_lib", "browser.mjs"))}).then(m=>{const b=m.findBrowser();console.log(b?b.path:"")})`], { encoding: "utf8" });
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
    process.exit(doctor(rest.includes("--strict")));
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
    const argv = toolArgv(tool, args);
    const r = spawnSync(argv[0], argv.slice(1), { stdio: "inherit" });
    process.exit(r.status ?? 1);
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
    const lanes = planLanes(validateTasks(input.tasks));
    for (const l of lanes) console.log(`${l.key}: ${l.tasks.map((t) => t.key).join(" + ")}  [${l.files.join(", ")}]`);
    if (rest.includes("--script")) {
      const t = loadConfig(cwd).config.team;
      console.log(buildTeamScript({ goal: input.goal ?? "", lanes, gate: input.gate ?? t.gate, gateTimeoutSec: t.gateTimeoutSec, maxRounds: t.maxRounds, workerAgent: t.workerAgent, verifierAgent: t.verifierAgent }));
    }
    break;
  }
  default:
    console.log("usage: ptk doctor [--strict] | env | tools | run <name> [args...] | demo [dir] | plan <tasks.json> [--script]");
    process.exit(cmd ? 2 : 0);
}
