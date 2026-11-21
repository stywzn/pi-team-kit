// Decide, before pi runs a bash command, whether it would hang, waste time, or hit a known pitfall.
// Pure functions: everything the decision needs is passed in, so tests cover every rule.

import type { SearchPolicy } from "./config.ts";
import { baseName, effectiveCommand, hasFlag, splitSegments, type Segment } from "./shell.ts";

export interface Pitfall {
  id: string;
  /** Regular expression tested against the whole command. */
  match: string;
  /** Optional regular expression tested against the working directory. */
  when?: string;
  action: "block" | "warn";
  message: string;
}

export interface GuardOptions {
  blockLongRunners: boolean;
  preferFastSearch: SearchPolicy;
  sudoNonInteractive: boolean;
  hasRg: boolean;
  hasFd: boolean;
  /** pi's own rg/fd backed tools that are active in this session. */
  builtinSearch: { grep: boolean; find: boolean };
  pitfalls: Pitfall[];
  cwd: string;
}

export type GuardDecision =
  | { kind: "allow"; command: string; notes: string[] }
  | { kind: "block"; reason: string };

const BG_HINT =
  "Run it in the background instead: toolbox run bg with args [\"start\", \"<name>\", \"--wait-for\", \"<regex | :port | http://url>\", \"--\", <command...>], " +
  "then [\"logs\", \"<name>\"] to read output and [\"stop\", \"<name>\"] when done. " +
  "If you only need one pass (tests, a build), drop the watch/dev flag instead.";

