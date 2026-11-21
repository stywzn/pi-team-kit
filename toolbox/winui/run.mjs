#!/usr/bin/env node
// winui: drive a Windows desktop app by its controls (Windows UI Automation), not by screenshot coordinates.
//   winui windows                                  list top-level windows
//   winui tree <window> [--depth 4]                list the window's controls (type, name, id)
//   winui click <window> <control>                 press a button, toggle a checkbox, select an item
//   winui type <window> <control> <text>           set a text box's value
//   winui read <window> <control>                  print a control's value or text
//   winui wait <window> [control] [--timeout 30]   wait until the window (or control) exists
//   winui focus <window>                           bring the window to the front
// <window>: part of the title, a process name (notepad), or pid:1234. <control>: its name or automation id,
// exact match first, then part of the name. --type Button narrows by control type, --index N picks the Nth match.
// Works from Windows and from WSL (through powershell.exe). Uses Windows PowerShell 5.1, which ships with Windows.

import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

const USAGE = `usage:
  winui windows
  winui tree <window> [--depth 4]
  winui click <window> <control> [--type Button] [--index N]
  winui type <window> <control> <text> [--type Edit] [--index N]
  winui read <window> <control> [--type Text] [--index N]
  winui wait <window> [control] [--timeout 30]
  winui focus <window>
<window>: part of the title, a process name (notepad) or pid:1234
<control>: name or automation id (exact first, then part of the name); run tree to see them`;

const ACTIONS = { windows: 0, tree: 1, click: 2, type: 3, read: 2, wait: 1, focus: 1 };

export function parseArgs(argv) {
  const args = [...argv];
  const opt = (name, fallback) => {
    const i = args.indexOf(name);
    if (i < 0) return fallback;
    const v = args[i + 1];
    args.splice(i, 2);
    return v ?? fallback;
  };
  const type = opt("--type", "");
  const index = Number(opt("--index", "1"));
  const depth = Number(opt("--depth", "4"));
  const timeout = Number(opt("--timeout", "30"));
  const [action, window = "", control = "", text = ""] = args;
  if (!(action in ACTIONS) || args.length - 1 < ACTIONS[action]) return undefined;
  return {
    action,
    window,
    control,
    text,
    type,
    index: Number.isInteger(index) && index > 0 ? index : 1,
    depth: Number.isInteger(depth) && depth > 0 ? Math.min(depth, 12) : 4,
    timeout: Number.isFinite(timeout) && timeout > 0 ? Math.min(timeout, 600) : 30,
  };
}

