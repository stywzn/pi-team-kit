// A whole-file write based on an old read throws away what changed since: another lead's edit, a worker's merge, a
// script, a sub-worker in the same worktree. Seen in real use: one cases.yaml rewritten in turn by two or three
// sessions and a script, each time from the version it had read. So a session remembers the content of every file
// it read or wrote, and a whole-file write of an existing file is refused when the file is not what it last saw
// (or it never read it). An edit (replace this text with that) applies to the current content and is not limited.

import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";

const MAX_HASHED = 8_000_000;

/** What a file is now: a content hash (size and mtime for very large files), "gone", or "dir". */
export function fileFingerprint(file: string): string {
  try {
    const st = statSync(file);
    if (st.isDirectory()) return "dir";
    if (st.size > MAX_HASHED) return `big:${st.size}:${st.mtimeMs}`;
    return createHash("sha1").update(readFileSync(file)).digest("hex");
  } catch {
    return "gone";
  }
}

export class SeenFiles {
  private seen = new Map<string, string>();
  private fingerprint: (file: string) => string;
  private max: number;

  constructor(fingerprint: (file: string) => string = fileFingerprint, max = 2000) {
    this.fingerprint = fingerprint;
    this.max = max;
  }

  private key(file: string): string {
    return process.platform === "win32" ? file.toLowerCase() : file;
  }

  /** The session read or wrote this file: remember what it saw. */
  saw(file: string): void {
    const fp = this.fingerprint(file);
    const k = this.key(file);
    this.seen.delete(k);
    if (fp === "gone" || fp === "dir") return;
    this.seen.set(k, fp);
    if (this.seen.size > this.max) this.seen.delete(this.seen.keys().next().value!);
  }

  /** Why a whole-file write of `file` would overwrite content this session has not seen, or undefined. */
  writeProblem(file: string, shown: string): string | undefined {
    const now = this.fingerprint(file);
    if (now === "gone" || now === "dir") return undefined;
    const before = this.seen.get(this.key(file));
    if (before === undefined)
      return `${shown} already exists and this session has not read it: writing the whole file would replace content you have not seen. Read it first, then change it (edit changes part of a file and keeps the rest).`;
    if (before !== now)
      return `${shown} changed on disk since this session last read or wrote it (another session, a worker or a command changed it). Read it again and make your change on the current content; edit, which changes only the part you name, is safer than rewriting the whole file.`;
    return undefined;
  }
}
