#!/usr/bin/env bash
# End-to-end check of lead-to-lead messages with real pi sessions in tmux. Costs a few cents of model usage.
# Needs: pi with pi-team-kit installed and a model logged in, tmux, python3, git.
#
#   test/e2e/leads.sh
#   PTK_E2E_MODEL=deepseek/deepseek-flash test/e2e/leads.sh
#
# Two repos, two leads:
#   web  (frontend, calls POST /login)  - started first, then left alone: nobody types into it again
#   api  (backend)                      - renames POST /login to POST /v2/login and tells web with update=true
# Asserts: web is woken by the message, updates its own code and status, and replies to api; the chain stops.
# Then a third lead in a worktree of the web repo changes the same file: it is held until it tells web first.
set -euo pipefail

ROOT="${PTK_E2E_LEADS_DIR:-$HOME/code/ptk-e2e-leads}"
TIMEOUT_SEC="${PTK_E2E_TIMEOUT_SEC:-420}"
AGENT="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
BOARD="$AGENT/ptk/board"
MODEL_ARGS=()
[ -n "${PTK_E2E_MODEL:-}" ] && MODEL_ARGS=(--model "$PTK_E2E_MODEL")
WEB="$ROOT/ptk-e2e-web" API="$ROOT/ptk-e2e-api" WT="$ROOT/ptk-e2e-webwt"
T_WEB="ptk-e2e-web-$$" T_API="ptk-e2e-api-$$" T_WT="ptk-e2e-wt-$$"

say() { printf '\033[1;34m==>\033[0m %s\n' "$*"; }
fail() { printf '\033[1;31mFAIL\033[0m %s\n' "$*"; exit 1; }
for c in pi tmux python3 git; do command -v "$c" >/dev/null || fail "missing $c"; done

cleanup() {
  for t in "$T_WEB" "$T_API" "$T_WT"; do tmux kill-session -t "$t" 2>/dev/null || true; done
  sleep 1
  # Only the e2e names; the rest of the board belongs to real sessions.
  rm -rf "$BOARD"/ptk-e2e-web.json "$BOARD"/ptk-e2e-api.json "$BOARD"/ptk-e2e-webwt.json "$BOARD"/ptk-e2e-*.inbox
  [ -f "$BOARD/log.jsonl" ] && python3 - "$BOARD/log.jsonl" <<'PY' || true
import json, sys
p = sys.argv[1]
keep = [l for l in open(p) if not json.loads(l).get("from", "").startswith("ptk-e2e-")]
open(p, "w").writelines(keep)
PY
}

for n in ptk-e2e-web ptk-e2e-api ptk-e2e-webwt; do
  if [ -e "$BOARD/$n.json" ]; then fail "a lead named $n is on the board already; close that session first"; fi
done
trap cleanup EXIT

# Fresh scratch repos. Only ever delete a directory this script created.
if [ -e "$ROOT" ]; then
  [ -f "$ROOT/.ptk-e2e" ] || fail "$ROOT exists and was not created by this script; set PTK_E2E_LEADS_DIR"
  rm -rf "$ROOT"
fi
mkdir -p "$WEB/src" "$WEB/docs" "$API"
touch "$ROOT/.ptk-e2e"
cat > "$WEB/src/login.js" <<'EOF'
// Login form for the web app.
export async function login(user, password) {
  const res = await fetch("/login", { method: "POST", body: JSON.stringify({ user, password }) });
  return res.json();
}
export const LOGIN_BUTTON = "Login";
EOF
printf '# Login\n\nThe form posts to `POST /login` on the API.\n' > "$WEB/docs/login.md"
printf '# API\n\nEndpoints: POST /login\n' > "$API/README.md"
for r in "$WEB" "$API"; do
  git -C "$r" init -q -b main
  git -C "$r" add -A
  git -C "$r" -c user.name=ptk-e2e -c user.email=ptk-e2e@localhost commit -q -m fixture
done
git -C "$WEB" worktree add -q -b wt "$WT"

key() { printf -- '--%s--' "$(printf '%s' "$1" | sed 's#^/##; s#/#-#g')"; }
STARTED="$(mktemp)"
session_file() { find "$AGENT/sessions/$(key "$1")" -maxdepth 1 -name '*.jsonl' -newer "$STARTED" 2>/dev/null | head -1; }