/** The PowerShell program for one request; the request travels as base64 JSON, so no quoting can break it. */
export function psScript(req) {
  const data = Buffer.from(JSON.stringify(req), "utf8").toString("base64");
  return `$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$req = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('${data}')) | ConvertFrom-Json
Add-Type -AssemblyName UIAutomationClient, UIAutomationTypes
# Without the client-side providers, classic Win32/WinForms controls show up as bare panes with no patterns.
# The first registration call fails inside ProxyManager.LoadDefaultProxies (a .NET Framework fault); the second works.
$cspError = $null
try {
  $csp = [Reflection.Assembly]::LoadWithPartialName('UIAutomationClientsideProviders')
  $table = $csp.GetType('UIAutomationClientsideProviders.UIAutomationClientSideProviders').GetField('ClientSideProviderDescriptionTable').GetValue($null)
  foreach ($try in 1..2) { try { [System.Windows.Automation.ClientSettings]::RegisterClientSideProviders($table); $cspError = $null; break } catch { $cspError = $_.Exception.Message } }
} catch { $cspError = $_.Exception.Message }
if ($cspError) { [Console]::Error.WriteLine('note: classic Win32 controls may show as panes: ' + $cspError) }
$A = [System.Windows.Automation.AutomationElement]
$Scope = [System.Windows.Automation.TreeScope]
$Any = [System.Windows.Automation.Condition]::TrueCondition
function Fail($msg, $code) { [Console]::Error.WriteLine($msg); exit $code }
function TypeName($el) { $el.Current.ControlType.ProgrammaticName -replace '^ControlType\\.', '' }
function ProcName($el) { try { (Get-Process -Id $el.Current.ProcessId -ErrorAction Stop).ProcessName } catch { '?' } }
function Q($s) { '"' + $s + '"' }
function Describe($el) {
  $c = $el.Current; $s = (TypeName $el) + ' ' + (Q $c.Name)
  if ($c.AutomationId) { $s += ' id=' + $c.AutomationId }
  if (-not $c.IsEnabled) { $s += ' (disabled)' }
  $s
}
function WindowLine($w) { $w.Current.Name + ' [' + (ProcName $w) + ' pid:' + $w.Current.ProcessId + ']' }
function Windows() { @($A::RootElement.FindAll($Scope::Children, $Any)) | Where-Object { $_.Current.Name } }
function FindWindow($q) {
  $all = Windows
  if ($q -match '^pid:(\\d+)$') { $hit = @($all | Where-Object { $_.Current.ProcessId -eq [int]$Matches[1] }) }
  else {
    $hit = @($all | Where-Object { $_.Current.Name -eq $q })
    if (-not $hit.Count) { $hit = @($all | Where-Object { $_.Current.Name -and $_.Current.Name.IndexOf($q, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
    if (-not $hit.Count) { $hit = @($all | Where-Object { (ProcName $_) -ieq ($q -replace '\\.exe$', '') }) }
  }
  if ($hit.Count) { return $hit[0] }
  return $null
}
function FindControl($win, $q) {
  $all = @($win.FindAll($Scope::Descendants, $Any))
  if ($req.type) { $all = @($all | Where-Object { (TypeName $_) -ieq $req.type }) }
  $hit = @($all | Where-Object { $_.Current.Name -eq $q -or $_.Current.AutomationId -eq $q })
  if (-not $hit.Count) { $hit = @($all | Where-Object { $_.Current.Name -and $_.Current.Name.IndexOf($q, [StringComparison]::OrdinalIgnoreCase) -ge 0 }) }
  if ($hit.Count -ge $req.index) { return $hit[$req.index - 1] }
  return $null
}
function NeedWindow() {
  $w = FindWindow $req.window
  if (-not $w) {
    $open = (Windows | ForEach-Object { '  ' + (WindowLine $_) }) -join [Environment]::NewLine
    Fail ('no window matches {0}. Open windows:{1}{2}' -f (Q $req.window), [Environment]::NewLine, $open) 1
  }
  $w
}
function NeedControl($w) {
  $c = FindControl $w $req.control
  if (-not $c) {
    $kind = ''; if ($req.type) { $kind = ' of type ' + $req.type }
    Fail ('no control matches {0}{1} in {2}. Run: winui tree {3}' -f (Q $req.control), $kind, (Q $w.Current.Name), (Q $req.window)) 1
  }
  $c
}
function Pattern($el, $p) { $o = $null; if ($el.TryGetCurrentPattern($p, [ref]$o)) { return $o }; return $null }
function MouseClick($el) {
  Add-Type -Namespace PtkWinUi -Name Native -MemberDefinition '[DllImport("user32.dll")] public static extern bool SetCursorPos(int x, int y); [DllImport("user32.dll")] public static extern void mouse_event(uint f, uint x, uint y, uint d, System.UIntPtr e);'
  $r = $el.Current.BoundingRectangle
  if ($r.IsEmpty) { Fail "the control has no position on screen (hidden or off-screen)" 1 }
  [PtkWinUi.Native]::SetCursorPos([int]($r.X + $r.Width / 2), [int]($r.Y + $r.Height / 2)) | Out-Null
  [PtkWinUi.Native]::mouse_event(2, 0, 0, 0, [UIntPtr]::Zero); [PtkWinUi.Native]::mouse_event(4, 0, 0, 0, [UIntPtr]::Zero)
}

switch ($req.action) {
  'windows' { Windows | ForEach-Object { WindowLine $_ } }
  'tree' {
    $w = NeedWindow; $walker = [System.Windows.Automation.TreeWalker]::ControlViewWalker; $script:n = 0
    function Walk($el, $d) {
      if ($script:n -ge 400) { return }
      $script:n++; ('  ' * $d) + (Describe $el)
      if ($d -ge $req.depth) { return }
      $ch = $walker.GetFirstChild($el)
      while ($ch -and $script:n -lt 400) { Walk $ch ($d + 1); $ch = $walker.GetNextSibling($ch) }
    }
    Walk $w 0
    if ($script:n -ge 400) { "... cut at 400 controls; narrow with a deeper control or --depth" }
  }
  'click' {
    $c = NeedControl (NeedWindow)
    if (-not $c.Current.IsEnabled) { Fail ((Describe $c) + ' is disabled') 1 }
    if ($p = Pattern $c ([System.Windows.Automation.InvokePattern]::Pattern)) { $p.Invoke(); $how = 'invoked' }
    elseif ($p = Pattern $c ([System.Windows.Automation.TogglePattern]::Pattern)) { $p.Toggle(); $how = 'toggled to ' + $p.Current.ToggleState }
    elseif ($p = Pattern $c ([System.Windows.Automation.SelectionItemPattern]::Pattern)) { $p.Select(); $how = 'selected' }
    elseif ($p = Pattern $c ([System.Windows.Automation.ExpandCollapsePattern]::Pattern)) { $p.Expand(); $how = 'expanded' }
    else { MouseClick $c; $how = 'clicked with the mouse at its centre (it offers no invoke pattern)' }
    (Describe $c) + ': ' + $how
  }
  'type' {
    $c = NeedControl (NeedWindow)
    if ($p = Pattern $c ([System.Windows.Automation.ValuePattern]::Pattern)) {
      if ($p.Current.IsReadOnly) { Fail ((Describe $c) + ' is read-only') 1 }
      $p.SetValue([string]$req.text); (Describe $c) + ': value set'
    } else {
      Add-Type -AssemblyName System.Windows.Forms
      $c.SetFocus(); Start-Sleep -Milliseconds 100
      [System.Windows.Forms.SendKeys]::SendWait(([string]$req.text -replace '([+^%~(){}\\[\\]])', '{$1}'))
      (Describe $c) + ': typed with the keyboard (it offers no value pattern)'
    }
  }
  'read' {
    $c = NeedControl (NeedWindow)
    if ($p = Pattern $c ([System.Windows.Automation.ValuePattern]::Pattern)) { $p.Current.Value }
    elseif ($p = Pattern $c ([System.Windows.Automation.TextPattern]::Pattern)) { $p.DocumentRange.GetText(100000) }
    elseif ($p = Pattern $c ([System.Windows.Automation.TogglePattern]::Pattern)) { [string]$p.Current.ToggleState }
    else { $c.Current.Name }
  }
  'wait' {
    $end = (Get-Date).AddSeconds($req.timeout)
    while ((Get-Date) -lt $end) {
      $w = FindWindow $req.window
      if ($w -and (-not $req.control -or (FindControl $w $req.control))) { 'ready: ' + $w.Current.Name; exit 0 }
      Start-Sleep -Milliseconds 400
    }
    $what = Q $req.window; if ($req.control) { $what += ' / ' + (Q $req.control) }
    Fail ('timed out after {0}s waiting for {1}' -f $req.timeout, $what) 1
  }
  'focus' {
    $w = NeedWindow
    try { $w.SetFocus() } catch {}
    if ($p = Pattern $w ([System.Windows.Automation.WindowPattern]::Pattern)) { if ($p.Current.WindowVisualState -eq 'Minimized') { $p.SetWindowVisualState('Normal') } }
    "focused: $($w.Current.Name)"
  }
}
`;
}

