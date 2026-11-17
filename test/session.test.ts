import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { test } from "node:test";
import { DEFAULTS } from "../lib/config.ts";
import { buildNotification, compactThreshold, detectRole, modelCaps, sessionNameFrom, terminalTitle } from "../lib/session.ts";

const ROOT = resolve(import.meta.dirname, "..");
const body = (agent: string) => readFileSync(join(ROOT, "agents", `${agent}.md`), "utf8").split(/^---$/m)[2];

test("roles are detected from this package's agent prompts, so each gets its own context budget", () => {
  assert.equal(detectRole({}, body("team-planner")), "planner");
  assert.equal(detectRole({ PI_SUBAGENT_CHILD: "1" }, body("team-worker")), "worker");
  assert.equal(detectRole({ PI_SUBAGENT_CHILD: "1" }, body("team-verifier")), "verifier");
  assert.equal(detectRole({ PI_SUBAGENT_CHILD: "1" }, "You are scout."), "child");
  assert.equal(detectRole({}, "You are pi, a coding agent."), "lead");
});

test("compaction threshold: role budget, capped by a fraction of the model window", () => {
  const c = DEFAULTS.context;
  assert.equal(compactThreshold("lead", c, 1_000_000), 160_000, "1M-token model: still compacts at the lead budget");
  assert.equal(compactThreshold("lead", c, 128_000), 64_000, "small window: half the window");
  assert.equal(compactThreshold("verifier", c, 1_000_000), 60_000);
  assert.equal(compactThreshold("worker", c, undefined), 120_000);
  assert.equal(compactThreshold("lead", { ...c, maxWindowFraction: 0.01 }, 32_000), 30_000, "never below what pi can actually compact");
});

test("model caps give each role's model its budget plus the compaction reserve", () => {
  const caps = modelCaps({ lead: "deepseek/deepseek-v4-pro", planner: "deepseek/deepseek-v4-pro", worker: "deepseek/deepseek-flash", verifier: "zai-coding-cn/glm-5-3" }, DEFAULTS.context);
  assert.deepEqual(caps, {
    deepseek: { "deepseek-v4-pro": { contextWindow: 160_000 + 16_384 }, "deepseek-flash": { contextWindow: 120_000 + 16_384 } },
    "zai-coding-cn": { "glm-5-3": { contextWindow: 60_000 + 16_384 } },
  });
  assert.deepEqual(modelCaps({ worker: "" }, DEFAULTS.context), {}, "unknown models are skipped");
});

test("sessions are named after the first prompt", () => {
  assert.equal(sessionNameFrom("/team fix the flaky checkout test"), "team: fix the flaky checkout test");
  assert.equal(sessionNameFrom("给登录接口补 E2E 测试\n第二行不要"), "给登录接口补 E2E 测试");
  assert.equal(sessionNameFrom("/skill:retro"), "retro");
  assert.equal(sessionNameFrom("/model"), undefined);
  assert.equal(sessionNameFrom("   "), undefined);
  const long = sessionNameFrom("a".repeat(100)) ?? "";
  assert.equal(long.length, 40);
  assert.ok(long.endsWith("…"));
});

test("title shows session name and directory, with a marker while working", () => {
  assert.equal(terminalTitle("team: fix flake", "shop-api", false), "π team: fix flake · shop-api");
  assert.equal(terminalTitle(undefined, "shop-api", true), "● π shop-api");
});

test("notifications pick the right mechanism and escape their text", () => {
  const wsl = buildNotification("pi · it's done", "Done after 42s", "linux", { WSL_DISTRO_NAME: "Ubuntu" }, false);
  assert.equal(wsl.kind, "spawn");
  assert.equal(wsl.kind === "spawn" && wsl.command, "powershell.exe");
  assert.equal(wsl.kind === "spawn" && wsl.args[2], "-EncodedCommand");
  const script = Buffer.from(wsl.kind === "spawn" ? wsl.args[3] : "", "base64").toString("utf16le");
  assert.match(script, /'pi · it''s done'/, "text survives as UTF-16, single quotes doubled for PowerShell");
  const mac = buildNotification('say "hi"', "b", "darwin", {}, false);
  assert.equal(mac.kind === "spawn" && mac.command, "osascript");
  assert.match(mac.kind === "spawn" ? mac.args[1] : "", /with title "say \\"hi\\""/);
  assert.equal(buildNotification("t", "b", "linux", { DISPLAY: ":0" }, true).kind, "spawn");
  const osc = buildNotification("t;x", "b\x07evil", "linux", {}, false);
  assert.equal(osc.kind, "osc");
  assert.equal(osc.kind === "osc" && osc.sequence, "\x1b]777;notify;t,x;b evil\x07", "control characters and separators stripped");
  const tmux = buildNotification("t", "b", "linux", { TMUX: "/tmp/tmux" }, false);
  assert.ok(tmux.kind === "osc" && tmux.sequence.startsWith("\x1bPtmux;"), "wrapped for tmux passthrough");
});
