#!/usr/bin/env bash
# End-to-end check of the speed-ups with real pi in tmux. Costs a few cents, a few minutes. Needs pi, tmux, python3, git.
#   test/e2e/speed.sh                         # lead on deepseek/deepseek-flash; team roles from your ptk.json
#   PTK_E2E_MODEL=<provider/model> test/e2e/speed.sh
# The project has a virtualenv and an ignored .env, and a test that fails unless both are there, so a lane
# passes only if its worktree was prepared and the combined gate passes only if the lead used the virtualenv too.
# Asserts: the reader runs once, its digest is reused the second time and handed to the team; each lane ran
# only its own tests; planner/verifier think at max and workers at high; .env never reaches the patch;
# /team-thinking changes this session only.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
KIT="$(cd "$HERE/../.." && pwd)"
ROOT="${PTK_E2E_SPEED_DIR:-$HOME/code/ptk-e2e-speed}"
REPO="$ROOT/app"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${PTK_E2E_MODEL:-deepseek/deepseek-flash}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-20}"
T="ptk-e2e-speed-$$"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_SPEED_DIR"
  for w in $(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep pi-worktree || true); do git -C "$REPO" worktree remove --force "$w" || true; done
  rm -rf "$ROOT"
fi
mkdir -p "$REPO/.pi"
touch "$ROOT/.ptk-e2e"
cp "$KIT"/examples/demo-repo/* "$REPO/"
cat >> "$REPO/test_calc.py" <<'EOF'


import os
import sys


class ProjectEnvTest(unittest.TestCase):
    def test_runs_in_the_project_virtualenv_with_its_env_file(self):
        self.assertNotEqual(sys.prefix, sys.base_prefix, "tests must run inside the project's virtualenv")
        self.assertTrue(os.path.exists(".env"), "the local .env must be present")
EOF
printf '__pycache__/\n.pi/subagents/\n.venv/\n.env\n' > "$REPO/.gitignore"
printf '{ "team": { "confirm": false } }\n' > "$REPO/.pi/ptk.json"
git -C "$REPO" init -q -b main
git -C "$REPO" add -A
git -C "$REPO" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture
printf 'BASE_URL=http://localhost:8080\n' > "$REPO/.env"
python3 -m venv --without-pip "$REPO/.venv"

# Digests of an earlier run of this script would be found again for the same folder: start clean.
python3 - "$AGENT/ptk/digests" "$REPO" <<PY2
import glob, json, os, sys
d, repo = sys.argv[1:]
for f in glob.glob(os.path.join(d, "*.json")):
    try:
        if json.load(open(f)).get("root") == repo:
            os.remove(f); md = f[:-5] + ".md"
            if os.path.exists(md): os.remove(md)
    except Exception: pass
PY2

key() { printf -- '--%s--' "$(printf '%s' "$1" | sed 's#^/##; s#/#-#g')"; }
STARTED="$(mktemp)"
trap 'tmux kill-session -t "$T" 2>/dev/null || true' EXIT
sess() { find "$AGENT/sessions/$(key "$REPO")" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1; }
type_in() { tmux send-keys -t "$T" -l "$1"; sleep 1; tmux send-keys -t "$T" Enter; }
# wait_tool <description> <seconds> <tool> <text the result contains> <minimum count>
wait_tool() {
  local deadline=$(( $(date +%s) + $2 ))
  say "waiting: $1"
  until [ -n "$(sess)" ] && python3 - "$(sess)" "$3" "$4" "$5" <<'PY'
import json, sys
f, tool, needle, n = sys.argv[1], sys.argv[2], sys.argv[3], int(sys.argv[4])
hits = 0; settled = False
for line in open(f):
    m = (json.loads(line).get("message") or {})
    if m.get("role") == "toolResult" and m.get("toolName") == tool and needle in json.dumps(m.get("content")): hits += 1; settled = False
    if hits >= n and m.get("role") == "assistant" and any(p.get("type") == "text" and p.get("text", "").strip() for p in m.get("content") or []) and not any(p.get("type") == "toolCall" for p in m.get("content") or []): settled = True
sys.exit(0 if hits >= n and settled else 1)
PY
  do
    [ "$(date +%s)" -lt "$deadline" ] || { tmux capture-pane -t "$T" -p | tail -25; fail "timed out: $1"; }
    sleep 4
  done
}

say "pi in $REPO (lead model $MODEL)"
tmux new-session -d -s "$T" -x 200 -y 50 -c "$REPO" "pi -a --model $MODEL"
for _ in $(seq 1 60); do tmux capture-pane -t "$T" -p | grep -q "ptk:" && break; sleep 1; done
start=$(date +%s)

type_in "让阅读 agent 看一下这个项目的测试约定（测试怎么跑、测试文件在哪、有什么特殊要求），提炼要点，主题就叫 test conventions。"
wait_tool "the reader reads once and its digest is saved" 420 digest "Saved reader digest" 1
type_in "test conventions 的要点是什么？用阅读 agent 之前的结果回答。"
wait_tool "the second time the saved digest is reused" 240 digest "source file(s) are unchanged" 1

type_in '/team Fix the division-by-zero TODO in calc.py (raise ValueError("division by zero")) with a test in test_calc.py. Done when python3 -m unittest -q passes. Out of scope: the other TODO and any other file. Hand the team the reader digest "test conventions". Do not pass a gate to team_run, the detected one is right. Everything is decided: do not ask me anything, go straight to team_run.'
wait_tool "the team run is integrated and reported" $((TIMEOUT_MIN * 60)) team_integrate "applied" 1

type_in "/team-thinking worker=medium"
sleep 5
elapsed=$(( $(date +%s) - start ))

say "checking results"
set +e
python3 - "$(sess)" "$REPO" <<'PY'
import glob, json, os, re, subprocess, sys
sess, repo = sys.argv[1:]
ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok = ok and cond
calls, results, entries, value, run_dir = [], [], [], None, None
for line in open(sess):
    e = json.loads(line); entries.append(e); m = e.get("message") or {}
    for p in (m.get("content") or []) if isinstance(m.get("content"), list) else []:
        if p.get("type") == "toolCall": calls.append((p.get("name"), p.get("arguments") or {}))
    if m.get("role") == "toolResult": results.append((m.get("toolName"), " ".join(x.get("text", "") for x in m.get("content") or [] if isinstance(x, dict))))
    if e.get("type") == "custom_message":
        r = re.search(r"Workflow receipt:\s*(.+?)/workflow-receipt\.json", str(e.get("content")))
        if r:
            run_dir = r.group(1)
            try: value = json.load(open(run_dir + "/status.json"))["workflow"]["value"]
            except Exception: pass
readers = [a for n, a in calls if n == "subagent" and a.get("agent") == "team-reader"]
check(len(readers) == 1, f"the reader ran exactly once ({len(readers)})")
check(any(n == "digest" and "source file(s) are unchanged" in t for n, t in results), "the second request reused the saved digest")
runs = [a for n, a in calls if n == "team_run"]
check(runs and any("test conventions" in " ".join(a.get("digests") or []) for a in runs), f"the digest was handed to the team: {[a.get('digests') for a in runs]}")
lanes = (value or {}).get("lanes") or []
check(lanes and all(l["state"] == "passed" for l in lanes), f"lanes passed (the worktree had the virtualenv and .env): {[(l['lane'], l['state'], l['rounds']) for l in lanes]}")
integ = [t for n, t in results if n == "team_integrate"]
check(integ and "PASSED" in integ[-1], "the combined gate passed in the lead too (virtualenv used there as well)")
roles, gates = {}, []
for line in open(run_dir + "/workflow-children.jsonl"):
    e = json.loads(line)
    if e.get("type") != "settle": continue
    rid = (e.get("result") or {}).get("runId")
    d = (e.get("result") or {}).get("asyncDir") or os.path.join(os.path.dirname(run_dir), rid)
    try:
        st = json.load(open(os.path.join(d, "status.json"))); s = (st.get("steps") or [{}])[0]
        roles[e["key"]] = s.get("thinking")
    except Exception: pass
    for f in glob.glob(os.path.join(d, "**", "*.json*"), recursive=True):
        try:
            if "unittest -q test_calc.py" in open(f).read(): gates.append(e["key"])
        except Exception: pass
print("       thinking per child:", roles)
check(roles.get("plan", "max") == "max" and any("-verify-" in k for k in roles) and all(v == "max" for k, v in roles.items() if "-verify-" in k), "planner (when there is one) and verifier thought at max")
check(any(a.get("tasks") for a in runs) or "plan" in roles, "a small goal: the lead split it itself or the planner did")
check(any(v == "high" for k, v in roles.items() if k.endswith("-work")), "workers thought at high")
check(bool(gates), f"each lane ran only its own tests (python3 -m unittest -q test_calc.py): {sorted(set(gates))}")
diff = subprocess.run(["git", "-C", repo, "diff"], capture_output=True, text=True).stdout
check("BASE_URL" not in diff and ".venv" not in subprocess.run(["git", "-C", repo, "status", "--porcelain"], capture_output=True, text=True).stdout, "neither .env nor the virtualenv reached the patch")
thinking = [e for e in entries if e.get("type") == "custom" and e.get("customType") == "ptk-team-thinking"]
check(thinking and thinking[-1].get("data", {}).get("worker") == "medium", "/team-thinking worker=medium is kept for this session")
glob_cfg = json.load(open(os.path.expanduser("~/.pi/agent/ptk.json"))) if os.path.exists(os.path.expanduser("~/.pi/agent/ptk.json")) else {}
check((glob_cfg.get("team", {}).get("thinking", {}) or {}).get("worker", "") != "medium", "and nothing global changed")
sys.exit(0 if ok else 1)
PY
status=$?
say "scratch kept for inspection: $ROOT"
[ $status -eq 0 ] && printf '\033[1;32mPASS\033[0m e2e speed (%ss)\n' "$elapsed"
exit $status
