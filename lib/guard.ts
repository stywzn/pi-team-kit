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
    const positional = rest.filter((a, i) => !a.startsWith("-") && !(i > 0 && /^-[bcDEeFIiJLlmOopQRSWw]$/.test(rest[i - 1])));
    if (positional.length <= 1) return "`ssh` without a remote command opens an interactive shell";
  }
  if (["vim", "vi", "nvim", "nano", "emacs", "micro", "helix", "hx", "less", "more", "most", "top", "htop", "btop", "nload", "iftop", "lazygit", "tig", "mc", "ranger"].includes(prog))
    return `\`${prog}\` is a full-screen interactive program`;
  return undefined;
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

  const segments = splitSegments(command);
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
      if (opts.preferFastSearch === "block") return { kind: "block", reason: hint };
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
  NEXT_TELEMETRY_DISABLED: "1",
  DOTNET_CLI_TELEMETRY_OPTOUT: "1",
  DO_NOT_TRACK: "1",
};
