#!/usr/bin/env bash
# Start one worker process per entry in WORKER_ACCOUNTS (N accounts => N processes).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/workers-common.sh"
load_dotenv
parse_worker_accounts

AUTH_DIR="${NOTION_AUTH_DIR:-./auth}"
STAGGER="$(stagger_sec)"
mkdir -p log

echo "Starting ${#ACCOUNTS[@]} outreach worker(s) from WORKER_ACCOUNTS…"
echo "  shared locks: $ROOT/data"
echo "  stagger: ${STAGGER}s between starts"
echo

# Validate all auth files before starting any process (avoid partial fleet).
for account in "${ACCOUNTS[@]}"; do
  auth="$(auth_path_for "$account")"
  if [[ ! -f "$auth" ]]; then
    echo "ERROR: missing auth file: $auth" >&2
    echo "  Run: NOTION_ACCOUNT=$account npm run worker:login" >&2
    exit 1
  fi
done

idx=0
for account in "${ACCOUNTS[@]}"; do
  pid_file="log/worker-${account}.pid"
  if [[ -f "$pid_file" ]]; then
    old_pid="$(cat "$pid_file" 2>/dev/null || true)"
    if [[ -n "${old_pid:-}" ]] && kill -0 "$old_pid" 2>/dev/null; then
      echo "SKIP $account — already running (pid $old_pid)"
      idx=$((idx + 1))
      continue
    fi
    rm -f "$pid_file"
  fi

  mkdir -p ".playwright-tmp/${account}" "artifacts/${account}" log
  tmp_abs="$ROOT/.playwright-tmp/${account}"

  (
    export NOTION_ACCOUNT="$account"
    export WORKER_ID="worker-${account}"
    export NOTION_AUTH_DIR="$AUTH_DIR"
    export TMPDIR="$tmp_abs"
    export TEMP="$tmp_abs"
    export TMP="$tmp_abs"
    export ARTIFACT_DIR="artifacts/${account}"
    export PLAYWRIGHT_HEADLESS="${PLAYWRIGHT_HEADLESS:-true}"
    exec npx tsx src/cli.ts --queue=outreach
  ) >>"log/worker-${account}.log" 2>&1 &
  echo $! >"$pid_file"
  echo "STARTED $account  WORKER_ID=worker-${account}  pid=$(cat "$pid_file")  log=log/worker-${account}.log"

  idx=$((idx + 1))
  if [[ "$idx" -lt "${#ACCOUNTS[@]}" ]]; then
    sleep "$STAGGER"
  fi
done

echo
echo "Done. Status: npm run workers:status"
echo "Logs:     tail -f log/worker-*.log"
echo "Stop:     npm run workers:stop"
