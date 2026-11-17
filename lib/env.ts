// Detect the environment once per session so the model stops re-discovering it with tool calls.
// Everything is computed from the machine and the repo, never hand-written, so it cannot drift.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";

// Paths follow the probed platform, not the host, so tests with a fake Linux probe also pass on Windows.
let join = posix.join;

export interface Probe {
  platform: NodeJS.Platform;
  release: string;
  arch: string;
  env: NodeJS.ProcessEnv;
  cwd: string;
  repoRoot?: string;
  home: string;
  nodeVersion: string;
  /** Extra directories searched for executables after PATH (pi's bundled rg/fd live in one). */
  extraBin: string[];
  exists(path: string): boolean;
  read(path: string): string | undefined;
  list(path: string): string[];
}

export function realProbe(cwd: string, repoRoot: string | undefined, extraBin: string[]): Probe {
  return {
    platform: process.platform,
    release: safe(() => readFileSync("/proc/sys/kernel/osrelease", "utf8").trim()) ?? "",
    arch: process.arch,
    env: process.env,
    cwd,
    repoRoot,
    home: homedir(),
    nodeVersion: process.version,
    extraBin,
    exists: (p) => existsSync(p),
    read: (p) => safe(() => (statSync(p).size < 512_000 ? readFileSync(p, "utf8") : undefined)),
    list: (p) => safe(() => readdirSync(p)) ?? [],
  };
}

function safe<T>(fn: () => T): T | undefined {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/** Locate an executable on PATH (plus extra dirs) without spawning anything. */
export function which(probe: Probe, name: string, accept: (path: string) => boolean = () => true): string | undefined {
  join = probe.platform === "win32" ? win32.join : posix.join;
  const dirs = [...(probe.env.PATH ?? "").split(probe.platform === "win32" ? ";" : ":"), ...probe.extraBin].filter(Boolean);
  const exts = probe.platform === "win32" ? ["", ".exe", ".cmd", ".bat"] : [""];
  for (const dir of dirs) {
    // Windows PATH entries leak into WSL; only use them for names that are Windows-only anyway.
    if (probe.platform === "linux" && dir.startsWith("/mnt/") && !name.endsWith(".exe")) continue;
    for (const ext of exts) {
      const full = join(dir, name + ext);
      if (probe.exists(full) && accept(full)) return full;
    }
  }
  return undefined;
}

export interface EnvFacts {
  os: string;
  wsl: boolean;
  tools: Record<string, string>;
  missing: string[];
  network: string[];
  repo?: { root: string; branch?: string; remote?: string };
  project: string[];
  testCommand?: string;
  /** The command that starts Python here: "python3", "python" or "py -3". Undefined when there is none. */
  python?: string;
}

const TOOLS = [
  "git", "rg", "fd", "fdfind", "jq", "node", "npm", "pnpm", "yarn", "bun", "deno", "uv", "pip3", "poetry",
  "go", "cargo", "java", "docker", "make", "gh", "tmux", "pandoc", "apt-get", "brew", "winget",
];

/**
 * How to start Python on this machine. Windows: prefer `python`, then the `py` launcher, then `python3`;
 * skip the Microsoft Store aliases in ...\WindowsApps\, which only print "Python was not found".
 * Elsewhere: `python3`, then `python`.
 */
export function pythonCommand(probe: Probe): string | undefined {
  const order = probe.platform === "win32" ? ["python", "py", "python3"] : ["python3", "python"];
  const real = (p: string) => !(probe.platform === "win32" && /[\\/]WindowsApps[\\/]/i.test(p));
  for (const name of order) if (which(probe, name, real)) return name === "py" ? "py -3" : name;
  return undefined;
}

export function detectEnv(probe: Probe): EnvFacts {
  join = probe.platform === "win32" ? win32.join : posix.join;
  const wsl = probe.platform === "linux" && (/microsoft|wsl/i.test(probe.release) || Boolean(probe.env.WSL_DISTRO_NAME));
  const os =
    probe.platform === "linux"
      ? `${distro(probe) ?? "Linux"}${wsl ? ` on WSL2 (${probe.env.WSL_DISTRO_NAME ?? "distro"})` : ""}`
      : probe.platform === "darwin"
        ? "macOS"
        : probe.platform === "win32"
          ? "Windows"
          : probe.platform;
  const tools: Record<string, string> = {};
  const missing: string[] = [];
  for (const t of TOOLS) {
    const found = which(probe, t);
    if (found) tools[t] = found;
    else if (["rg", "fd", "jq", "git"].includes(t)) missing.push(t);
  }
  if (!tools.fd && tools.fdfind) missing.splice(missing.indexOf("fd"), 1);
  const python = pythonCommand(probe);
  return { os: `${os} ${probe.arch}`, wsl, tools, missing, network: network(probe), repo: repoInfo(probe), python, ...project(probe, python) };
}

function distro(probe: Probe): string | undefined {
  const text = probe.read("/etc/os-release");
  return text?.match(/^PRETTY_NAME="?([^"\n]+)"?/m)?.[1];
}

