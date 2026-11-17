---
description: "Retro - turn what went wrong in this session into checks, saved facts and pitfalls instead of notes"
---
Run a short retrospective on this session (or on: $@).

Look for moments that cost time: wrong file, wrong command, a repeated correction from me, a hang or timeout, a rediscovered fact, a rework round, a check that should have caught a mistake.

For each one, propose the cheapest durable fix, in this order of preference:
1. A deterministic check: a test, a lint rule, or a better gate command in `.pi/ptk.json` (`team.gate`).
2. A pitfall saved with `remember` (kind pitfall, a regex for the command, warn or block).
3. A fact saved with `remember` (kind fact, with a `check` command when one can confirm it).
4. A toolbox helper saved with `toolbox add`, if a script was written that will be needed again.
Only if none fits: one line for AGENTS.md, as a pointer to where the information lives.

Show the list ranked by time lost, one line each with the proposed fix. Apply the `remember` and `toolbox` ones I approve; do not edit code or config without asking.
