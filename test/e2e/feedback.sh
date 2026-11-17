#!/usr/bin/env bash
# End-to-end check of the friction report with real pi. Costs a fraction of a cent, about a minute.
#   test/e2e/feedback.sh
# 1. A lead notes friction with the friction tool; ptk feedback shows the note for that project.
# 2. /feedback inside pi writes the same report to <agentDir>/ptk/feedback.md.
# 3. If test/e2e/rework.sh ran (0.5.0 or later), the report for ptk-e2e names the verifier's rework reason.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/../.." && pwd)"
DIR="${PTK_E2E_FEEDBACK_DIR:-$HOME/code/ptk-e2e-feedback}"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi git node; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -e "$DIR" ]; then
  [ -f "$DIR/.ptk-e2e" ] || fail "$DIR exists and was not created by this script; set PTK_E2E_FEEDBACK_DIR"
  rm -rf "$DIR"
fi
mkdir -p "$DIR"
touch "$DIR/.ptk-e2e"
printf '# scratch\n' > "$DIR/README.md"
git -C "$DIR" init -q -b main
git -C "$DIR" add -A
git -C "$DIR" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture
cd "$DIR"

ok=1
check() { if eval "$1"; then echo "  ok   $2"; else echo "  FAIL $2"; ok=0; fi; }

say "a lead notes friction"
timeout 180 pi -p "Call the friction tool exactly once with this text: the planner put two unrelated tasks into one lane. Then answer: done." </dev/null >/dev/null
report="$(node "$KIT/bin/ptk.ts" feedback 1 --repo "$(basename "$DIR")")"
echo "$report" | sed 's/^/       /'
check 'echo "$report" | grep -q "Noted by leads"' "the report lists the lead's notes"
check 'echo "$report" | grep -q "two unrelated tasks into one lane"' "with the note's text"

say "/feedback inside pi"
before="$(stat -c %Y "$AGENT/ptk/feedback.md" 2>/dev/null || echo 0)"
sleep 1
timeout 120 pi -p "/feedback 1" </dev/null >/dev/null || true
after="$(stat -c %Y "$AGENT/ptk/feedback.md" 2>/dev/null || echo 0)"
check '[ "$after" -gt "$before" ] && grep -q "$(basename "$DIR")" "$AGENT/ptk/feedback.md"' "/feedback wrote the report for this project to ptk/feedback.md"

if [ -d "$HOME/code/ptk-e2e" ]; then
  say "report on the real team runs in ptk-e2e"
  real="$(node "$KIT/bin/ptk.ts" feedback 1 --repo ptk-e2e)"
  echo "$real" | sed 's/^/       /'
  check 'echo "$real" | grep -q "Lanes sent back for rework"' "rework is found in real team runs"
  check 'echo "$real" | grep -q "Missing review marker"' "with the verifier's reason, from each lane's history"
fi

[ $ok -eq 1 ] && printf '\033[1;32mPASS\033[0m e2e feedback\n'
[ $ok -eq 1 ]
