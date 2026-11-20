#!/usr/bin/env bash
# Nested workers with real pi in tmux: one lane whose worker splits its task into sub-workers (subtasks tool)
# that work at the same time in its worktree. Costs a few cents, a few minutes. Needs pi, tmux, python3, git.
#   test/e2e/nested.sh
#   PTK_E2E_MODEL=<provider/model> test/e2e/nested.sh
# Asserts: the worker called subtasks; two or more team-subworker runs finished, with the 2-hour deadline and the
# hand-off before it; the lane passed review; every module and its test is in the checkout and the tests pass.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="${PTK_E2E_NESTED_DIR:-$HOME/code/ptk-e2e-nested}"
REPO="$ROOT/app"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${PTK_E2E_MODEL:-deepseek/deepseek-flash}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-25}"
T="ptk-e2e-nested-$$"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_NESTED_DIR"
  for w in $(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep pi-worktree || true); do git -C "$REPO" worktree remove --force "$w" || true; done
  rm -rf "$ROOT"
fi
mkdir -p "$REPO/.pi" "$REPO/shapes" "$REPO/tests"
touch "$ROOT/.ptk-e2e" "$REPO/shapes/__init__.py" "$REPO/tests/__init__.py"
printf '# shapes\nArea functions, one module per shape. Tests: python3 -m unittest discover -s tests -t . -q\n' > "$REPO/README.md"
printf '__pycache__/\n.pi/subagents/\n' > "$REPO/.gitignore"
printf '{ "team": { "confirm": false } }\n' > "$REPO/.pi/ptk.json"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture

key() { printf -- '--%s--' "$(printf '%s' "$1" | sed 's#^/##; s#/#-#g')"; }
STARTED="$(mktemp)"
trap 'tmux kill-session -t "$T" 2>/dev/null || true' EXIT
sess() { find "$AGENT/sessions/$(key "$REPO")" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1; }
type_in() { tmux send-keys -t "$T" -l "$1"; sleep 1; tmux send-keys -t "$T" Enter; }
wait_tool() {
  local deadline=$(( $(date +%s) + $2 ))
  say "waiting: $1"
  until [ -n "$(sess)" ] && python3 - "$(sess)" "$3" "$4" <<'PY'
import json, sys
f, tool, needle = sys.argv[1:]
hits = 0; settled = False
for line in open(f):
    m = (json.loads(line).get("message") or {})
    if m.get("role") == "toolResult" and m.get("toolName") == tool and needle in json.dumps(m.get("content")): hits += 1; settled = False
    if hits and m.get("role") == "assistant" and any(p.get("type") == "text" and p.get("text", "").strip() for p in m.get("content") or []) and not any(p.get("type") == "toolCall" for p in m.get("content") or []): settled = True
sys.exit(0 if hits and settled else 1)
PY
  do
    [ "$(date +%s)" -lt "$deadline" ] || { tmux capture-pane -t "$T" -p | tail -25; fail "timed out: $1"; }
    sleep 5
  done
}

say "pi in $REPO (lead model $MODEL)"
tmux new-session -d -s "$T" -x 200 -y 50 -c "$REPO" "pi -a --model $MODEL"
for _ in $(seq 1 60); do tmux capture-pane -t "$T" -p | grep -q "ptk:" && break; sleep 1; done
start=$(date +%s)
type_in '/team Add three shape modules, each with a function area(...) and a unittest file: shapes/square.py area(side), shapes/circle.py area(r) using math.pi, shapes/triangle.py area(base, height). Tests: tests/test_square.py, tests/test_circle.py, tests/test_triangle.py, each with two assertEqual/assertAlmostEqual checks. Done when python3 -m unittest discover -s tests -t . -q passes. Pass tasks yourself: exactly ONE task, key "shapes", files ["shapes/", "tests/"], whose brief tells the worker to split the work with its subtasks tool into three parts (one per shape, each owning its module and its test file) and then run the tests itself. Gate: python3 -m unittest discover -s tests -t . -q. Everything is decided: do not ask me anything, go straight to team_run.'
wait_tool "the team run is integrated and reported" $((TIMEOUT_MIN * 60)) team_integrate "applied"
elapsed=$(( $(date +%s) - start ))