/**
 * PowerShell started with redirected stderr writes CLIXML there: progress records (noise) and error records
 * (the message that matters). Keep the error text, decoded, and drop the rest.
 */
export function cleanStderr(stderr) {
  return stderr
    .replace(/^#< CLIXML\r?$/gm, "")
    .replace(/<Objs[^>]*>([\s\S]*?)<\/Objs>/g, (_m, body) =>
      [...body.matchAll(/<S S="Error">([\s\S]*?)<\/S>/g)]
        .map((m) => m[1])
        .join("")
        .replace(/_x000D__x000A_/g, "\n")
        .replace(/_x([0-9A-F]{4})_/g, (_x, hex) => String.fromCharCode(parseInt(hex, 16)))
        .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, "&"))
    .replace(/\r/g, "")
    .replace(/\n{2,}/g, "\n")
    .trim();
}

/** Windows PowerShell 5.1: on Windows by name, from WSL through interop. */
export function findPowerShell(platform = process.platform, exists = existsSync) {
  if (platform === "win32") return "powershell.exe";
  const wsl = "/mnt/c/Windows/System32/WindowsPowerShell/v1.0/powershell.exe";
  return platform === "linux" && exists(wsl) ? wsl : undefined;
}

function main() {
  const argv = process.argv.slice(2);
  if (!argv.length || argv[0] === "-h" || argv[0] === "--help") {
    console.log(USAGE);
    process.exit(argv.length ? 0 : 2);
  }
  const req = parseArgs(argv);
  if (!req) {
    console.error(USAGE);
    process.exit(2);
  }
  const ps = findPowerShell();
  if (!ps) {
    console.error("winui drives Windows desktop apps: run it on Windows or inside WSL on a Windows machine.");
    process.exit(3);
  }
  const encoded = Buffer.from(psScript(req), "utf16le").toString("base64");
  const r = spawnSync(ps, ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded], {
    encoding: "utf8",
    windowsHide: true,
    timeout: (req.action === "wait" ? req.timeout + 30 : 90) * 1000,
    maxBuffer: 16 * 1024 * 1024,
  });
  if (r.error) {
    console.error(`could not start ${ps}: ${r.error.message}`);
    process.exit(3);
  }
  process.stdout.write(r.stdout ?? "");
  const err = cleanStderr(r.stderr ?? "");
  if (err) console.error(err);
  process.exit(r.status ?? 1);
}

if (import.meta.url === `file://${process.argv[1]}` || process.argv[1]?.endsWith("run.mjs")) main();
