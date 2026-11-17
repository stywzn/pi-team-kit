---
name: retro
description: Retrospective on a coding session that turns lost time into checks, saved pitfalls and facts instead of notes. Only when the user asks for a retro.
disable-model-invocation: true
---

Run a short retrospective on the session the user names, or on the current one.

1. Find the moments that cost time: wrong file, wrong command, a correction the user had to repeat, a hang or timeout, a fact rediscovered with several tool calls, a rework round in a team run, a mistake a check should have caught.

2. For each one, propose the cheapest durable fix, in this order of preference:
   - A deterministic check: a test, a lint rule, or a stronger gate in `.pi/ptk.json` (`team.gate`). Mechanical rules always become checks, never prose.
   - A pitfall saved with the `remember` tool (kind pitfall, a regex for the command, warn or block), so the guard catches it next time.
   - A fact saved with `remember` (kind fact, with a `check` command when one can confirm it), so the next session does not rediscover it.
   - A toolbox helper saved with `toolbox` action add, if a script was written that will be needed again.
   - A playbook change (`playbook` action update: add a pitfall or tip, bump an item that held again, retire a wrong one) when the session followed a playbook; or suggest `/harvest <name>` when this kind of task will come again and has none.
   - Only if none of these fits: one line in AGENTS.md, as a pointer to where the information lives. Never paste the information itself.

3. Show the list ranked by time lost, one line each: what happened, the proposed fix, which kind.

4. Apply the `remember`, `toolbox` and `playbook` items the user approves. Do not edit code, tests or config without asking.
