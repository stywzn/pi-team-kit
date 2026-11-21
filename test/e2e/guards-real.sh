#!/usr/bin/env bash
# Batch-1 guards with real pi in tmux (costs a few cents, 10-20 minutes). Needs pi, tmux, python3, git.
#   test/e2e/guards-real.sh
#   PTK_E2E_MODEL=<provider/model> test/e2e/guards-real.sh
# A: the tests already fail on the unchanged code because a service is down -> the baseline gate stops the run before
#    any worker starts, the lead is told it is an environment problem, and the empty run branch is removed.
# B: a normal two-lane run. Asked mid-run to edit the checkout itself, the lead is refused (lead lock); the run holds
#    leases on its files; a worker's discovery reaches the lead; after integration the lead's own code change is checked.
set -euo pipefail

ROOT="${PTK_E2E_GUARDS_DIR:-$HOME/code/ptk-e2e-guards-real}"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${PTK_E2E_MODEL:-deepseek/deepseek-flash}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-30}"
T="ptk-e2e-guards-$$"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_GUARDS_DIR"
  for r in "$ROOT"/*/; do
    for w in $(git -C "$r" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep -v "^${r%/}\$" || true); do git -C "$r" worktree remove --force "$w" || true; done
  done
  rm -rf "$ROOT"
fi
mkdir -p "$ROOT"
touch "$ROOT/.ptk-e2e"
key() { printf -- '--%s--' "$(printf '%s' "$1" | sed 's#^/##; s#/#-#g')"; }
trap 'tmux kill-session -t "$T" 2>/dev/null || true' EXIT
type_in() { tmux send-keys -t "$T" -l "$1"; sleep 1; tmux send-keys -t "$T" Enter; }
fixture() { # $1 repo dir
  mkdir -p "$1/.pi"
  printf '__pycache__/\n.pi/subagents/\n' > "$1/.gitignore"
  printf '{ "team": { "confirm": false } }\n' > "$1/.pi/ptk.json"
  printf 'import unittest\n\n\nclass Smoke(unittest.TestCase):\n    def test_true(self):\n        self.assertTrue(True)\n' > "$1/test_smoke.py"
}
commit() { git -C "$1" init -q -b main; git -C "$1" add -A; git -C "$1" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture; }
# wait_for <what> <seconds> <session-file-glob-dir> <python condition reading the session file as sys.argv[1]>
wait_for() {
  local what="$1" secs="$2" dir="$3" cond="$4" deadline=$(( $(date +%s) + $2 ))
  say "waiting: $what"
  until f=$(find "$dir" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1) && [ -n "$f" ] && python3 -c "$cond" "$f"; do
    [ "$(date +%s)" -lt "$deadline" ] || { tmux capture-pane -t "$T" -p | tail -30; fail "timed out: $what"; }
    sleep 5
  done
}
PYLIB='
import json, sys
E = [json.loads(l) for l in open(sys.argv[1])]
def msgs(): return [e.get("message") or {} for e in E]
def custom(t): return [str(e.get("content")) for e in E if e.get("type") == "custom_message" and e.get("customType") == t]
def results(tool): return [json.dumps(m.get("content")) for m in msgs() if m.get("role") == "toolResult" and m.get("toolName") == tool]
def settled():
    last = [m for m in msgs() if m.get("role") == "assistant"]
    return bool(last) and not any(p.get("type") == "toolCall" for p in last[-1].get("content") or []) and any(p.get("type") == "text" and p.get("text", "").strip() for p in last[-1].get("content") or [])
'

# ---------------- A: the gate already fails on the unchanged code ----------------
A="$ROOT/broken"
fixture "$A"
# The service the test needs is down: a port that was free a moment ago, so nothing listens there.
printf 'import socket\nimport unittest\n\n\nclass Db(unittest.TestCase):\n    def test_db(self):\n        s = socket.socket()\n        s.bind(("127.0.0.1", 0))\n        port = s.getsockname()[1]\n        s.close()\n        socket.create_connection(("127.0.0.1", port), timeout=2).close()\n' > "$A/test_db.py"
printf '# broken\nTests: python3 -m unittest -q (test_db needs the database service)\n' > "$A/README.md"
commit "$A"
STARTED="$(mktemp)"
say "A: pi in $A (model $MODEL)"
tmux new-session -d -s "$T" -x 200 -y 50 -c "$A" "pi -a --model $MODEL"
for _ in $(seq 1 60); do tmux capture-pane -t "$T" -p | grep -q "ptk:" && break; sleep 1; done
type_in '/team One task; pass it yourself to team_run, exactly this (test_db.py is not part of this task): key "greet", files ["greet.py", "test_greet.py"]: create greet.py with hello(name) returning "hello <name>", and test_greet.py checking hello("a") == "hello a"; verify: python3 -m unittest -q test_greet -> OK. Gate: python3 -m unittest -q. Do not ask me anything; go straight to team_run. When the run reports back, tell me in two lines what happened and stop.'
wait_for "A: the run reports back" $((TIMEOUT_MIN * 60)) "$AGENT/sessions/$(key "$A")" "$PYLIB
sys.exit(0 if custom('ptk-run-report') and settled() else 1)"
set +e
python3 - "$(find "$AGENT/sessions/$(key "$A")" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" | head -1)" "$A" "$AGENT" <<'PY'
import glob, json, os, re, subprocess, sys
f, repo, agent = sys.argv[1:]
E = [json.loads(l) for l in open(f)]
ok = True
def check(c, m):
    global ok
    print(("  ok   " if c else "  FAIL ") + m); ok = ok and bool(c)
reports = [str(e.get("content")) for e in E if e.get("type") == "custom_message" and e.get("customType") == "ptk-run-report"]
check(any("started no worker" in r and "environment problem" in r for r in reports), "the lead is told no worker started, and that it looks like the environment")
value, steps = None, []
for e in E:
    if e.get("type") == "custom_message":
        r = re.search(r"Workflow receipt:\s*(.+?)/workflow-receipt\.json", str(e.get("content")))
        if r:
            st = json.load(open(r.group(1) + "/status.json")); value = st["workflow"]["value"]; steps = st.get("steps") or []
check((value or {}).get("state") == "baseline-failed", f"the run ended as baseline-failed: {(value or {}).get('state')}")
check(not any(s.get("agent") == "team-worker" for s in steps), f"no worker ran: {[s.get('agent') for s in steps]}")
left = subprocess.run(["git", "branch", "--list", "ptk/run-*"], cwd=repo, capture_output=True, text=True).stdout.strip()
check(not left, f"the empty run branch was removed: {left!r}")
leads = glob.glob(os.path.join(agent, "ptk", "leads", "broken-*.json"))
st = json.load(open(leads[0])) if leads else {}
check((st.get("runs") or [{}])[-1].get("status") == "ended", f"the lead state records the run as ended: {(st.get('runs') or [{}])[-1].get('status')}")
sys.exit(0 if ok else 1)
PY
rcA=$?
set -e
tmux kill-session -t "$T" 2>/dev/null || true

# ---------------- B: a normal run: lead lock, leases, discoveries, the lead's own check ----------------
B="$ROOT/numbers"
fixture "$B"
printf '# numbers\nSmall number helpers. Tests: python3 -m unittest -q\n' > "$B/README.md"
commit "$B"
STARTED="$(mktemp)"
S="$AGENT/sessions/$(key "$B")"
say "B: pi in $B"
tmux new-session -d -s "$T" -x 200 -y 50 -c "$B" "pi -a --model $MODEL"
for _ in $(seq 1 60); do tmux capture-pane -t "$T" -p | grep -q "ptk:" && break; sleep 1; done
start=$(date +%s)
LEASEWATCH="$(mktemp)"
( for _ in $(seq 1 600); do python3 - "$AGENT" >> "$LEASEWATCH" <<'PY'
import glob, json, os, sys
for f in glob.glob(os.path.join(sys.argv[1], "ptk", "board", "leases", "*.json")):
    try: l = json.load(open(f))
    except Exception: continue
    if l.get("kind") == "team-run" and (l.get("checkout", "").rstrip("/").endswith("/numbers") or "stats.py" in l.get("paths", [])): print(",".join(l["paths"]))
PY
  sleep 1; done ) &
WATCHER=$!
type_in '/team Two tasks; pass them yourself to team_run, exactly these. (1) key "stats", files ["stats.py", "test_stats.py"]: create stats.py with mean(xs) (ValueError("empty") on an empty list) and test_stats.py with unittest checks for [1, 2, 3] -> 2 and the empty case; in your report under Discoveries write the output of python3 --version; verify: python3 -m unittest -q test_stats -> OK. (2) key "clamp", files ["clamp.py", "test_clamp.py"]: create clamp.py with clamp(x, lo, hi) and test_clamp.py checking clamp(5, 0, 3) == 3; verify: python3 -m unittest -q test_clamp -> OK. Gate: python3 -m unittest -q. Do not ask me anything; go straight to team_run. Right after team_run returns (the run goes on in the background), append the line "lead was here" to README.md yourself with your edit tool and tell me in one line whether it worked. Then wait for the run; when it finishes call team_integrate, commit the result with git (message "team run"), and report.'
wait_for "B: integrated" $((TIMEOUT_MIN * 60)) "$S" "$PYLIB
sys.exit(0 if any('applied' in r for r in results('team_integrate')) and settled() else 1)"
kill "$WATCHER" 2>/dev/null || true
LEASES="$(sort -u "$LEASEWATCH" | tr '\n' '|')"
say "leases seen while the run was going: $LEASES"
# whether the lead's edit of README.md went through before team_integrate (it must not)
README_DURING="$(python3 - "$(find "$S" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" | head -1)" <<'PY'
import json, sys
E = [json.loads(l) for l in open(sys.argv[1])]
first_integrate = next((i for i, e in enumerate(E) if (e.get("message") or {}).get("role") == "toolResult" and (e.get("message") or {}).get("toolName") == "team_integrate"), len(E))
# an edit of README.md that went through before team_integrate would show as a successful edit result
for e in E[:first_integrate]:
    m = e.get("message") or {}
    if m.get("role") == "toolResult" and m.get("toolName") in ("edit", "write") and not m.get("isError") and "README.md" in json.dumps(m.get("content")): print("lead was here (edited before integration)")
PY
)"
type_in 'Now add to stats.py a function median(xs) returning the median of a non-empty list. Keep it short; no new test file needed.'
wait_for "B: the lead changed stats.py and finished" 900 "$S" "$PYLIB
edits = [i for i, m in enumerate(msgs()) if m.get('role') == 'toolResult' and m.get('toolName') in ('edit', 'write') and 'median' in json.dumps(E[i])]
sys.exit(0 if any('def median' in open(sys.argv[1]).read() for _ in [0]) and settled() else 1)"
elapsed=$(( $(date +%s) - start ))
set +e
python3 - "$(find "$S" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" | head -1)" "$B" "$LEASES" "$README_DURING" <<'PY'
import json, re, subprocess, sys
f, repo, leases, readme_during = sys.argv[1:]
E = [json.loads(l) for l in open(f)]
ok = True
def check(c, m):
    global ok
    print(("  ok   " if c else "  FAIL ") + m); ok = ok and bool(c)
check("**" in leases and "stats.py" in leases, f"the run held leases on its checkout and its files: {leases}")
blocked = [e for e in E if (e.get("message") or {}).get("role") == "toolResult" and "your team run is going" in json.dumps((e.get("message") or {}).get("content")).lower()]
check(blocked, "the lead's own edit of the checkout during its run was refused (or flagged)")
check("lead was here" not in readme_during, "README.md was unchanged while the run was going")
reports = " ".join(str(e.get("content")) for e in E if e.get("type") == "custom_message" and e.get("customType") == "ptk-run-report")
check(re.search(r"Workers' discoveries.*Python 3", reports, re.S), "the worker's discovery (python version) reached the lead")
# the lead's own change after integration: checked, by itself or after the self-check message
idx = [i for i, e in enumerate(E) if (e.get("message") or {}).get("role") == "toolResult" and (e.get("message") or {}).get("toolName") in ("edit", "write") and "stats.py" in json.dumps(e)]
last_edit = idx[-1] if idx else None
calls = [(i, p) for i, e in enumerate(E) if (e.get("message") or {}).get("role") == "assistant" for p in ((e.get("message") or {}).get("content") or []) if p.get("type") == "toolCall" and p.get("name") == "bash"]
checks_after = [i for i, p in calls if last_edit is not None and i > last_edit and re.search(r"unittest|pytest|py_compile", json.dumps(p.get("arguments") or {}))]
nudged = [e for e in E if e.get("type") == "custom_message" and e.get("customType") == "ptk-self-check"]
check(last_edit is not None and checks_after, f"the lead checked its own change to stats.py ({'after the self-check message' if nudged else 'by itself'})")
r = subprocess.run(["python3", "-m", "unittest", "-q"], cwd=repo, capture_output=True, text=True)
check(r.returncode == 0, "the tests pass in the checkout")
left = subprocess.run(["git", "branch", "--list", "ptk/run-*"], cwd=repo, capture_output=True, text=True).stdout.strip()
check(not left, "no run branch left")
sys.exit(0 if ok else 1)
PY
rcB=$?
set -e
say "scratch kept for inspection: $ROOT"
[ "$rcA" -eq 0 ] && [ "$rcB" -eq 0 ] || fail "e2e guards-real (${elapsed}s)"
printf '\033[1;32mPASS\033[0m e2e guards-real (%ss)\n' "$elapsed"
