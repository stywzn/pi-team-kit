#!/usr/bin/env bash
# End-to-end check of a real team run, including one forced rework round.
# Costs a few cents of model usage. Needs: pi with pi-subagents + pi-team-kit installed and a model logged in, tmux, python3.
#
#   test/e2e/rework.sh                          # uses the main session's model everywhere
#   PTK_E2E_WORKER_MODEL=deepseek/deepseek-flash test/e2e/rework.sh
#
# Asserts: the planner split the goal; every lane passed; at least one lane went through rework (rounds >= 2);
# the integrated code contains the rework; the combined tests pass; no worker worktrees are left behind.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/../.." && pwd)"
DIR="${PTK_E2E_DIR:-$HOME/code/ptk-e2e}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-20}"
SESSION="ptk-e2e-$$"
MARK="# reviewed-by: team-verifier"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }

for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

# Fresh scratch repo. Only ever delete a directory this script created.
if [ -e "$DIR" ]; then
  [ -f "$DIR/.ptk-e2e" ] || fail "$DIR exists and was not created by this script; set PTK_E2E_DIR"
  for w in $(git -C "$DIR" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep pi-worktree || true); do git -C "$DIR" worktree remove --force "$w" || true; done
  rm -rf "$DIR"
fi
mkdir -p "$DIR/.pi/agents"
cp "$KIT"/examples/demo-repo/* "$DIR/"
cp "$HERE/strict-verifier.md" "$DIR/.pi/agents/team-verifier.md"
# confirm=false: nobody is at the keyboard to answer the brief dialog in this test
printf '{ "team": { "confirm": false, "models": { "worker": "%s" } } }\n' "${PTK_E2E_WORKER_MODEL:-}" > "$DIR/.pi/ptk.json"
printf '__pycache__/\n.pi/subagents/\n' > "$DIR/.gitignore"
touch "$DIR/.ptk-e2e"
git -C "$DIR" init -q -b main
git -C "$DIR" add -A
git -C "$DIR" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m "e2e fixture"

key="--$(printf '%s' "$DIR" | sed 's#^/##; s#/#-#g')--"
SESS_DIR="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}/sessions/$key"
STARTED="$(mktemp)"   # only session files newer than this belong to this run

GOAL='Fix the two TODOs in calc.py (division by zero raises ValueError("division by zero"); main() prints usage to stderr and returns 2 on a wrong argument count) with tests in test_calc.py, and add stats.py with mean(xs) and median(xs) (ValueError on an empty list) plus test_stats.py. Done when python3 -m unittest -q passes. Out of scope: any other file. Do not pass tasks: let the team-planner split the work. Everything is decided: do not ask me anything, go straight to team_run.'

say "starting pi in tmux ($SESSION) in $DIR"
tmux new-session -d -s "$SESSION" -x 200 -y 50 -c "$DIR" "pi -a"
trap 'tmux kill-session -t "$SESSION" 2>/dev/null || true; rm -f "$STARTED"' EXIT
for _ in $(seq 1 60); do tmux capture-pane -t "$SESSION" -p | grep -q "ptk:" && break; sleep 1; done
tmux send-keys -t "$SESSION" -l "/team $GOAL"
sleep 1
tmux send-keys -t "$SESSION" Enter
start=$(date +%s)

say "waiting for the run to finish (max ${TIMEOUT_MIN} min)"
deadline=$((start + TIMEOUT_MIN * 60))
SESS=""
while :; do
  [ "$(date +%s)" -lt "$deadline" ] || { tmux capture-pane -t "$SESSION" -p | tail -30; fail "timed out"; }
  SESS="$(find "$SESS_DIR" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1)"
  if [ -n "$SESS" ] && python3 - "$SESS" <<'PY'
import json, sys
done = False; after = False
for line in open(sys.argv[1]):
    m = (json.loads(line).get("message") or {})
    if m.get("role") == "toolResult" and m.get("toolName") == "team_integrate": after = True
    if after and m.get("role") == "assistant" and any(p.get("type") == "text" and p.get("text", "").strip() for p in m.get("content") or []): done = True
sys.exit(0 if done else 1)
PY
  then break; fi
  sleep 5
done
elapsed=$(( $(date +%s) - start ))
say "run finished in ${elapsed}s; checking results"

set +e
python3 - "$SESS" "$DIR" "$MARK" <<'PY'
import json, re, subprocess, sys
sess, repo, mark = sys.argv[1:]
ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok = ok and cond
value = None; integrate = ""; calls = []; notified = False
for line in open(sess):
    e = json.loads(line); m = e.get("message") or {}
    for p in (m.get("content") or []) if isinstance(m.get("content"), list) else []:
        if p.get("type") == "toolCall": calls.append(p.get("name"))
    if e.get("type") == "custom_message" and "Background task completed" in str(e.get("content")):
        # The notice holds a possibly truncated return value; the full one is in the run's status.json.
        notified = True
        rec = re.search(r"(/\S+)/workflow-receipt\.json", str(e.get("content")))
        if rec:
            try: value = json.load(open(rec.group(1) + "/status.json"))["workflow"]["value"]
            except Exception as err: print("  note cannot read status.json:", err)
    text = m.get("content") if isinstance(m.get("content"), str) else " ".join(p.get("text", "") for p in (m.get("content") or []) if isinstance(p, dict))
    if m.get("role") == "toolResult" and m.get("toolName") == "team_integrate": integrate = text
check("team_run" in calls, "main session called team_run")
check(notified and value is not None, "the run finished and woke the main session with its result")
value = value or {}
lanes = value.get("lanes") or []
plan = value.get("plan") or {}
check(len(plan.get("tasks") or []) >= 2, f"the team-planner split the goal: {[t['key'] for t in plan.get('tasks') or []]}")
check(lanes and all(l["state"] == "passed" for l in lanes), f"all lanes passed: {[(l['lane'], l['state']) for l in lanes]}")
check(any(l["rounds"] >= 2 for l in lanes), f"rework happened: rounds {[(l['lane'], l['rounds']) for l in lanes]}")
check("applied" in integrate and "PASSED" in integrate, "team_integrate applied the lanes and the combined gate passed")
changed = subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout.split("\n")
files = [l[3:].strip() for l in changed if l.strip() and l[3:].strip().endswith(".py")]
check(len(files) >= 3, f"integrated changes present: {files}")
marked = [f for f in files if open(f"{repo}/{f}").read().rstrip().endswith(mark)]
check(len(marked) == len(files) and files, f"rework content (review marker) reached the checkout: {len(marked)}/{len(files)} files")
wt = subprocess.run(["git", "-C", repo, "worktree", "list"], capture_output=True, text=True).stdout.strip().split("\n")
check(len(wt) == 1, f"no worker worktrees left ({len(wt) - 1} extra)")
t = subprocess.run(["python3", "-m", "unittest", "-q"], cwd=repo, capture_output=True, text=True)
check(t.returncode == 0, "combined tests pass: " + (t.stderr.strip().splitlines() or ["?"])[-1])
import hashlib, os
agent = os.environ.get("PI_CODING_AGENT_DIR") or os.path.expanduser("~/.pi/agent")
name = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.basename(repo))[:40]
lead = f"{agent}/ptk/leads/{name}-{hashlib.sha256(repo.encode()).hexdigest()[:10]}.json"
try:
    st = json.load(open(lead))
    check(st["brief"]["doneWhen"] and st["runs"][-1]["status"] == "integrated", f"takeover record written for /continue (last run {st['runs'][-1]['status']})")
except Exception as err:
    check(False, f"takeover record written for /continue ({err})")
sys.exit(0 if ok else 1)
PY
status=$?
say "scratch repo kept for inspection: $DIR"
[ $status -eq 0 ] && printf '\033[1;32mPASS\033[0m e2e rework run (%ss)\n' "$elapsed"
exit $status