/** Why a simple command would never finish on its own, or undefined. */
export function longRunnerReason(seg: Segment): string | undefined {
  if (seg.background) return undefined;
  const eff = effectiveCommand(seg.argv);
  if (eff.bounded || eff.detached || eff.argv.length === 0) return undefined;
  const argv = eff.argv;
  const prog = baseName(argv[0]);
  const rest = argv.slice(1);
  const sub = rest.find((a) => !a.startsWith("-"));
  const has = (...flags: string[]) => rest.some((a) => flags.includes(a) || flags.some((f) => a.startsWith(f + "=")));

  // The Windows `py` launcher: `py -3.12 -m http.server` is `python -m http.server`.
  if (prog === "py") return longRunnerReason({ ...seg, argv: ["python", ...stripPyVersion(rest)] });

  const devScripts = new Set(["dev", "start", "serve", "watch", "preview", "develop"]);
  if (["npm", "pnpm", "yarn", "bun"].includes(prog)) {
    const script = sub === "run" || sub === "run-script" ? rest[rest.indexOf(sub) + 1] : sub;
    if (script && devScripts.has(script)) return `\`${prog} ${sub === script ? script : `run ${script}`}\` starts a server or watcher`;
    if (sub && ["exec", "dlx", "x"].includes(sub)) return longRunnerReason({ ...seg, argv: rest.slice(rest.indexOf(sub) + 1) });
    return undefined;
  }
  if (prog === "npx" || prog === "bunx" || prog === "pnpx") {
    const args = rest.filter((a) => a !== "-y" && a !== "--yes" && !a.startsWith("--package"));
    return args.length ? longRunnerReason({ ...seg, argv: args }) : undefined;
  }

  const watchFlag = has("--watch", "-w", "--watchAll", "--watch-all");
  if (["vite", "next", "nuxt", "nuxi", "astro", "remix", "svelte-kit", "gatsby", "docusaurus"].includes(prog)) {
    if (prog === "vite" && !rest.some((a) => ["build", "optimize", "--help", "-h", "--version", "-v"].includes(a))) return "`vite` without `build` starts a dev server";
    if (sub && ["dev", "start", "serve", "preview", "develop"].includes(sub)) return `\`${prog} ${sub}\` starts a server`;
    return undefined;
  }
  if (["nodemon", "live-server", "http-server", "browser-sync", "serve", "json-server", "watchexec", "entr"].includes(prog))
    return `\`${prog}\` keeps running until stopped`;
  if (["tsc", "jest", "vitest", "mocha", "esbuild", "rollup", "webpack", "tailwindcss", "sass", "babel"].includes(prog) && watchFlag)
    return `\`${prog}\` in watch mode never exits`;
  // Test tooling that waits for a human: report servers, GUIs, watch modes.
  if (prog === "playwright" && sub === "show-report") return "`playwright show-report` starts a report server";
  if (prog === "playwright" && sub === "test" && has("--ui", "--debug", "--headed-debug")) return "`playwright test --ui/--debug` is interactive";
  if (prog === "cypress" && sub === "open") return "`cypress open` is an interactive GUI (use `cypress run`)";
  if (prog === "ng" && sub === "test" && !has("--watch=false", "--no-watch")) return "`ng test` watches by default (add --watch=false)";
  if (prog === "karma" && sub === "start" && !has("--single-run")) return "`karma start` watches by default (add --single-run)";
  if (["ptw", "pytest-watch", "pytest-watcher"].includes(prog)) return `\`${prog}\` re-runs tests forever`;
  if (prog === "pytest" && has("--looponfail", "-f")) return "`pytest --looponfail` waits for file changes";
  if (prog === "vitest" && (sub === "watch" || sub === "dev" || has("--ui"))) return "`vitest watch/--ui` never exits (use `vitest run`)";
  if (prog === "webpack" && sub === "serve") return "`webpack serve` starts a dev server";
  if (prog === "ng" && sub === "serve") return "`ng serve` starts a dev server";
  if (prog === "tsx" && sub === "watch") return "`tsx watch` never exits";
  if (prog === "cargo" && sub === "watch") return "`cargo watch` never exits";
  if (prog === "watch") return "`watch` repeats forever";
  if (["tail", "journalctl"].includes(prog) && (hasFlag(rest, "f", "--follow") || hasFlag(rest, "F")))
    return `\`${prog} -f\` follows output forever`;
  if (["docker", "kubectl", "podman"].includes(prog) && sub === "logs" && hasFlag(rest, "f", "--follow"))
    return `\`${prog} logs -f\` follows output forever`;
  if (prog === "kubectl" && sub === "port-forward") return "`kubectl port-forward` keeps running";
  if ((prog === "docker" || prog === "podman") && sub === "compose" && rest.includes("up") && !hasFlag(rest, "d", "--detach"))
    return "`docker compose up` without `-d` stays attached";
  if (prog === "docker-compose" && sub === "up" && !hasFlag(rest, "d", "--detach")) return "`docker-compose up` without `-d` stays attached";
  if ((prog === "docker" || prog === "podman") && (sub === "run" || sub === "exec") && hasFlag(rest, "t") && hasFlag(rest, "i"))
    return `\`${prog} ${sub} -it\` needs an interactive terminal`;
  if (/^python(\d(\.\d+)?)?$/.test(prog)) {
    if (rest.length === 0) return "a bare `python` opens an interactive prompt";
    const m = rest.indexOf("-m");
    const mod = m >= 0 ? rest[m + 1] : undefined;
    if (mod && ["http.server", "SimpleHTTPServer", "flask", "uvicorn", "streamlit", "jupyter", "notebook"].includes(mod) && !has("--help"))
      return `\`python -m ${mod}\` starts a server`;
    if (rest.some((a) => a.endsWith("manage.py")) && rest.includes("runserver")) return "`manage.py runserver` starts a server";
    return undefined;
  }
  if (["uvicorn", "gunicorn", "hypercorn", "daphne"].includes(prog) && !has("--help", "--version")) return `\`${prog}\` starts a server`;
  if (prog === "flask" && sub === "run") return "`flask run` starts a server";
  if (prog === "streamlit" && sub === "run") return "`streamlit run` starts a server";
  if (prog === "jupyter" && sub && ["notebook", "lab", "server"].includes(sub)) return "`jupyter` starts a server";
  if (["rails", "bin/rails"].includes(argv[0]) && sub && ["s", "server"].includes(sub)) return "`rails server` starts a server";
  if (prog === "php" && (rest.includes("-S") || (rest.includes("artisan") && rest.includes("serve")))) return "`php` dev server keeps running";
  if (["hugo", "jekyll", "mkdocs", "zola"].includes(prog) && sub && ["server", "serve"].includes(sub)) return `\`${prog} ${sub}\` starts a server`;
  if (["node", "deno", "bun", "irb", "ghci", "lua", "R", "julia"].includes(prog) && rest.length === 0)
    return `a bare \`${prog}\` opens an interactive prompt`;
  if (["psql", "mysql", "mariadb", "redis-cli", "sqlite3", "mongosh", "mongo"].includes(prog)) {
    const scripted = has("-c", "--command", "-e", "--execute", "-f", "--file", "--eval") || rest.some((a) => /^-[ce]/.test(a));
    const positional = rest.filter((a) => !a.startsWith("-"));
    if (!scripted && !(prog === "sqlite3" && positional.length >= 2) && !(prog === "redis-cli" && positional.length >= 1))
      return `\`${prog}\` without a command opens an interactive prompt`;
  }
  if (prog === "ssh") {
    // -V prints the version, -G the resolved config, -Q queries supported algorithms: none opens a session.
    if (rest.some((a) => a === "-V" || a === "-G" || a === "-Q" || /^-[a-zA-Z]*V$/.test(a))) return undefined;
    const positional = rest.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[bcDEeFIiJLlmOopQRSWw]$/.test(rest[i - 1])));
    if (positional.length <= 1) return "`ssh` without a remote command opens an interactive shell (give the command to run: ssh host \"cmd\")";
  }
  if (["vim", "vi", "nvim", "nano", "emacs", "micro", "helix", "hx", "less", "more", "most", "top", "htop", "btop", "nload", "iftop", "lazygit", "tig", "mc", "ranger"].includes(prog))
    return `\`${prog}\` is a full-screen interactive program`;
  return undefined;
}

