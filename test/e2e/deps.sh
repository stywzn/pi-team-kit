#!/usr/bin/env bash
# Merge queue and dependent tasks with real pi in tmux. Costs a few cents, ten minutes or so. Needs pi, tmux, python3, git.
#   test/e2e/deps.sh
#   PTK_E2E_MODEL=<provider/model> test/e2e/deps.sh
# Three tasks: core adds stats.py, report adds report.py that imports stats (dependsOn core), docs edits the README.
# Asserts: every passed lane was merged into the run branch by a team-merger step; report started only after core was
# merged and still passed its own test (which imports stats.py, absent from HEAD); team_integrate applied the lanes,
# removed the run branch, and the tests pass in the checkout.
set -euo pipefail

ROOT="${PTK_E2E_DEPS_DIR:-$HOME/code/ptk-e2e-deps}"
REPO="$ROOT/app"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
MODEL="${PTK_E2E_MODEL:-deepseek/deepseek-flash}"
TIMEOUT_MIN="${PTK_E2E_TIMEOUT_MIN:-30}"
T="ptk-e2e-deps-$$"
say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_DEPS_DIR"
  for w in $(git -C "$REPO" worktree list --porcelain 2>/dev/null | awk '/^worktree /{print $2}' | grep -v "^$REPO\$" || true); do git -C "$REPO" worktree remove --force "$w" || true; done
  rm -rf "$ROOT"
fi
mkdir -p "$REPO/.pi"
touch "$ROOT/.ptk-e2e"
printf '# numbers\nSmall number helpers. Tests: python3 -m unittest -q\n' > "$REPO/README.md"
printf 'import unittest\n\n\nclass Smoke(unittest.TestCase):\n    def test_true(self):\n        self.assertTrue(True)\n' > "$REPO/test_smoke.py"
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
type_in '/team Three tasks; pass them yourself to team_run, exactly these. (1) key "core", files ["stats.py", "test_stats.py"]: create stats.py with mean(xs) returning the arithmetic mean and raising ValueError("empty") on an empty list, and test_stats.py with unittest checks for [1, 2, 3] -> 2 and the empty case; verify: python3 -m unittest -q test_stats -> OK. (2) key "report", files ["report.py", "test_report.py"], dependsOn ["core"]: create report.py with summary(xs) returning the string "n=<count> mean=<mean from stats.mean>" (it must import mean from stats), and test_report.py checking summary([2, 4]) == "n=2 mean=3.0"; verify: python3 -m unittest -q test_report -> OK. (3) key "docs", files ["README.md"]: add a Usage section to README.md naming stats.mean and report.summary; verify: grep -c Usage README.md -> 1. Gate: python3 -m unittest -q. Everything is decided: do not ask me anything, go straight to team_run, and integrate when it finishes.'
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
value, run_dir, team_args, integrate_out = None, None, [], ""
for line in open(sess):
    e = json.loads(line)
    m = e.get("message") or {}
    for p in m.get("content") or [] if isinstance(m.get("content"), list) else []:
        if p.get("type") == "toolCall" and p.get("name") == "team_run": team_args.append(p.get("arguments") or {})
    if m.get("role") == "toolResult" and m.get("toolName") == "team_integrate": integrate_out += json.dumps(m.get("content"))
    if e.get("type") == "custom_message":
        r = re.search(r"Workflow receipt:\s*(.+?)/workflow-receipt\.json", str(e.get("content")))
        if r:
            run_dir = r.group(1)
            try: value = json.load(open(run_dir + "/status.json"))["workflow"]["value"]
            except Exception: pass
tasks = (team_args[-1].get("tasks") if team_args else None) or []
check(any(t.get("key") == "report" and "core" in (t.get("dependsOn") or []) for t in tasks), f"the lead passed report with dependsOn core ({len(team_args)} team_run call(s))")
check(all(t.get("verify") for t in tasks), "every task the run accepted has a verify command")
lanes = {l["lane"]: l for l in (value or {}).get("lanes") or []}
check(set(lanes) == {"core", "report", "docs"}, f"three lanes: {sorted(lanes)}")
integ = (value or {}).get("integration") or {}
check(integ.get("branch", "").startswith("ptk/run-"), f"a merge-queue branch: {integ.get('branch')}")
merged = integ.get("merged") or []
check(set(merged) == {"core", "report", "docs"}, f"every lane was merged: {merged}")
check("core" in merged and "report" in merged and merged.index("core") < merged.index("report"), "core was merged before report")
check(lanes.get("report", {}).get("state") == "passed", f"report passed its own test, which imports stats.py from core: {lanes.get('report', {}).get('state')} in {lanes.get('report', {}).get('rounds')} round(s)")
steps = []
for st in glob.glob(os.path.join(run_dir or "", "status.json")):
    steps = json.load(open(st)).get("steps") or []
mergers = [s for s in steps if s.get("agent") == "team-merger"]
check(sum(1 for s in mergers if s.get("status") in ("complete", "completed")) == 3, f"three team-merger steps finished: {[s.get('status') for s in mergers]}")
check("removed the merge-queue branch" in integrate_out, "team_integrate removed the run branch")
for f in ["stats.py", "test_stats.py", "report.py", "test_report.py"]:
    check(os.path.exists(os.path.join(repo, f)), f"{f} is in the checkout")
check("Usage" in open(os.path.join(repo, "README.md")).read(), "README.md has the Usage section")
r = subprocess.run(["python3", "-m", "unittest", "-q"], cwd=repo, capture_output=True, text=True)
check(r.returncode == 0, "the tests pass in the checkout: " + (r.stderr.strip().splitlines() or [""])[-1])
left = subprocess.run(["git", "branch", "--list", "ptk/run-*"], cwd=repo, capture_output=True, text=True).stdout.strip()
check(not left, f"no run branch left: {left!r}")
sys.exit(0 if ok else 1)
PY
rc=$?
set -e
say "scratch kept for inspection: $ROOT"
[ "$rc" -eq 0 ] || fail "e2e deps (${elapsed}s)"
printf '\033[1;32mPASS\033[0m e2e deps (%ss)\n' "$elapsed"
