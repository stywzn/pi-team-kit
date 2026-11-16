# Changelog

## [0.1.0] - 2026-11-17

First release.

- Team run: `/team <goal>`, `team_run` and `team_integrate` on top of pi-subagents. Tasks that share files merge into one lane; each lane runs a worker in its own git worktree, a host-run gate, a fresh read-only verifier, and rework by the same worker for at most 3 rounds. A failing lane ends as `failed`/`needs-human` without stopping the others.
- `team_integrate` diffs each worker's worktree (so rework rounds are included), applies the lanes in order, runs the gate on the combined result, and removes the workers' worktrees and branches when it passes.
- Project-level config, facts and toolbox load only after pi trusts the project, so a cloned repository cannot run its fact checks on your machine.
- Command guard: default 180 s bash timeout (pi has none), 1200 s ceiling; blocks dev servers, watchers, `tail -f`, REPLs and full-screen programs in the foreground; `grep -r` / `find -name` / `ls -R` redirected to rg/fd; `sudo` runs as `sudo -n`; pager, editor and credential prompts disabled through environment variables.
- Environment facts detected by code every session (OS/WSL, runtimes, package managers, mirrors, proxy, repo, project scripts, test command), plus agent-saved facts with check commands and pitfalls that the guard enforces (`remember` tool).
- Plain-talk output rules and a check for unexplained abbreviations that feeds the next turn.
- Toolbox: `md2pdf`, `shot`, `bg`, and `toolbox add` to save new helpers globally or per project.
- `ptk` CLI: `doctor`, `env`, `tools`, `run`, `plan`.
