// A worker's worktree is a fresh checkout: no virtualenv, no .env, no node_modules. Without them a worker
// reinstalls dependencies or fails on missing local config and goes into rework. This prepares the worktree
// when the worker's pi session starts, before its first turn:
//   - a virtualenv of the main checkout is activated for the worker (and the gate it runs), not copied
//   - small local files ignored by git (.env) are copied
//   - folders ignored by git (node_modules) are symlinked, except on Windows, where a directory link can be
//     deleted through by cleanup tools and take the original with it
// Only paths git ignores *in the worktree* are ever placed: anything else would end up in the worker's patch.
// The check runs before the path exists there, so git judges it as a file, which is how it sees a symlink too:
// a "node_modules/" pattern (folders only) does not ignore a link named node_modules, so no link is made.

import { copyFileSync, existsSync, mkdirSync, readFileSync, statSync, symlinkSync } from "node:fs";
import { basename, delimiter, dirname, isAbsolute, join, resolve } from "node:path";

export interface WorktreePrep {
  venv?: string;
  copied: string[];
  linked: string[];
  skipped: string[];
}

/** The main checkout of a linked worktree (its .git file points into <main>/.git/worktrees/...), or undefined. */
export function mainCheckout(worktree: string): string | undefined {
  try {
    const dotGit = join(worktree, ".git");
    if (!existsSync(dotGit) || statSync(dotGit).isDirectory()) return undefined;
    const pointer = readFileSync(dotGit, "utf8").match(/^gitdir:\s*(.+)$/m)?.[1]?.trim();
    if (!pointer) return undefined;
    // <main>/.git/worktrees/<name>  ->  <main>
    const gitDir = resolve(worktree, pointer);
    const worktreesDir = dirname(gitDir);
    const dotGitDir = dirname(worktreesDir);
    if (basename(worktreesDir) !== "worktrees" || basename(dotGitDir) !== ".git") return undefined;
    return dirname(dotGitDir);
  } catch {
    return undefined;
  }
}

/** A linked worktree of some main checkout. Only checked in subagent processes; pi-subagents' allocators name
 *  their worktrees differently (pi-worktree-*, Worktrunk), so the name is not relied on. */
export const isWorkerWorktree = (cwd: string) => mainCheckout(cwd) !== undefined;

/** `isIgnored(rel)` must ask git in the worktree (git -C <worktree> check-ignore -q -- rel). */
export function prepareWorktree(main: string, worktree: string, names: string[], isIgnored: (rel: string) => boolean, platform = process.platform): WorktreePrep {
  const prep: WorktreePrep = { copied: [], linked: [], skipped: [] };
  for (const raw of names) {
    const rel = raw.replace(/\\/g, "/").replace(/^\.\//, "").replace(/\/+$/, "");
    // ":" would be a drive (C:x) or an NTFS stream (file:stream) on Windows
    if (!rel || isAbsolute(rel) || rel.split("/").includes("..") || rel.includes(":")) {
      prep.skipped.push(`${raw}: must be a path inside the repo`);
      continue;
    }
    const src = join(main, rel);
    const dst = join(worktree, rel);
    if (!existsSync(src)) continue;
    try {
      const st = statSync(src);
      if (st.isDirectory() && existsSync(join(src, "pyvenv.cfg"))) {
        if (!prep.venv) prep.venv = src;
        continue;
      }
      if (existsSync(dst)) {
        prep.skipped.push(`${rel}: already in the worktree`);
        continue;
      }
      if (!isIgnored(rel)) {
        prep.skipped.push(`${rel}: not ignored by git, so it would end up in the patch`);
        continue;
      }
      mkdirSync(dirname(dst), { recursive: true });
      if (!st.isDirectory() && !st.isFile()) {
        // a named pipe (1Password mounts .env as one), socket or device: copying would block or leak
        prep.skipped.push(`${rel}: not a regular file`);
        continue;
      }
      if (st.isDirectory()) {
        if (platform === "win32") {
          prep.skipped.push(`${rel}: folders are not linked on Windows`);
          continue;
        }
        symlinkSync(src, dst, "dir");
        prep.linked.push(rel);
      } else if (st.size <= 1_000_000) {
        copyFileSync(src, dst);
        prep.copied.push(rel);
      } else prep.skipped.push(`${rel}: larger than 1 MB`);
    } catch (error) {
      prep.skipped.push(`${rel}: ${(error as Error).message}`);
    }
  }
  return prep;
}

/**
 * In a worker's worktree the shared virtualenv may hold an editable install (pip install -e .) of the main
 * checkout: imports would then load the original code, not the worker's. The worktree (and its src/) go first
 * on PYTHONPATH, ahead of site-packages and editable finders.
 */
export function preferWorktreeCode(worktree: string, env: NodeJS.ProcessEnv): void {
  const first = [join(worktree, "src"), worktree].filter((p) => existsSync(p));
  const rest = (env.PYTHONPATH ?? "").split(delimiter).filter((p) => p && !first.includes(p));
  env.PYTHONPATH = [...first, ...rest].join(delimiter);
}

/** Activate a virtualenv for this process and everything it starts (bash commands, the gate). */
export function activateVenv(venv: string, env: NodeJS.ProcessEnv, platform = process.platform): void {
  const bin = join(venv, platform === "win32" ? "Scripts" : "bin");
  const pathKey = Object.keys(env).find((k) => k.toUpperCase() === "PATH") ?? "PATH";
  const parts = (env[pathKey] ?? "").split(delimiter).filter((p) => p && p !== bin);
  env[pathKey] = [bin, ...parts].join(delimiter);
  env.VIRTUAL_ENV = venv;
  delete env.PYTHONHOME;
}

export function describePrep(p: WorktreePrep): string {
  const parts = [
    p.venv ? `the project's virtualenv ${p.venv} is active (do not create another one or reinstall packages)` : "",
    p.copied.length ? `copied from the main checkout: ${p.copied.join(", ")}` : "",
    p.linked.length ? `linked from the main checkout: ${p.linked.join(", ")}` : "",
  ].filter(Boolean);
  return parts.length ? `This worktree was prepared: ${parts.join("; ")}.` : "";
}
