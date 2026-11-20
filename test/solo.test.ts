// Team mode by default: past a few files in one request, the lead hands the rest to workers.
import assert from "node:assert/strict";
import { test } from "node:test";
import { SoloWork } from "../lib/solo.ts";

test("the lead may change N files in a request; a new one after that goes to workers", () => {
  const s = new SoloWork({ enabled: true, files: 3, nudgeCalls: 0 });
  for (const f of ["/r/a.py", "/r/b.py", "/r/c.py"]) {
    assert.equal(s.before("edit", f), undefined);
    s.after("edit", f, false);
  }
  assert.match(s.before("write", "/r/d.py") ?? "", /4th file \(already: a\.py, b\.py, c\.py\)[\s\S]*team_run/);
  assert.equal(s.before("edit", "/r/a.py"), undefined, "finishing a file it already changed is fine");
  assert.equal(s.before("read", "/r/d.py"), undefined, "reading is never stopped");
  s.after("edit", "/r/x.py", true);
  assert.ok(s.before("edit", "/r/x.py"), "a failed edit does not count as changed, and does not unlock");
  s.after("team_run", undefined, false);
  assert.equal(s.before("edit", "/r/d.py"), undefined, "after a team run the lead may fix up anything");
  s.userInput();
  for (const f of ["/r/1", "/r/2", "/r/3"]) s.after("edit", f, false);
  assert.ok(s.before("edit", "/r/4"));
  s.userInput();
  assert.equal(s.before("edit", "/r/4"), undefined, "the user replied: a new count");
  s.after("team_run", undefined, true);
  for (const f of ["/r/5", "/r/6", "/r/7"]) s.after("edit", f, false);
  assert.ok(s.before("edit", "/r/8"), "a team run that failed to start does not unlock");
});

test("off, or files 0, means no limit; the note comes once at nudgeCalls", () => {
  const off = new SoloWork({ enabled: false, files: 1, nudgeCalls: 2 });
  off.after("edit", "/a", false);
  assert.equal(off.before("edit", "/b"), undefined);
  assert.equal(off.after("read", undefined, false), undefined, "no note when off");
  const zero = new SoloWork({ enabled: true, files: 0, nudgeCalls: 0 });
  zero.after("edit", "/a", false);
  assert.equal(zero.before("edit", "/b"), undefined);
  const n = new SoloWork({ enabled: true, files: 0, nudgeCalls: 3 });
  assert.deepEqual([n.after("read", undefined, false), n.after("grep", undefined, false)], [undefined, undefined]);
  assert.match(n.after("bash", undefined, false) ?? "", /3 tool calls[\s\S]*team_run runs them in parallel/);
  assert.equal(n.after("read", undefined, false), undefined, "once per request");
});
