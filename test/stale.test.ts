import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileFingerprint, SeenFiles } from "../lib/stale.ts";

test("stale writes: an existing file must have been read, and still be what was read, before it is rewritten whole", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptk-stale-"));
  const f = join(dir, "cases.yaml");
  writeFileSync(f, "cases: [a]\n");
  const seen = new SeenFiles();
  assert.match(seen.writeProblem(f, "cases.yaml") ?? "", /already exists and this session has not read it/);
  seen.saw(f);
  assert.equal(seen.writeProblem(f, "cases.yaml"), undefined, "read and unchanged: fine");
  writeFileSync(f, "cases: [a, b]  # another session\n");
  assert.match(seen.writeProblem(f, "cases.yaml") ?? "", /changed on disk since this session last read or wrote it/);
  seen.saw(f); // read again
  assert.equal(seen.writeProblem(f, "cases.yaml"), undefined);
  assert.equal(seen.writeProblem(join(dir, "new.py"), "new.py"), undefined, "a new file is fine");
  assert.equal(seen.writeProblem(dir, "dir"), undefined, "a folder is not judged here");
  // the same size and a rewrite within the same millisecond still count: content is compared
  const g = join(dir, "same.txt");
  writeFileSync(g, "aaaa");
  seen.saw(g);
  writeFileSync(g, "bbbb");
  assert.match(seen.writeProblem(g, "same.txt") ?? "", /changed on disk/);
  assert.equal(fileFingerprint(join(dir, "missing")), "gone");
});

test("stale writes: remembering is bounded", () => {
  let n = 0;
  const seen = new SeenFiles(() => `fp${n}`, 3);
  for (const f of ["a", "b", "c", "d"]) seen.saw(f);
  assert.match(seen.writeProblem("a", "a") ?? "", /has not read it/, "the oldest is forgotten past the limit");
  assert.equal(seen.writeProblem("d", "d"), undefined);
  n = 1;
  assert.match(seen.writeProblem("d", "d") ?? "", /changed on disk/);
});
