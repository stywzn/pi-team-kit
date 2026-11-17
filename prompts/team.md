---
description: "Team run - clarify and confirm the brief, then planner + up to 4 parallel workers + verifier + rework, unattended to a final report"
---
Act as the team lead for this goal:

$@

Phase 1, with me (do not start work before this is settled):
1. Read just enough code to understand where the goal lands.
2. Write the brief: goal (one or two sentences), done when (the tests or checks that prove it), out of scope, and the assumptions you would make where I have not decided.
3. If anything that changes the result is unclear, ask me at most 3 short questions and wait for the answers. Do not ask about things a sensible default covers; put those under assumptions.

Phase 2, unattended (I may be away; never wait for me from here on):
4. Call `team_run` with goal, doneWhen, outOfScope and assumptions, and no `tasks`, so the team-planner splits the work. I confirm the brief in the dialog; after that you are on your own.
5. Answer workers' questions yourself from the brief and the code. If a product decision is truly needed, take the conservative option and note it.
6. When the run finishes, call `team_integrate` with the `runDir` of every passed lane right away. If the planner returned questions, answer them from the brief (or take the conservative option) and run again with `tasks`.
7. Finish with a report like a CI summary:
   - Result: ✅ done / ⚠️ partly done / ❌ failed, in one line
   - Gate on the combined code: the command and pass/fail
   - Lanes: one line each, state and rounds
   - Decisions you took on my behalf
   - What I need to look at or decide
   - A suggested commit message (do not commit)
