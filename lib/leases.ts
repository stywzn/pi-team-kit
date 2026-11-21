// File leases between lead sessions. A lead about to change some files claims them; while the claim holds, another
// lead's edit/write of those files is refused (not only announced), with who holds them and why. A team run claims
// its lanes' files for the lead that started it, and its checkout as a whole: workers that start later branch from
// that checkout and the result is applied onto it, so it must stay clean until the run is integrated.
// Plain files next to the lead board, one per lease, each written and removed only by its owner:
//   <board>/leases/<owner>-<id>.json
// A lease counts while it has not expired and its owner's card on the board is fresh (the session is running).

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ownsPath } from "./progress.ts";
import { normalizePath, pathKey, patternsOverlap } from "./team.ts";

export const DEFAULT_LEASE_MIN = 60;
export const MAX_LEASE_MIN = 480;
export const MAX_LEASE_PATHS = 50;

export interface Lease {
  id: string;
  /** Board owner id (host:pid:instance) of the session holding it. */
  owner: string;
  /** Lead name when it was taken, for messages. */
  lead: string;
  /** Repository key (git common dir), equal for every checkout and worktree of one repo. */
  repo: string;
  /** Repo-relative paths or globs; ["**"] = every file. */
  paths: string[];
  /** Only edits inside this checkout (pathKey of its root) are held; absent = every checkout of the repo. */
  checkout?: string;
  reason: string;
  at: string;
  until: string;
  kind: "claim" | "team-run";
}

export const leaseDir = (boardDir: string) => join(boardDir, "leases");
/** An owner id as part of a file name: letters, digits, _ and - only (no dots, no separators). */
const safe = (s: string) => s.replace(/[^\w-]+/g, "_").slice(0, 80);

/** A lease of `minutes` (1 to `max`); a team run's lease lasts as long as the run may. */
export function newLease(l: Omit<Lease, "id" | "at" | "until">, minutes: number, now = Date.now(), max = MAX_LEASE_MIN): Lease {
  const m = Math.max(1, Math.min(max, Math.round(Number(minutes) || DEFAULT_LEASE_MIN)));
  const paths = [...new Set(l.paths.map(normalizePath).filter(Boolean))].slice(0, MAX_LEASE_PATHS);
  if (!paths.length) throw new Error("name the files to claim (paths relative to the repo root, globs allowed)");
  for (const p of paths) if (p.startsWith("/") || /^[A-Za-z]:/.test(p) || p.split("/").includes("..")) throw new Error(`"${p}" must be relative to the repo root`);
  return { ...l, paths, id: randomBytes(4).toString("hex"), at: new Date(now).toISOString(), until: new Date(now + m * 60_000).toISOString() };
}

export function writeLease(dir: string, lease: Lease): void {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${safe(lease.owner)}-${lease.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(lease));
  renameSync(tmp, file);
}

const str = (v: unknown): v is string => typeof v === "string";

/**
 * Leases in force: not expired, held by a running session (`alive` owner ids). Expired lease files older than an
 * hour are removed on the way (anyone may: an expired lease holds nothing).
 */
