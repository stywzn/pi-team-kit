#!/usr/bin/env node
// md2docx <input.md> [output.docx]
// Markdown -> Word without Word, pandoc or Python: headings, lists, tables, code, quotes, links, local images,
// Chinese fonts. Parsed with marked; the .docx (a zip of XML) is written here with node:zlib.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { marked } from "marked";

const [input, outArg] = process.argv.slice(2);
if (!input || input === "-h" || input === "--help") {
  console.log("usage: md2docx <input.md> [output.docx]");
  process.exit(input ? 0 : 2);
}
if (!existsSync(input)) {
  console.error(`not found: ${input}`);
  process.exit(2);
}
const baseDir = path.dirname(path.resolve(input));
const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, "");
const rels = []; // [id, type, target, external]
const media = []; // [name, bytes]
const rel = (type, target, external) => {
  const id = `rId${rels.length + 10}`;
  rels.push([id, type, target, external]);
  return id;
};
const R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";

// ---------- inline ----------
function text(s, rPr = "") {
  return String(s)
    .split("\n")
    .map((line) => line.split("\t").map((part) => (part ? `<w:r>${rPr && `<w:rPr>${rPr}</w:rPr>`}<w:t xml:space="preserve">${esc(part)}</w:t></w:r>` : "")).join(`<w:r><w:tab/></w:r>`))
    .join("<w:r><w:br/></w:r>");
}
function imageSize(b) {
  if (b[0] === 0x89 && b[1] === 0x50) return [b.readUInt32BE(16), b.readUInt32BE(20)];
  if (b[0] === 0x47 && b[1] === 0x49) return [b.readUInt16LE(6), b.readUInt16LE(8)];
  if (b[0] === 0xff && b[1] === 0xd8)
    for (let i = 2; i + 9 < b.length; ) {
      const marker = b[i + 1];
      if (marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker)) return [b.readUInt16BE(i + 7), b.readUInt16BE(i + 5)];
      i += 2 + b.readUInt16BE(i + 2);
    }
  return undefined;
}
function image(tok) {
  const file = /^(https?:|data:)/.test(tok.href) ? "" : path.resolve(baseDir, decodeURI(tok.href.split(/[?#]/)[0]));
  const ext = path.extname(file).toLowerCase().replace("jpg", "jpeg").slice(1);
  if (!file || !["png", "jpeg", "gif"].includes(ext) || !existsSync(file)) return text(tok.text ? `[${tok.text}]` : tok.href);
  const bytes = readFileSync(file);
  const size = imageSize(bytes);
  if (!size) return text(`[${tok.text || path.basename(file)}]`);
  const name = `image${media.length + 1}.${ext}`;
  media.push([name, bytes]);
  const id = rel(`${R}/image`, `media/${name}`);
  const scale = Math.min(1, 576 / size[0]); // at most 6 inches wide at 96 dpi
  const [cx, cy] = size.map((v) => Math.round(v * scale * 9525));
  const n = media.length;
  return `<w:r><w:drawing><wp:inline><wp:extent cx="${cx}" cy="${cy}"/><wp:docPr id="${n}" name="${name}" descr="${esc(tok.text)}"/><a:graphic xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main"><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:pic xmlns:pic="http://schemas.openxmlformats.org/drawingml/2006/picture"><pic:nvPicPr><pic:cNvPr id="${n}" name="${name}"/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${id}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}
function inline(tokens = [], rPr = "") {
  return tokens
    .map((t) => {
      switch (t.type) {
        case "strong":
          return inline(t.tokens, `${rPr}<w:b/>`);
        case "em":
          return inline(t.tokens, `${rPr}<w:i/>`);
        case "del":
          return inline(t.tokens, `${rPr}<w:strike/>`);
        case "codespan":
          return text(t.text, `${rPr}<w:rStyle w:val="CodeChar"/>`);
        case "br":
          return "<w:r><w:br/></w:r>";
        case "image":
          return image(t);
        case "link":
          if (!/^(https?|mailto|file):/i.test(t.href)) return inline(t.tokens, rPr);
          return `<w:hyperlink r:id="${rel(`${R}/hyperlink`, t.href, true)}">${inline(t.tokens, `${rPr}<w:rStyle w:val="Hyperlink"/>`)}</w:hyperlink>`;
        case "html":
          return text(t.text.replace(/<[^>]*>/g, ""), rPr);
        default:
          return t.tokens ? inline(t.tokens, rPr) : text(t.text ?? "", rPr);
      }
    })
    .join("");
}

// ---------- blocks ----------
const para = (body, pPr = "") => `<w:p>${pPr && `<w:pPr>${pPr}</w:pPr>`}${body}</w:p>`;
const nums = []; // numbering instances: [abstractNumId, start]; each ordered list counts from its own start
function list(tok, level, out, pStyle) {
  nums.push([tok.ordered ? 1 : 0, Number(tok.start) || 1]);
  const numId = nums.length;
  for (const item of tok.items) {
    let first = true;
    // marked puts a task's [x] in a checkbox token before the item's text
    const box = item.task ? text(item.checked ? "☑ " : "☐ ") : "";
    for (const child of item.tokens) {
      if (child.type === "checkbox") continue;
      if (child.type === "list") list(child, Math.min(level + 1, 8), out, pStyle);
      else if (child.type === "text" || child.type === "paragraph") {
        const pPr = `<w:pStyle w:val="${pStyle ?? "ListParagraph"}"/>${first ? `<w:numPr><w:ilvl w:val="${level}"/><w:numId w:val="${numId}"/></w:numPr>` : `<w:ind w:left="${720 * (level + 1)}"/>`}`;
        out.push(para((first ? box : "") + inline(child.tokens ?? [{ type: "text", text: child.text }]), pPr));
        first = false;
      } else if (child.type !== "space") blocks([child], out);
    }
  }
}
function blocks(tokens, out, pStyle) {
  const style = (s) => `<w:pStyle w:val="${pStyle ?? s}"/>`;
  for (const t of tokens) {
    switch (t.type) {
      case "heading":
        out.push(para(inline(t.tokens), `<w:pStyle w:val="Heading${t.depth}"/>`));
        break;
      case "paragraph":
      case "text":
        out.push(para(inline(t.tokens ?? [{ type: "text", text: t.text }]), pStyle ? style() : ""));
        break;
      case "code":
        out.push(para(text(t.text.replace(/\n$/, "")), `<w:pStyle w:val="CodeBlock"/>`));
        break;
      case "blockquote":
        blocks(t.tokens, out, "Quote");
        break;
      case "list":
        list(t, 0, out, pStyle);
        break;
      case "hr":
        out.push(para("", `<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="D0D7DE"/></w:pBdr>`));
        break;
      case "table": {
        const jc = (i) => ({ center: "center", right: "right" })[t.align[i]] ?? "left";
        const cell = (c, i, head) =>
          `<w:tc><w:tcPr>${head ? `<w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/>` : ""}</w:tcPr>${para(inline(c.tokens, head ? "<w:b/>" : ""), `<w:spacing w:before="40" w:after="40"/><w:jc w:val="${jc(i)}"/>`)}</w:tc>`;
        const row = (cells, head) => `<w:tr>${head ? "<w:trPr><w:tblHeader/></w:trPr>" : ""}${cells.map((c, i) => cell(c, i, head)).join("")}</w:tr>`;
        out.push(`<w:tbl><w:tblPr><w:tblStyle w:val="TableGrid"/><w:tblW w:w="0" w:type="auto"/></w:tblPr><w:tblGrid>${t.header.map(() => "<w:gridCol/>").join("")}</w:tblGrid>${row(t.header, true)}${t.rows.map((r) => row(r, false)).join("")}</w:tbl>`);
        out.push(para(""));
        break;
      }
      case "html":
        if (t.text.replace(/<[^>]*>/g, "").trim()) out.push(para(text(t.text.replace(/<[^>]*>/g, "").trim())));
        break;
      // space, def: nothing to show
    }
  }
}

// ---------- package ----------
const out = [];
blocks(marked.lexer(readFileSync(input, "utf8"), { gfm: true }), out);
const NS = `xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="${R}" xmlns:wp="http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing"`;
const document = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:document ${NS}><w:body>${out.join("")}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1304" w:bottom="1440" w:left="1304" w:header="708" w:footer="708" w:gutter="0"/></w:sectPr></w:body></w:document>`;

const font = (ascii, size) => `<w:rFonts w:ascii="${ascii}" w:hAnsi="${ascii}" w:eastAsia="Microsoft YaHei" w:cs="${ascii}"/>${size ? `<w:sz w:val="${size}"/><w:szCs w:val="${size}"/>` : ""}`;
const heading = (n, size, color) =>
  `<w:style w:type="paragraph" w:styleId="Heading${n}"><w:name w:val="heading ${n}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/><w:pPr><w:keepNext/><w:spacing w:before="${n < 3 ? 360 : 240}" w:after="120"/><w:outlineLvl w:val="${n - 1}"/></w:pPr><w:rPr><w:b/><w:color w:val="${color}"/><w:sz w:val="${size}"/><w:szCs w:val="${size}"/></w:rPr></w:style>`;
const styles = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:docDefaults><w:rPrDefault><w:rPr>${font("Calibri", 21)}<w:lang w:val="en-US" w:eastAsia="zh-CN"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults><w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/><w:qFormat/></w:style>${[
  [1, 36, "1F2328"],
  [2, 30, "1F2328"],
  [3, 26, "1F2328"],
  [4, 23, "1F2328"],
  [5, 21, "1F2328"],
  [6, 21, "59636E"],
]
  .map((h) => heading(...h))
  .join(
    "",
  )}<w:style w:type="paragraph" w:styleId="ListParagraph"><w:name w:val="List Paragraph"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="60"/><w:contextualSpacing/></w:pPr></w:style><w:style w:type="paragraph" w:styleId="Quote"><w:name w:val="Quote"/><w:basedOn w:val="Normal"/><w:pPr><w:pBdr><w:left w:val="single" w:sz="18" w:space="8" w:color="D0D7DE"/></w:pBdr><w:ind w:left="240"/></w:pPr><w:rPr><w:color w:val="59636E"/></w:rPr></w:style><w:style w:type="paragraph" w:styleId="CodeBlock"><w:name w:val="Code Block"/><w:basedOn w:val="Normal"/><w:pPr><w:shd w:val="clear" w:color="auto" w:fill="F6F8FA"/><w:spacing w:before="60" w:after="160" w:line="260" w:lineRule="auto"/><w:ind w:left="120" w:right="120"/></w:pPr><w:rPr>${font("Consolas", 19)}</w:rPr></w:style><w:style w:type="character" w:styleId="CodeChar"><w:name w:val="Code Char"/><w:rPr>${font("Consolas", 19)}<w:shd w:val="clear" w:color="auto" w:fill="EFF1F3"/></w:rPr></w:style><w:style w:type="character" w:styleId="Hyperlink"><w:name w:val="Hyperlink"/><w:rPr><w:color w:val="0969DA"/><w:u w:val="single"/></w:rPr></w:style><w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders>${["top", "left", "bottom", "right", "insideH", "insideV"].map((s) => `<w:${s} w:val="single" w:sz="4" w:space="0" w:color="D0D7DE"/>`).join("")}</w:tblBorders><w:tblCellMar><w:left w:w="108" w:type="dxa"/><w:right w:w="108" w:type="dxa"/></w:tblCellMar></w:tblPr></w:style></w:styles>`;

const BULLETS = ["•", "◦", "▪"];
const abstract = (id, ordered) =>
  `<w:abstractNum w:abstractNumId="${id}"><w:multiLevelType w:val="hybridMultilevel"/>${Array.from({ length: 9 }, (_, l) => `<w:lvl w:ilvl="${l}"><w:start w:val="1"/><w:numFmt w:val="${ordered ? ["decimal", "lowerLetter", "lowerRoman"][l % 3] : "bullet"}"/><w:lvlText w:val="${ordered ? `%${l + 1}.` : BULLETS[l % 3]}"/><w:lvlJc w:val="left"/><w:pPr><w:ind w:left="${720 * (l + 1)}" w:hanging="360"/></w:pPr></w:lvl>`).join("")}</w:abstractNum>`;
const numbering = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><w:numbering xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">${abstract(0, false)}${abstract(1, true)}${nums.map(([a, start], i) => `<w:num w:numId="${i + 1}"><w:abstractNumId w:val="${a}"/>${a ? Array.from({ length: 9 }, (_, l) => `<w:lvlOverride w:ilvl="${l}"><w:startOverride w:val="${l ? 1 : start}"/></w:lvlOverride>`).join("") : ""}</w:num>`).join("")}</w:numbering>`;

const docRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/styles" Target="styles.xml"/><Relationship Id="rId2" Type="${R}/numbering" Target="numbering.xml"/>${rels.map(([id, type, target, ext]) => `<Relationship Id="${id}" Type="${type}" Target="${esc(target)}"${ext ? ' TargetMode="External"' : ""}/>`).join("")}</Relationships>`;
const W = "application/vnd.openxmlformats-officedocument.wordprocessingml";
const contentTypes = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="png" ContentType="image/png"/><Default Extension="jpeg" ContentType="image/jpeg"/><Default Extension="gif" ContentType="image/gif"/><Override PartName="/word/document.xml" ContentType="${W}.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="${W}.styles+xml"/><Override PartName="/word/numbering.xml" ContentType="${W}.numbering+xml"/></Types>`;
const rootRels = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="${R}/officeDocument" Target="word/document.xml"/></Relationships>`;

// A zip with deflated entries: local headers, central directory, end record.
const CRC = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc32 = (buf) => (zlib.crc32 ? zlib.crc32(buf) : buf.reduce((c, b) => CRC[(c ^ b) & 0xff] ^ (c >>> 8), 0xffffffff) ^ 0xffffffff) >>> 0;
function zip(files) {
  const local = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const raw = Buffer.isBuffer(data) ? data : Buffer.from(data, "utf8");
    const packed = zlib.deflateRawSync(raw);
    const fname = Buffer.from(name, "utf8");
    const head = Buffer.alloc(30);
    head.writeUInt32LE(0x04034b50, 0);
    head.writeUInt16LE(20, 4);
    head.writeUInt16LE(0x0800, 6); // UTF-8 names
    head.writeUInt16LE(8, 8); // deflate
    head.writeUInt16LE(0x21, 12); // 1980-01-01
    head.writeUInt32LE(crc32(raw), 14);
    head.writeUInt32LE(packed.length, 18);
    head.writeUInt32LE(raw.length, 22);
    head.writeUInt16LE(fname.length, 26);
    const dir = Buffer.alloc(46);
    dir.writeUInt32LE(0x02014b50, 0);
    dir.writeUInt16LE(20, 4);
    head.copy(dir, 6, 4, 30); // version needed .. name length
    dir.writeUInt32LE(offset, 42);
    local.push(head, fname, packed);
    central.push(dir, fname);
    offset += 30 + fname.length + packed.length;
  }
  const size = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(size, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...local, ...central, end]);
}

const target = path.resolve(outArg ?? input.replace(/\.[^.]+$/, "") + ".docx");
writeFileSync(
  target,
  zip([
    ["[Content_Types].xml", contentTypes],
    ["_rels/.rels", rootRels],
    ["word/document.xml", document],
    ["word/_rels/document.xml.rels", docRels],
    ["word/styles.xml", styles],
    ["word/numbering.xml", numbering],
    ...media.map(([name, bytes]) => [`word/media/${name}`, bytes]),
  ]),
);
console.log(`wrote ${target} (${out.length} blocks${media.length ? `, ${media.length} image(s)` : ""})`);
