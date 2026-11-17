// facts, plain talk, toolbox, environment detection and config merging
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEFAULTS, mergeKnown } from "../lib/config.ts";
import { detectEnv, formatEnv, pythonCommand, type Probe } from "../lib/env.ts";
import { applyRemember, emptyFactFile, readFactFile, writeFactFile } from "../lib/facts.ts";
import { unexplainedAcronyms } from "../lib/plain.ts";
import { addTool, discoverTools, toolArgv } from "../lib/toolbox.ts";

test("remember: save, update, cap, forget, validate", () => {
  let f = emptyFactFile();
  f = applyRemember(f, { kind: "fact", text: "Postgres for tests runs in docker compose service db on port 5433", id: "test-db", check: "docker compose ps db" }, 3, "2026-11-17").file;
  assert.equal(f.facts[0].check, "docker compose ps db");
  f = applyRemember(f, { kind: "fact", text: "Postgres moved to port 5434", id: "test-db" }, 3).file;
  assert.equal(f.facts.length, 1);
  assert.match(f.facts[0].text, /5434/);
  f = applyRemember(f, { kind: "pitfall", text: "npm install on /mnt/c is 10x slower", match: "npm (i|install)", when: "^/mnt/" }, 3).file;
  assert.equal(f.pitfalls[0].action, "warn");
  assert.throws(() => applyRemember(f, { kind: "pitfall", text: "bad", match: "(" }, 3), /invalid regex/);
  assert.throws(() => applyRemember(f, { kind: "pitfall", text: "slow", match: "(a+)+b" }, 3), /too complex/);
  assert.throws(() => applyRemember(f, { kind: "fact", text: "x".repeat(301) }, 3), /300/);
  f = applyRemember(f, { kind: "forget", id: "test-db" }, 3).file;
  assert.equal(f.facts.length, 0);
  assert.throws(() => applyRemember(f, { kind: "forget", id: "nope" }, 3), /no fact/);
  const dir = mkdtempSync(join(tmpdir(), "ptk-facts-"));
  writeFactFile(join(dir, "facts.json"), f);
  assert.deepEqual(readFactFile(join(dir, "facts.json")), f);
  writeFileSync(join(dir, "broken.json"), "{oops");
  assert.deepEqual(readFactFile(join(dir, "broken.json")), emptyFactFile());
});

test("plain talk: flags unexplained abbreviations only", () => {
  assert.deepEqual(unexplainedAcronyms("The RPC layer retries via the DLQ."), ["RPC", "DLQ"]);
  assert.deepEqual(unexplainedAcronyms("用 RPC（远程调用）通知主会话，失败进 DLQ (dead-letter queue)。"), []);
  assert.deepEqual(unexplainedAcronyms("Run `npm run ESLINT` and open https://x.io/ABC and /usr/LOCAL/bin"), []);
  assert.deepEqual(unexplainedAcronyms("Fixed the API and the JSON parser; P0 resolved."), []);
  assert.deepEqual(unexplainedAcronyms("SLA breached", "what's our SLA?"), [], "user's own words are fine");
  assert.deepEqual(unexplainedAcronyms("TTL is 30s", "", ["ttl"]), []);
});

test("toolbox: layers override by name, add copies a script with a manifest", () => {
  const root = mkdtempSync(join(tmpdir(), "ptk-tools-"));
  const mk = (layer: string, name: string, desc: string) => {
    mkdirSync(join(root, layer, name), { recursive: true });
    writeFileSync(join(root, layer, name, "tool.json"), JSON.stringify({ name, description: desc, usage: name, run: ["node", "run.mjs"] }));
  };
  mk("bundled", "md2pdf", "bundled version");
  mk("bundled", "shot", "screens");
  mk("global", "md2pdf", "my tweaked version");
  mkdirSync(join(root, "bundled", "_lib"));
  const tools = discoverTools([
    { dir: join(root, "bundled"), layer: "bundled" },
    { dir: join(root, "global"), layer: "global" },
    { dir: join(root, "missing"), layer: "project" },
  ]);
  assert.deepEqual(tools.map((t) => `${t.name}:${t.layer}`), ["md2pdf:global", "shot:bundled"]);
  const argv = toolArgv(tools[0], ["in.md"]);
  assert.equal(argv[0], process.execPath);
  assert.equal(argv[1], join(root, "global", "md2pdf", "run.mjs"));
  assert.equal(argv[2], "in.md");

  writeFileSync(join(root, "csv2md.py"), "print('hi')\n");
  const saved = addTool(join(root, "global"), { name: "csv2md", description: "CSV to Markdown table", usage: "csv2md <file>", source: "csv2md.py" }, root);
  assert.deepEqual(saved.run, ["python3", "csv2md.py"]);
  assert.match(readFileSync(join(saved.dir, "tool.json"), "utf8"), /CSV to Markdown/);
  assert.throws(() => addTool(join(root, "global"), { name: "Bad Name", description: "x", usage: "", source: "csv2md.py" }, root), /lowercase/);
});