/** Drop the `py` launcher's version selectors (`-3`, `-3.12`, `-3.12-64`, `-V:3.12`). */
export function stripPyVersion(args: string[]): string[] {
  let i = 0;
  while (i < args.length && /^-(\d+(\.\d+)?(-(32|64))?|V:\S+)$/.test(args[i])) i++;
  return args.slice(i);
}

/** A faster equivalent for slow recursive searches, or undefined. */
export function fastSearchHint(seg: Segment, opts: Pick<GuardOptions, "hasRg" | "hasFd" | "builtinSearch">): string | undefined {
  const argv = effectiveCommand(seg.argv).argv;
  if (argv.length === 0) return undefined;
  const prog = baseName(argv[0]);
  const rest = argv.slice(1);
  if ((prog === "grep" || prog === "egrep" || prog === "fgrep") && (hasFlag(rest, "r", "--recursive") || hasFlag(rest, "R", "--dereference-recursive"))) {
    if (!opts.hasRg && !opts.builtinSearch.grep) return undefined;
    const tool = opts.builtinSearch.grep ? "the built-in `grep` tool (ripgrep, respects .gitignore, bounded output) or " : "";
    return `Recursive grep is slow and searches node_modules/.git. Use ${tool}\`rg -n <pattern> [path]\` (\`-i\` ignore case, \`-g '*.ts'\` filter files, \`-l\` names only).`;
  }
  if (prog === "find") {
    const simple = new Set(["-name", "-iname", "-type", "-path", "-ipath", "-maxdepth", "-mindepth", "-not", "!", "-o", "-or", "-print", "-a", "-and"]);
    const flags = rest.filter((a) => a.startsWith("-") || a === "!");
    if (flags.length === 0 || !flags.every((f) => simple.has(f))) return undefined;
    if (!rest.some((a) => ["-name", "-iname", "-path", "-ipath"].includes(a))) return undefined;
    if (!opts.hasFd && !opts.builtinSearch.find) return undefined;
    const tool = opts.builtinSearch.find ? "the built-in `find` tool (fd, respects .gitignore) or " : "";
    return `Use ${tool}\`fd <regex> [path]\` (\`-e ts\` by extension, \`-t f\` files only, \`-g '*.md'\` glob, \`-H\` include hidden).`;
  }
  if (prog === "ls" && hasFlag(rest, "R", "--recursive") && (opts.hasFd || opts.builtinSearch.find)) {
    return "`ls -R` dumps everything. Use `fd . [path]` (add `-t f`, `-e ext`, `--max-depth N`) or the built-in `ls`/`find` tools.";
  }
  return undefined;
}

