---
description: "Team run - planner splits the goal, up to 4 workers in parallel, verifier, automatic rework, then integrate"
---
Act as the team lead for this goal:

$@

1. If the goal is ambiguous or risky, ask me first (at most 3 short questions). Otherwise go on without asking.
2. Restate the goal in one or two sentences, including how to tell it is done (which tests or checks must pass).
3. Call `team_run` with that `goal` and no `tasks`: the team-planner reads the code and splits the work with file ownership. Only pass `tasks` yourself when the split is obvious and you already have the context.
4. While it runs, answer workers' questions yourself from the goal and the code. Bring me only product or scope decisions.
5. When it finishes, call `team_integrate` with the `runDir` of each passed lane, in order. If the planner returned questions, answer them (ask me only if you cannot) and run again with `tasks`. For lanes marked needs-human or failed, summarise the verifier's findings in plain words and propose what to do.
6. Final report in plain words: what changed, the gate result on the combined code, what is left. Suggest a commit message; do not commit unless I say so.
