#!/usr/bin/env node
// Background processes for agents: start a server/watcher without blocking, wait until it is ready, read logs, stop it.
//   bg start <name> [--cwd dir] [--wait-for <regex | :port | http(s)://url>] [--timeout 60] -- <command...>
//   bg status [name] | bg logs <name> [--lines 60] | bg stop <name> | bg list

import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const STATE = path.join(os.tmpdir(), `ptk-bg-${typeof process.getuid === "function" ? process.getuid() : os.userInfo().username}`);
mkdirSync(STATE, { recursive: true });
const NAME = /^[A-Za-z0-9._-]{1,40}$/;

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const head = sep >= 0 ? argv.slice(0, sep) : argv;
const command = sep >= 0 ? argv.slice(sep + 1) : [];
const [action, name] = head;
const opt = (flag, fallback) => {
  const i = head.indexOf(flag);
  return i >= 0 && head[i + 1] !== undefined ? head[i + 1] : fallback;
};

const metaFile = (n) => path.join(STATE, `${n}.json`);
const logFile = (n) => path.join(STATE, `${n}.log`);
const readMeta = (n) => {
  try {
    return existsSync(metaFile(n)) ? JSON.parse(readFileSync(metaFile(n), "utf8")) : undefined;
  } catch {
    return undefined;
  }
};
/** Linux start time of a pid (clock ticks since boot), so a reused pid is not mistaken for ours. */
const procStart = (pid) => {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19];
  } catch {
    return undefined;
  }
};
const alive = (pid, start) => {
  try {
    process.kill(pid, 0);
  } catch (e) {
    if (e.code !== "EPERM") return false;
  }
  return !start || procStart(pid) === undefined || procStart(pid) === start;
};
const tail = (n, lines) => {
  if (!existsSync(logFile(n))) return "";
  const text = readFileSync(logFile(n), "utf8");
  return text.split("\n").slice(-lines).join("\n").trimEnd();
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function portOpen(port) {
  return new Promise((resolve) => {
    const s = net.connect({ port, host: "127.0.0.1" });
    s.once("connect", () => (s.destroy(), resolve(true)));
    s.once("error", () => resolve(false));
    s.setTimeout(800, () => (s.destroy(), resolve(false)));
  });
}

async function ready(n, waitFor, pid) {
  if (/^:\d+$/.test(waitFor)) return portOpen(Number(waitFor.slice(1)));
  if (/^https?:\/\//.test(waitFor)) {
    try {
      const r = await fetch(waitFor, { signal: AbortSignal.timeout(1500) });
      return r.status < 500;
    } catch {
      return false;
    }
  }
  return new RegExp(waitFor, "i").test(existsSync(logFile(n)) ? readFileSync(logFile(n), "utf8") : "");
}

function usage(code) {
  console.log(
    "usage:\n  bg start <name> [--cwd dir] [--wait-for <regex|:port|url>] [--timeout 60] -- <command...>\n  bg status [name]\n  bg logs <name> [--lines 60]\n  bg stop <name>\n  bg list",
  );
  process.exit(code);
}

function describe(n) {
  const m = readMeta(n);
  if (!m) return `${n}: unknown`;
  const up = alive(m.pid, m.procStart);
  const age = Math.round((Date.now() - m.started) / 1000);
  return `${n}: ${up ? "running" : "exited"} pid ${m.pid}, ${age}s, cwd ${m.cwd}\n  $ ${m.command}\n  log ${logFile(n)}`;
}

async function stop(n) {
  const m = readMeta(n);
  if (!m) return `${n}: nothing to stop`;
  if (alive(m.pid, m.procStart)) {
    if (process.platform === "win32") spawn("taskkill", ["/pid", String(m.pid), "/T", "/F"], { stdio: "ignore" });
    else {
      try {
        process.kill(-m.pid, "SIGTERM");
      } catch {
        try {
          process.kill(m.pid, "SIGTERM");
        } catch {}
      }
      for (let i = 0; i < 30 && alive(m.pid, m.procStart); i++) await sleep(100);
      if (alive(m.pid, m.procStart)) {
        try {
          process.kill(-m.pid, "SIGKILL");
        } catch {}
      }
    }
  }
  rmSync(metaFile(n), { force: true });
  return `${n}: stopped`;
}

if (!action || action === "-h" || action === "--help") usage(action ? 0 : 2);

if (action === "list" || (action === "status" && !name)) {
  const names = readdirSync(STATE).filter((f) => f.endsWith(".json")).map((f) => f.slice(0, -5));
  console.log(names.length ? names.map(describe).join("\n") : "no background processes");
  process.exit(0);
}
if (!name || !NAME.test(name)) usage(2);

if (action === "status") {
  console.log(describe(name));
  console.log(tail(name, 10));
} else if (action === "logs") {
  console.log(tail(name, Number(opt("--lines", "60"))) || "(empty log)");
} else if (action === "stop") {
  console.log(await stop(name));
} else if (action === "start") {
  if (command.length === 0) usage(2);
  const prev = readMeta(name);
  if (prev && alive(prev.pid, prev.procStart)) {
    console.error(`${name} is already running (pid ${prev.pid}). Use bg stop ${name} first, or bg logs ${name}.`);
    process.exit(1);
  }
  const cwd = path.resolve(opt("--cwd", process.cwd()));
  const waitFor = opt("--wait-for", "");
  const timeout = Number(opt("--timeout", "60"));
  // Validate everything before starting a process we would then have to clean up.
  if (!Number.isFinite(timeout) || timeout <= 0) {
    console.error(`--timeout must be a positive number of seconds, got ${opt("--timeout", "")}`);
    process.exit(2);
  }
  if (waitFor && !/^:\d+$/.test(waitFor) && !/^https?:\/\//.test(waitFor)) {
    try {
      new RegExp(waitFor);
    } catch (e) {
      console.error(`--wait-for is not a valid regex: ${e.message}`);
      process.exit(2);
    }
  }
  if (!existsSync(cwd)) {
    console.error(`--cwd does not exist: ${cwd}`);
    process.exit(2);
  }
  // One argument = a shell command line (pipes, &&, env vars allowed). Several = an exact argv, no shell.
  const quote = (a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : `"${a.replace(/"/g, '\\"')}"`);
  const cmd = command.length === 1 ? command[0] : command.map(quote).join(" ");
  const fd = openSync(logFile(name), "w");
  const stdio = ["ignore", fd, fd];
  const child =
    process.platform === "win32"
      ? spawn(cmd, { cwd, shell: true, detached: true, windowsHide: true, stdio })
      : command.length === 1
        ? spawn("sh", ["-c", cmd], { cwd, detached: true, stdio })
        : spawn(command[0], command.slice(1), { cwd, detached: true, stdio });
  child.on("error", () => {}); // reported below as "exited before it was ready"
  child.unref();
  closeSync(fd);
  writeFileSync(metaFile(name), JSON.stringify({ pid: child.pid, procStart: child.pid ? procStart(child.pid) : undefined, command: cmd, cwd, started: Date.now(), waitFor }, null, 2));
  if (!child.pid) {
    console.error(`${name}: could not start ${command[0]}`);
    rmSync(metaFile(name), { force: true });
    process.exit(1);
  }
  if (!waitFor) {
    await sleep(1500);
    const up = alive(child.pid);
    if (!up) rmSync(metaFile(name), { force: true });
    console.log(`${name}: ${up ? "started" : "exited immediately"} (pid ${child.pid}), log ${logFile(name)}\n${tail(name, 15)}`);
    process.exit(up ? 0 : 1);
  }
  const deadline = Date.now() + timeout * 1000;
  for (;;) {
    if (await ready(name, waitFor, child.pid)) {
      console.log(`${name}: ready (${waitFor}) after ${Math.round((Date.now() - (deadline - timeout * 1000)) / 100) / 10}s, pid ${child.pid}\n${tail(name, 15)}`);
      process.exit(0);
    }
    if (!alive(child.pid)) {
      console.error(`${name}: exited before it was ready. Last log lines:\n${tail(name, 30)}`);
      rmSync(metaFile(name), { force: true });
      process.exit(1);
    }
    if (Date.now() > deadline) {
      console.error(`${name}: still running but not ready after ${timeout}s (${waitFor}). It keeps running; check bg logs ${name}.\n${tail(name, 20)}`);
      process.exit(1);
    }
    await sleep(300);
  }
} else usage(2);
