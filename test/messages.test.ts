// Reliable lead messages: ids, threads, receipts (queued, read, answered), no duplicates, and a thread that has gone
// back and forth too often stops and goes to the users.
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { DEDUPE_MS, formatIncoming, formatReceipts, markDelivered, MAX_THREAD, readInbox, readReceipt, sendMessage, sentReceipts, takeInbox, writeCard, type LeadCard } from "../lib/board.ts";

const T0 = Date.now();
const iso = (ms: number) => new Date(ms).toISOString();
const card = (name: string): LeadCard => ({ name, owner: `host:${name}`, cwd: `/c/${name}`, status: "", working: false, files: [], startedAt: iso(T0), updatedAt: iso(T0) });
const board = () => {
  const dir = mkdtempSync(join(tmpdir(), "ptk-msg-"));
  for (const n of ["api", "web", "docs"]) writeCard(dir, card(n));
  return dir;
};

test("a message has an id and a receipt: queued, then read when the receiver takes it in, then answered by re=<id>", () => {
  const dir = board();
  const sent = sendMessage(dir, { from: "api", to: "web", text: "POST /v2/login is live", update: true, hops: 0 }, T0);
  const id = sent.ids.web;
  assert.equal(readReceipt(dir, id)?.state, "queued");
  const box = readInbox(dir, "web");
  assert.equal(box.messages[0].id, id);
  assert.equal(box.messages[0].thread, id);
  assert.equal(box.messages[0].n, 1);
  const shown = formatIncoming(box.messages);
  assert.match(shown, new RegExp(`\\[id ${id}\\]`));
  assert.match(shown, new RegExp(`answer api in one line with what you changed: leads send to=api re=${id}`));
  markDelivered(dir, [id], T0 + 1);
  assert.equal(readReceipt(dir, id)?.state, "delivered");
  assert.match(formatReceipts(sentReceipts(dir, "api"), T0 + 2), /to web.*read, not answered yet \(an update request: they should answer\)/);
  const answer = sendMessage(dir, { from: "web", to: "api", text: "updated the client to /v2/login", update: false, hops: 1, re: id }, T0 + 3);
  assert.equal(answer.thread, id, "an answer joins the thread");
  assert.equal(answer.n, 2);
  const r = readReceipt(dir, id)!;
  assert.equal(r.state, "answered");
  assert.equal(r.answer, "updated the client to /v2/login");
  assert.match(formatReceipts(sentReceipts(dir, "api"), T0 + 4), /answered .*"updated the client to \/v2\/login"/);
  const back = takeInbox(dir, "api")[0];
  assert.equal(back.re, id);
  assert.match(formatIncoming([back]), new RegExp(`answering your message ${id} \\(message 2 of at most ${MAX_THREAD} in this thread\\)`));
});

test("only the receiver can answer a message; an unknown id is refused", () => {
  const dir = board();
  const id = sendMessage(dir, { from: "api", to: "web", text: "q", update: false, hops: 0 }, T0).ids.web;
  assert.throws(() => sendMessage(dir, { from: "docs", to: "api", text: "a", update: false, hops: 0, re: id }, T0 + 1), /was not sent to you/);
  assert.throws(() => sendMessage(dir, { from: "web", to: "api", text: "a", update: false, hops: 0, re: "zzzzzzzzzzzz" }, T0 + 1), /no message with id/);
  assert.throws(() => sendMessage(dir, { from: "web", to: "api", text: "a", update: false, hops: 0, re: "../../etc" }, T0 + 1), /no message with id/);
});

test("a thread that has gone back and forth too often stops: the leads tell their users instead", () => {
  const dir = board();
  let re = sendMessage(dir, { from: "api", to: "web", text: "m1", update: true, hops: 0 }, T0).ids.web;
  let from = "web";
  let to = "api";
  for (let n = 2; n <= MAX_THREAD; n++) {
    const r = sendMessage(dir, { from, to, text: `m${n}`, update: true, hops: 0, re }, T0 + n);
    assert.equal(r.n, n);
    re = r.ids[to];
    [from, to] = [to, from];
  }
  assert.throws(() => sendMessage(dir, { from, to, text: "one more", update: true, hops: 0, re }, T0 + 99), /gone back and forth 6 times\. Stop messaging about it: tell your user/);
  // a new message (not an answer) starts a new thread
  assert.equal(sendMessage(dir, { from, to, text: "a different topic", update: false, hops: 0 }, T0 + 100).n, 1);
});

test("the same words to the same lead again within minutes are refused; to someone else, or later, they go", () => {
  const dir = board();
  sendMessage(dir, { from: "api", to: "web", text: "Run the migration  before testing", update: true, hops: 0 }, T0);
  assert.throws(() => sendMessage(dir, { from: "api", to: "web", text: "run the migration before testing", update: true, hops: 0 }, T0 + 60_000), /You sent exactly this to web at .* Do not send it again/);
  assert.equal(sendMessage(dir, { from: "api", to: "docs", text: "Run the migration before testing", update: false, hops: 0 }, T0 + 60_000).delivered[0], "docs");
  assert.ok(sendMessage(dir, { from: "api", to: "web", text: "Run the migration before testing", update: true, hops: 0 }, T0 + DEDUPE_MS + 1).ids.web, "later it goes (web is offline by then: it waits in the inbox)");
  for (const n of ["web", "docs"]) writeCard(dir, { ...card(n), updatedAt: iso(T0 + DEDUPE_MS) });
  const all = sendMessage(dir, { from: "api", to: "all", text: "release at 5", update: false, hops: 0 }, T0 + DEDUPE_MS + 2);
  assert.deepEqual(all.delivered.sort(), ["docs", "web"]);
  assert.throws(() => sendMessage(dir, { from: "api", to: "all", text: "release at 5", update: false, hops: 0 }, T0 + DEDUPE_MS + 3), /You sent exactly this to (docs, web|web, docs)/, "everyone already has it");
});

test("messages written by an older version (no id, thread or position) still read fine", () => {
  const dir = board();
  mkdirSync(join(dir, "web.inbox"), { recursive: true });
  writeFileSync(join(dir, "web.inbox", "0001795000000000-1-ab.json"), JSON.stringify({ from: "api", to: "web", text: "old style", update: false, hops: 0, at: iso(T0) }));
  const m = readInbox(dir, "web").messages[0];
  assert.equal(m.text, "old style");
  assert.equal(m.n, 1);
  assert.equal(m.thread, m.id);
  assert.doesNotMatch(formatIncoming([m]), /\[id /, "an id that is not ours is not offered for answers");
});
