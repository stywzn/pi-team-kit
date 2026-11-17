// Session-level policy: what kind of session this is, how much context it may use,
// what to call it, and how to tell the user a long run finished. Pure functions; the extension wires them in.

export type SessionRole = "lead" | "planner" | "worker" | "verifier" | "child";

// The first lines of this package's agent prompts (agents/*.md). Kept in sync by test/session.test.ts.
const ROLE_MARKERS: [SessionRole, string][] = [
  ["planner", "You plan a team run."],
  ["worker", "You are a worker in a team run."],
  ["verifier", "You verify one lane of a team run."],
];

/** Which kind of session is running, from the subagent environment flag and the system prompt. */
export function detectRole(env: NodeJS.ProcessEnv, systemPrompt: string): SessionRole {
  for (const [role, marker] of ROLE_MARKERS) if (systemPrompt.includes(marker)) return role;
  return env.PI_SUBAGENT_CHILD ? "child" : "lead";
}

export interface ContextBudget {
  lead: number;
  planner: number;
  worker: number;
  verifier: number;
  child: number;
  maxWindowFraction: number;
}

/** Token count at which this session should compact: its role budget, capped by a fraction of the window. */
export function compactThreshold(role: SessionRole, budget: ContextBudget, contextWindow?: number): number {
  const byRole = budget[role];
  if (!contextWindow || contextWindow <= 0) return byRole;
  return Math.max(30_000, Math.min(byRole, Math.floor(contextWindow * budget.maxWindowFraction)));
}

/**
 * modelOverrides for ~/.pi/agent/models.json that give each role's model a context window of
 * (role budget + pi's compaction reserve), so pi compacts subagents between turns at their budget.
 * Roles sharing a model get the largest of their budgets. Models given as "provider/model".
 */
export function modelCaps(models: Partial<Record<SessionRole, string>>, budget: ContextBudget, reserveTokens = 16_384): Record<string, Record<string, { contextWindow: number }>> {
  const out: Record<string, Record<string, { contextWindow: number }>> = {};
  for (const [r, spec] of Object.entries(models) as [SessionRole, string][]) {
    const slash = spec?.indexOf("/") ?? -1;
    if (!spec || slash <= 0) continue;
    const provider = spec.slice(0, slash);
    const id = spec.slice(slash + 1);
    const window = budget[r] + reserveTokens;
    out[provider] ??= {};
    out[provider][id] = { contextWindow: Math.max(out[provider][id]?.contextWindow ?? 0, window) };
  }
  return out;
}

/** A short session name from the first prompt: "/team fix the login flake" -> "team: fix the login flake". */
export function sessionNameFrom(input: string, max = 40): string | undefined {
  let text = input.trim();
  if (!text) return undefined;
  let prefix = "";
  const cmd = /^\/(\S+)\s*/.exec(text);
  if (cmd) {
    const name = cmd[1];
    if (name === "team") prefix = "team: ";
    else if (name.startsWith("skill:")) prefix = `${name.slice(6)}: `;
    else return undefined; // other commands (/model, /resume...) say nothing about the session
    text = text.slice(cmd[0].length);
  }
  const line = text.split("\n").find((l) => l.trim())?.trim().replace(/\s+/g, " ");
  if (!line) return prefix ? prefix.slice(0, -2) : undefined;
  const full = prefix + line;
  return full.length > max ? `${full.slice(0, max - 1).trimEnd()}…` : full;
}

export function terminalTitle(sessionName: string | undefined, directory: string, working: boolean): string {
  const base = sessionName ? `π ${sessionName} · ${directory}` : `π ${directory}`;
  return working ? `● ${base}` : base;
}

export type Notification = { kind: "spawn"; command: string; args: string[] } | { kind: "osc"; sequence: string };

const psQuote = (s: string) => `'${s.replace(/'/g, "''")}'`;
const clean = (s: string) => s.replace(/[\u0000-\u001f\u007f]/g, " ").slice(0, 200);

/**
 * How to show a desktop notification here. WSL and Windows: a Windows toast through PowerShell
 * (works in any terminal, including inside tmux). macOS: osascript. Linux desktop: notify-send.
 * Otherwise an OSC 777 escape (WezTerm, iTerm2, Ghostty), wrapped for tmux passthrough.
 */
export function buildNotification(title: string, body: string, platform: NodeJS.Platform, env: NodeJS.ProcessEnv, hasNotifySend: boolean): Notification {
  const t = clean(title);
  const b = clean(body);
  if (platform === "win32" || env.WSL_DISTRO_NAME || env.WT_SESSION) {
    const ns = "Windows.UI.Notifications";
    // The PowerShell app id is registered on every Windows install, so the toast is always allowed to show.
    const appId = "{1AC14E77-02E7-4E5D-B744-2EB1AE5198B7}\\WindowsPowerShell\\v1.0\\powershell.exe";
    const script = [
      `[${ns}.ToastNotificationManager, ${ns}, ContentType = WindowsRuntime] > $null`,
      `$x = [${ns}.ToastNotificationManager]::GetTemplateContent([${ns}.ToastTemplateType]::ToastText02)`,
      `$t = $x.GetElementsByTagName('text')`,
      `$t[0].AppendChild($x.CreateTextNode(${psQuote(t)})) > $null`,
      `$t[1].AppendChild($x.CreateTextNode(${psQuote(b)})) > $null`,
      `[${ns}.ToastNotificationManager]::CreateToastNotifier(${psQuote(appId)}).Show([${ns}.ToastNotification]::new($x))`,
    ].join("; ");
    return { kind: "spawn", command: platform === "win32" ? "powershell" : "powershell.exe", args: ["-NoProfile", "-NonInteractive", "-Command", script] };
  }
  if (platform === "darwin") {
    const q = (s: string) => `"${s.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
    return { kind: "spawn", command: "osascript", args: ["-e", `display notification ${q(b)} with title ${q(t)}`] };
  }
  if (hasNotifySend && (env.DISPLAY || env.WAYLAND_DISPLAY)) return { kind: "spawn", command: "notify-send", args: [t, b] };
  const osc = `\x1b]777;notify;${t.replace(/;/g, ",")};${b.replace(/;/g, ",")}\x07`;
  return { kind: "osc", sequence: env.TMUX ? `\x1bPtmux;${osc.replace(/\x1b/g, "\x1b\x1b")}\x1b\\` : osc };
}