function network(probe: Probe): string[] {
  const out: string[] = [];
  const proxy = ["HTTPS_PROXY", "https_proxy", "HTTP_PROXY", "http_proxy", "ALL_PROXY", "all_proxy"].find((k) => probe.env[k]);
  if (proxy) out.push(`proxy is set via ${proxy}`);
  const npmrc = [probe.repoRoot && join(probe.repoRoot, ".npmrc"), join(probe.home, ".npmrc")].filter(Boolean) as string[];
  for (const f of npmrc) {
    const reg = probe.read(f)?.match(/^\s*registry\s*=\s*(\S+)/m)?.[1];
    if (reg && !/registry\.npmjs\.org/.test(reg)) {
      out.push(`npm registry ${reg}`);
      break;
    }
  }
  const pipConf = [join(probe.home, ".config", "pip", "pip.conf"), join(probe.home, ".pip", "pip.conf"), "/etc/pip.conf"];
  for (const f of pipConf) {
    const idx = probe.read(f)?.match(/^\s*index-url\s*=\s*(\S+)/m)?.[1];
    if (idx) {
      out.push(`pip index ${idx}`);
      break;
    }
  }
  if (probe.env.GOPROXY) out.push(`GOPROXY ${probe.env.GOPROXY}`);
  return out;
}

function repoInfo(probe: Probe): EnvFacts["repo"] {
  if (!probe.repoRoot) return undefined;
  const gitPath = join(probe.repoRoot, ".git");
  let gitDir = gitPath;
  const pointer = probe.read(gitPath); // worktrees and submodules store "gitdir: <path>" in a file
  if (pointer?.startsWith("gitdir:")) gitDir = pointer.slice(7).trim();
  const head = probe.read(join(gitDir, "HEAD"))?.trim();
  const branch = head?.startsWith("ref: refs/heads/") ? head.slice(16) : head ? `detached ${head.slice(0, 8)}` : undefined;
  const config = probe.read(join(gitDir, "config")) ?? probe.read(join(gitDir, "..", "..", "config"));
  const url = config?.match(/\[remote "origin"\][^[]*?url\s*=\s*(\S+)/)?.[1];
  const remote = url?.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/]*@/i, "$1"); // never echo credentials embedded in a URL
  return { root: probe.repoRoot, branch, remote };
}

