// A failure caused by the environment (a port taken, a service down, a tool or package missing, no network, a full
// disk) is not fixed by changing code, yet workers did exactly that: one lane polled an empty port list 106 times,
// others changed code to get around a missing service. Recognised by code from the output, so the session is told
// at once: check it once, then report it (workers to the lead, the lead to the user) instead of working around it.

export interface EnvFailure {
  kind: string;
  /** Sure enough to stop work on (a stop, a breaker, a skipped lane). The others (a missing module could be the
   *  project's own, a missing setting could be a bug) only add a hint and keep the normal rounds. */
  certain: boolean;
  /** The line that matched, trimmed. */
  line: string;
  /** What to check, in one sentence. */
  check: string;
}

const KINDS: { kind: string; re: RegExp; check: string; certain: boolean }[] = [
  { kind: "port in use", re: /\bEADDRINUSE\b|address already in use|port \S+ is already (allocated|in use)|Only one usage of each socket address|bind: address already in use/i, check: "something else holds that port (another lane's server, a leftover process): find it with ss -ltnp / netstat, or use a different port", certain: true },
  { kind: "service not reachable", re: /\bECONNREFUSED\b|Connection refused|could not connect to server|Can't connect to (local )?MySQL|connect ECONNRESET\b|Is the server running|server closed the connection unexpectedly|No connection could be made because the target machine actively refused/i, check: "the service the code talks to (database, API, broker) is not running or listens elsewhere", certain: true },
  { kind: "docker not running", re: /Cannot connect to the Docker daemon|docker daemon is not running|error during connect:.*docker/i, check: "Docker is not running here", certain: true },
  { kind: "command missing", re: /command not found|is not recognized as an internal or external command|No such file or directory.*(bin|exe)\b|Python was not found; run without arguments/i, check: "a program the command needs is not installed or not on PATH here", certain: true },
  { kind: "package missing", re: /ModuleNotFoundError: No module named '([\w-]+)'|Cannot find module '([^./][^']*)'|ERR_MODULE_NOT_FOUND.*'([^./][^']*)'|ImportError: cannot import name .* from '([\w-]+)'.*site-packages|package .* is not installed/i, check: "a third-party package is not installed in this environment (a module of the project itself would be a code problem)", certain: false },
  { kind: "browser missing", re: /Executable doesn't exist at .*(chrom|firefox|webkit)|playwright install|Looks like Playwright was just installed|browserType\.launch: .*not found/i, check: "the test browser is not installed (npx playwright install)", certain: true },
  { kind: "network or DNS", re: /\bENOTFOUND\b|\bgetaddrinfo\b|Temporary failure in name resolution|Could not resolve host|Name or service not known|\bETIMEDOUT\b|network is unreachable|proxy.*(refused|error)|SSL: CERTIFICATE_VERIFY_FAILED|self[- ]signed certificate/i, check: "no network access, a proxy or a certificate problem on this machine", certain: true },
  { kind: "disk full", re: /\bENOSPC\b|No space left on device|disk quota exceeded/i, check: "the disk is full", certain: true },
  { kind: "out of memory", re: /\bENOMEM\b|JavaScript heap out of memory|MemoryError|Cannot allocate memory|Killed\s*$|exit code 137/im, check: "the machine ran out of memory (too many parallel jobs?)", certain: true },
  { kind: "missing setting", re: /environment variable .*(not set|is required|missing)|Missing required env|database "[^"]+" does not exist|role "[^"]+" does not exist|Access denied for user/i, check: "a setting, secret or database the code expects is missing here (.env, credentials, a database not created)", certain: false },
  { kind: "file locked", re: /\bEBUSY\b|resource busy or locked|being used by another process|database is locked|Unable to create '.*\.lock': File exists/i, check: "another process holds the file (another lane, an editor, a leftover process)", certain: false },
];

/** The first environment problem in this output, or undefined. Only the last 200 lines are looked at. */
export function envFailure(output: string): EnvFailure | undefined {
  const lines = String(output || "").replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split(/\r?\n/).slice(-200);
  for (const k of KINDS)
    for (const l of lines) if (k.re.test(l)) return { kind: k.kind, line: l.trim().slice(0, 240), check: k.check, certain: k.certain };
  return undefined;
}

/** The note a session gets with such a failure, worded for its role. */
export function envFailureNote(f: EnvFailure, role: string): string {
  const head = `This looks like an environment problem (${f.kind}: "${f.line}"), not a problem in the code: ${f.check}.`;
  if (role === "worker" || role === "child")
    return `${head} Do not change code, tests or config to get around it. Check it once (one command); if it is the environment, call contact_supervisor with reason "need_decision" and the exact error, or report BLOCKED with it. If it really is the code (a module of this project, a port your change chose), fix that.`;
  return `${head} Do not change code to get around it. Fix the environment if that is part of the task, otherwise tell the user what is missing.`;
}

// Source for the workflow script (it runs without imports): same patterns, same order.
export const ENV_FAILURE_JS = `var ENV_KINDS = ${JSON.stringify(KINDS.map((k) => ({ kind: k.kind, re: k.re.source, flags: k.re.flags, check: k.check, certain: k.certain })))};
function envFailure(text) {
  var lines = String(text || "").replace(/\\x1b\\[[0-9;?]*[A-Za-z]/g, "").split(/\\r?\\n/).slice(-200);
  for (var i = 0; i < ENV_KINDS.length; i++) {
    var re = new RegExp(ENV_KINDS[i].re, ENV_KINDS[i].flags);
    for (var j = 0; j < lines.length; j++) if (re.test(lines[j])) return { kind: ENV_KINDS[i].kind, line: lines[j].trim().slice(0, 240), check: ENV_KINDS[i].check, certain: ENV_KINDS[i].certain };
  }
  return null;
}`;
