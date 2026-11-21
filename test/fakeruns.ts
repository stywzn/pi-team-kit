// pi-subagents' runs.all for a fake `runs` object: each item launched like runs.run, a failed child returned as
// { ok: false } with its run id instead of thrown (the real runs.all passes collectFailure), so the workflow sees
// the failure's details. A fake may throw an Error with `results` to hand back check output (verifyRuns).
// A first round's acceptance { level: "verified", verify: [{ id: "gate", ... }] } is what pi-subagents makes of the
// gate shorthand, so the fake shows it as item.gate too (with the lane's env when there is one).
type Fake = { run: (key: string, item: any) => Promise<any>; status: (key: string) => Promise<any> };

function asSeen(item: any): any {
  const v = item?.acceptance?.verify;
  const g = Array.isArray(v) && v.length === 1 && v[0]?.id === "gate" && !item.acceptance.preserveStagedIndex ? v[0] : undefined;
  return g ? { ...item, gate: { command: g.command, timeoutMs: g.timeoutMs, ...(g.env ? { env: g.env } : {}) } } : item;
}

export function withAll<T extends Fake>(runs: T): T & { all: (items: any[]) => Promise<any[]> } {
  return Object.assign(runs, {
    all: (items: any[]) =>
      Promise.all(
        items.map(async ({ key, ...item }) => {
          try {
            return await runs.run(key, asSeen(item));
          } catch (e) {
            const s = await runs.status(key).catch(() => ({}));
            // the real result carries the run folder in artifactPaths, as a passed child's does
            const dir = s?.artifactPaths?.[0] || (String(s?.output ?? "").match(/\nDir: (\S+)/) ?? [])[1];
            return { ok: false, error: String((e as Error).message ?? e), output: "", runId: s?.runId ?? null, artifactPaths: dir ? [dir] : [], ...((e as { results?: unknown }).results ? { results: (e as { results?: unknown }).results } : {}) };
          }
        }),
      ),
  });
}