say "checking results"
set +e
python3 - "$(sess)" "$REPO" "$STARTED" <<'PY'
import glob, json, os, re, subprocess, sys
sess, repo, started = sys.argv[1:]
since = os.path.getmtime(started)
ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok = ok and cond
value, run_dir = None, None
for line in open(sess):
    e = json.loads(line)
    if e.get("type") == "custom_message":
        r = re.search(r"Workflow receipt:\s*(.+?)/workflow-receipt\.json", str(e.get("content")))
        if r:
            run_dir = r.group(1)
            try: value = json.load(open(run_dir + "/status.json"))["workflow"]["value"]
            except Exception: pass
lanes = (value or {}).get("lanes") or []
check(len(lanes) == 1 and lanes[0]["state"] == "passed", f"one lane, passed: {[(l['lane'], l['state'], l['rounds']) for l in lanes]}")
base = os.path.dirname(run_dir) if run_dir else ""
subtasks, launches, waits = [], {}, 0
for st in glob.glob(os.path.join(base, "*", "status.json")):
    if os.path.getmtime(st) < since: continue
    try: s = json.load(open(st))
    except Exception: continue
    for step in s.get("steps") or []:
        if step.get("agent") != "team-worker" or not step.get("sessionFile") or not os.path.exists(step["sessionFile"]): continue
        for line in open(step["sessionFile"]):
            m = (json.loads(line).get("message") or {})
            for p in m.get("content") or [] if isinstance(m.get("content"), list) else []:
                if p.get("type") != "toolCall": continue
                a = p.get("arguments") or {}
                if p.get("name") == "subtasks": subtasks.append(a)
                if p.get("name") == "subagent" and a.get("agent") == "team-subworker": launches[p.get("id")] = None
                if p.get("name") == "bg_wait": waits += 1
            if m.get("role") == "toolResult" and m.get("toolCallId") in launches: launches[m["toolCallId"]] = not m.get("isError")
check(subtasks, f"the worker had its parts approved by subtasks ({len(subtasks)} time(s), parts {[len(a.get('parts') or []) for a in subtasks]})")
started = [k for k, v in launches.items() if v]
check(len(started) >= 2, f"it started two or more sub-workers with subagent: {list(launches.values())}")
check(waits >= 1, "and waited for them with bg_wait")
# pi-subagents keeps nested runs under <temp root>/nested-subagent-runs/<root run>/<run>/.
nested_root = os.path.join(os.path.dirname(base), "nested-subagent-runs")
subs, limits, cwds = [], set(), set()
for f in glob.glob(os.path.join(nested_root, "*", "**", "*.json"), recursive=True):
    if os.path.getmtime(f) < since: continue
    t = open(f, errors="replace").read()
    if "team-subworker" not in t: continue
    for v in re.findall(r'"timeoutMs":\s*(\d+)', t): limits.add(int(v))
    if os.path.basename(f) != "status.json": continue
    s = json.loads(t)
    for step in s.get("steps") or []:
        if step.get("agent") == "team-subworker": subs.append(step.get("status")); cwds.add(s.get("cwd", ""))
check(sum(1 for x in subs if x in ("complete", "completed")) >= 2, f"two or more sub-workers finished: {subs}")
check(7200000 in limits, f"they had the 2-hour deadline: {sorted(limits)}")
check(len(cwds) == 1 and "pi-worktree" in next(iter(cwds), ""), f"they worked in the worker's own worktree: {cwds}")
for f in ["shapes/square.py", "shapes/circle.py", "shapes/triangle.py", "tests/test_square.py", "tests/test_circle.py", "tests/test_triangle.py"]:
    check(os.path.exists(os.path.join(repo, f)), f"{f} is in the checkout")
r = subprocess.run(["python3", "-m", "unittest", "discover", "-s", "tests", "-t", ".", "-q"], cwd=repo, capture_output=True, text=True)
check(r.returncode == 0, "the tests pass: " + (r.stderr.strip().splitlines() or [""])[-1])
sys.exit(0 if ok else 1)
PY
rc=$?
set -e
say "scratch kept for inspection: $ROOT"
[ "$rc" -eq 0 ] || fail "e2e nested (${elapsed}s)"
printf '\033[1;32mPASS\033[0m e2e nested (%ss)\n' "$elapsed"
