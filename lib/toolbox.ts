// A toolbox of ready-made helpers (md2pdf, screenshots, background processes...) so the agent
// reuses a tested script instead of writing a new one-off every session.
// Layers, later wins on name clashes: bundled (this package) < global (~/.pi/agent/ptk/toolbox) < project (.pi/ptk/toolbox).

import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { basename, extname, isAbsolute, join, resolve } from "node:path";

export interface ToolManifest {
  name: string;
  description: string;
  usage: string;
  /** Program and leading args; relative paths resolve against the tool directory. */
  run: string[];
}

export interface ToolEntry extends ToolManifest {
  dir: string;
  layer: "bundled" | "global" | "project";
}

const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

export function readManifest(dir: string): ToolManifest | undefined {
  const file = join(dir, "tool.json");
  if (!existsSync(file)) return undefined;
  try {
    const m = JSON.parse(readFileSync(file, "utf8")) as ToolManifest;
    if (!NAME.test(m.name) || typeof m.description !== "string" || !Array.isArray(m.run) || m.run.length === 0) return undefined;
    return { name: m.name, description: m.description, usage: m.usage ?? m.name, run: m.run.map(String) };
  } catch {
    return undefined;
  }
}

export function discoverTools(layers: { dir: string; layer: ToolEntry["layer"] }[]): ToolEntry[] {
  const byName = new Map<string, ToolEntry>();
  for (const { dir, layer } of layers) {
    if (!existsSync(dir)) continue;
    for (const child of readdirSync(dir).sort()) {
      if (child.startsWith("_") || child.startsWith(".")) continue;
      const toolDir = join(dir, child);
      if (!statSync(toolDir).isDirectory()) continue;
      const m = readManifest(toolDir);
      if (m) byName.set(m.name, { ...m, dir: toolDir, layer });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/**
 * argv to execute a tool: manifest `run` (relative paths made absolute) followed by user args.
 * `python` is the command that really starts Python here ("python", "py -3", "python3", from env detection);
 * manifests say python3, which does not exist or is only a Store alias on many Windows machines.
 */
export function toolArgv(tool: ToolEntry, args: string[], python?: string): string[] {
  let [program, ...lead] = tool.run;
  // Only `python3` (what `toolbox add` writes); a manifest that says `python` explicitly is left alone.
  if (python && program === "python3") {
    const [exe, ...pre] = python.split(" ");
    program = exe;
    lead = [...pre, ...lead];
  }
  const abs = (p: string) => (!isAbsolute(p) && /[\\/]|\.(m?js|ts|py|sh)$/.test(p) ? join(tool.dir, p) : p);
  const exe = program === "node" ? process.execPath : abs(program);
  return [exe, ...lead.map(abs), ...args];
}

const RUNNERS: Record<string, string> = { ".mjs": "node", ".js": "node", ".ts": "node", ".py": "python3", ".sh": "bash" };

export interface AddToolInput {
  name: string;
  description: string;
  usage: string;
  /** Existing script file, or a directory containing tool.json or a main script. */
  source: string;
}

/** Copy a script the agent just wrote into a toolbox layer and give it a manifest. */
export function addTool(targetRoot: string, input: AddToolInput, cwd: string): ToolEntry {
  if (!NAME.test(input.name)) throw new Error("name: lowercase letters, digits and dashes, max 40 characters");
  if (!input.description?.trim()) throw new Error("description is required: say what it does and when to use it");
  const source = resolve(cwd, input.source);
  if (!existsSync(source)) throw new Error(`source not found: ${source}`);
  const dir = join(targetRoot, input.name);
  mkdirSync(dir, { recursive: true });
  let run: string[];
  if (statSync(source).isDirectory()) {
    cpSync(source, dir, { recursive: true });
    const existing = readManifest(dir);
    const main = existing?.run ?? guessMain(dir);
    if (!main) throw new Error("directory has no tool.json and no single run.* / main.* script");
    run = main;
  } else {
    const ext = extname(source);
    const runner = RUNNERS[ext];
    if (!runner) throw new Error(`unsupported script type ${ext || "(none)"}; use .mjs, .js, .ts, .py or .sh`);
    const file = basename(source);
    cpSync(source, join(dir, file));
    run = [runner, file];
  }
  const manifest: ToolManifest = { name: input.name, description: input.description.trim(), usage: input.usage?.trim() || input.name, run };
  writeFileSync(join(dir, "tool.json"), JSON.stringify(manifest, null, 2) + "\n");
  return { ...manifest, dir, layer: "global" };
}

function guessMain(dir: string): string[] | undefined {
  const files = readdirSync(dir).filter((f) => /^(run|main|index)\.(mjs|js|ts|py|sh)$/.test(f));
  if (files.length !== 1) return undefined;
  return [RUNNERS[extname(files[0])], files[0]];
}

export function formatToolList(tools: ToolEntry[], limit = 30): string {
  return tools
    .slice(0, limit)
    .map((t) => `- ${t.name}: ${t.description} Usage: ${t.usage}`)
    .join("\n");
}
