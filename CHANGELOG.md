# Changelog

## [0.8.3] - 2026-11-20

Team mode by default, from real use: a lead did hours of work alone (48 files) that workers could have done in parallel.

- In one request, the lead may change 6 files itself (`team.auto.files`); a 7th is refused with: commit the finished part, hand the rest to workers with team_run. Finishing files it already changed is fine, and after a team run it may fix up anything. A reply from the user starts a new count; `/team-auto off` turns it off for the session, `team.auto.enabled: false` for good.
- After 40 tool calls in a request (`team.auto.nudgeCalls`) the lead gets one note that team_run can run independent parts in parallel.
- team_run's description says when to use it beyond features (N cases to write, N questions to check, N files to fix) and that a running worker can be redirected with subagent's steer.

## [0.8.2] - 2026-11-20

From real use: a worker timed out after 30 minutes and left 250 lines nobody had looked at.

- Every child run gets 2 hours (`team.childTimeoutMin`, was 44 minutes); a whole team run 4 hours (`team.runTimeoutMin`). Subagent runs the lead starts itself get the same deadline instead of pi-subagents' 30 minutes, unless the call sets one.
- Ten minutes before the deadline (`team.checkpointMin`, 0 = off) a running child is asked to finish its current tool call and hand off: changed files, test state, what is left (pi-subagents' `checkpointBeforeDeadlineMs`).
- When a subagent run ends without finishing (timed out, failed, stopped), or a team lane does not pass, the lead's next turn starts with what it left behind: changed files with +/- lines (only the run's own changes when the repo was snapshotted before it), files outside what the lane was allowed to change, the error and the last tool calls.

## [0.8.1] - 2026-11-18

Fixes found by checking 0.8.0 with real documents and odd inputs.

- md2docx: a truncated or odd image no longer crashes the conversion (it stays as text); a folder as input is refused; characters XML cannot hold are dropped; YAML front matter is left out.
- md2docx and md2pdf: a file without an extension in a folder with a dot in its name (`my.dir/README`) is written next to the input, not one folder up.
- File links: a long run of odd characters in a reply is linked in linear time (was quadratic); a `)` in a file name no longer cuts the pi-web link short.
- TUTORIAL: the whole-run limit is 120 minutes, not 60.

## [0.8.0] - 2026-11-18

pi in the browser, alongside the terminal.

