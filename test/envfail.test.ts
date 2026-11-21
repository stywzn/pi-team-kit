import assert from "node:assert/strict";
import { test } from "node:test";
import { ENV_FAILURE_JS, envFailure, envFailureNote } from "../lib/envfail.ts";

const samples: [string, string | undefined][] = [
  ["Error: listen EADDRINUSE: address already in use :::3000", "port in use"],
  ["psycopg2.OperationalError: could not connect to server: Connection refused\n\tIs the server running on host \"localhost\"", "service not reachable"],
  ["requests.exceptions.ConnectionError: HTTPConnectionPool(host='localhost', port=8000): [Errno 111] Connection refused", "service not reachable"],
  ["Cannot connect to the Docker daemon at unix:///var/run/docker.sock. Is the docker daemon running?", "docker not running"],
  ["bash: line 1: pnpm: command not found", "command missing"],
  ["'npx' is not recognized as an internal or external command,", "command missing"],
  ["E   ModuleNotFoundError: No module named 'httpx'", "package missing"],
  ["Error: Cannot find module 'express'", "package missing"],
  ["browserType.launch: Executable doesn't exist at /root/.cache/ms-playwright/chromium-1105/chrome-linux/chrome", "browser missing"],
  ["getaddrinfo ENOTFOUND registry.npmjs.org", "network or DNS"],
  ["OSError: [Errno 28] No space left on device", "disk full"],
  ["FATAL ERROR: Reached heap limit Allocation failed - JavaScript heap out of memory", "out of memory"],
  ['django.db.utils.OperationalError: FATAL:  database "shop_test" does not exist', "missing setting"],
  ["sqlite3.OperationalError: database is locked", "file locked"],
  // code problems stay code problems
  ["FAILED tests/test_login.py::test_lock - AssertionError: assert 3 == 2", undefined],
  ["TypeError: Cannot read properties of undefined (reading 'id')", undefined],
  ["E   ModuleNotFoundError: No module named 'app.utilz'", undefined], // a module path of the project itself: code
  ["Error: Cannot find module './utils/format'", undefined],
  ["ModuleNotFoundError while importing the isServiceBusy helper", undefined],
  ["SyntaxError: invalid syntax", undefined],
];

test("environment failures are told apart from code failures by their output", () => {
  for (const [out, kind] of samples) assert.equal(envFailure(out)?.kind, kind, out);
  const f = envFailure("noise\n".repeat(500) + "Error: listen EADDRINUSE :::5173")!;
  assert.equal(f.line, "Error: listen EADDRINUSE :::5173", "the matching line is quoted");
  assert.equal(envFailure("Error: listen EADDRINUSE :::5173\n" + "ok\n".repeat(300)), undefined, "only the end of a long output counts");
});

test("the note tells a worker to report, the lead to fix the environment or tell the user; never to change code around it", () => {
  const f = envFailure("connect ECONNREFUSED 127.0.0.1:5432")!;
  const w = envFailureNote(f, "worker");
  assert.match(w, /environment problem \(service not reachable/);
  assert.match(w, /Do not change code, tests or config to get around it.*contact_supervisor.*BLOCKED/s);
  assert.match(envFailureNote(f, "lead"), /tell the user what is missing/);
});

test("the workflow's copy finds the same problems as the extension's", () => {
  const fn = new Function(`${ENV_FAILURE_JS}; return envFailure;`)() as (t: string) => { kind: string } | null;
  for (const [out, kind] of samples) assert.equal(fn(out)?.kind, kind, out);
});
