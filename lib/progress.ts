// A team worker watched by code from inside its own session: is it really working, or circling?
// Real runs: lanes spent most of an hour reading code, and re-ran the same failing command, while the lead slept.
// Three rules, all decided from the worker's own tool calls (no polling, no model):
//   - reading without changing anything: a note at `nudgeAfter` read-only calls in a row, and at `blockAfter`
//     (or after twice `stallMin` minutes without a change) read-only calls are refused until it changes a file,
//     runs a check, or asks the lead with contact_supervisor;
//   - running a command that just failed when nothing changed since: refused (it would fail the same way);
//     the third identical failure after changes gets a note to stop and find the cause, or report BLOCKED;
//   - editing a file outside the task's own files: refused, with "ask contact_supervisor".
// Retries after a real change are never limited.

import { baseName, effectiveCommand, splitSegments } from "./shell.ts";
import { classifyCommand } from "./guard.ts";

export interface WatchConfig {
  /** Read-only calls in a row before a note. */
  nudgeAfter: number;
  /** Read-only calls in a row before they are refused. */
  blockAfter: number;
  /** Minutes without changing a file before a note; twice this and read-only calls are refused. */
  stallMin: number;
}

export const DEFAULT_WATCH: WatchConfig = { nudgeAfter: 12, blockAfter: 25, stallMin: 20 };

const READ_TOOLS = new Set(["read", "grep", "find", "ls"]);
const READ_PROGRAMS = new Set([
  "cat", "head", "tail", "less", "more", "ls", "ll", "tree", "pwd", "wc", "file", "stat", "du", "df", "which", "type", "whereis",
  "grep", "egrep", "fgrep", "rg", "ag", "ack", "find", "fd", "fdfind", "locate", "nl", "cut", "sort", "uniq", "diff", "cmp",
  "echo", "printf", "true", "basename", "dirname", "realpath", "readlink", "env", "printenv", "date", "jq", "yq", "column", "od", "xxd", "hexdump", "strings",
]);
const GIT_READ = new Set(["log", "show", "diff", "status", "blame", "grep", "ls-files", "rev-parse", "branch", "describe", "shortlog", "cat-file", "ls-tree"]);

/** A shell command that only looks at things: every part of it is a reading program (sed/awk without writing, git log...). */
export function isReadOnlyCommand(command: string): boolean {
  const segs = splitSegments(command);
  if (!segs.length) return false;
  for (const seg of segs) {
    if (/(^|[^<>&0-9])>{1,2}(?!&)|\btee\b/.test(seg.text.replace(/2>&1|>\s*\/dev\/null|2>\s*\/dev\/null/g, ""))) return false;
    const argv = effectiveCommand(seg.argv).argv;
    if (!argv.length) continue;
    const prog = baseName(argv[0]);
    if (prog === "cd" || prog === "pushd" || prog === "popd") continue;
    if (prog === "git") {
      const sub = argv.slice(1).find((a) => !a.startsWith("-"));
      if (!sub || !GIT_READ.has(sub)) return false;
      continue;
    }
    if (prog === "sed") {
      if (argv.some((a) => /^-[a-zA-Z]*i/.test(a) || a === "--in-place" || a.startsWith("--in-place="))) return false;
      continue;
    }
    if (prog === "awk" || prog === "gawk") {
      if (/system\s*\(|>\s*"/.test(seg.text)) return false;
      continue;
    }
    if (!READ_PROGRAMS.has(prog)) return false;
  }
  return true;
}

/** The files a worker or sub-worker owns, from its task text ("Files you own (...):" then "- path" lines). */
export function ownedFiles(task: string): string[] | undefined {
  const m = /Files you own[^\n]*:\n((?:- [^\n]+\n?)+)/.exec(task);
  if (!m) return undefined;
  const files = m[1].split("\n").map((l) => l.replace(/^- /, "").trim().replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "")).filter(Boolean);
  return files.length ? files : undefined;
}

function globRegex(pattern: string): RegExp {
  let re = "";
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === "*") {
      if (pattern[i + 1] === "*") {
        re += pattern[i + 2] === "/" ? "(?:.*/)?" : ".*";
        i += pattern[i + 2] === "/" ? 2 : 1;
      } else re += "[^/]*";
    } else if (c === "?") re += "[^/]";
    else if (c === "{") {
      const end = pattern.indexOf("}", i);
      if (end < 0) re += "\\{";
      else {
        re += `(?:${pattern.slice(i + 1, end).split(",").map((s) => s.replace(/[.+^$()|[\]\\]/g, "\\$&")).join("|")})`;
        i = end;
      }
    } else re += c.replace(/[.+^$()|[\]\\]/g, "\\$&");
  }
  return new RegExp(`^${re}$`);
}

