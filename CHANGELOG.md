# Changelog

## [0.4.0] - 2026-11-17

- Lead sessions on related tasks see each other and tell each other what changed (`lib/board.ts`, the `leads` tool, `/leads`). Plain files under `~/.pi/agent/ptk/board`, no daemon; only lead sessions join (workers keep talking to their own lead).
  - `leads list` / `status` / `send`. A message reaches a busy lead before its next model call (steered, nothing interrupted); `update=true` wakes an idle lead to update its own code, docs and status and reply. A turn started by a message can wake the other side once more at most (A → B → A), so replies never ping-pong.
  - A lead that changes (edit/write) a file another running lead in the same repo, or one of its worktrees, changed in the last 30 minutes is held until it has told that lead. `team_integrate` flags such files too, and team runs update the lead's status.
  - Names default to the repo folder (`leads.name` to set one); an offline lead's unread mail goes to the next session that takes its name. Settings: `leads.enabled`, `leads.wake`.
  - One board seat per process: a session created inside the lead's process (pi-subagents' foreground subagents run there; today without ambient extensions) can never take the lead's name and mail. The e2e test runs a foreground subagent and watches the lead's card.
  - Messages are wrapped in `<lead-messages>` tags a peer cannot forge. Without a clear end, a message waiting for the next turn ran into the user's next prompt and the model mixed the two up (found by the e2e test).
  - A session suspended (Ctrl+Z) past the stale limit whose name was taken moves to a free name instead of overwriting the newer card; inbox files are removed only after pi accepted the message; the log rotates instead of being rewritten.
  - `ptk leads [n]` prints the board from a shell (over SSH too).
- `test/e2e/leads.sh`: two real leads in tmux (one woken by a message updates its code and replies), plus a third lead in a worktree held until it tells the first.

## [0.3.4] - 2026-11-17

- `bg` on Windows: logs stayed empty, so `bg logs`, `--wait-for <log regex>` and the "last log lines" of a process that died at start all showed nothing. The cause is a detached `cmd.exe`: it drops output redirected to a file (redirecting inside cmd, as first suggested, loses it too). `bg` now starts a small detached node supervisor (`toolbox/bg/win-supervisor.mjs`) that owns the log and runs the command; `bg stop` ends it with its whole process tree. Linux/macOS are unchanged. CI now waits on a log line and checks the logs and the early-exit reason on every platform.
- Toolbox helpers declared with `python3` run with the Python that works here (`python`, `py -3`, `python3`), like the gate.
- `ptk plan --script` prints the same plan `team_run` would build (configured `maxTasks`, models, planner, detected gate) and validates tasks against `team.maxTasks`.

## [0.3.3] - 2026-11-17

Fixes from a second round of testing on Windows, plus an independent review of the fixes.

- Worktree cleanup works on Windows: git prints `C:/...` while pi-subagents records `C:\...`, so nothing ever matched and every worker worktree was left behind. Paths are now compared after normalising separators (and case, for Windows paths only). A worktree is only deleted when git says it is on exactly the `pi-subagents/` branch the handoff recorded for it; detached or reused paths are never deleted on a name match. Whatever is not deleted is listed with the reason instead of being silently skipped.
- The gate preflight never runs a script (`./run_tests.sh` is only checked for existence) and only judges a gate whose first command is the program: gates with setup steps (`source .venv/bin/activate && ...`, `cd api && ...`, `export ...`), shell expansions (`$PYTHON`, `~`) or a leading redirection are not checked rather than falsely blocked. Exit 0 always counts as runnable.
- A fact check that times out, is aborted or has no shell is "unknown", not "stale"; the default check timeout is 5 s.
- `team_integrate` runs the same gate the team run used (recorded when it started) unless told otherwise; before, a custom per-run gate passed in every worker but the combined code was tested with the default one.

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
