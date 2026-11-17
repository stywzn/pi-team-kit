#!/usr/bin/env bash
# End-to-end check of playbooks with real pi sessions in tmux. Costs a few cents of model usage, ~8 minutes.
#   test/e2e/playbook.sh                       # runs test/e2e/rework.sh first to get a project with history
#   PTK_E2E_SKIP_SOURCE=1 test/e2e/playbook.sh # reuse ~/code/ptk-e2e from a recent rework.sh run
#
# 1. harvest: /harvest in the rework project, where the verifier sent every lane back for a missing review
#    marker. Asserts: a valid, short playbook, written from evidence that includes that finding.
# 2. apply: a similar task in a new repo whose verifier enforces the marker from round 1. Nobody mentions
#    the playbook. Asserts: the lead picks it, every lane passes in round 1 (the lesson arrived), its use is recorded.
# 3. refine: the lead applies its proposed changes. Asserts: still valid, no item lost except retired ones.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/../.." && pwd)"
SRC="${PTK_E2E_DIR:-$HOME/code/ptk-e2e}"
ROOT="${PTK_E2E_PLAYBOOK_DIR:-$HOME/code/ptk-e2e-playbook}"
PB="$ROOT/playbooks" NEW="$ROOT/calc2"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
WORKER="${PTK_E2E_WORKER_MODEL:-deepseek/deepseek-flash}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-20}"
T_SRC="ptk-e2e-pb-src-$$" T_NEW="ptk-e2e-pb-new-$$"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -z "${PTK_E2E_SKIP_SOURCE:-}" ]; then
  say "source project: a real team run with one rework round per lane (test/e2e/rework.sh)"
  PTK_E2E_WORKER_MODEL="$WORKER" bash "$HERE/rework.sh"
fi
[ -f "$SRC/.ptk-e2e" ] || fail "no source project at $SRC; run test/e2e/rework.sh first"

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_PLAYBOOK_DIR"
  rm -rf "$ROOT"
fi
mkdir -p "$PB"
touch "$ROOT/.ptk-e2e"
trap 'tmux kill-session -t "$T_SRC" 2>/dev/null || true; tmux kill-session -t "$T_NEW" 2>/dev/null || true' EXIT

# Playbooks go to the scratch folder and are saved without the editor dialog (nobody at the keyboard).
python3 - "$SRC/.pi/ptk.json" "$PB" <<'PY'
import json, sys
p, pb = sys.argv[1:]
c = json.load(open(p))
c["playbooks"] = {"dir": pb, "confirm": False}
json.dump(c, open(p, "w"))
PY

key() { printf -- '--%s--' "$(printf '%s' "$1" | sed 's#^/##; s#/#-#g')"; }
STARTED="$(mktemp)"
session_file() { find "$AGENT/sessions/$(key "$1")" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1; }
start_pi() { # tmux-name dir
  tmux new-session -d -s "$1" -x 200 -y 50 -c "$2" "pi -a"
  for _ in $(seq 1 60); do tmux capture-pane -t "$1" -p | grep -q "ptk:" && return 0; sleep 1; done
  fail "pi did not start in $2"
}
type_in() { tmux send-keys -t "$1" -l "$2"; sleep 1; tmux send-keys -t "$1" Enter; }
until_true() { # description deadline-seconds command...
  local what="$1" limit="$2"; shift 2
  local deadline=$(( $(date +%s) + limit ))
  say "waiting: $what"
  until "$@"; do
    [ "$(date +%s)" -lt "$deadline" ] || { tmux capture-pane -t "$T_SRC" -p 2>/dev/null | tail -15; tmux capture-pane -t "$T_NEW" -p 2>/dev/null | tail -15; fail "timed out: $what"; }
    sleep 4
  done
}
# The lead finished its turn after calling <tool>: an assistant text message follows that tool's result.
settled_after() { # session-file tool
  [ -n "$1" ] && python3 - "$1" "$2" <<'PY'
import json, sys
after = done = False
for line in open(sys.argv[1]):
    m = (json.loads(line).get("message") or {})
    if m.get("role") == "toolResult" and m.get("toolName") == sys.argv[2]: after, done = True, False
    if after and m.get("role") == "assistant" and any(p.get("type") == "text" and p.get("text", "").strip() for p in m.get("content") or []) and not any(p.get("type") == "toolCall" for p in m.get("content") or []): done = True
sys.exit(0 if done else 1)
PY
}

start=$(date +%s)
# ---------- 1. harvest ----------
say "harvest in $SRC"
start_pi "$T_SRC" "$SRC"
type_in "$T_SRC" "/harvest calc-todo-fixes fixing TODOs in a small Python module with unittest tests"
until_true "a playbook is saved" 300 sh -c "ls '$PB'/*/SKILL.md >/dev/null 2>&1"
S_SRC="$(session_file "$SRC")"
until_true "the harvest turn ends" 120 settled_after "$S_SRC" playbook
NAME="$(basename "$(dirname "$(ls "$PB"/*/SKILL.md | head -1)")")"
cp "$PB/$NAME/SKILL.md" "$ROOT/harvested.md"
tmux kill-session -t "$T_SRC"
say "harvested playbook: $NAME"
sed 's/^/       /' "$PB/$NAME/SKILL.md"

