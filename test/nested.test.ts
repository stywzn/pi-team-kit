// Nested workers: a worker splits its own task into parts that run at the same time; two levels at most.
import assert from "node:assert/strict";
import { test } from "node:test";
import { approvePartCall, partTask, validateParts, type Part } from "../lib/nested.ts";

const part = (title: string, files: string[]): Part => ({ title, brief: `Write the ${title} cases and run them.`, files });

test("parts: 2 to max, own files only, never sharing a file", () => {
  const ok = validateParts([part("login", ["tests/kh/test_login.py"]), part("cart", ["tests/kh/test_cart.py"])], 3, ["tests/kh/"]);
  assert.equal(ok.length, 2);
  assert.throws(() => validateParts([part("one", ["a.py"])], 3), /at least 2 parts/);
  assert.throws(() => validateParts([part("a", ["a.py"]), part("b", ["b.py"]), part("c", ["c.py"]), part("d", ["d.py"])], 3), /at most 3 parts/);
  assert.throws(() => validateParts([part("a", ["tests/x.py"]), part("b", ["tests/"])], 3), /share tests\/x\.py/);
  assert.throws(() => validateParts([part("a", ["lib/bench_seed.py"]), part("b", ["tests/kh/b.py"])], 3, ["tests/kh/"]), /lib\/bench_seed\.py" is not one of your own files/);
  assert.throws(() => validateParts([part("a", ["../x.py"]), { title: "", brief: "short", files: [] }], 3), /relative to the repo root[\s\S]*title[\s\S]*brief[\s\S]*files/);
  assert.ok(validateParts([part("a", ["a.py"]), part("b", ["b.py"])], 3, ["**"]), "a worker that owns everything");
});

test("a part's task: its files, the others' files to leave alone, the report format", () => {
  const [a, b] = validateParts([{ ...part("login", ["tests/test_login.py"]), verify: { cmd: "pytest tests/test_login.py -q", expect: "4 passed" } }, part("cart", ["tests/test_cart.py"])], 3);
  const t = partTask("automate the KH cases", a, [b]);
  assert.match(t, /^You are a sub-worker in a team run/);
  assert.match(t, /Overall goal: automate the KH cases/);
  assert.match(t, /Done when: "pytest tests\/test_login\.py -q" prints "4 passed"/);
  assert.match(t, /Files you own[^\n]*\n- tests\/test_login\.py/);
  assert.match(t, /do not touch them: tests\/test_cart\.py/);
  assert.match(t, /Status: DONE, DONE_WITH_CONCERNS or BLOCKED/);
});


test("a worker's subagent call runs only an approved part, with the deadline, hand-off and folder set in code", () => {
  const approved = new Map([["ptk-part-1", { task: "You are a sub-worker... part 1", model: "deepseek/deepseek-flash:high" }]]);
  const opts = { cwd: "/wt/lane", timeoutMs: 7_200_000, checkpointMs: 600_000, subworker: false };
  const call: Record<string, unknown> = { agent: "team-subworker", task: "ptk-part-1", timeoutMs: 60_000, async: false, cwd: "/elsewhere" };
  assert.equal(approvePartCall(call, approved, opts), undefined);
  assert.deepEqual(call, { agent: "team-subworker", task: "You are a sub-worker... part 1", async: true, cwd: "/wt/lane", timeoutMs: 7_200_000, model: "deepseek/deepseek-flash:high", checkpointBeforeDeadlineMs: 600_000 });
  assert.match(approvePartCall({ agent: "team-subworker", task: "ptk-part-1" }, approved, opts) ?? "", /only through subtasks/, "an id is used once");
  assert.ok(approvePartCall({ agent: "team-worker", task: "do anything" }, new Map([["x", { task: "t" }]]), opts), "any other agent or task is refused");
  assert.ok(approvePartCall({ agent: "team-subworker", task: "ptk-part-1" }, new Map([["ptk-part-1", { task: "t" }]]), { ...opts, subworker: true }), "a sub-worker cannot start more");
  assert.equal(approvePartCall({ action: "status", id: "r1" }, new Map(), opts), undefined, "looking at runs is fine");
  const short: Record<string, unknown> = { agent: "team-subworker", task: "a" };
  approvePartCall(short, new Map([["a", { task: "t" }]]), { ...opts, timeoutMs: 300_000, checkpointMs: 600_000 });
  assert.equal(short.checkpointBeforeDeadlineMs, undefined, "no hand-off longer than the deadline");
});
