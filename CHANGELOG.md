# Changelog

## [0.3.2] - 2026-11-17

Fixes from running on a company Windows machine.

- Python: the detected test command uses a Python that actually runs here (`python`, `py -3` or `python3`; Windows Store aliases skipped) instead of a hard-coded `python3`; no gate is guessed when there is no Python. The `py` launcher is understood by the guard (`py -m http.server` blocked, `py -m pytest` gets the test timeout).
- `team_run` checks that the gate's program can start (`<program> --version`) before any worker runs, so a broken gate fails in seconds instead of after a full round.
- Gate and fact checks run through pi's own bash (Git Bash on Windows) instead of `sh` on PATH; fact checks now run on Windows too, and `/ptk` says whether they ran.
- Facts the agent saves for a project go to `.git/ptk/` (never in `git status`, so they cannot block a team run); `ptk facts share` merges them into the committed `.pi/ptk/facts.json`. Project toolbox helpers saved by the agent go to `.git/ptk/toolbox`.
- `ptk doctor`: finds `pi.cmd` on Windows, finds the browser on Windows (file URL import), and flags package paths with backslashes (local-path installs on Windows, which hide this package's agents from pi-subagents); `--fix` rewrites them. `/ptk` shows the same warning.
- `team.maxTasks` (default 8) applies everywhere; more tasks is an error and a planner over the limit hands its plan back instead of being cut silently.
- md2pdf/shot no longer fail with EBUSY when Windows still holds the browser's temp files; `ls -R` gets a hint instead of being blocked.

## [0.3.1] - 2026-11-17

- Windows/WSL desktop notifications: the script is passed with `-EncodedCommand`, so Chinese and other non-ASCII text survives the WSL to Windows code page boundary, and the toast template is filled without the "collection was modified" error that kept it from showing.

## [0.3.0] - 2026-11-17

- Clarify first, then unattended: `team_run` takes `doneWhen`, `outOfScope` and `assumptions`, and in the terminal shows the brief in a confirmation dialog before starting. After that the lead never waits for the user, takes conservative defaults on minor decisions, integrates and writes a CI-style report. The done-criteria travel to planner, workers and verifier.
- Inheritance: a per-repository record of the brief, each team run and handoff notes (kept under the pi agent directory, not in the repo). New sessions are told about it; `/continue` hands the task to the new lead, which checks the current state before doing anything. `/handoff <next step>` writes a focused brief and opens a fresh session.
- Context budget per kind of session (lead 160k, planner 80k, worker 120k, verifier 60k, at most half the model window). The lead compacts only when idle (compacting during a run aborts it, tested), with a cooldown, and is pointed to `/handoff` after two compactions. `ptk caps [--apply]` sets per-role context windows through pi's model overrides.
- Terminal title "π <session name> · <directory>", sessions auto-named from their first prompt, and a desktop notification (Windows/WSL, macOS, Linux, OSC 777 through tmux) instead of a bell when a long run finishes.
- The retrospective is now the `retro` skill (`/skill:retro`).

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
