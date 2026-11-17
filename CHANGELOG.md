# Changelog

## [0.2.0] - 2026-11-17

- Planner: `team_run` with only a `goal` lets the new `team-planner` agent read the code and split the work (file ownership, contract-first interfaces, a playbook per task type). The main session's context stays small; questions that block planning come back as `needs-input`.
- Models per role (`team.models.planner/worker/verifier`), e.g. DeepSeek workers and a GLM verifier.
- Lane results carry the worker's report up to the main session; `team_run` tells the lead to answer worker questions itself and escalate only product or scope decisions.
- Guard: timeouts by command type (default 180 s, tests 900 s, installs/builds 600 s, ceiling 1800 s); test commands run with `CI=1`; Playwright report servers, `cypress open`, Karma/ng watch, pytest-watch and `vitest watch` are blocked; commands wrapped in `bash -c` / `sh -c` / `eval` are inspected too.
- Plain talk keeps established English technical terms (flaky test, fixture, mock...) and allows common testing acronyms.
- Terminal title shows session name and state (● running, ✓ just finished) and rings the bell after long runs, so tmux can name and flag pi windows.
- `/team-retro` turns wasted time into checks, pitfalls and facts; `ptk demo` creates a practice repo; `docs/TUTORIAL.md`.
- Tests: security and performance suites, a real-model end-to-end script with a forced rework round (`test/e2e/rework.sh`), CI on Windows too.

## [0.1.1] - 2026-11-17

- `/team` prompt template: quoted the description so its YAML frontmatter parses without a warning.
- `ptk doctor`: missing rg/fd on a fresh install is a warning with the install command, not a failure (pi downloads them on first use).

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