/** Also look inside `bash -c "..."`, `sh -c '...'` and `eval ...`, so wrapping a command does not hide it. */
export function expandSegments(segments: Segment[], depth = 0): Segment[] {
  if (depth > 3) return segments;
  const out: Segment[] = [];
  for (const seg of segments) {
    out.push(seg);
    const argv = effectiveCommand(seg.argv).argv;
    const prog = argv.length ? baseName(argv[0]) : "";
    let inner: string | undefined;
    if (["bash", "sh", "zsh", "dash", "ksh"].includes(prog)) {
      const c = argv.findIndex((a, i) => i > 0 && /^-[a-z]*c[a-z]*$/.test(a));
      if (c > 0) inner = argv[c + 1];
    } else if (prog === "eval") inner = argv.slice(1).join(" ");
    if (inner) {
      const nested = splitSegments(inner).map((s) => ({ ...s, background: s.background || seg.background }));
      out.push(...expandSegments(nested, depth + 1));
    }
  }
  return out;
}

export type CommandClass = "test" | "build" | "default";

const TEST_PROGS = new Set(["pytest", "py.test", "jest", "vitest", "mocha", "ava", "tap", "karma", "tox", "nox", "phpunit", "rspec", "ctest", "behave", "robot"]);
const PKG_MANAGERS = new Set(["npm", "pnpm", "yarn", "bun"]);

