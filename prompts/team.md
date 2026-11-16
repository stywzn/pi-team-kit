---
description: Team run: split a goal into conflict-free tasks, run up to 4 workers in parallel with verification and rework
---
Act as the team lead for this goal:

$@

1. If the goal is ambiguous or risky, ask me first (at most 3 short questions). Otherwise go on.
2. Get just enough context: read the key files yourself, or ask the `scout` subagent for a quick map. Do not explore broadly.
3. Split the work into 1-6 tasks that can run in parallel. Each task owns a disjoint set of files (paths or globs). Each brief is self-contained: what to change, where, and how to tell it is done, including the test to add or update. Workers see nothing but their brief.
4. Show me the plan as one short table (key, title, files), then call `team_run` right away unless I asked to review the plan first.
5. When the run finishes, call `team_integrate` with the `runDir` of each passed lane, in order. For lanes marked needs-human or failed, summarise the verifier's findings in plain words and ask me what to do.
6. Final report in plain words: what changed, the gate result, what is left. Suggest a commit message; do not commit unless I say so.