# ---------- 2. apply ----------
say "a similar task in a new repo: $NEW"
mkdir -p "$NEW/.pi/agents"
cp "$KIT"/examples/demo-repo/* "$NEW/"
cp "$HERE/marker-verifier.md" "$NEW/.pi/agents/team-verifier.md"
printf '{ "team": { "confirm": false, "models": { "worker": "%s" } }, "playbooks": { "dir": "%s", "confirm": false } }\n' "$WORKER" "$PB" > "$NEW/.pi/ptk.json"
printf '__pycache__/\n.pi/subagents/\n' > "$NEW/.gitignore"
git -C "$NEW" init -q -b main
git -C "$NEW" add -A
git -C "$NEW" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture
start_pi "$T_NEW" "$NEW"
type_in "$T_NEW" '/team Fix the two TODOs in calc.py (division by zero raises ValueError("division by zero"); main() prints usage to stderr and returns 2 on a wrong argument count) with tests in test_calc.py. Done when python3 -m unittest -q passes. Out of scope: any other file. Everything is decided: do not ask me anything, go straight to team_run.'
until_true "the team run is integrated and reported" $((TIMEOUT_MIN * 60)) sh -c "f=\$(find '$AGENT/sessions/$(key "$NEW")' -maxdepth 1 -name '*.jsonl' -newer '$STARTED' 2>/dev/null | head -1); [ -n \"\$f\" ] && grep -q '\"toolName\":\"team_integrate\"' \"\$f\""
S_NEW="$(session_file "$NEW")"
until_true "the lead's report" 300 settled_after "$S_NEW" team_integrate

# ---------- 3. refine ----------
say "refine: the lead applies the changes it proposed"
type_in "$T_NEW" "Apply the playbook changes you proposed with the playbook tool. If you proposed none, add one tip from this run."
until_true "the playbook is updated" 300 python3 -c "import json,sys; sys.exit(0 if json.load(open('$PB/$NAME/playbook.json'))['log'] else 1)"
until_true "the refine turn ends" 120 settled_after "$S_NEW" playbook
elapsed=$(( $(date +%s) - start ))

say "checking results"
set +e
node "$KIT/bin/ptk.ts" playbooks check "$PB"
check_status=$?
python3 - "$PB/$NAME" "$ROOT/harvested.md" "$S_NEW" "$NAME" "$check_status" <<'PY'
import json, re, sys
pb, harvested, s_new, name, check_status = sys.argv[1:]
ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok = ok and cond
first = open(harvested).read()
now = open(f"{pb}/SKILL.md").read()
lines = [l for l in first.split("\n")[4:] if l.strip()]
check(len(lines) <= 60, f"harvested playbook is short: {len(lines)} lines")
check(re.search(r"^## Steps", first, re.M) and re.search(r"^## Done when", first, re.M), "it has Steps and Done when")
sources = open(f"{pb}/references/sources.md").read()
check("verifier on" in sources and "review marker" in sources.lower(), "it was written from evidence that includes the verifier's rework reason")
check("reviewed-by" in first, "the lesson made it in: the review marker")
calls, integrate, value = [], "", None
for line in open(s_new):
    e = json.loads(line); m = e.get("message") or {}
    for p in (m.get("content") or []) if isinstance(m.get("content"), list) else []:
        if p.get("type") == "toolCall": calls.append((p.get("name"), p.get("arguments") or {}))
    if m.get("role") == "toolResult" and m.get("toolName") == "team_integrate":
        integrate = " ".join(p.get("text", "") for p in m.get("content") or [])
    if e.get("type") == "custom_message":
        r = re.search(r"(/\S+)/workflow-receipt\.json", str(e.get("content")))
        if r:
            try: value = json.load(open(r.group(1) + "/status.json"))["workflow"]["value"]
            except Exception: pass
runs = [a for n, a in calls if n == "team_run"]
check(any(a.get("playbook") == name for a in runs), f"the lead picked the playbook by itself: {[a.get('playbook') for a in runs]}")
lanes = (value or {}).get("lanes") or []
check(lanes and all(l["state"] == "passed" for l in lanes), f"all lanes passed: {[(l['lane'], l['state']) for l in lanes]}")
check(lanes and all(l["rounds"] == 1 for l in lanes), f"no rework needed, the lesson arrived: rounds {[(l['lane'], l['rounds']) for l in lanes]} (the source run needed 2)")
check(f'Playbook "{name}" was used' in integrate, "team_integrate asked for the lessons of this run")
meta = json.load(open(f"{pb}/playbook.json"))
check(meta["uses"] and meta["uses"][-1]["outcome"] == "gate passed", f"the use is recorded: {meta['uses']}")
check(meta["log"], f"the lead applied changes: {[(l['op'], l['id']) for l in meta['log']]}")
check(check_status == "0", "ptk playbooks check passes after the changes")
retired = open(f"{pb}/references/retired.md").read() if __import__("os").path.exists(f"{pb}/references/retired.md") else ""
ids = re.findall(r"\(([a-z]\d+)(?:, \d+x)?\)$", first, re.M)
lost = [i for i in ids if f"({i}" not in now and f" {i}:" not in retired]
check(not lost, f"nothing lost: every original item is still there or listed in retired.md ({len(ids)} items, lost {lost})")
sys.exit(0 if ok else 1)
PY
status=$?
say "scratch kept for inspection: $ROOT"
[ $status -eq 0 ] && printf '\033[1;32mPASS\033[0m e2e playbook (%ss)\n' "$elapsed"
exit $status
