import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
// @ts-expect-error plain .mjs helper without types
import { cleanStderr, findPowerShell, parseArgs, psScript } from "../toolbox/winui/run.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const tool = join(here, "..", "toolbox", "winui", "run.mjs");

test("winui: arguments, and a request that no quoting can break", () => {
  assert.equal(parseArgs(["click", "app"]), undefined, "click needs a control");
  assert.equal(parseArgs(["dance"]), undefined);
  assert.deepEqual(parseArgs(["type", "My App", "nameBox", "x", "--index", "2", "--type", "Edit"]), {
    action: "type", window: "My App", control: "nameBox", text: "x", type: "Edit", index: 2, depth: 4, timeout: 30,
  });
  const text = `张三 "quoted" 'single' $(Remove-Item x) {x} \`n`;
  const script = psScript({ action: "type", window: "w", control: "c", text });
  const b64 = /FromBase64String\('([A-Za-z0-9+/=]+)'\)/.exec(script)![1];
  assert.equal(JSON.parse(Buffer.from(b64, "base64").toString("utf8")).text, text, "the text travels as data, never as PowerShell code");
  assert.doesNotMatch(script, /Remove-Item/);
  const clixml = '#< CLIXML\r\n<Objs Version="1.1.0.1" xmlns="x"><Obj S="progress" RefId="0"><TN RefId="0"><T>x</T></TN></Obj><S S="Error">no control matches "a" &amp; b_x000D__x000A_</S><S S="Error">Run: winui tree "w"_x000D__x000A_</S></Objs>';
  assert.equal(cleanStderr(clixml), 'no control matches "a" & b\nRun: winui tree "w"', "errors are kept, progress records dropped");
  assert.equal(findPowerShell("win32"), "powershell.exe");
  assert.equal(findPowerShell("linux", () => false), undefined);
  assert.equal(findPowerShell("darwin"), undefined);
});

test("winui: usage errors exit 2, other systems exit 3", () => {
  assert.equal(spawnSync(process.execPath, [tool, "click", "only-window"], { encoding: "utf8" }).status, 2);
  if (!findPowerShell()) assert.equal(spawnSync(process.execPath, [tool, "windows"], { encoding: "utf8" }).status, 3);
});

// Opens a real window: run with PTK_GUI_TESTS=1 on Windows, or in WSL on a Windows machine.
test("winui: drives a real window by control names", { skip: !process.env.PTK_GUI_TESTS || !findPowerShell() }, async () => {
  const ps = findPowerShell()!;
  const app = process.platform === "win32" ? join(here, "e2e", "winui-app.ps1") : spawnSync("wslpath", ["-w", join(here, "e2e", "winui-app.ps1")], { encoding: "utf8" }).stdout.trim();
  const closeAll = () =>
    spawnSync(ps, ["-NoProfile", "-Command", "Get-Process powershell -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowTitle -like 'ptk winui test*' } | Stop-Process -Force"], { stdio: "ignore" });
  closeAll(); // a window left by an interrupted run would be found first
  const child = spawn(ps, ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", app], { stdio: "ignore" });
  const w = "ptk winui test";
  const run = (...args: string[]) => spawnSync(process.execPath, [tool, ...args], { encoding: "utf8", timeout: 120_000 });
  try {
    const ready = run("wait", w, "Say hi", "--timeout", "40");
    assert.equal(ready.status, 0, ready.stderr);
    const tree = run("tree", w);
    assert.match(tree.stdout, /Button "Say hi"/);
    assert.match(tree.stdout, /Edit "Name box" id=nameBox/);
    assert.match(run("windows").stdout, /ptk winui test 测试 \[powershell pid:\d+\]/);
    const typed = `张三 "q" {x}`;
    assert.match(run("type", w, "nameBox", typed).stdout, /value set/);
    assert.match(run("click", w, "Agree").stdout, /toggled to On/);
    assert.match(run("click", w, "Say hi", "--type", "Button").stdout, /invoked/);
    // Invoke posts the click to the app; its handler runs a moment later.
    let result = "";
    for (let i = 0; i < 10 && result !== `hi ${typed} agree=True`; i++) result = run("read", w, "result").stdout.trim();
    assert.equal(result, `hi ${typed} agree=True`);
    assert.equal(run("read", w, "Name box").stdout.trim(), typed);
    const missing = run("click", w, "No such button");
    assert.equal(missing.status, 1);
    assert.match(missing.stderr, /no control matches "No such button".*Run: winui tree/s);
    assert.match(run("click", "no window like this", "x").stderr, /no window matches/);
  } finally {
    child.kill();
    closeAll();
  }
});
