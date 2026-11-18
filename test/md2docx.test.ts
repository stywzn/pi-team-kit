// md2docx: a valid .docx (zip of XML) from Markdown, with no Word, pandoc or Python.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";

const tool = fileURLToPath(new URL("../toolbox/md2docx/run.mjs", import.meta.url));
const fixture = fileURLToPath(new URL("fixtures/md2docx/sample.md", import.meta.url));

/** Entries of a zip, read from its central directory. */
function unzip(buf: Buffer): Map<string, string> {
  const end = buf.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
  const out = new Map<string, string>();
  for (let p = buf.readUInt32LE(end + 16), n = buf.readUInt16LE(end + 10); n--; ) {
    const [csize, nameLen, extra, comment, local] = [buf.readUInt32LE(p + 20), buf.readUInt16LE(p + 28), buf.readUInt16LE(p + 30), buf.readUInt16LE(p + 32), buf.readUInt32LE(p + 42)];
    const name = buf.toString("utf8", p + 46, p + 46 + nameLen);
    const start = local + 30 + buf.readUInt16LE(local + 26) + buf.readUInt16LE(local + 28);
    const data = zlib.inflateRawSync(buf.subarray(start, start + csize));
    assert.equal(zlib.crc32 ? zlib.crc32(data) : buf.readUInt32LE(p + 16), buf.readUInt32LE(p + 16), `${name} CRC`);
    out.set(name, data.toString("latin1"));
    p += 46 + nameLen + extra + comment;
  }
  return out;
}

test("md2docx: headings, lists, table, code, quote, link, local image, escaping; a valid zip", () => {
  const out = join(mkdtempSync(join(tmpdir(), "ptk-docx-")), "报告 1.docx");
  const r = spawnSync(process.execPath, [tool, fixture, out], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parts = unzip(readFileSync(out));
  for (const p of ["[Content_Types].xml", "_rels/.rels", "word/document.xml", "word/styles.xml", "word/numbering.xml", "word/media/image1.png"]) assert.ok(parts.has(p), p);
  const doc = Buffer.from(parts.get("word/document.xml")!, "latin1").toString("utf8");
  for (const s of ['w:val="Heading1"', 'w:val="Heading2"', "<w:tbl>", 'w:val="CodeBlock"', 'w:val="Quote"', "<w:numPr>", "<w:hyperlink", "r:embed", "<w:strike/>", "☑", "☐", "&lt;总结&gt;", '<w:jc w:val="right"/>'])
    assert.ok(doc.includes(s), s);
  assert.ok(!/<(?!\/?(w|wp|a|pic|r):|\?xml)/.test(doc.replace(/<w:document[^>]*>/, "")), "no raw markup from the Markdown leaks into the XML");
  assert.match(parts.get("word/_rels/document.xml.rels")!, /Target="https:\/\/example\.com\/report\?a=1&amp;b=2" TargetMode="External"/);
  assert.match(parts.get("word/numbering.xml")!, /<w:startOverride w:val="3"\/>/, "an ordered list starting at 3 starts at 3");
});

test("md2docx: unsafe links stay text, missing images do not fail, characters XML cannot hold are dropped", () => {
  const dir = join(mkdtempSync(join(tmpdir(), "ptk-docx-")), "my.dir");
  mkdirSync(dir);
  writeFileSync(join(dir, "a"), "---\nname: meta\n---\n[x](javascript:alert(1)) ![gone](nope.png) ![key](../../.ssh/id_rsa) bad\u0001char ￿ \ud800 end\n");
  const r = spawnSync(process.execPath, [tool, join(dir, "a")], { encoding: "utf8" });
  assert.equal(r.status, 0, r.stderr);
  const parts = unzip(readFileSync(join(dir, "a.docx"))); // no extension, folder with a dot: written next to the input
  assert.ok(!parts.get("word/document.xml")!.includes("meta"), "front matter is not part of the document");
  assert.ok(!/￿/.test(Buffer.from(parts.get("word/document.xml")!, "latin1").toString("utf8")), "U+FFFF is not valid XML");
  // Truncated images become text instead of crashing; a folder is refused.
  writeFileSync(join(dir, "t.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  writeFileSync(join(dir, "t.jpg"), Buffer.from([0xff, 0xd8, 0xff, 0xc0]));
  writeFileSync(join(dir, "img.md"), "![a](t.png) ![b](t.jpg)\n");
  assert.equal(spawnSync(process.execPath, [tool, join(dir, "img.md")]).status, 0, "truncated images");
  assert.ok(unzip(readFileSync(join(dir, "img.docx"))).get("word/document.xml")!.includes("[a]"));
  assert.equal(spawnSync(process.execPath, [tool, dir]).status, 2, "a folder is not a file");
  assert.ok(!parts.get("word/_rels/document.xml.rels")!.includes("javascript"));
  assert.ok(![...parts.keys()].some((k) => k.startsWith("word/media/")), "only existing png/jpeg/gif files are embedded");
  assert.ok(!parts.get("word/document.xml")!.includes("\u0001"));
});