/** Decide which default timeout a command gets. Tests may take long; most other commands should not. */
export function classifyCommand(command: string): CommandClass {
  let cls: CommandClass = "default";
  for (const seg of expandSegments(splitSegments(command))) {
    let argv = effectiveCommand(seg.argv).argv;
    if (argv.length === 0) continue;
    let prog = baseName(argv[0]);
    // npx playwright test, uv run pytest, poetry run pytest, python -m pytest
    if (["npx", "bunx", "pnpx"].includes(prog) || ((prog === "uv" || prog === "poetry" || prog === "pdm" || prog === "pipenv") && argv[1] === "run")) {
      argv = argv.slice(prog === "npx" || prog === "bunx" || prog === "pnpx" ? 1 : 2).filter((a) => a !== "-y" && a !== "--yes");
      prog = argv.length ? baseName(argv[0]) : "";
    }
    if (prog === "py") {
      argv = ["python", ...stripPyVersion(argv.slice(1))];
      prog = "python";
    }
    if (/^python(\d(\.\d+)?)?$/.test(prog) && argv[1] === "-m") {
      argv = argv.slice(2);
      prog = argv[0] ?? "";
    }
    const sub = argv.slice(1).find((a) => !a.startsWith("-"));
    const isTest =
      TEST_PROGS.has(prog) ||
      prog === "unittest" ||
      (prog === "playwright" && sub === "test") ||
      (prog === "cypress" && sub === "run") ||
      (prog === "go" && sub === "test") ||
      (prog === "cargo" && (sub === "test" || sub === "nextest")) ||
      (prog === "dotnet" && sub === "test") ||
      (prog === "deno" && sub === "test") ||
      ((prog === "mvn" || prog === "mvnw") && argv.some((a) => a === "test" || a === "verify")) ||
      ((prog === "gradle" || prog === "gradlew") && argv.some((a) => a === "test" || a === "check")) ||
      (PKG_MANAGERS.has(prog) && (sub === "test" || sub === "t" || ((sub === "run" || sub === "run-script") && /^(test|e2e|spec)/.test(argv[argv.indexOf(sub) + 1] ?? "")))) ||
      (prog === "make" && argv.slice(1).some((a) => /^(test|check|e2e)/.test(a)));
    if (isTest) return "test";
    const isBuild =
      (PKG_MANAGERS.has(prog) && ["install", "i", "ci", "add", "update", "upgrade"].includes(sub ?? "")) ||
      (PKG_MANAGERS.has(prog) && (sub === "run" || sub === "run-script") && /^build/.test(argv[argv.indexOf(sub) + 1] ?? "")) ||
      (/^pip\d?$/.test(prog) && sub === "install") ||
      (prog === "uv" && ["sync", "add", "pip", "lock"].includes(sub ?? "")) ||
      (prog === "poetry" && ["install", "add", "lock", "update"].includes(sub ?? "")) ||
      ((prog === "apt-get" || prog === "apt" || prog === "dnf" || prog === "brew") && ["install", "update", "upgrade"].includes(sub ?? "")) ||
      ((prog === "cargo" || prog === "go") && ["build", "install", "fetch"].includes(sub ?? "")) ||
      ((prog === "mvn" || prog === "mvnw") && argv.some((a) => a === "package" || a === "install")) ||
      ((prog === "gradle" || prog === "gradlew") && argv.some((a) => a === "build" || a === "assemble")) ||
      (prog === "docker" && (["build", "pull"].includes(sub ?? "") || (sub === "compose" && argv.some((a) => a === "build" || a === "pull")))) ||
      (prog === "playwright" && sub === "install") ||
      prog === "make" ||
      (prog === "cmake" && argv.includes("--build"));
    if (isBuild) cls = "build";
  }
  return cls;
}

function safeRegExp(source: string): RegExp | undefined {
  try {
    return new RegExp(source);
  } catch {
    return undefined;
  }
}

