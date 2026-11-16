// Just enough shell parsing to recognise what a command is about to run.
// No expansion, no evaluation: quotes are honoured so `echo "a && b"` stays one segment.

export interface Segment {
  /** Raw text of this simple command, trimmed. */
  text: string;
  /** Words with quotes removed. */
  argv: string[];
  /** Ends with a lone `&`, so it runs in the background. */
  background: boolean;
}

const SEPARATORS = ["&&", "||", ";", "|", "\n", "&"];

/** Split a command line into simple commands at unquoted `&& || ; | & newline`. */
export function splitSegments(command: string): Segment[] {
  const segments: Segment[] = [];
  let current = "";
  let quote: '"' | "'" | null = null;
  let i = 0;
  // Here-document bodies (`cat <<EOF ... EOF`) are data, not commands: skip them.
  const heredocs: { delim: string; dash: boolean }[] = [];
  const push = (background: boolean) => {
    const text = current.trim();
    if (text) segments.push({ text, argv: words(text), background });
    current = "";
  };
  const skipHeredocBodies = () => {
    while (heredocs.length && i < command.length) {
      const { delim, dash } = heredocs.shift() as { delim: string; dash: boolean };
      for (;;) {
        const end = command.indexOf("\n", i);
        const line = command.slice(i, end < 0 ? command.length : end);
        i = end < 0 ? command.length : end + 1;
        if ((dash ? line.replace(/^\t+/, "") : line) === delim || end < 0) break;
      }
    }
  };
  while (i < command.length) {
    const ch = command[i];
    if (!quote && ch === "<" && command[i + 1] === "<" && command[i + 2] !== "<") {
      const m = /^<<(-?)\s*(['"]?)([A-Za-z0-9_.-]+)\2/.exec(command.slice(i));
      if (m) {
        heredocs.push({ delim: m[3], dash: m[1] === "-" });
        current += m[0];
        i += m[0].length;
        continue;
      }
    }
    if (!quote && ch === "\n" && heredocs.length) {
      push(false);
      i++;
      skipHeredocBodies();
      continue;
    }
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < command.length) {
        current += ch + command[i + 1];
        i += 2;
        continue;
      }
      if (ch === quote) quote = null;
      current += ch;
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < command.length) {
      current += ch + command[i + 1];
      i += 2;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      current += ch;
      i++;
      continue;
    }
    if (ch === "#" && (i === 0 || /\s/.test(command[i - 1]))) {
      while (i < command.length && command[i] !== "\n") i++;
      continue;
    }
    // `2>&1`, `&>file` and `>&2` are redirections, not separators.
    if (ch === "&" && (command[i - 1] === ">" || command[i + 1] === ">")) {
      current += ch;
      i++;
      continue;
    }
    const sep = SEPARATORS.find((s) => command.startsWith(s, i));
    if (sep) {
      push(sep === "&");
      i += sep.length;
      continue;
    }
    current += ch;
    i++;
  }
  push(false);
  return segments;
}

/** Split one simple command into words, removing quotes. */
export function words(text: string): string[] {
  const out: string[] = [];
  let word = "";
  let inWord = false;
  let quote: '"' | "'" | null = null;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quote) {
      if (ch === quote) quote = null;
      else if (ch === "\\" && quote === '"' && i + 1 < text.length) word += text[++i];
      else word += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      inWord = true;
      continue;
    }
    if (ch === "\\" && i + 1 < text.length) {
      word += text[++i];
      inWord = true;
      continue;
    }
    if (/\s/.test(ch)) {
      if (inWord) out.push(word);
      word = "";
      inWord = false;
      continue;
    }
    word += ch;
    inWord = true;
  }
  if (inWord) out.push(word);
  return out;
}

/** Wrapper programs and their options that consume the next word (`sudo -u root x` wraps `x`, not `root`). */
const WRAPPERS: Record<string, Set<string>> = {
  sudo: new Set(["-u", "-g", "-U", "-C", "-h", "-p", "-r", "-t", "-D", "-R", "-T", "--user", "--group", "--chdir", "--prompt", "--role", "--type", "--host"]),
  doas: new Set(["-u", "-C"]),
  env: new Set(["-u", "-C", "-S", "--unset", "--chdir", "--split-string"]),
  nice: new Set(["-n", "--adjustment"]),
  ionice: new Set(["-c", "-n", "-p", "-t"]),
  stdbuf: new Set(["-i", "-o", "-e"]),
  time: new Set(["-f", "-o", "--format", "--output"]),
  command: new Set(),
  exec: new Set(["-a"]),
};

/**
 * The program a segment really runs, skipping `VAR=x`, `sudo`, `env`, `time` and friends.
 * `timeout 30 x` and `nohup x` are reported as bounded/detached instead of being skipped.
 */
export function effectiveCommand(argv: string[]): { argv: string[]; bounded: boolean; detached: boolean } {
  let i = 0;
  let bounded = false;
  let detached = false;
  while (i < argv.length) {
    const w = argv[i];
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w)) {
      i++;
      continue;
    }
    if (w === "timeout" || w === "gtimeout") {
      bounded = true;
      i++;
      while (i < argv.length && argv[i].startsWith("-")) i += argv[i] === "-s" || argv[i] === "-k" ? 2 : 1;
      i++; // the duration
      continue;
    }
    if (w === "nohup" || w === "setsid" || w === "disown") {
      detached = true;
      i++;
      continue;
    }
    const takesValue = WRAPPERS[w];
    if (takesValue) {
      i++;
      while (i < argv.length && argv[i].startsWith("-")) {
        if (argv[i] === "--") {
          i++;
          break;
        }
        i += takesValue.has(argv[i]) ? 2 : 1;
      }
      continue;
    }
    break;
  }
  return { argv: argv.slice(i), bounded, detached };
}

export function baseName(program: string): string {
  const name = program.split(/[\\/]/).pop() ?? program;
  return name.replace(/\.(exe|cmd|bat)$/i, "");
}

/** True when any short-flag cluster (`-rn`) or long flag in `argv` matches. */
export function hasFlag(argv: string[], short: string, long?: string): boolean {
  return argv.some((a) => {
    if (long && (a === long || a.startsWith(long + "="))) return true;
    return /^-[A-Za-z]+$/.test(a) && a.slice(1).includes(short);
  });
}
