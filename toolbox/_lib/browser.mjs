// Find a Chromium-family browser (Chrome, Edge, Chromium, Brave) and drive it headless.
// Works on Linux, macOS, Windows, and WSL using the Windows browser when Linux has none.

import { spawnSync, execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

export function isWsl() {
  return process.platform === "linux" && (/microsoft|wsl/i.test(os.release()) || Boolean(process.env.WSL_DISTRO_NAME));
}

const LINUX = ["chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "microsoft-edge", "microsoft-edge-stable", "brave-browser"];
const MAC = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser",
];
const WIN = [
  "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
  "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
  "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
];

function onPath(name) {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    if (!dir || dir.startsWith("/mnt/")) continue;
    const full = path.join(dir, name);
    if (existsSync(full)) return full;
  }
  return undefined;
}

const winToWsl = (p) => `/mnt/${p[0].toLowerCase()}/${p.slice(3).replace(/\\/g, "/")}`;

/** @returns {{ path: string, windows: boolean } | undefined} */
export function findBrowser() {
  const forced = process.env.PTK_BROWSER;
  if (forced) return { path: forced, windows: isWsl() && forced.toLowerCase().endsWith(".exe") };
  if (process.platform === "darwin") {
    const p = MAC.find((x) => existsSync(x));
    return p ? { path: p, windows: false } : undefined;
  }
  if (process.platform === "win32") {
    const p = WIN.find((x) => existsSync(x));
    return p ? { path: p, windows: true } : undefined;
  }
  for (const name of LINUX) {
    const p = onPath(name);
    if (p) return { path: p, windows: false };
  }
  if (isWsl()) {
    const p = WIN.map(winToWsl).find((x) => existsSync(x));
    if (p) return { path: p, windows: true };
  }
  return undefined;
}

export const INSTALL_HINT =
  "No Chrome/Edge/Chromium found. Install one (Ubuntu: `sudo apt install chromium-browser` or Google Chrome; macOS: `brew install --cask google-chrome`), " +
  "or point PTK_BROWSER at a browser binary.";

function toWin(p) {
  return execFileSync("wslpath", ["-w", p], { encoding: "utf8" }).trim();
}

/** A scratch directory the browser can read and write. For a Windows browser under WSL that is the Windows temp dir. */
function scratchDir(browser) {
  if (browser.windows && isWsl()) {
    const winTemp = execFileSync("cmd.exe", ["/c", "echo", "%TEMP%"], { encoding: "utf8", cwd: "/mnt/c" }).trim();
    const base = execFileSync("wslpath", ["-u", winTemp], { encoding: "utf8" }).trim();
    return mkdtempSync(path.join(base, "ptk-"));
  }
  return mkdtempSync(path.join(os.tmpdir(), "ptk-"));
}

/**
 * Render `html` with the browser and copy its output file to `outPath`.
 * @param {{ path: string, windows: boolean }} browser
 * @param {string} html
 * @param {"pdf" | "png"} kind
 * @param {string} outPath
 * @param {{ width?: number, height?: number, timeoutMs?: number, url?: string }} [opts]
 */
export function render(browser, html, kind, outPath, opts = {}) {
  const dir = scratchDir(browser);
  try {
    const page = path.join(dir, "page.html");
    const result = path.join(dir, kind === "pdf" ? "out.pdf" : "out.png");
    if (!opts.url) writeFileSync(page, html);
    const nativePath = (p) => (browser.windows && isWsl() ? toWin(p) : p);
    const target = opts.url ?? (browser.windows ? "file:///" + nativePath(page).replace(/\\/g, "/") : "file://" + page);
    const args = [
      "--headless=new",
      "--disable-gpu",
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-extensions",
      "--hide-scrollbars",
      `--user-data-dir=${nativePath(path.join(dir, "profile"))}`,
      "--virtual-time-budget=8000",
    ];
    if (kind === "pdf") args.push(`--print-to-pdf=${nativePath(result)}`, "--no-pdf-header-footer");
    else args.push(`--screenshot=${nativePath(result)}`, `--window-size=${opts.width ?? 1280},${opts.height ?? 800}`);
    args.push(target);
    const run = spawnSync(browser.path, args, { encoding: "utf8", timeout: opts.timeoutMs ?? 90_000, cwd: browser.windows && isWsl() ? "/mnt/c" : undefined });
    if (!existsSync(result)) {
      const why = run.error ? run.error.message : (run.stderr || run.stdout || `exit ${run.status}`).trim().split("\n").slice(-6).join("\n");
      throw new Error(`browser produced no ${kind}: ${why}`);
    }
    copyFileSync(result, outPath);
  } finally {
    // On Windows the browser can still hold its profile files for a moment (EBUSY). The output is already
    // copied; a leftover temp dir is not worth failing the command over.
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 });
    } catch {
      /* the OS temp cleaner will get it */
    }
  }
}
