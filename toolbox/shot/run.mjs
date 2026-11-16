#!/usr/bin/env node
// shot <url|file.html> [output.png] [--width 1280] [--height 800]
// Screenshot a web page or local HTML file with headless Chrome/Edge (e.g. to show a UI change).

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { findBrowser, INSTALL_HINT, render } from "../_lib/browser.mjs";

const args = process.argv.slice(2);
const num = (name, fallback) => {
  const i = args.indexOf(name);
  if (i < 0) return fallback;
  const v = Number(args[i + 1]);
  args.splice(i, 2);
  return Number.isFinite(v) && v > 0 ? v : fallback;
};
const width = num("--width", 1280);
const height = num("--height", 800);
const [target, outArg] = args;
if (!target || target === "-h" || target === "--help") {
  console.log("usage: shot <url|file.html> [output.png] [--width 1280] [--height 800]");
  process.exit(target ? 0 : 2);
}
const isUrl = /^https?:\/\//.test(target);
if (!isUrl && !existsSync(target)) {
  console.error(`not found: ${target}`);
  process.exit(2);
}
const browser = findBrowser();
if (!browser) {
  console.error(INSTALL_HINT);
  process.exit(3);
}
const out = path.resolve(outArg ?? (isUrl ? "screenshot.png" : target.replace(/\.[^.]+$/, ".png")));
render(browser, isUrl ? "" : readFileSync(target, "utf8"), "png", out, { width, height, url: isUrl ? target : undefined });
console.log(`wrote ${out} (${width}x${height})`);
