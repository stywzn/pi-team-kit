// A big task done by the lead alone is slow. Past a size the lead stops editing more files and hands the rest to
// workers with team_run (on by default; /team-auto off or team.auto.enabled=false turns it off). Counted per user
// request: a reply from the user, or a team run, starts over.

export interface SoloOptions {
  enabled: boolean;
  /** Distinct files the lead may change in one request before the rest goes to workers. 0 = no limit. */
  files: number;
  /** Tool calls in one request before a one-time note that team_run can run the parts in parallel. 0 = never. */
  nudgeCalls: number;
}

export class SoloWork {
  private files = new Set<string>();
  private calls = 0;
  private nudged = false;
  private delegated = false;
  opts: SoloOptions;

  constructor(opts: SoloOptions) {
    this.opts = opts;
  }

  /** A person wrote: their request starts a new count. */
  userInput(): void {
    this.files.clear();
    this.calls = 0;
    this.nudged = false;
    this.delegated = false;
  }

  /** Why this edit should go to workers instead, or undefined. `file` is an absolute path. */
  before(tool: string, file?: string): string | undefined {
    const o = this.opts;
    if (!o.enabled || this.delegated || o.files <= 0 || (tool !== "edit" && tool !== "write") || !file) return undefined;
    if (this.files.has(file) || this.files.size < o.files) return undefined;
    const done = [...this.files].map((f) => f.split(/[\\/]/).pop()).slice(0, 6).join(", ");
    return (
      `This request has the lead on a ${o.files + 1}th file (already: ${done}${this.files.size > 6 ? ", ..." : ""}): that is a team task, and one session doing it alone is slow. ` +
      "Commit the finished part (team_run needs a clean tree), then hand the rest to workers in parallel with team_run: pass the tasks you already know, or leave tasks out and the planner splits. " +
      "If the user wants you to go on alone, their reply resets this; /team-auto off turns it off for the session."
    );
  }

  /** Record a finished call; returns a note for its result, or undefined. */
  after(tool: string, file: string | undefined, failed: boolean): string | undefined {
    if (tool === "team_run") {
      if (!failed) this.delegated = true;
      return undefined;
    }
    if ((tool === "edit" || tool === "write") && file && !failed) this.files.add(file);
    this.calls++;
    const o = this.opts;
    if (!o.enabled || this.delegated || this.nudged || o.nudgeCalls <= 0 || this.calls < o.nudgeCalls) return undefined;
    this.nudged = true;
    return `Note: ${this.calls} tool calls in this request. If it has independent parts (questions to check, cases to write, files to fix), team_run runs them in parallel instead of one by one here.`;
  }
}
