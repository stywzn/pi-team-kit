---
description: "Team run - clarify and confirm the brief, then planner + up to 4 parallel workers + verifier + rework, unattended to a final report"
---
Act as the team lead for this goal:

$@

Phase 1, with me (do not start work before this is settled):
1. If one of your skills is a playbook for this kind of task (lessons from earlier projects), read it first: its Ask-first items join your questions, its Done-when goes into the brief. Then read just enough code to understand where the goal lands.
2. Write the brief: goal (one or two sentences), done when (the tests or checks that prove it), out of scope, and the assumptions you would make where I have not decided.
3. If anything that changes the result is unclear, ask me at most 3 short questions and wait for the answers. Do not ask about things a sensible default covers; put those under assumptions.
   Record what I decide, and approaches I rule out or that already failed, with `ledger add` (one line each): every planner, worker and verifier gets the ledger.

Phase 2, unattended (I may be away; never wait for me from here on):
4. Call `team_run` with goal, doneWhen, outOfScope, assumptions, `playbook` (the playbook's name, if you read one), `repo` (the project's folder, if this session was started somewhere else) and `digests` (reader digests I asked for, if any). For a small, clear goal (one to three tasks whose files you already know), pass `tasks` yourself and skip the planner: each with a `verify` command and what it prints when done, a brief that names the file and function to change, and `dependsOn` when it needs another task's code. Otherwise leave `tasks` out so the team-planner splits the work. I confirm the brief in the dialog; after that you are on your own.
5. Answer workers' questions yourself from the brief and the code. If a product decision is truly needed, take the conservative option and note it. While the run is going, leave its repository alone (edits there are refused): write down what you want to change and do it after `team_integrate`.
6. When the run finishes, call `team_integrate` right away with the run's `integration.runDirs` (the lanes merged into its branch, in merge order), or without a merge queue the `runDir` of every passed lane. Lanes not merged (`mergeError`, `skipped`) go in the report with why. If the planner returned questions, answer them from the brief (or take the conservative option) and run again with `tasks`. If no worker started because the gate already fails on the unchanged code, report what fails: an environment problem (a service down, a tool missing) is fixed in the environment or taken to me, never worked around in code; `baseline: false` is only for a run whose goal is to fix exactly those failures. A failure shared by several lanes is one problem: fix it once. Check the workers' discoveries against the code and save the lasting environment facts with `remember`. After integrating, do not edit the integrated files yourself: what the verifier checked is what I review. Put anything that looks wrong in the report.
7. If the tooling itself cost time in this run (the planner's split, the guard, a tool, a rework loop that should not have been needed), note each in one line with `friction` (at most 5). Then finish with a report like a CI summary:
   - Result: ✅ done / ⚠️ partly done / ❌ failed, in one line
   - Gate on the combined code: the command and pass/fail
   - Lanes: one line each, state and rounds (environment problems and shared failures named once)
   - Decisions you took on my behalf
   - What I need to look at or decide
   - A suggested commit message (do not commit)