start_lead() { # tmux-name dir board-name
  tmux new-session -d -s "$1" -x 200 -y 50 -c "$2" "pi -a ${MODEL_ARGS[*]:-}"
  for _ in $(seq 1 60); do [ -f "$BOARD/$3.json" ] && tmux capture-pane -t "$1" -p | grep -q "ptk:" && return 0; sleep 1; done
  tmux capture-pane -t "$1" -p | tail -20
  fail "$3 did not join the board"
}
type_in() { tmux send-keys -t "$1" -l "$2"; sleep 1; tmux send-keys -t "$1" Enter; }

# wait_for <description> <python expression over helpers> : polls until true or timeout
wait_for() {
  local what="$1" expr="$2" deadline=$(( $(date +%s) + TIMEOUT_SEC ))
  say "waiting: $what"
  until python3 - "$BOARD" "$WEB" "$WT" "$expr" <<'PY'
import json, os, sys
board, web, wt, expr = sys.argv[1:]
def card(n):
    try: return json.load(open(f"{board}/{n}.json"))
    except Exception: return {}
def log():
    try: return [json.loads(l) for l in open(f"{board}/log.jsonl")]
    except Exception: return []
def said(a, b): return [m for m in log() if m.get("from") == a and m.get("to") in (b, "all")]
def read(p):
    try: return open(p).read()
    except Exception: return ""
sys.exit(0 if eval(expr) else 1)
PY
  do
    [ "$(date +%s)" -lt "$deadline" ] || { for t in "$T_WEB" "$T_API" "$T_WT"; do echo "--- $t"; tmux capture-pane -t "$t" -p 2>/dev/null | tail -15; done; fail "timed out: $what"; }
    sleep 3
  done
}

start=$(date +%s)
say "starting lead web in $WEB"
start_lead "$T_WEB" "$WEB" ptk-e2e-web
type_in "$T_WEB" "You own the web frontend in this repo and keep it in sync with the API. For now, only set your status with the leads tool to: building the login page (calls POST /login)."
wait_for "web sets its status" '"login page" in card("ptk-e2e-web").get("status", "")'
PRIMED="$(python3 -c 'import json,sys; print(json.load(open(sys.argv[1]))["status"])' "$BOARD/ptk-e2e-web.json")"
export PRIMED

say "starting lead api in $API"
start_lead "$T_API" "$API" ptk-e2e-api
type_in "$T_API" "You just renamed the API endpoint POST /login to POST /v2/login (request and response bodies unchanged) and updated README.md. Tell lead ptk-e2e-web about it with the leads tool and update=true. Then set your status to: renamed /login to /v2/login. Nothing else."

# From here on nobody types into web: it has to be woken by the message.
wait_for "web updates its code, its status, and replies to api" \
  '"/v2/login" in read(f"{web}/src/login.js") and card("ptk-e2e-web").get("status") not in ("", os.environ["PRIMED"]) and said("ptk-e2e-web", "ptk-e2e-api")'
sleep 15 # let any further replies land, to see that the chain stops

say "starting a third lead in a worktree of the web repo: $WT"
start_lead "$T_WT" "$WT" ptk-e2e-webwt
type_in "$T_WT" "In src/login.js change the LOGIN_BUTTON text from Login to Sign in. If a change is refused, do what the refusal says, then retry. Nothing else."
wait_for "the worktree lead tells web first, then changes the file" '"Sign in" in read(f"{wt}/src/login.js") and said("ptk-e2e-webwt", "ptk-e2e-web")'

# A foreground subagent (async: false) runs as a second session inside api's own process and loads this
# extension too. It must not take api's name, card or mail. Watch api's card while it runs.
say "running a foreground subagent inside api"
S_API="$(session_file "$API")"; export S_API
WATCH="$(mktemp)"; STOP="$WATCH.stop"
python3 - "$BOARD/ptk-e2e-api.json" "$WATCH" "$STOP" <<'PY' &
import json, os, sys, time
card, out, stop = sys.argv[1:]
first = json.load(open(card))
with open(out, "w") as log:
    while not os.path.exists(stop):
        try: c = json.load(open(card))
        except FileNotFoundError: log.write("card gone\n"); c = None
        except Exception: c = None  # mid-rename read
        if c and (c["owner"] != first["owner"] or c["status"] != first["status"] or c["cwd"] != first["cwd"]): log.write(f"card changed: {c['owner']} {c['status']!r}\n")
        log.flush(); time.sleep(0.3)
