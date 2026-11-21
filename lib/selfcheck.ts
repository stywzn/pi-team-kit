// Changing code is half the job; a change nobody checked is not done. Workers are held to a gate and a verifier, the
// lead was held to nothing. Decided by code from the lead's own tool calls, per user request:
//   - the lead changed code files and ran no check since (tests, a build, a linter or type check): before the turn
//     ends it gets one message to run the narrowest check and report the result (once per request);
//   - it changed more than `reviewAfter` code files in this request: the same message also asks for a fresh-context
//     review of the diff (agent team-reviewer), unless one already ran.
// Docs, images and data files do not count; a team run or team_integrate (which runs the gate) counts as checked.

import { classifyCommand } from "./guard.ts";
import { isReadOnlyCommand } from "./progress.ts";
import { splitSegments } from "./shell.ts";

const NOT_CODE = /\.(md|markdown|mdx|txt|rst|adoc|org|csv|tsv|log|png|jpe?g|gif|svg|webp|ico|pdf|docx?|xlsx?|pptx?)$/i;
const CHECK = /(^|[\s;&|(/])(tsc|eslint|biome|oxlint|ruff|flake8|pylint|mypy|pyright|black|isort|prettier|go\s+(vet|build)|golangci-lint|staticcheck|cargo\s+(check|clippy|build)|node\s+--check|py_compile|compileall|shellcheck|bash\s+-n|php\s+-l|rubocop|ktlint|dotnet\s+build|javac|gcc|g\+\+|clang|cmake\s+--build|ninja|terraform\s+validate|helm\s+lint|yamllint|hadolint|vue-tsc|svelte-check|deno\s+(check|lint))(\s|$)|(npm|pnpm|yarn|bun)\s+(run\s+)?(lint|check|typecheck|type-check|build|verify)\b/;

export function isCodeFile(path: string): boolean {
  return !NOT_CODE.test(path);
}

/** A command that checks code: tests, builds, linters, type checkers. */
export function isCheckCommand(command: string): boolean {
  const cls = classifyCommand(command);
  return cls === "test" || cls === "build" || CHECK.test(command);
}

/** A check that rewrites files: formatters, --fix, --write. */
const REWRITES = /(^|\s)(--fix\b|--write\b|-w\b|--in-place\b)|(^|[\s/])(black|isort|autopep8|gofmt|rustfmt)(\s|$)(?!.*--check)|\bruff\s+format\b(?!.*--check)|\bprettier\b(?!.*--check)|\bcargo\s+fmt\b(?!.*--check)/;

/**
 * What a read-only reviewer may run: every part of the command reads (git diff, cat, rg) or checks (tests,
 * linters, type checks) without rewriting files and without writing output to a file.
 */
export function reviewerMayRun(command: string): boolean {
  const segs = splitSegments(command);
  if (!segs.length) return false;
  // A plain variable assignment (the guard puts "export CI=1" in front of test commands) changes no file.
  const assigns = (t: string) => /^\s*(export\s+)?[A-Za-z_]\w*=[\w./:@%+-]*(\s+[A-Za-z_]\w*=[\w./:@%+-]*)*\s*$/.test(t);
  return segs.every((s) => assigns(s.text) || isReadOnlyCommand(s.text) || (isCheckCommand(s.text) && !REWRITES.test(s.text) && !/(^|[^<>&0-9])>{1,2}(?!&)|\btee\b/.test(s.text.replace(/2>&1|>\s*\/dev\/null|2>\s*\/dev\/null/g, ""))));
}

export interface SelfCheckOptions {
  enabled: boolean;
  /** More code files than this changed in one request: ask for a fresh-context review too. 0 = never. */
  reviewAfter: number;
}

export const DEFAULT_SELF_CHECK: SelfCheckOptions = { enabled: true, reviewAfter: 3 };

export class LeadSelfCheck {
  private unchecked = new Set<string>();
  private changed = new Set<string>();
  private roots = new Set<string>();
  private reviewed = false;
  private nudged = false;
  opts: SelfCheckOptions;

  constructor(opts: SelfCheckOptions) {
    this.opts = opts;
  }

  /** A person wrote: a new request. */
  userInput(): void {
    this.unchecked.clear();
    this.changed.clear();
    this.roots.clear();
    this.reviewed = this.nudged = false;
  }

  /** For a takeover: code files changed since the last check, across requests (a new request does not verify them). */
  private sinceCheck = new Set<string>();
  /** The checks that ran, latest last, with their result. */
  checks: { command: string; ok: boolean; at: string }[] = [];

  /** The lead changed a file (`shown` as the user would read it), in the repository `root` when known. */
  edited(shown: string, root?: string): void {
    if (!isCodeFile(shown)) return;
    this.unchecked.add(shown);
    this.changed.add(shown);
    this.sinceCheck.add(shown);
    if (root) this.roots.add(root);
  }

  /** A command ran (failed or not: a failing check is a check; its result is the lead's to report). */
  ran(command: string, failed = false): void {
    if (!isCheckCommand(command)) return;
    this.unchecked.clear();
    this.sinceCheck.clear();
    this.checks = [...this.checks, { command: command.replace(/\s+/g, " ").trim().slice(0, 200), ok: !failed, at: new Date().toISOString() }].slice(-10);
  }

  /** Code files changed after the last check, for the takeover record. */
  uncheckedFiles(): string[] {
    return [...this.sinceCheck];
  }

  /** team_run hands the work to a gate and a verifier; team_integrate runs the gate. */
  delegated(): void {
    this.sinceCheck.clear();
    this.unchecked.clear();
    this.changed.clear();
    this.reviewed = true;
  }

  /** A fresh-context review of the change ran. */
  reviewStarted(): void {
    this.reviewed = true;
  }

  /** The message to add before the turn ends, or undefined. Once per request. */
  /** `testHint`: the repository's test command, or that none was found, so the lead does not go looking. */
  beforeEnd(request: string, testHint = ""): string | undefined {
    if (!this.opts.enabled || this.nudged) return undefined;
    const review = this.opts.reviewAfter > 0 && this.changed.size > this.opts.reviewAfter && !this.reviewed;
    if (!this.unchecked.size && !review) return undefined;
    this.nudged = true;
    const parts: string[] = [];
    const list = (s: Set<string>) => `${[...s].slice(0, 8).join(", ")}${s.size > 8 ? ` and ${s.size - 8} more` : ""}`;
    if (this.unchecked.size)
      parts.push(
        `[ptk] You changed ${list(this.unchecked)} and ran no check since. Before you report, run the narrowest check that proves the change works (the test for it, the build, or the linter/type check) and report its result as it is. If no check applies, say so in one line and why.${testHint ? ` ${testHint}` : ""}`,
      );
    if (review) {
      const where = [...this.roots][0];
      const ask = request.replace(/\s+/g, " ").trim().slice(0, 300) || "what the user asked";
      parts.push(
        `[ptk] This request changed ${this.changed.size} code files. Have the change reviewed with fresh eyes before you report: subagent({ "agent": "team-reviewer", ${where ? `"cwd": ${JSON.stringify(where)}, ` : ""}"task": ${JSON.stringify(`Review the uncommitted change in this repository. The user asked: ${ask}`)} }). Fix the important findings (then check again) or list them in your report.`,
      );
    }
    return parts.join("\n");
  }
}
