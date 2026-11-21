import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { claimConflicts, formatLease, leaseBlockReason, leaseConflict, leaseCovers, newLease, readLeases, removeLeases, writeLease, type Lease } from "../lib/leases.ts";

const base = (o: Partial<Lease> = {}) => ({ owner: "h:1:a", lead: "shop", repo: "/r/.git", paths: ["src/app.py"], reason: "refactor", kind: "claim" as const, ...o });

test("leases: claimed files of another running lead are held; own, expired and dead ones are not", () => {
  const dir = mkdtempSync(join(tmpdir(), "ptk-lease-"));
  const now = Date.now();
  writeLease(dir, newLease(base(), 30, now));
  writeLease(dir, newLease(base({ owner: "h:2:b", lead: "api", paths: ["api/**"] }), 30, now));
  writeLease(dir, newLease(base({ owner: "h:3:c", lead: "gone", paths: ["docs/x.md"] }), 30, now));
  const old = newLease(base({ owner: "h:2:b", paths: ["old.py"] }), 1, now - 3 * 3_600_000);
  writeLease(dir, old);
  writeFileSync(join(dir, "broken.json"), "{not json");
  const alive = new Set(["h:1:a", "h:2:b"]);
  const leases = readLeases(dir, alive, now);
  assert.deepEqual(leases.map((l) => l.lead).sort(), ["api", "shop"], "a lease of a session that is gone holds nothing");
  assert.ok(!readdirSync(dir).some((f) => f.includes(old.id)), "a lease expired over an hour ago is removed");
  assert.equal(leaseConflict(leases, "h:2:b", "/r/.git", "src/app.py")?.lead, "shop", "another lead's claim holds");
  assert.equal(leaseConflict(leases, "h:1:a", "/r/.git", "src/app.py"), undefined, "your own claim never holds you");
  assert.equal(leaseConflict(leases, "h:1:a", "/r/.git", "api/v1/routes.py")?.lead, "api", "globs hold everything under them");
  assert.equal(leaseConflict(leases, "h:2:b", "/other/.git", "src/app.py"), undefined, "another repository is not held");
  assert.equal(leaseConflict(leases, "h:2:b", "/r/.git", "src/app.pyc"), undefined);
  assert.equal(removeLeases(dir, "h:1:a"), 1);
  assert.equal(readLeases(dir, alive, now).length, 1);
});

test("leases: a team run's checkout lease holds every file of that checkout only; claims meet overlapping claims", () => {
  const run = { ...newLease(base({ kind: "team-run", paths: ["**"], checkout: "/home/u/shop", reason: "team run: add login" }), 250, Date.now(), 2880) };
  assert.ok(leaseCovers(run, "/r/.git", "README.md", "/home/u/shop"));
  assert.ok(!leaseCovers(run, "/r/.git", "README.md", "/home/u/shop-feature"), "another worktree of the repo is free");
  assert.ok(Date.parse(run.until) - Date.now() > 240 * 60_000, "a team run lease lasts as long as the run may");
  assert.match(leaseBlockReason(run, "README.md"), /team run going on this checkout.*separate worktree/);
  const claim = newLease(base(), 30);
  assert.match(leaseBlockReason(claim, "src/app.py"), /claimed by lead shop until \d\d:\d\d \(refactor\).*leads release/);
  assert.equal(claimConflicts([claim], "h:9:z", "/r/.git", ["src/**"]).length, 1);
  assert.equal(claimConflicts([claim], "h:9:z", "/r/.git", ["web/**"]).length, 0);
  assert.equal(claimConflicts([run], "h:9:z", "/r/.git", ["x.py"], "/home/u/other").length, 0, "a checkout lease does not stop claims made for another checkout");
  assert.match(formatLease(run), /shop \(team run\): every file in its checkout, until/);
});

test("leases: paths must be inside the repo, at most 480 minutes for a claim; Windows paths compare without case", () => {
  assert.throws(() => newLease(base({ paths: ["../etc/passwd"] }), 10), /relative to the repo root/);
  assert.throws(() => newLease(base({ paths: ["/etc/passwd"] }), 10), /relative to the repo root/);
  assert.throws(() => newLease(base({ paths: [] }), 10), /name the files/);
  const l = newLease(base({ paths: ["./Src/App.py", "Src/App.py"] }), 100_000);
  assert.deepEqual(l.paths, ["Src/App.py"]);
  assert.ok(Date.parse(l.until) - Date.parse(l.at) <= 480 * 60_000);
  assert.ok(leaseCovers(l, "/r/.git", "src/app.py", undefined, true));
  assert.ok(!leaseCovers(l, "/r/.git", "src/app.py", undefined, false));
});

test("leases: a team run's checkout lease does not stop a claim made from another worktree of the repo", () => {
  const run = newLease(base({ kind: "team-run", paths: ["**"], checkout: "/home/u/shop", owner: "h:1:a" }), 60);
  assert.equal(claimConflicts([run], "h:2:b", "/r/.git", ["src/x.py"], "/home/u/shop-feature").length, 0, "from another worktree");
  assert.equal(claimConflicts([run], "h:2:b", "/r/.git", ["src/x.py"], "/home/u/shop").length, 1, "in the run's own checkout it does");
});