export function inspectBash(command: string, opts: GuardOptions): GuardDecision {
  const notes: string[] = [];
  const probeText = command.slice(0, 4000);
  for (const p of opts.pitfalls) {
    if (unsafeRegex(p.match)) continue;
    const re = safeRegExp(p.match);
    if (!re || !re.test(probeText)) continue;
    if (p.when && !safeRegExp(p.when)?.test(opts.cwd)) continue;
    if (p.action === "block") return { kind: "block", reason: `Known pitfall "${p.id}": ${p.message}` };
    notes.push(`Known pitfall "${p.id}": ${p.message}`);
  }

  const segments = expandSegments(splitSegments(command));
  if (opts.blockLongRunners) {
    for (const seg of segments) {
      const why = longRunnerReason(seg);
      if (why) return { kind: "block", reason: `This command would not finish on its own: ${why}. ${BG_HINT}` };
    }
  }

  if (opts.preferFastSearch !== "off") {
    for (const seg of segments) {
      const hint = fastSearchHint(seg, opts);
      if (!hint) continue;
      // `ls -R` on a small tree is harmless; only nudge. Recursive grep/find are the real time sinks.
      const soft = hint.startsWith("`ls -R`");
      if (opts.preferFastSearch === "block" && !soft) return { kind: "block", reason: hint };
      notes.push(hint);
      break;
    }
  }

  let patched = command;
  if (opts.sudoNonInteractive && segments.some((s) => s.argv.find((w) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) === "sudo")) {
    patched = patched.replace(
      /(^|[;&|\n(]\s*)((?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)sudo(?=\s)(?!\s+-(?:n|S|v|k|K|h|V|l)\b)(?!\s+--(?:non-interactive|stdin|help|version))/g,
      "$1$2sudo -n",
    );
    if (patched !== command) notes.push("Ran sudo as `sudo -n`: if it needs a password it fails right away. Ask the user to run it, don't retry.");
  }
  return { kind: "allow", command: patched, notes };
}

/** Saved pitfall regexes run on every bash call, so refuse shapes prone to catastrophic backtracking. */
export function unsafeRegex(source: string): boolean {
  return /\((?:[^()\\]|\\.)*[+*](?:[^()\\]|\\.)*\)\s*[+*{]/.test(source) || source.length > 300;
}

// Shell builtins and keywords: `source .venv/bin/activate && pytest` starts pytest, not a program called source.
const SHELL_BUILTINS = new Set(["cd", "pushd", "popd", "source", ".", "export", "set", "unset", "alias", "true", ":", "shopt", "ulimit", "umask", "trap", "if", "then", "for", "while", "do", "{", "("]);

/** The program a gate command starts, skipping `VAR=x`, wrappers and shell builtins: `CI=1 python -m pytest` -> `python`. */
export function gateProgram(gate: string): string | undefined {
  for (const seg of splitSegments(gate)) {
    const prog = effectiveCommand(seg.argv).argv[0];
    if (prog && !SHELL_BUILTINS.has(prog)) return prog;
  }
  return undefined;
}

/** `./run_tests.sh`, `scripts/test`, `C:\tools\x.exe`: a file, not a command looked up on PATH. */
export function isPathLike(program: string): boolean {
  return /[\\/]/.test(program) || program.startsWith(".");
}

export type GatePreflight =
  | { kind: "skip"; reason: string }
  | { kind: "file"; path: string }
  | { kind: "command"; program: string };

/**
 * What the gate preflight may safely do. It must never run the suite and never block a valid gate, so it
 * only judges a gate whose first command is the program itself. Setup steps (`cd`, `source venv`, `export`)
 * change what the program resolves to, and shell expansions ($VAR, ~, globs) are not expanded here:
 * both are skipped rather than guessed.
 */
export function gatePreflight(gate: string): GatePreflight {
  const first = splitSegments(gate)[0];
  const prog = first ? effectiveCommand(first.argv).argv[0] : undefined;
  if (!prog) return { kind: "skip", reason: "no program found" };
  if (SHELL_BUILTINS.has(prog) || prog === "cd") return { kind: "skip", reason: "has setup steps before the program" };
  if (/[$`~*?[\]{}()]/.test(prog)) return { kind: "skip", reason: "uses shell expansion" };
  // `2>test.log pytest`, `>out npm test`: a leading redirection is not the program.
  if (/[<>|&;]/.test(prog)) return { kind: "skip", reason: "starts with a redirection" };
  if (isPathLike(prog)) return { kind: "file", path: prog };
  return { kind: "command", program: prog };
}

/**
 * Output of `<program> --version` that means the program cannot run here at all (not that tests failed).
 * Exit 0 always means it runs, whatever it printed.
 */
export function looksUnrunnable(code: number | null, output: string): boolean {
  if (code === 0) return false;
  return (
    code === 127 ||
    code === 9009 ||
    /command not found|is not recognized as an internal or external command|Python was not found|No such file or directory|cannot execute/i.test(output)
  );
}

/** Prefix test commands with CI=1 unless the command or environment already sets CI.
 *  Bash syntax on purpose: the guard only rewrites pi's `bash` tool, which runs bash everywhere (Git Bash on Windows). */
export function withCi(command: string, env: NodeJS.ProcessEnv): string {
  if (env.CI !== undefined || /(^|[\s;&|(])(export\s+)?CI=/.test(command)) return command;
  return `export CI=1\n${command}`;
}

/** Timeout to use for a bash call: fill in the default, never exceed the ceiling. */
export function resolveTimeout(requested: unknown, defaultSec: number, maxSec: number): { timeout: number; capped: boolean } {
  if (typeof requested !== "number" || !Number.isFinite(requested) || requested <= 0) return { timeout: defaultSec, capped: false };
  if (requested > maxSec) return { timeout: maxSec, capped: true };
  return { timeout: requested, capped: false };
}

/** pi reports a killed command as `timeout:<seconds>` or "timed out". */
export function looksLikeTimeout(text: string): boolean {
  return /\btimed?[ -]?out\b|\btimeout:\d+/i.test(text);
}

/** Environment that keeps CLIs from waiting on a pager, an editor or a credential prompt. */
export const NON_INTERACTIVE_ENV: Record<string, string> = {
  PAGER: "cat",
  GIT_PAGER: "cat",
  MANPAGER: "cat",
  SYSTEMD_PAGER: "",
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_MERGE_AUTOEDIT: "no",
  GCM_INTERACTIVE: "never",
  DEBIAN_FRONTEND: "noninteractive",
  NPM_CONFIG_YES: "true",
  NPM_CONFIG_FUND: "false",
  NPM_CONFIG_AUDIT: "false",
  NPM_CONFIG_UPDATE_NOTIFIER: "false",
  PIP_NO_INPUT: "1",
  PIP_DISABLE_PIP_VERSION_CHECK: "1",
  HOMEBREW_NO_AUTO_UPDATE: "1",
  HOMEBREW_NO_ENV_HINTS: "1",
  PLAYWRIGHT_HTML_OPEN: "never",
  PW_TEST_HTML_REPORT_OPEN: "never",
  NEXT_TELEMETRY_DISABLED: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DO_NOT_TRACK: "1",
};

/**
 * Seconds a command limits itself to with a leading `timeout N` (GNU coreutils: N, Ns, Nm, Nh), or undefined.
 * The tool's own timeout must be longer, or the tool kills it first and the command's own limit never applies.
 */
export function commandTimeoutSec(command: string): number | undefined {
  const m = /^\s*(?:(?:env\s+)?(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)*)(?:g?timeout)\s+(?:-{1,2}[a-zA-Z-]+(?:[= ](?:\d+[smhd]?|[A-Z]+))?\s+)*(\d+(?:\.\d+)?)([smhd]?)\s+\S/.exec(command);
  if (!m) return undefined;
  const n = Number(m[1]) * ({ s: 1, m: 60, h: 3600, d: 86400 }[m[2] as "s"] ?? 1);
  return Number.isFinite(n) && n > 0 ? Math.ceil(n) : undefined;
}

/**
 * Seconds a command spends sleeping in total (`sleep 178`, `sleep 2m`, PowerShell `Start-Sleep -Seconds 30`,
 * cmd `timeout /t 60`), or 0. A wait loop of sleeps longer than the tool timeout is killed half way otherwise.
 */
export function sleepSeconds(command: string): number {
  const unit = { s: 1, m: 60, h: 3600, d: 86400 } as Record<string, number>;
  let total = 0;
  for (const m of command.matchAll(/(?:^|[\s;&|(])sleep\s+(\d+(?:\.\d+)?)([smhd]?)(?=$|[\s;&|)])/g)) total += Number(m[1]) * (unit[m[2]] ?? 1);
  for (const m of command.matchAll(/Start-Sleep\s+(?:-(?:s|Seconds)\s+)?(\d+(?:\.\d+)?)(?!\s*-?(?:m|ms|Milliseconds))/gi)) total += Number(m[1]);
  for (const m of command.matchAll(/Start-Sleep\s+-(?:m|ms|Milliseconds)\s+(\d+)/gi)) total += Number(m[1]) / 1000;
  for (const m of command.matchAll(/(?:^|[\s;&|(])timeout\s+\/t\s+(\d+)/gi)) total += Number(m[1]);
  return Math.ceil(total);
}