function project(probe: Probe, python: string | undefined): { project: string[]; testCommand?: string } {
  const root = probe.repoRoot ?? probe.cwd;
  const has = (f: string) => probe.exists(join(root, f));
  const lines: string[] = [];
  let testCommand: string | undefined;

  const pkgText = probe.read(join(root, "package.json"));
  if (pkgText) {
    const pkg = safe(() => JSON.parse(pkgText)) as { scripts?: Record<string, string>; packageManager?: string } | undefined;
    const pm = pkg?.packageManager?.split("@")[0] ??
      (has("pnpm-lock.yaml") ? "pnpm" : has("yarn.lock") ? "yarn" : has("bun.lockb") || has("bun.lock") ? "bun" : "npm");
    const scripts = Object.keys(pkg?.scripts ?? {});
    lines.push(`Node project, package manager ${pm}${scripts.length ? `, scripts: ${scripts.slice(0, 14).join(", ")}` : ""}`);
    if (pkg?.scripts?.test && !/no test specified/.test(pkg.scripts.test)) testCommand = `${pm} test`;
  }
  if (has("pyproject.toml") || has("requirements.txt") || has("setup.py")) {
    const tool = has("uv.lock") ? "uv" : has("poetry.lock") ? "poetry" : has("Pipfile") ? "pipenv" : "pip";
    lines.push(`Python project (${tool})${has(".venv") ? ", virtualenv at .venv" : ""}`);
    const py = probe.read(join(root, "pyproject.toml")) ?? "";
    // Inside uv/poetry the environment's own `python` is right; otherwise use whatever starts Python here.
    const interpreter = tool === "uv" ? "uv run python" : tool === "poetry" ? "poetry run python" : python;
    if (!testCommand && interpreter && (/pytest/.test(py) || has("pytest.ini") || has("conftest.py"))) testCommand = `${interpreter} -m pytest -q`;
  }
  if (!testCommand && python && probe.list(root).some((f) => /^test_.*\.py$/.test(f))) testCommand = `${python} -m unittest -q`;
  if (!python && (has("pyproject.toml") || probe.list(root).some((f) => f.endsWith(".py")))) lines.push("Python files present but no working Python found on PATH");
  if (has("go.mod")) {
    lines.push("Go module");
    testCommand ??= "go test ./...";
  }
  if (has("Cargo.toml")) {
    lines.push("Rust crate");
    testCommand ??= "cargo test";
  }
  const makefile = probe.read(join(root, "Makefile"));
  if (makefile) {
    const targets = [...makefile.matchAll(/^([A-Za-z0-9][\w.-]*):(?!=)/gm)].map((m) => m[1]).slice(0, 12);
    lines.push(`Makefile targets: ${targets.join(", ")}`);
    if (!testCommand && targets.includes("test")) testCommand = "make test";
  }
  if (has("docker-compose.yml") || has("compose.yaml") || has("docker-compose.yaml") || has("compose.yml")) lines.push("docker compose file present");
  if (has(".env.example") && !has(".env")) lines.push(".env.example exists but .env does not");
  return { project: lines, testCommand };
}

export function formatEnv(facts: EnvFacts): string {
  const t = facts.tools;
  const runtimes = [
    ...(t.node ? ["node"] : []),
    ...(facts.python ? [`python (run as \`${facts.python}\`)`] : []),
    ...["go", "cargo", "java", "deno", "bun"].filter((k) => t[k]),
  ];
  const pms = ["npm", "pnpm", "yarn", "uv", "pip3", "poetry", "apt-get", "brew", "winget"].filter((k) => t[k]);
  const extras = ["git", "gh", "jq", "docker", "make", "tmux", "pandoc"].filter((k) => t[k]);
  const search = [t.rg ? "rg" : "", t.fd ? "fd" : t.fdfind ? "fdfind (Debian name for fd)" : ""].filter(Boolean);
  const lines = [
    `OS: ${facts.os}`,
    `Runtimes: ${runtimes.join(", ") || "none found"}. Package managers: ${pms.join(", ") || "none found"}.`,
    `Other CLIs: ${extras.join(", ") || "none"}. Fast search: ${search.join(", ") || "none (run the fast-search skill to install)"}.`,
  ];
  if (facts.missing.length) lines.push(`Not installed: ${facts.missing.join(", ")}.`);
  if (facts.wsl) lines.push("WSL: Windows drives are under /mnt/<letter> (slow for heavy I/O); Windows programs run as *.exe; keep repos in the Linux filesystem.");
  if (facts.network.length) lines.push(`Network: ${facts.network.join("; ")}.`);
  if (facts.repo) lines.push(`Git repo ${facts.repo.root}${facts.repo.branch ? ` on ${facts.repo.branch}` : ""}${facts.repo.remote ? `, origin ${facts.repo.remote}` : ""}.`);
  lines.push(...facts.project);
  if (facts.testCommand) lines.push(`Test command (detected): ${facts.testCommand}`);
  return lines.join("\n");
}
