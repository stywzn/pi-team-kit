// Worker worktrees get the project's virtualenv and ignored local config before the first turn.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { test } from "node:test";
import { activateVenv, describePrep, isWorkerWorktree, mainCheckout, prepareWorktree } from "../lib/worktree.ts";

const git = (cwd: string, ...args: string[]) => {
  const r = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@localhost", ...args], { cwd, encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  return r.stdout;
};

test("a pi-subagents worktree gets the virtualenv activated, ignored files copied, never anything git would commit", () => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "ptk-wt-")));
  const main = join(root, "hostapp-test");
  mkdirSync(join(main, ".venv", "bin"), { recursive: true });
  writeFileSync(join(main, ".venv", "pyvenv.cfg"), "home = /usr/bin\n");
  mkdirSync(join(main, "node_modules", "left-pad"), { recursive: true });
  mkdirSync(join(main, "build"), { recursive: true });
  writeFileSync(join(main, "build", "out.js"), "x\n");
  // "build/" ignores only folders: a symlink named build would not be ignored and would land in the patch
  writeFileSync(join(main, ".gitignore"), ".venv/\nnode_modules\nbuild/\n.env\n");
  writeFileSync(join(main, "test_app.py"), "import unittest\n");
  git(root, "init", "-q", "-b", "main", main);
  git(main, "add", "-A");
  git(main, "commit", "-q", "-m", "init");
  writeFileSync(join(main, ".env"), "BASE_URL=http://localhost:8080\n");
  writeFileSync(join(main, "notes.txt"), "untracked but not ignored\n");
  const wt = join(root, "pi-worktree-login-0");
  git(main, "worktree", "add", "-q", "-b", "pi-subagents/login", wt);

  assert.equal(mainCheckout(wt), main);
  assert.equal(isWorkerWorktree(wt), true);
  assert.equal(isWorkerWorktree(main), false, "the main checkout is no worker worktree");
  const ignored = (rel: string) => spawnSync("git", ["-C", wt, "check-ignore", "-q", "--", rel]).status === 0;
  const prep = prepareWorktree(main, wt, [".venv", ".env", "node_modules", "build", "notes.txt", "../escape", "missing.cfg"], ignored, "linux");
  assert.equal(prep.venv, join(main, ".venv"), "the virtualenv is activated, not copied");
  assert.equal(existsSync(join(wt, ".venv")), false);
  assert.deepEqual(prep.copied, [".env"]);
  assert.equal(readFileSync(join(wt, ".env"), "utf8"), "BASE_URL=http://localhost:8080\n");
  // (creating symlinks needs a privilege on a Windows host, so the link itself is checked elsewhere)
  if (process.platform !== "win32") {
    assert.deepEqual(prep.linked, ["node_modules"]);
    assert.equal(lstatSync(join(wt, "node_modules")).isSymbolicLink(), true);
  }
  assert.ok(prep.skipped.some((s) => s.startsWith("notes.txt: not ignored by git")), "it would end up in the patch");
  assert.ok(prep.skipped.some((s) => s.startsWith("build: not ignored by git")), "a folder-only pattern does not cover a link");
  assert.equal(existsSync(join(wt, "build")), false);
  assert.ok(prep.skipped.some((s) => s.startsWith("../escape: must be a path inside the repo")));
  assert.equal(git(wt, "status", "--porcelain"), "", "nothing placed shows up in git: the patch stays clean");
  assert.match(describePrep(prep), /virtualenv .* is active \(do not create another one or reinstall packages\); copied from the main checkout: \.env/);

  const again = prepareWorktree(main, wt, [".env"], ignored, "linux");
  assert.deepEqual(again.skipped, [".env: already in the worktree"]);
  const win = prepareWorktree(main, join(root, "pi-worktree-other"), ["node_modules"], ignored, "win32");
  assert.deepEqual(win.skipped, ["node_modules: folders are not linked on Windows"], "a directory link on Windows can be deleted through");
});

test("activating a virtualenv puts its bin first on PATH, once, for this process and what it starts", () => {
  const platform = process.platform === "win32" ? "win32" : "linux";
  const venv = join(tmpdir(), "proj", ".venv");
  const bin = join(venv, platform === "win32" ? "Scripts" : "bin");
  const other = join(tmpdir(), "usr-bin");
  const key = platform === "win32" ? "Path" : "PATH";
  const env: NodeJS.ProcessEnv = { [key]: [other, bin].join(delimiter), PYTHONHOME: "/x" };
  activateVenv(venv, env, platform);
  assert.equal(env[key], [bin, other].join(delimiter), "first, and only once");
  assert.equal(env.VIRTUAL_ENV, venv);
  assert.equal(env.PYTHONHOME, undefined);
  if (platform === "win32") assert.equal(env.PATH, undefined, "Windows: the existing Path key is kept, no second PATH");
});
