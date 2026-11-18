#!/usr/bin/env node
// md2pdf <input.md|input.html> [output.pdf] [--css extra.css] [--html-only]
// Markdown -> HTML (marked, GitHub-like style, CJK fonts, local images inlined) -> PDF via headless Chrome/Edge.

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { marked } from "marked";
import { findBrowser, INSTALL_HINT, render } from "../_lib/browser.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  if (i < 0) return undefined;
  const v = args[i + 1];
  args.splice(i, 2);
  return v;
};
const htmlOnly = args.includes("--html-only") ? (args.splice(args.indexOf("--html-only"), 1), true) : false;
const extraCss = flag("--css");
const [input, outArg] = args;
if (!input || input === "-h" || input === "--help") {
  console.log("usage: md2pdf <input.md|input.html> [output.pdf] [--css extra.css] [--html-only]");
  process.exit(input ? 0 : 2);
}
if (!existsSync(input)) {
  console.error(`not found: ${input}`);
  process.exit(2);
}

const STYLE = `
@page { margin: 18mm 16mm; }
body { font-family: -apple-system, "Segoe UI", "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", "Noto Sans CJK SC", "Source Han Sans SC", "WenQuanYi Micro Hei", Helvetica, Arial, sans-serif;
  font-size: 11pt; line-height: 1.6; color: #1f2328; max-width: 820px; margin: 0 auto; }
h1, h2, h3, h4 { line-height: 1.25; margin: 1.4em 0 .6em; } h1, h2 { border-bottom: 1px solid #d0d7de; padding-bottom: .3em; }
code, pre { font-family: "JetBrains Mono", "Cascadia Code", Consolas, "Liberation Mono", Menlo, monospace; font-size: .9em; }
code { background: #f6f8fa; padding: .15em .35em; border-radius: 4px; }
pre { background: #f6f8fa; padding: 12px 14px; border-radius: 6px; overflow-x: auto; white-space: pre-wrap; word-break: break-word; }
pre code { background: none; padding: 0; }
table { border-collapse: collapse; margin: 1em 0; } th, td { border: 1px solid #d0d7de; padding: 6px 12px; } th { background: #f6f8fa; }
blockquote { color: #59636e; border-left: 4px solid #d0d7de; margin: 1em 0; padding: 0 1em; }
img { max-width: 100%; } a { color: #0969da; text-decoration: none; }
pre, table, img, blockquote { page-break-inside: avoid; }
`;

const MIME = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".svg": "image/svg+xml", ".webp": "image/webp" };

/** Inline local images so the browser never needs file access outside its scratch directory. */
function inlineImages(html, baseDir) {
  return html.replace(/(<img\b[^>]*\bsrc=")([^"]+)(")/g, (all, pre, src, post) => {
    if (/^(https?:|data:)/.test(src)) return all;
    const file = path.resolve(baseDir, decodeURI(src.split("#")[0].split("?")[0]));
    const mime = MIME[path.extname(file).toLowerCase()];
    if (!mime || !existsSync(file)) return all;
    return `${pre}data:${mime};base64,${readFileSync(file).toString("base64")}${post}`;
  });
}

const source = readFileSync(input, "utf8");
const isHtml = /\.html?$/i.test(input);
const title = path.basename(input).replace(/\.[^.]+$/, "").replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"));
const bodyHtml = isHtml ? source : marked.parse(source.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n/, ""), { gfm: true }); // YAML front matter is metadata
let html = isHtml && /<html[\s>]/i.test(source)
  ? source
  : `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>${STYLE}${extraCss ? readFileSync(extraCss, "utf8") : ""}</style></head><body>${bodyHtml}</body></html>`;
html = inlineImages(html, path.dirname(path.resolve(input)));

const parsed = path.parse(path.resolve(input)); // not a regex on the path: "my.dir/README" has no extension
const out = path.resolve(outArg ?? path.join(parsed.dir, parsed.name + (htmlOnly ? ".html" : ".pdf")));
if (htmlOnly) {
  writeFileSync(out, html);
  console.log(`wrote ${out}`);
  process.exit(0);
}
const browser = findBrowser();
if (!browser) {
  console.error(INSTALL_HINT);
  process.exit(3);
}
const started = Date.now();
render(browser, html, "pdf", out);
console.log(`wrote ${out} (${Math.round((Date.now() - started) / 100) / 10}s, ${path.basename(browser.path)})`);