function fakeProbe(files: Record<string, string>, bins: string[], env: NodeJS.ProcessEnv = {}): Probe {
  return {
    platform: "linux",
    release: "6.6.87.2-microsoft-standard-WSL2",
    arch: "x64",
    env: { PATH: "/usr/bin:/mnt/c/Program Files/nodejs", WSL_DISTRO_NAME: "Ubuntu", ...env },
    cwd: "/repo",
    repoRoot: "/repo",
    home: "/home/u",
    nodeVersion: "v22.23.2",
    extraBin: ["/home/u/.pi/agent/bin"],
    exists: (p) => p in files || bins.includes(p),
    read: (p) => files[p],
    list: (p) => (p === "/repo" ? Object.keys(files).filter((f) => f.startsWith("/repo/") && !f.slice(6).includes("/")).map((f) => f.slice(6)) : []),
  };
}

test("environment: detected from the machine and repo, Windows PATH ignored inside WSL", () => {
  const probe = fakeProbe(
    {
      "/etc/os-release": 'PRETTY_NAME="Ubuntu 24.04.3 LTS"\n',
      "/repo/package.json": JSON.stringify({ scripts: { dev: "vite", test: "vitest run", build: "vite build" } }),
      "/repo/pnpm-lock.yaml": "",
      "/repo/.git": "",
      "/repo/.git/HEAD": "ref: refs/heads/feature/x\n",
      "/repo/.git/config": '[remote "origin"]\n\turl = ssh://deploy:token123@github.com/me/app.git\n',
      "/home/u/.npmrc": "registry=https://registry.npmmirror.com\n",
    },
    ["/usr/bin/git", "/usr/bin/node", "/home/u/.pi/agent/bin/rg", "/mnt/c/Program Files/nodejs/npm"],
    { HTTPS_PROXY: "http://127.0.0.1:7890" },
  );
  const facts = detectEnv(probe);
  assert.equal(facts.wsl, true);
  assert.equal(facts.tools.rg, "/home/u/.pi/agent/bin/rg", "pi's bundled rg counts");
  assert.equal(facts.tools.npm, undefined, "Windows npm under /mnt/c must not be used from WSL");
  assert.equal(facts.testCommand, "pnpm test");
  const text = formatEnv(facts);
  assert.match(text, /Ubuntu 24\.04\.3 LTS on WSL2/);
  assert.match(text, /npm registry https:\/\/registry\.npmmirror\.com/);
  assert.match(text, /proxy is set via HTTPS_PROXY/);
  assert.match(text, /on feature\/x, origin ssh:\/\/github\.com\/me\/app\.git/);
  assert.doesNotMatch(text, /token123/, "credentials in remote URLs are stripped");
  assert.match(text, /Not installed: fd/);
});

function winProbe(bins: string[], files: Record<string, string> = {}): Probe {
  return {
    platform: "win32",
    release: "",
    arch: "x64",
    env: { PATH: "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Python312;C:\\Windows\\py" },
    cwd: "C:\\repo",
    repoRoot: "C:\\repo",
    home: "C:\\Users\\u",
    nodeVersion: "v22.23.2",
    extraBin: [],
    exists: (p) => bins.includes(p) || p in files,
    read: (p) => files[p],
    list: (p) => (p === "C:\\repo" ? Object.keys(files).filter((f) => f.startsWith("C:\\repo\\")).map((f) => f.slice(8)) : []),
  };
}

test("python: the command that really runs is used for tests; Windows Store aliases are skipped", () => {
  const storeOnly = ["C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python3.exe", "C:\\Users\\u\\AppData\\Local\\Microsoft\\WindowsApps\\python.exe"];
  assert.equal(pythonCommand(winProbe(storeOnly)), undefined, "Store aliases only print 'Python was not found'");
  assert.equal(pythonCommand(winProbe([...storeOnly, "C:\\Python312\\python.exe"])), "python");
  assert.equal(pythonCommand(winProbe([...storeOnly, "C:\\Windows\\py\\py.exe"])), "py -3");
  const repo = winProbe(["C:\\Python312\\python.exe"], { "C:\\repo\\test_calc.py": "", "C:\\repo\\calc.py": "" });
  assert.equal(detectEnv(repo).testCommand, "python -m unittest -q");
  assert.match(formatEnv(detectEnv(repo)), /python \(run as `python`\)/);
  const none = detectEnv(winProbe(storeOnly, { "C:\\repo\\test_calc.py": "" }));
  assert.equal(none.testCommand, undefined, "no guessed gate that cannot run");
  assert.ok(none.project.some((l) => /no working Python/.test(l)));
  const linux = fakeProbe({ "/repo/test_x.py": "", "/repo/pyproject.toml": "[tool.pytest.ini_options]\n", "/repo/uv.lock": "" }, ["/usr/bin/python3"]);
  assert.equal(pythonCommand(linux), "python3");
  assert.equal(detectEnv(linux).testCommand, "uv run python -m pytest -q", "inside uv the environment's python is used");
});

test("config: known keys merge, wrong types and unknown keys are reported", () => {
  const warnings: string[] = [];
  const merged = mergeKnown(DEFAULTS, { guard: { defaultTimeoutSec: 60, preferFastSearch: "warn", bogus: 1 }, team: { maxParallel: "4" } }, "", warnings);
  assert.equal(merged.guard.defaultTimeoutSec, 60);
  assert.equal(merged.guard.preferFastSearch, "warn");
  assert.equal(merged.team.maxParallel, 4, "wrong type keeps the default");
  assert.deepEqual(warnings, ['unknown setting "guard.bogus" ignored', 'setting "team.maxParallel" should be number']);
});
