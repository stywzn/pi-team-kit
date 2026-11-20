// Edits that leave JSON or YAML unparsable are caught (Python is checked by the extension with the real python).
import assert from "node:assert/strict";
import { test } from "node:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { checkedKind, restoredNote, syntaxError, useYamlFrom } from "../lib/filecheck.ts";

// In pi the yaml package comes from pi's own install; here, from the pi installed on this machine.
const npmRoot = execFileSync(process.platform === "win32" ? "npm.cmd" : "npm", ["root", "-g"], { encoding: "utf8", shell: process.platform === "win32" }).trim();
const haveYaml = useYamlFrom(join(npmRoot, "@earendil-works", "pi-coding-agent", "package.json"));

test("which files are checked", () => {
  assert.equal(checkedKind("data/S1.json"), "json");
  assert.equal(checkedKind("data\kh\cases.yaml"), "yaml");
  assert.equal(checkedKind("ci.yml"), "yaml");
  assert.equal(checkedKind("tests/test_70.py"), "python");
  for (const p of ["tsconfig.json", "tsconfig.build.json", ".vscode/settings.json", "a.jsonc", "README.md"]) assert.equal(checkedKind(p), undefined, p);
});

test("the corruptions seen in real use are caught; valid files pass", (t) => {
  if (!haveYaml) return t.skip("pi (and its yaml package) is not installed here");
  assert.equal(syntaxError("json", '{"a": 1}'), "");
  assert.notEqual(syntaxError("json", '{"a": 1,'), "");
  assert.equal(syntaxError("json", "﻿{}"), "", "a BOM is fine");
  assert.equal(syntaxError("yaml", "cases:\n  - id: KH1\n    依据: x\n"), "");
  assert.notEqual(syntaxError("yaml", "cases:\n  - id: KH1\n   依据: x\n  bad: [\n"), "", "broken indentation and an open bracket");
  assert.notEqual(syntaxError("yaml", "name: \u0001x\n"), "", "a backslash-1 that became a control character");
  assert.equal(syntaxError("yaml", "a: 1\n---\nb: 2\n"), "", "several documents");
  assert.equal(syntaxError("python", "x = 1"), undefined, "python is checked by the caller");
  assert.match(restoredNote("cases.yaml", "bad indent", true), /put back exactly as it was before/);
  assert.match(restoredNote("new.json", "Unexpected end", false), /does not parse now/);
});
