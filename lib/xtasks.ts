// Tasks across lead sessions: one lead's task can wait for another lead's task (the web page for the backend
// endpoint). When the task it waits for is marked done, the lead of the waiting task is told at once (woken when
// idle), instead of polling or being forgotten. Owned by lead name, so a session that takes the name over (the next
// lead in that repo, /continue) carries on. Plain files on the lead board, written only by their owner:
//   <board>/tasks/<id>.json

import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface LeadTask {
  id: string;
  title: string;
  /** Lead name that owns it. */
  lead: string;
  state: "open" | "done";
  /** Ids of tasks (any lead's) this one waits for. */
  after: string[];
  /** What was done, when it was marked done. */
  note?: string;
  at: string;
  doneAt?: string;
}

export const TASK_LIMITS = { title: 200, note: 400, after: 10, open: 50 };
const ID = /^t[0-9a-z]{6,20}$/;
const tasksDir = (board: string) => join(board, "tasks");

export function readTasks(board: string): LeadTask[] {
  const dir = tasksDir(board);
  if (!existsSync(dir)) return [];
  const out: LeadTask[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const t = JSON.parse(readFileSync(join(dir, f), "utf8")) as LeadTask;
      if (!t || !ID.test(t.id) || typeof t.title !== "string" || typeof t.lead !== "string") continue;
      out.push({ ...t, state: t.state === "done" ? "done" : "open", after: Array.isArray(t.after) ? t.after.filter((a) => typeof a === "string" && ID.test(a)) : [] });
    } catch {
      /* skipped */
    }
  }
  return out.sort((a, b) => a.at.localeCompare(b.at));
}

function writeTask(board: string, t: LeadTask) {
  const dir = tasksDir(board);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = join(dir, `${t.id}.json`);
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(t));
  renameSync(tmp, file);
}

/** Waiting for nothing open: ready; a task it waits for is still open: waiting; or done. */
export function taskState(t: LeadTask, all: LeadTask[]): "done" | "ready" | "waiting" {
  if (t.state === "done") return "done";
  return t.after.some((a) => all.find((x) => x.id === a)?.state === "open") ? "waiting" : "ready";
}

export function addTask(board: string, t: { title: string; lead: string; after?: string[] }, now = Date.now()): LeadTask {
  const title = t.title.replace(/\s+/g, " ").trim();
  if (!title) throw new Error("text: the task in one line");
  if (title.length > TASK_LIMITS.title) throw new Error(`one line under ${TASK_LIMITS.title} characters`);
  const all = readTasks(board);
  const after = [...new Set((t.after ?? []).map((a) => a.trim()).filter(Boolean))];
  if (after.length > TASK_LIMITS.after) throw new Error(`at most ${TASK_LIMITS.after} tasks to wait for`);
  for (const a of after) if (!all.some((x) => x.id === a)) throw new Error(`no task "${a}" (leads list shows the tasks and their ids)`);
  if (all.filter((x) => x.lead === t.lead && x.state === "open").length >= TASK_LIMITS.open) throw new Error(`you have ${TASK_LIMITS.open} open tasks: mark some done or drop them first`);
  const task: LeadTask = { id: `t${now.toString(36)}${randomBytes(2).toString("hex")}`, title, lead: t.lead, state: "open", after, at: new Date(now).toISOString() };
  writeTask(board, task);
  return task;
}

/**
 * Mark a task done (only its own lead can). Returns it and the tasks this made ready: those that waited for it and
 * wait for nothing open any more; their leads are to be told.
 */
export function finishTask(board: string, id: string, lead: string, note = "", now = Date.now()): { task: LeadTask; ready: LeadTask[] } {
  const all = readTasks(board);
  const t = all.find((x) => x.id === id.trim());
  if (!t) throw new Error(`no task "${id}" (leads list shows them)`);
  if (t.lead !== lead) throw new Error(`task ${t.id} belongs to lead ${t.lead}; only that lead marks it done`);
  if (t.state === "done") return { task: t, ready: [] };
  const done: LeadTask = { ...t, state: "done", doneAt: new Date(now).toISOString(), ...(note.trim() ? { note: note.replace(/\s+/g, " ").trim().slice(0, TASK_LIMITS.note) } : {}) };
  writeTask(board, done);
  const next = all.map((x) => (x.id === done.id ? done : x));
  const ready = next.filter((x) => x.state === "open" && x.after.includes(done.id) && taskState(x, next) === "ready");
  return { task: done, ready };
}

export function dropTask(board: string, id: string, lead: string): boolean {
  const t = readTasks(board).find((x) => x.id === id.trim());
  if (!t || t.lead !== lead) return false;
  rmSync(join(tasksDir(board), `${t.id}.json`), { force: true });
  return true;
}

/** Done tasks older than a week are removed (no open task can wait for them any more once they are done). */
export function pruneTasks(board: string, now = Date.now()): void {
  for (const t of readTasks(board)) if (t.state === "done" && t.doneAt && now - Date.parse(t.doneAt) > 7 * 86_400_000) rmSync(join(tasksDir(board), `${t.id}.json`), { force: true });
}

export function formatTasks(all: LeadTask[], me?: string): string {
  const open = all.filter((t) => t.state === "open" || (t.doneAt && Date.now() - Date.parse(t.doneAt) < 86_400_000));
  if (!open.length) return "(no tasks)";
  return open
    .map((t) => {
      const st = taskState(t, all);
      const waits = t.after.map((a) => {
        const x = all.find((y) => y.id === a);
        return x ? `${a} (${x.lead}, ${x.state})` : `${a} (gone)`;
      });
      return `- [${t.id}] ${t.lead}${t.lead === me ? " (you)" : ""}: ${t.title} - ${st}${waits.length ? `, waits for ${waits.join(", ")}` : ""}${t.note ? ` - done: ${t.note}` : ""}`;
    })
    .join("\n");
}

/** The message a waiting lead gets when what it waited for is done. */
export function readyMessage(done: LeadTask, ready: LeadTask): string {
  return `Task ${done.id} "${done.title}" (lead ${done.lead}) is done${done.note ? `: ${done.note.replace(/[.!?]?$/, ".")}` : "."} Your task ${ready.id} "${ready.title}" waited for it and can start now. Check the change it relies on, then go ahead.`;
}
