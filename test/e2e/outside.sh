#!/usr/bin/env bash
# End-to-end check: pi started in a folder that is not a git repository (like the home folder on a company
# machine) runs /team on a project elsewhere. Costs a few cents, a few minutes. Needs pi, tmux, python3, git.
#   test/e2e/outside.sh
# Asserts: team_run worked with repo=<project>; the gate was detected from the project (not the session
# folder); the lanes ran in worktrees of the project and were integrated there; the takeover record is the
# project's; nothing was written to the session folder.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/../.." && pwd)"
ROOT="${PTK_E2E_OUTSIDE_DIR:-$HOME/code/ptk-e2e-outside}"
HOMEDIR="$ROOT/home" REPO="$ROOT/hostapp-test"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-20}"
T="ptk-e2e-outside-$$"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_OUTSIDE_DIR"
  for w in $(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep pi-worktree || true); do git -C "$REPO" worktree remove --force "$w" || true; done
  rm -rf "$ROOT"
fi
mkdir -p "$HOMEDIR" "$REPO"
touch "$ROOT/.ptk-e2e"
git -C "$HOMEDIR" rev-parse --git-dir >/dev/null 2>&1 && fail "$HOMEDIR is inside a git repository; set PTK_E2E_OUTSIDE_DIR elsewhere"
cp "$KIT"/examples/demo-repo/* "$REPO/"
printf '__pycache__/\n.pi/subagents/\n' > "$REPO/.gitignore"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture

key() { printf -- '--%s--' "$(printf '%s' "$1" | sed 's#^/##; s#/#-#g')"; }
STARTED="$(mktemp)"
trap 'tmux kill-session -t "$T" 2>/dev/null || true' EXIT

say "pi in $HOMEDIR (not a repository), project in $REPO"
tmux new-session -d -s "$T" -x 200 -y 50 -c "$HOMEDIR" "pi -a"
for _ in $(seq 1 60); do tmux capture-pane -t "$T" -p | grep -q "ptk:" && break; sleep 1; done
tmux send-keys -t "$T" -l "/team In the git repository at $REPO, fix the division-by-zero TODO in calc.py (raise ValueError(\"division by zero\")) with a test in test_calc.py. Done when python3 -m unittest -q passes there. Out of scope: the other TODO and any other file. Everything is decided: do not ask me anything, go straight to team_run."
sleep 1
tmux send-keys -t "$T" Enter
start=$(date +%s)

say "waiting for the run (the brief dialog is confirmed like a person would)"
deadline=$((start + TIMEOUT_MIN * 60))
SESS=""
while :; do
  [ "$(date +%s)" -lt "$deadline" ] || { tmux capture-pane -t "$T" -p | tail -30; fail "timed out"; }
  if tmux capture-pane -t "$T" -p | grep -q "Start this team run?"; then tmux send-keys -t "$T" Enter; sleep 2; fi
  SESS="$(find "$AGENT/sessions/$(key "$HOMEDIR")" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1)"
  if [ -n "$SESS" ] && python3 - "$SESS" <<'PY'
import json, sys
after = done = False
for line in open(sys.argv[1]):
    m = (json.loads(line).get("message") or {})
    if m.get("role") == "toolResult" and m.get("toolName") == "team_integrate": after = True
    if after and m.get("role") == "assistant" and any(p.get("type") == "text" and p.get("text", "").strip() for p in m.get("content") or []) and not any(p.get("type") == "toolCall" for p in m.get("content") or []): done = True
sys.exit(0 if done else 1)
PY
  then break; fi
  sleep 5
done
elapsed=$(( $(date +%s) - start ))

say "checking results"
set +e
python3 - "$SESS" "$REPO" "$HOMEDIR" "$AGENT" <<'PY'
import hashlib, json, os, re, subprocess, sys
sess, repo, homedir, agent = sys.argv[1:]
ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok = ok and cond
runs, results, integrate, value = [], {}, "", None
for line in open(sess):
    e = json.loads(line); m = e.get("message") or {}
    for p in (m.get("content") or []) if isinstance(m.get("content"), list) else []:
        if p.get("type") == "toolCall" and p.get("name") == "team_run": runs.append((p.get("id"), p.get("arguments") or {}))
    if m.get("role") == "toolResult" and m.get("toolName") == "team_run": results[m.get("toolCallId")] = (m.get("isError"), " ".join(x.get("text", "") for x in m.get("content") or []))
    if m.get("role") == "toolResult" and m.get("toolName") == "team_integrate": integrate = " ".join(x.get("text", "") for x in m.get("content") or [])
    if e.get("type") == "custom_message":
        r = re.search(r"Workflow receipt:\s*(.+?)/workflow-receipt\.json", str(e.get("content")))
        if r:
            try: value = json.load(open(r.group(1) + "/status.json"))["workflow"]["value"]
            except Exception: pass
started = [(a, results.get(i, (True, ""))) for i, a in runs if not results.get(i, (True, ""))[0]]
refused = [results.get(i, (False, ""))[1] for i, a in runs if results.get(i, (False, ""))[0]]
for msg in refused: print("       refused first:", msg[:160])
check(started and os.path.realpath(os.path.expanduser(started[-1][0].get("repo", ""))) == os.path.realpath(repo), f"team_run ran with repo = the project: {[a.get('repo') for a, _ in started]}")
check(started and "gate `python3 -m unittest -q`" in started[-1][1][1], "the gate was detected from the project, not the session folder")
check(started and f"Repository: {repo}" in started[-1][1][1], "the result names the project's repository")
lanes = (value or {}).get("lanes") or []
check(lanes and all(l["state"] == "passed" for l in lanes), f"lanes passed: {[(l['lane'], l['state'], l['rounds']) for l in lanes]}")
check("applied" in integrate and "PASSED" in integrate, "team_integrate applied the lanes to the project and the gate passed")
changed = subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout
check("calc.py" in changed, f"the project has the changes: {changed.split()}")
t = subprocess.run(["python3", "-m", "unittest", "-q"], cwd=repo, capture_output=True, text=True)
check(t.returncode == 0, "the project's tests pass")
wt = subprocess.run(["git", "-C", repo, "worktree", "list"], capture_output=True, text=True).stdout.strip().split("\n")
check(len(wt) == 1, f"no worker worktrees left ({len(wt) - 1} extra)")
name = re.sub(r"[^A-Za-z0-9._-]+", "-", os.path.basename(repo))[:40]
lead = f"{agent}/ptk/leads/{name}-{hashlib.sha256(repo.encode()).hexdigest()[:10]}.json"
try:
    st = json.load(open(lead)); check(st["runs"][-1]["status"] == "integrated", "the takeover record (/continue <repo>) belongs to the project")
except Exception as err:
    check(False, f"the takeover record belongs to the project ({err})")
check(os.listdir(homedir) == [], f"nothing was written to the session folder: {os.listdir(homedir)}")
sys.exit(0 if ok else 1)
PY
status=$?
say "scratch kept for inspection: $ROOT"
[ $status -eq 0 ] && printf '\033[1;32mPASS\033[0m e2e outside (%ss)\n' "$elapsed"
exit $status
