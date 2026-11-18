// File paths in replies become links people can Ctrl+click (terminal) or click (pi-web).
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { test } from "node:test";
import { fileUrl, linkFilePaths, piWebUrl } from "../lib/link.ts";

test("file URLs open from the terminal's own OS: Windows, WSL (the Windows view), Linux", () => {
  assert.equal(fileUrl("D:\\dev\\测试 报告.docx", {}, "win32"), "file:///D:/dev/测试%20报告.docx");
  assert.equal(fileUrl("/home/way/out/a (1).pdf", { WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "file://wsl.localhost/Ubuntu/home/way/out/a%20%281%29.pdf");
  assert.equal(fileUrl("/mnt/d/dev/report.docx", { WSL_DISTRO_NAME: "Ubuntu" }, "linux"), "file:///D:/dev/report.docx");
  assert.equal(fileUrl("/tmp/x#1.md", {}, "linux"), "file:///tmp/x%231.md");
});

test("pi-web download links are encoded the way pi-web encodes them", () => {
  assert.equal(piWebUrl("/home/way/x y.docx"), "/api/files/home/way/x%20y.docx?type=download");
  assert.equal(piWebUrl("D:\\dev\\报告.docx"), `/api/files/D%3A/dev/${encodeURIComponent("报告.docx")}?type=download`);
  assert.equal(piWebUrl("\\\\server\\share\\a.pdf"), "/api/files/%2F%2Fserver/share/a.pdf?type=download");
  assert.equal(piWebUrl("/x/a).pdf"), "/api/files/x/a%29.pdf?type=download", "a parenthesis cannot end the markdown link");
});

test("paths of existing files in a reply become links; code blocks, links and missing files stay as they are", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptk-link-"));
  mkdirSync(join(dir, "out"));
  for (const f of ["out/report.docx", "out/测试报告.pdf", "out/with space.md", "README.md"]) writeFileSync(join(dir, f), "x");
  const url = (abs: string) => `U<${abs.slice(dir.length).replace(/\\/g, "/")}>`;
  const L = (s: string) => linkFilePaths(s, url, [dir], "/home/u");
  const abs = join(dir, "out/report.docx");
  assert.equal(L(`Wrote ${abs}.`), `Wrote [${abs}](U</out/report.docx>).`, "absolute, trailing period kept outside");
  assert.equal(L("已生成 out/测试报告.pdf，请查看"), "已生成 [out/测试报告.pdf](U</out/测试报告.pdf>)，请查看", "relative to the session folder, CJK name and punctuation");
  assert.equal(L("see `out/with space.md`"), "see [`out/with space.md`](U</out/with space.md>)", "inline code keeps its look");
  assert.equal(L("```\ncat out/report.docx\n```"), "```\ncat out/report.docx\n```", "code blocks untouched");
  assert.equal(L("[the report](out/report.docx) and ![x](out/report.docx)"), "[the report](out/report.docx) and ![x](out/report.docx)", "existing links untouched");
  assert.equal(L("out/missing.docx and calc.py and https://x.com/out/report.docx"), "out/missing.docx and calc.py and https://x.com/out/report.docx", "missing files, other extensions, URLs untouched");
  assert.equal(L("README.md"), "[README.md](U</README.md>)");
  const long = `${"word ".repeat(4000)}${abs}`;
  const t0 = performance.now();
  assert.ok(L(long).endsWith("(U</out/report.docx>)"));
  assert.ok(performance.now() - t0 < 200, "a long reply is linked fast");
  const t1 = performance.now();
  L("+".repeat(50_000) + " " + "~a".repeat(20_000));
  assert.ok(performance.now() - t1 < 500, `a long run of odd characters stays linear (${Math.round(performance.now() - t1)}ms)`);
});