PY
WATCHER=$!
type_in "$T_API" "Run the subagent tool exactly once with async set to false: agent scout, task: list the files in this repo. Do not change your status and do nothing else afterwards."
wait_for "the foreground subagent finishes" 'any("toolResult" in l and "\"subagent\"" in l for l in read(os.environ["S_API"]).splitlines())'
sleep 5
touch "$STOP"; wait "$WATCHER" || true
elapsed=$(( $(date +%s) - start ))

say "checking results"
set +e
python3 - "$BOARD" "$WEB" "$(session_file "$WEB")" "$S_API" "$(session_file "$WT")" "$WATCH" <<'PY'
import json, os, sys
board, web, s_web, s_api, s_wt, watch = sys.argv[1:]
ok = True
def check(cond, msg):
    global ok
    print(("  ok   " if cond else "  FAIL ") + msg)
    ok = ok and cond
def entries(p):
    try: return [json.loads(l) for l in open(p)]
    except Exception: return []
def lead_msgs(p): return [e for e in entries(p) if e.get("type") == "custom_message" and e.get("customType") == "ptk-lead-message"]
def user_prompts(p): return [e for e in entries(p) if (e.get("message") or {}).get("role") == "user"]
log = [json.loads(l) for l in open(f"{board}/log.jsonl")]
mine = [m for m in log if m["from"].startswith("ptk-e2e-")]
for m in mine: print(f"       {m['from']} -> {m['to']}{' (update)' if m['update'] else ''} hops={m['hops']}: {m['text'][:100]}")
a2w = [m for m in mine if m["from"] == "ptk-e2e-api" and m["to"] == "ptk-e2e-web"]
check(a2w and a2w[0]["update"] and a2w[0]["hops"] == 0, "api told web with update=true, from a turn a person started (hops 0)")
check(len(lead_msgs(s_web)) >= 1, f"web received it in its session ({len(lead_msgs(s_web))} lead message(s))")
check(len(user_prompts(s_web)) == 1, f"web acted without anyone typing (user prompts in web: {len(user_prompts(s_web))})")
src = open(f"{web}/src/login.js").read()
check("/v2/login" in src and '"/login"' not in src, "web updated its own code to /v2/login")
w2a = [m for m in mine if m["from"] == "ptk-e2e-web" and m["to"] == "ptk-e2e-api"]
check(w2a and all(m["hops"] >= 1 for m in w2a), f"web replied to api from the woken turn (hops {[m['hops'] for m in w2a]})")
check(len(lead_msgs(s_api)) >= 1, "api received the reply")
pair = [m for m in mine if {m["from"], m["to"]} == {"ptk-e2e-api", "ptk-e2e-web"}]
check(len(pair) <= 4 and max(m["hops"] for m in pair) <= 2, f"the reply chain stopped ({len(pair)} messages, max hops {max(m['hops'] for m in pair)})")
held = any("was changed in the last 30 minutes by lead ptk-e2e-web" in json.dumps(e) for e in entries(s_wt))
check(held, "the worktree lead was held before changing the file web had changed")
t2w = [m for m in mine if m["from"] == "ptk-e2e-webwt" and m["to"] in ("ptk-e2e-web", "all")]
check(bool(t2w), "it told web first, then the change went through")
sub = [e for e in entries(s_api) if (e.get("message") or {}).get("role") == "toolResult" and (e.get("message") or {}).get("toolName") == "subagent"]
check(bool(sub), "api ran a foreground subagent")
anomalies = sorted(set(open(watch).read().split("\n")) - {""})
extra = [f for f in os.listdir(board) if f.startswith("ptk-e2e-api-")]
check(not anomalies and not extra, f"the subagent did not take api's place on the board ({anomalies or 'card unchanged'}{', extra ' + str(extra) if extra else ''})")
sys.exit(0 if ok else 1)
PY
status=$?
[ $status -eq 0 ] && printf '\033[1;32mPASS\033[0m e2e leads (%ss)\n' "$elapsed"
exit $status
