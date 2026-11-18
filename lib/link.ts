// File paths in a lead's reply become links: in the terminal Ctrl+click opens the file with its default app
// (Word, a PDF viewer, the browser); in pi-web a click downloads it through pi-web's file API.

import { existsSync, statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";

/** Files people open from a reply. */
const EXT = "md|markdown|docx?|pdf|html?|xlsx?|csv|pptx?|txt|log|png|jpe?g|gif|svg|webp|json|xml|zip";
const ENDS = new RegExp(`\\.(?:${EXT})$`, "i");
const PATH_CHARS = "[^\\s`'\"<>|*?()\\[\\]，。；：！？、（）]";
const BARE = new RegExp(
  `(?<![\\w/\\\\.:-])(?:[A-Za-z]:[\\\\/]|~/|/|\\.{1,2}/)?${PATH_CHARS}*\\.(?:${EXT})(?![\\w/\\\\])`,
  "gi",
);

/** Characters a file URL must escape; everything else (CJK too) stays readable and Windows opens it as is. */
const encodePath = (p: string) =>
  p.replace(/[%\s()<>#?"'[\]]/g, (c) => (c.charCodeAt(0) < 128 ? `%${c.charCodeAt(0).toString(16).toUpperCase().padStart(2, "0")}` : encodeURIComponent(c)));

/** A file URL that the terminal's own OS opens: from WSL, the Windows view of the file. */
export function fileUrl(abs: string, env: Record<string, string | undefined> = process.env, platform = process.platform): string {
  if (platform === "win32" || /^[A-Za-z]:[\\/]/.test(abs)) return `file:///${encodePath(abs.replace(/\\/g, "/"))}`;
  if (env.WSL_DISTRO_NAME) {
    const mnt = /^\/mnt\/([a-z])(\/.*)?$/.exec(abs);
    if (mnt) return `file:///${mnt[1].toUpperCase()}:${encodePath(mnt[2] ?? "/")}`;
    return `file://wsl.localhost/${encodeURIComponent(env.WSL_DISTRO_NAME)}${encodePath(abs)}`;
  }
  return `file://${encodePath(abs)}`;
}

/** pi-web's download link for a file, encoded the way pi-web 0.17 encodes it (each path part, drive included). */
export function piWebUrl(abs: string): string {
  const p = /^[A-Za-z]:[\\/]/.test(abs) || abs.startsWith("\\\\") ? abs.replace(/\\/g, "/") : abs;
  const parts = p.split("/").filter(Boolean);
  if (p.startsWith("//") && parts.length) parts[0] = `//${parts[0]}`;
  return `/api/files/${parts.map(encodeURIComponent).join("/")}?type=download`;
}

/**
 * Turn paths of existing files into markdown links, outside code blocks and existing links. `bases` resolve
 * relative paths (the session folder, the repo being worked on). Returns the text unchanged when nothing matched.
 */
export function linkFilePaths(text: string, toUrl: (abs: string) => string, bases: string[], home = ""): string {
  const find = (p: string): string | undefined => {
    const expanded = p.replace(/^~(?=\/)/, home);
    const candidates = isAbsolute(expanded) || /^[A-Za-z]:[\\/]/.test(expanded) ? [expanded] : bases.map((b) => resolve(b, expanded));
    return candidates.find((c) => {
      try {
        return existsSync(c) && statSync(c).isFile();
      } catch {
        return false;
      }
    });
  };
  const link = (shown: string, p: string) => {
    const abs = ENDS.test(p) ? find(p) : undefined;
    return abs ? `[${shown}](${toUrl(abs)})` : undefined;
  };
  // Fenced blocks stay as they are; in the rest, links and inline code are handled before bare paths.
  return text
    .split(/(```[\s\S]*?```)/)
    .map((part, i) =>
      i % 2
        ? part
        : part
            .split(/(\[[^\]\n]*\]\([^)\n]*\)|`[^`\n]+`)/)
            .map((seg, j) => {
              if (!(j % 2)) return seg.replace(BARE, (m) => link(m, m) ?? m);
              if (seg.startsWith("`")) return link(seg, seg.slice(1, -1).trim()) ?? seg;
              return seg; // already a link
            })
            .join(""),
    )
    .join("");
}