/** Is `rel` (relative to the worktree root, forward slashes) inside one of the owned paths or globs? */
export function ownsPath(patterns: string[], rel: string): boolean {
  const p = rel.replace(/\\/g, "/").replace(/^\.\//, "");
  return patterns.some((g) => {
    if (g === "**" || g === "*") return true;
    if (!/[*?[{]/.test(g)) return p === g || p.startsWith(`${g}/`);
    return globRegex(g).test(p) || globRegex(`${g}/**`).test(p);
  });
}

/** The parts of a failure that stay the same between runs (no times, counts, addresses, temp paths). */
export function failureSignature(output: string): string {
  const lines = output
    .replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "")
    .split(/\r?\n/)
    .map((l) => l.replace(/0x[0-9a-f]+/gi, "#").replace(/\/tmp\/\S+/g, "#").replace(/\d+(\.\d+)?/g, "#").replace(/\s+/g, " ").trim())
    .filter(Boolean);
  const key = lines.filter((l) => /fail|error|exception|assert|traceback|panic|cannot|not found|denied|exit(ed)? (with )?code/i.test(l));
  return (key.length ? key : lines.slice(-20)).slice(0, 60).join("\n");
}

/** One command, as the same failure is recognised by: the main command without leading cd/export, whitespace folded. */
export function commandKey(command: string): string {
  const segs = splitSegments(command).filter((s) => !/^(cd|pushd|export|set|source|\.)$/.test(baseName(effectiveCommand(s.argv).argv[0] ?? "")));
  return (segs.length ? segs.map((s) => s.text).join(" && ") : command).replace(/\s+/g, " ").trim();
}

export interface Verdict {
  block?: string;
}

export class WorkerWatch {
  private readStreak = 0;
  private lastChangeAt: number;
  private readNoted = false;
  private stallNoted = false;
  /** Failing commands by commandKey; `changedSince` turns true when a file or another command changes something. */
  private failures = new Map<string, { sig: string; count: number; changedSince: boolean }>();

  private cfg: WatchConfig;
  private owned: string[] | undefined;
  private now: () => number;

  constructor(cfg: WatchConfig, owned: string[] | undefined, now: () => number = Date.now) {
    this.cfg = cfg;
    this.owned = owned;
    this.now = now;
    this.lastChangeAt = now();
  }

  private stalledHard(): boolean {
    return this.now() - this.lastChangeAt > 2 * this.cfg.stallMin * 60_000;
  }

  private isRead(tool: string, command?: string): boolean {
    return READ_TOOLS.has(tool) || (tool === "bash" && command !== undefined && isReadOnlyCommand(command));
  }

  private mins(): number {
    return Math.round((this.now() - this.lastChangeAt) / 60_000);
  }

  /** Before a tool runs: refuse it, or let it go. `rel` is the edited path relative to the worktree (edit/write). */
  before(tool: string, input: { command?: string }, rel?: string): Verdict {
    if (tool === "contact_supervisor") return {};
    if ((tool === "edit" || tool === "write") && rel !== undefined && this.owned && !ownsPath(this.owned, rel))
      return {
        block: `${rel} is outside the files this task owns (${this.owned.join(", ")}). Do not work around it: if the task needs this file, call contact_supervisor with reason "need_decision", say which file and why, and wait for the answer.`,
      };
    if (this.isRead(tool, input.command) && (this.readStreak >= this.cfg.blockAfter || this.stalledHard()))
      return {
        block:
          (this.readStreak >= this.cfg.blockAfter ? `${this.readStreak} read-only calls in a row` : `${this.mins()} minutes`) +
          " without changing anything, so more reading is refused. Do one of these now: make the change the brief asks for (write what you have if it is research), run the task's check, or call contact_supervisor with reason \"need_decision\" saying what you tried and exactly what is missing.",
      };
    if (tool === "bash" && input.command) {
      const f = this.failures.get(commandKey(input.command));
      if (f && !f.changedSince)
        return {
          block: `\`${commandKey(input.command)}\` failed last time and nothing has changed since (no file edited, no other command run), so it would fail the same way. Read that failure and change something first; if you do not know what to change, report BLOCKED or call contact_supervisor with the failure and what you tried.`,
        };
    }
    return {};
  }

  /** After a tool ran: a note to add to its result, if any. */
  after(tool: string, input: { command?: string }, failed: boolean, output: string): string | undefined {
    const notes: string[] = [];
    if (tool === "contact_supervisor") {
      this.readStreak = 0;
      this.lastChangeAt = this.now();
      this.readNoted = this.stallNoted = false;
      return undefined;
    }
    if (this.isRead(tool, input.command)) {
      this.readStreak++;
      if (this.readStreak >= this.cfg.nudgeAfter && !this.readNoted) {
        this.readNoted = true;
        const where = this.owned?.length ? ` The brief says where: ${this.owned.slice(0, 4).join(", ")}.` : "";
        notes.push(`${this.readStreak} read-only calls in a row without a change.${where} Start the change now. If something you need is missing or unclear, call contact_supervisor (reason "need_decision") and say exactly what.`);
      }
    } else if (tool === "edit" || tool === "write") {
      if (!failed) this.changed();
    } else if (tool === "bash" && input.command) {
      const key = commandKey(input.command);
      this.readStreak = 0;
      this.readNoted = false;
      // Any other command may have changed what the failing one depends on (an install, a generated file).
      for (const [k, f] of this.failures) if (k !== key) f.changedSince = true;
      if (failed) {
        const sig = failureSignature(output);
        const prev = this.failures.get(key);
        const count = prev && prev.sig === sig ? prev.count + 1 : 1;
        this.failures.set(key, { sig, count, changedSince: false });
        if (count === 3)
          notes.push(`Third time \`${key}\` failed the same way. Stop changing things to see what happens: write down the cause you believe and the evidence. If you cannot find it, report BLOCKED with what you tried, or call contact_supervisor.`);
      } else {
        this.failures.delete(key);
        // A passing check is work, not a change; anything else that ran (a generator, an install, a move) changed files.
        const cls = classifyCommand(input.command);
        if (cls !== "test" && cls !== "build") this.changed();
      }
    }
    if (!this.stallNoted && this.now() - this.lastChangeAt > this.cfg.stallMin * 60_000) {
      this.stallNoted = true;
      notes.push(`${this.mins()} minutes without changing a file. If you are stuck, say so now with contact_supervisor (what you tried, what is missing) instead of searching further.`);
    }
    return notes.length ? notes.join("\n") : undefined;
  }

  private changed(): void {
    for (const f of this.failures.values()) f.changedSince = true;
    this.readStreak = 0;
    this.readNoted = this.stallNoted = false;
    this.lastChangeAt = this.now();
  }
}