export function readLeases(dir: string, alive: Set<string>, now = Date.now()): Lease[] {
  if (!existsSync(dir)) return [];
  const out: Lease[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    let l: Lease | undefined;
    try {
      l = JSON.parse(readFileSync(join(dir, f), "utf8")) as Lease;
    } catch {
      continue;
    }
    if (!l || !str(l.id) || !str(l.owner) || !str(l.repo) || !str(l.until) || !Array.isArray(l.paths)) continue;
    const until = Date.parse(l.until);
    if (!(until > now)) {
      if (now - until > 3_600_000) rmSync(join(dir, f), { force: true });
      continue;
    }
    if (!alive.has(l.owner)) continue;
    // One malformed file must not take the others down with it: every field is checked or defaulted.
    out.push({
      id: l.id,
      owner: l.owner,
      repo: l.repo,
      until: l.until,
      at: str(l.at) ? l.at : l.until,
      paths: l.paths.filter(str),
      checkout: str(l.checkout) ? l.checkout : undefined,
      lead: str(l.lead) ? l.lead : "?",
      reason: str(l.reason) ? l.reason : "",
      kind: l.kind === "team-run" ? "team-run" : "claim",
    });
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

/** Remove this owner's leases; `match` picks which (default: all). Returns how many. */
export function removeLeases(dir: string, owner: string, match: (l: Lease) => boolean = () => true): number {
  if (!existsSync(dir)) return 0;
  let n = 0;
  for (const f of readdirSync(dir)) {
    if (!f.startsWith(`${safe(owner)}-`) || !f.endsWith(".json")) continue;
    try {
      const l = JSON.parse(readFileSync(join(dir, f), "utf8")) as Lease;
      if (l.owner !== owner || !match(l)) continue;
    } catch {
      /* unreadable and ours: remove */
    }
    rmSync(join(dir, f), { force: true });
    n++;
  }
  return n;
}

const caseFold = (s: string, windowsHost: boolean) => (windowsHost ? s.toLowerCase() : s);

/** Does this lease hold `rel` (repo-relative) of `repo`, edited in the checkout `checkout` (pathKey)? */
export function leaseCovers(l: Lease, repo: string, rel: string, checkout: string | undefined, windowsHost = process.platform === "win32"): boolean {
  if (l.repo !== repo) return false;
  if (l.checkout && (!checkout || l.checkout !== checkout)) return false;
  return ownsPath(
    l.paths.map((p) => caseFold(p, windowsHost)),
    caseFold(normalizePath(rel), windowsHost),
  );
}

/** Another session's lease on this file, if any. */
export function leaseConflict(leases: Lease[], owner: string, repo: string, rel: string, checkout?: string, windowsHost = process.platform === "win32"): Lease | undefined {
  return leases.find((l) => l.owner !== owner && leaseCovers(l, repo, rel, checkout, windowsHost));
}

/** Other sessions' leases that overlap paths this lead wants to claim, from `checkout` (pathKey of its checkout):
 *  a lease held for another checkout (a team run's) does not stand in the way of work in this one. */
export function claimConflicts(leases: Lease[], owner: string, repo: string, paths: string[], checkout?: string): Lease[] {
  return leases.filter((l) => l.owner !== owner && l.repo === repo && (!l.checkout || !checkout || l.checkout === checkout) && l.paths.some((a) => paths.some((b) => patternsOverlap(a, b))));
}

export function checkoutKey(root: string): string {
  return pathKey(root);
}

const hhmm = (iso: string) => {
  const d = new Date(iso);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
};

export function formatLease(l: Lease): string {
  const what = l.paths.length > 6 ? `${l.paths.slice(0, 6).join(", ")} and ${l.paths.length - 6} more` : l.paths.join(", ");
  return `${l.lead}${l.kind === "team-run" ? " (team run)" : ""}: ${l.paths[0] === "**" ? "every file" : what}${l.checkout ? " in its checkout" : ""}, until ${hhmm(l.until)}${l.reason ? ` - ${l.reason}` : ""}`;
}

/** Why an edit is refused, as an instruction to the model that tried it. */
export function leaseBlockReason(l: Lease, rel: string): string {
  if (l.kind === "team-run" && l.checkout)
    return (
      `${rel}: lead ${l.lead} has a team run going on this checkout (${l.reason || "workers in progress"}). Workers that start later branch from this checkout and the result is applied onto it, so it must stay unchanged until that run is integrated (until ${hhmm(l.until)} at the latest). ` +
      `Ask ${l.lead} with the leads tool (send) when it will be done, or work in a separate worktree (git worktree add ../<folder> -b <branch>) meanwhile. Do not get around this with a shell command.`
    );
  return (
    `${rel} is claimed by lead ${l.lead} until ${hhmm(l.until)}${l.reason ? ` (${l.reason})` : ""}. Ask ${l.lead} with the leads tool (send, update=true): either they make your change, or they release the file (leads release) and you retry. ` +
    "Do not get around the claim with a shell command or by writing the file another way."
  );
}
