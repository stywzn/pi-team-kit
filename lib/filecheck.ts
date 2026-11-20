// An edit that leaves a .json, .yaml/.yml or .py file unparsable is put back as it was and the agent is told why,
// instead of the broken file being found later (a "\1" that became a control character, a lost indent, a "\n"
// that became a real newline inside a string). Only a file that parsed before the edit is put back.

import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

/** Files checked after an edit. JSON with comments (tsconfig, VS Code settings, .jsonc) is left alone. */
export function checkedKind(path: string): "json" | "yaml" | "python" | undefined {
  const p = path.replace(/\\/g, "/");
  if (/\.json$/i.test(p) && !/(^|\/)(tsconfig[^/]*|jsconfig[^/]*|\.vscode\/[^/]*|devcontainer[^/]*|\.devcontainer\/[^/]*)\.json$/i.test(p)) return "json";
  if (/\.ya?ml$/i.test(p)) return "yaml";
  if (/\.py$/i.test(p)) return "python";
  return undefined;
}

type YamlLib = { parseAllDocuments: (s: string) => Array<{ errors: Array<{ message: string }> }> | { errors: Array<{ message: string }> } };
let yamlLib: YamlLib | null | undefined;
/** pi ships the `yaml` package; it is found from pi's own location when this package has none. */
function yaml(): YamlLib | null {
  if (yamlLib !== undefined) return yamlLib;
  const bases = [import.meta.url, process.argv[1] ? pathToFileURL(process.argv[1]).href : ""].filter(Boolean);
  for (const base of bases) {
    try {
      yamlLib = createRequire(base)("yaml") as YamlLib;
      return yamlLib;
    } catch {
      /* next */
    }
  }
  yamlLib = null;
  return null;
}

/** Load `yaml` as resolved from `base` (a file path or URL); true when found. For tests and unusual hosts. */
export function useYamlFrom(base: string): boolean {
  try {
    yamlLib = createRequire(base)("yaml") as YamlLib;
    return true;
  } catch {
    return false;
  }
}

/** Why `text` does not parse: "" when it does; undefined when this kind is not checked here (python: the caller). */
export function syntaxError(kind: "json" | "yaml" | "python", text: string): string | undefined {
  // A control character is how a "\1" or "\x01" written through a regex replacement shows up; parsers accept some.
  if (kind !== "python") {
    const c = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/.exec(text);
    if (c) return `control character U+${c[0].charCodeAt(0).toString(16).toUpperCase().padStart(4, "0")} on line ${text.slice(0, c.index).split("\n").length}`;
  }
  if (kind === "json") {
    try {
      JSON.parse(text.replace(/^﻿/, ""));
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  }
  if (kind === "yaml") {
    const y = yaml();
    if (!y) return undefined;
    try {
      const docs = y.parseAllDocuments(text);
      for (const d of Array.isArray(docs) ? docs : [docs]) if (d.errors?.length) return d.errors[0].message.split("\n")[0];
      return "";
    } catch (e) {
      return (e as Error).message;
    }
  }
  return undefined;
}

/** A Python syntax check that runs no code and writes no __pycache__. */
export const PY_CHECK = "import ast,sys; ast.parse(open(sys.argv[1],'rb').read(), sys.argv[1])";

/** The note for the agent. */
export function restoredNote(file: string, error: string, restored: boolean): string {
  return restored
    ? `This change left ${file} unparsable (${error}), so it was put back exactly as it was before. Make the change again and keep the file valid: check escapes (\\1, \\n inside strings), indentation and quoting, or write it with a proper serializer.`
    : `${file} does not parse now (${error}). Fix it before going on.`;
}