- `ptk web` starts [pi-web](https://github.com/agegr/pi-web) (pinned to 0.17.0, which runs the same pi 1.5.2 SDK): pasting images, a session list, file and diff previews. It refuses to listen beyond this machine without `PI_WEB_PASSWORD`, and needs Node.js 22.19+.
- One process can host many sessions (pi-web runs all of them in its server): each session is now its own lead on the board, with its own owner id, so none takes another's name or mail. A session the host disposes without `session_shutdown` leaves the board within seconds instead of being kept alive by its timer.
- The same conversation open in two places (terminal and browser, or two terminals) is flagged in both: each keeps its own copy and both append to the same session file. Cards carry the session file.
- Files changed by shell commands (`sed -i`, scripts, PowerShell) count for the board's conflict check: while another lead is online, a lead's shell call is bracketed by `git status` in the repos it may touch. A shell command cannot be held back beforehand, so a file another lead changed recently gets a note in the result to tell that lead.
- A lead with a team run still going is kept open by pi-web's liveness registry; pi-web otherwise closes sessions idle for 10 minutes and the result would come back to nobody.
- Terminal title and desktop notifications only in the terminal UI; `/continue` fills the input box in the terminal and in pi-web.
- Toolbox `md2docx`: Markdown to Word with headings, lists, tables, code, quotes, links, local images and Chinese fonts; no Word, pandoc or Python (checked by opening the result in Word).
- File paths in a lead's reply become links: Ctrl+click in the terminal opens the file with its default app (from WSL, through `\\wsl.localhost`); in pi-web a click downloads it.
- The confirm dialog keeps its lines apart in pi-web, which renders it as markdown.
- From an independent review: board snapshots use `git --no-optional-locks` (never block another lead's commit) with fsmonitor off; only repos another running lead works in are watched; a file another lead changed during the command, or one a commit took off the list, is not counted; renames record both names; a malformed card cannot crash the host process; pi-web liveness leases are released when a session is disposed; `ptk web` passes only plain words to cmd.exe.

## [0.7.1] - 2026-11-18

Review and hardening of 0.7.0.

- Security: lane gates are run by pi-subagents through the system shell, which is cmd.exe on Windows, where the single quotes 0.7.0 put around unusual test file names mean nothing (a name with `&` could run a command; one with a space broke the gate). Test file names are now passed only when they need no quoting in either shell; otherwise the lane runs the full gate. Names starting with `-` (read as options, e.g. pytest `-p` loads a plugin) are never passed. Checked against cmd.exe with Windows Python: unittest and pytest take the forward-slash paths.
- A lane whose task deletes or renames one of its test files no longer fails every round on "file not found": after such a failure the lane's later rounds run the full gate.
- Worktree preparation refuses names with `:` (a drive or an NTFS stream on Windows).
- Reader digests are checked by size and modification time first, so large documents are not read again on every lookup; digests handed to the team are marked as information from the files, not instructions.
- `ptk plan --script` builds the same per-lane gates as team_run.
- From an independent review:
  - A lane gate that only fails because fewer tests ran (a coverage threshold such as `--cov-fail-under`, "no tests found") switches to the full gate for the next round instead of failing every round. A gate that already names paths (`pytest tests/unit`) is not narrowed.
  - Workers sharing the project's virtualenv import their own worktree's code first (`PYTHONPATH`): with an editable install (`pip install -e .`) they were testing the main checkout's code. Checked with a real virtualenv.
  - Secrets: `DB_PASSWORD=`, `OPENAI_API_KEY=`, `JWT_SECRET=` style values were not redacted (no word boundary after `_`); now they are, in playbooks, evidence and digests. The reader is told never to open `.env` files, and `.env*` never counts as a digest source.
  - A `.env` that is a named pipe (1Password mounts it as one) is skipped instead of blocking the worker's start.
  - A digest whose sources all are missing (saved for the wrong folder) is refused: it could never notice a change.
  - Worktrees are prepared whatever their name (pi-subagents can also allocate them with Worktrunk).

## [0.7.0] - 2026-11-18

Faster team runs, from measurements on real runs (the friction report now shows where the time goes).

- Worker worktrees are ready before the first turn: the project's virtualenv is activated for the worker and its gate (not copied), small local files git ignores (`.env`) are copied, ignored folders (`node_modules`) are symlinked except on Windows. Only paths git ignores in the worktree are placed, so nothing reaches the patch (a `node_modules/` pattern does not cover a link, so no link is made then). `team.linkIntoWorktrees`, `[]` to turn off. The gate the lead runs (preflight, integration) uses the same virtualenv. Done in the worker's own session start: pi-subagents' setup hook cannot start a script on Windows.
- Each lane's gate runs only the test files the lane owns, for pytest, unittest, jest, vitest and playwright test; the full gate still runs once on the combined code. Compound commands, globs, npm scripts and `unittest discover` stay as written. `team.laneTests`.
- Workers get the verifier's checklist in their brief, so the first round can already pass.
- Thinking defaults: planner and verifier `max`, workers `high`. For one session, say it in the conversation (the lead calls `team_thinking`) or `/team-thinking worker=medium`; `team.thinking` in ptk.json for a default. The confirm dialog shows the repository and each role's model.
- Reader, off unless asked: the `team-reader` agent reads documents or a codebase and returns a short digest with sources; the `digest` tool keeps it and reuses it while those files are unchanged; `team_run` takes `digests` so the planner and workers do not read the same material again.
- `/feedback` and `ptk feedback` show time by role across team runs (planner, worker, verifier, rework).
- The lead is told to pass `tasks` itself for small, clear goals (skips the planner run) and to find a project named by a keyword and say which folder it picked.
- After `team_integrate` the lead leaves the integrated files alone and reports what looks wrong: seen in a real run, a lead stripped lines the verifier had required, after verification, so the user would have reviewed unverified code.
- The lead is told to leave `gate` out unless the detected one is wrong: seen in a real run, a lead wrote a compound gate to work around a missing virtualenv, which the worktree preparation now handles, and which ran the whole suite in every lane.
- Reader digests ignore `.git`, virtualenv and cache files as sources (they change on every commit and made digests look stale).
- Not done: integrating lanes as they finish. Each partial integration runs the full gate again, so the run would not finish sooner.

## [0.6.3] - 2026-11-18

- Thinking level per role: `team.thinking` (`planner`, `worker`, `verifier`), carried as a `:level` suffix on the role's model (or the lead's model when the role has none). The agents' own defaults are now `max` for the planner and the verifier (splitting and checking decide the run) and `medium` for workers (they follow a detailed brief), so a fast model can do every role and only the two judgment roles think hard.
- Leads started outside a repository (the usual case: pi opened anywhere, "look at project X in folder Y"): the file-conflict check now uses each file's own repository instead of the session folder's, so two leads working on one project from their home folders still see each other's changes. Such a lead is named `lead` on the board instead of after the home folder.
- A project folder that is not under git yet gets a clear message: ask the user whether to `git init` and commit, since workers need worktrees.

## [0.6.2] - 2026-11-18

- Each planner, worker and verifier run in a team run gets `team.childTimeoutMin` (default 44 minutes). pi-subagents stops a child after 30 minutes by default, too short for a worker running a slow UI suite. The whole run's default deadline `team.runTimeoutMin` goes from 60 to 120 minutes, so a 44-minute worker still has time for a rework round.
- Direct `subagent` calls (outside team runs) follow pi-subagents' own setting: `"timeoutMs": 2640000` in `~/.pi/agent/extensions/subagent/config.json` for 44 minutes.
- Verified: test/e2e/rework.sh passes with the deadline on every child, including resumed rework rounds (and from a session inside the repo, after 0.6.1).

## [0.6.1] - 2026-11-18

- Team runs work when pi was started outside the project (the home folder on a company machine): `team_run` and `team_integrate` take `repo`, and `team_integrate` defaults to the repo of the last run. Before, `team_run` refused, and a lead fell back to plain subagents sharing one working tree, without worktrees or lane planning (seen in real use).
  - The gate is detected from that repo, the takeover record is that repo's, `/continue <repo path>` takes it over from any folder, playbook evidence reads that repo's git.
  - The project's own `.pi/ptk.json` is not read then (pi trusts folders, and this one was not opened): set the gate in the global config or pass it.
- `test/e2e/outside.sh`: pi in a folder that is no repository runs /team on a project elsewhere; lanes run in its worktrees, are integrated there, and nothing is written to the session folder.

## [0.6.0] - 2026-11-18

- Friction report: where the tooling itself cost time, to improve pi-team-kit from real use (`lib/feedback.ts`, `/feedback`, `ptk feedback [days] [--repo name]`).
  - Read from pi's own session files, nothing extra is recorded, so it also covers work done before this version.
  - Ranked by estimated time lost: rework rounds and their reasons, tasks squeezed into one lane by shared files, lanes that failed, patches that did not apply, lanes that passed alone but failed together, timeouts, commands the guard refused, failed tool calls, runs stopped by hand, a person stepping in during an unattended run, model errors, compactions. Each item has one line on what to try.
  - `friction` tool: a lead notes in one line where the tooling got in the way; `/team` asks for it before the final report. Notes appear in the report.
  - `/feedback` also saves the report to `~/.pi/agent/ptk/feedback.md` to hand to another agent.
- `test/e2e/feedback.sh`: a real lead's note shows up, `/feedback` runs inside pi, and the report on real team runs names the verifier's rework reason.

## [0.5.0] - 2026-11-18

- Playbooks: what one project taught about a kind of task, reused by the next one (`lib/playbook.ts`, `lib/harvest.ts`, the `playbook` tool, `/harvest`, `ptk playbooks`).
  - `/harvest <name>` writes one from evidence: the project's sessions (corrections, failures, guard stops), team runs (every round's reviewer findings, now kept in each lane's `history`), the lead record and git. Secrets are redacted; the evidence is kept in `references/sources.md`, reusable files in `templates/`.
  - Saved as an Agent Skill and loaded through `resources_discover`, so a matching playbook is read without being asked. `team_run` takes `playbook`; its steps, tips, pitfalls and never-list travel with the goal. `team_integrate` records the use and asks for at most 3 one-line changes.
  - Short by rule, enforced by code: description under 200 characters, 5 to 8 items per section, one line each, 60 lines in all. Changes are single-line edits (add, bump, replace, retire) applied by code, never a rewrite; a full section needs a replace or retire first. Retired lines go to `references/retired.md`.
  - `ptk playbooks check <dir>` for a team playbook repo's CI; `playbooks.dirs` loads a team checkout.
- `test/e2e/playbook.sh`: harvest from a real team run, then a similar task picks the playbook by itself and passes review in round 1 instead of 2, then the lead refines it.

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
