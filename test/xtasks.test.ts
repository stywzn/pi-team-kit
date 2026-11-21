import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { addTask, dropTask, finishTask, formatTasks, readTasks, readyMessage, taskState } from "../lib/xtasks.ts";

test("cross-lead tasks: the web task waits for the api task and becomes ready when it is done", () => {
  const board = mkdtempSync(join(tmpdir(), "ptk-xt-"));
  const api = addTask(board, { title: "POST /v2/login returns a session cookie", lead: "api" });
  const docs = addTask(board, { title: "document /v2/login", lead: "docs" });
  const web = addTask(board, { title: "login page uses /v2/login", lead: "web", after: [api.id, docs.id] });
  let all = readTasks(board);
  assert.equal(taskState(web, all), "waiting");
  assert.equal(taskState(api, all), "ready");
  assert.match(formatTasks(all, "web"), new RegExp(`\\[${web.id}\\] web \\(you\\): login page uses /v2/login - waiting, waits for ${api.id} \\(api, open\\), ${docs.id} \\(docs, open\\)`));
  assert.throws(() => finishTask(board, api.id, "web"), /belongs to lead api/);
  const first = finishTask(board, api.id, "api", "cookie name is sid");
  assert.deepEqual(first.ready, [], "web still waits for docs");
  const second = finishTask(board, docs.id, "docs");
  assert.deepEqual(second.ready.map((t) => t.id), [web.id], "the last one it waited for makes it ready");
  all = readTasks(board);
  assert.equal(taskState(all.find((t) => t.id === web.id)!, all), "ready");
  assert.match(readyMessage(first.task, web), /Task t\w+ "POST \/v2\/login returns a session cookie" \(lead api\) is done: cookie name is sid\. Your task t\w+ "login page uses \/v2\/login" waited for it and can start now/);
  assert.deepEqual(finishTask(board, api.id, "api").ready, [], "done twice changes nothing");
  assert.ok(!dropTask(board, web.id, "api"), "only the owner drops it");
  assert.ok(dropTask(board, web.id, "web"));
});

test("cross-lead tasks: unknown ids, empty or long titles and broken files are handled", () => {
  const board = mkdtempSync(join(tmpdir(), "ptk-xt-"));
  assert.throws(() => addTask(board, { title: "x", lead: "a", after: ["tnope123"] }), /no task "tnope123"/);
  assert.throws(() => addTask(board, { title: "   ", lead: "a" }), /one line/);
  assert.throws(() => addTask(board, { title: "x".repeat(201), lead: "a" }), /under 200/);
  mkdirSync(join(board, "tasks"), { recursive: true });
  writeFileSync(join(board, "tasks", "evil.json"), JSON.stringify({ id: "../../x", title: "t", lead: "a" }));
  writeFileSync(join(board, "tasks", "bad.json"), "{");
  assert.deepEqual(readTasks(board), []);
  assert.throws(() => finishTask(board, "../../etc/passwd", "a"), /no task/);
});
