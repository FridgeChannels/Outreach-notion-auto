#!/usr/bin/env bash
# Stop all Outreach worker processes completely:
# - tracked pid files
# - orphaned local tsx workers for configured accounts
# - account-scoped Playwright Chromium children
# - docker compose worker containers
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/workers-common.sh"
load_dotenv

mkdir -p log

collect_accounts() {
  if [[ -n "${WORKER_ACCOUNTS:-}" ]]; then
    parse_worker_accounts
    return
  fi

  ACCOUNTS=()
  shopt -s nullglob
  local pid_file
  for pid_file in log/worker-*.pid; do
    local base account
    base="$(basename "$pid_file" .pid)"
    account="${base#worker-}"
    ACCOUNTS+=("$account")
  done
}

kill_pid_graceful() {
  local label="$1"
  local pid="$2"
  if [[ -z "${pid:-}" ]] || ! [[ "$pid" =~ ^[0-9]+$ ]]; then
    return 0
  fi
  if ! kill -0 "$pid" 2>/dev/null; then
    return 0
  fi

  echo "STOPPING     $label pid=$pid (SIGTERM)"
  kill -TERM "$pid" 2>/dev/null || true
  local i
  for i in $(seq 1 20); do
    if ! kill -0 "$pid" 2>/dev/null; then
      echo "STOPPED      $label"
      return 0
    fi
    sleep 0.5
  done
  echo "FORCE KILL   $label pid=$pid"
  kill -KILL "$pid" 2>/dev/null || true
  echo "KILLED       $label"
}

stop_tracked_pid() {
  local account="$1"
  local pid_file="log/worker-${account}.pid"
  if [[ ! -f "$pid_file" ]]; then
    echo "NO PID FILE  $account"
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -z "${pid:-}" ]]; then
    rm -f "$pid_file"
    echo "EMPTY PID    $account"
    return 0
  fi
  kill_pid_graceful "$account" "$pid"
  rm -f "$pid_file"
}

kill_account_orphans() {
  local account="$1"
  local pids=""

  # Kill local worker node/tsx processes that belong to this account.
  pids="$(ps -axo pid=,command= | awk -v a="$account" '
    index($0, "Outreach-notion-auto") &&
    index($0, "src/cli.ts") &&
    index($0, "--queue=outreach") &&
    (index($0, "worker-" a) || index($0, "/.playwright-tmp/" a "/")) { print $1 }'
  )"
  if [[ -n "${pids//$'\n'/}" ]]; then
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_pid_graceful "${account}-orphan" "$pid"
    done <<< "$pids"
  fi

  # Kill any account-scoped Playwright Chromium leftovers.
  pids="$(ps -axo pid=,command= | awk -v a="$account" '
    index($0, "Google Chrome for Testing") &&
    index($0, "/.playwright-tmp/" a "/") { print $1 }'
  )"
  if [[ -n "${pids//$'\n'/}" ]]; then
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_pid_graceful "${account}-chrome" "$pid"
    done <<< "$pids"
  fi
}

kill_all_project_orphans() {
  local pids=""

  # Any remaining local Outreach worker processes from this repo.
  pids="$(ps -axo pid=,command= | awk '
    index($0, "/Users/markbai/Documents/Outreach-notion-auto") &&
    index($0, "src/cli.ts") &&
    index($0, "--queue=outreach") { print $1 }'
  )"
  if [[ -n "${pids//$'\n'/}" ]]; then
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_pid_graceful "project-worker" "$pid"
    done <<< "$pids"
  fi

  # Any remaining Playwright Chrome roots under this repo temp dir.
  pids="$(ps -axo pid=,command= | awk '
    index($0, "Google Chrome for Testing") &&
    index($0, "/Users/markbai/Documents/Outreach-notion-auto/.playwright-tmp/") { print $1 }'
  )"
  if [[ -n "${pids//$'\n'/}" ]]; then
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_pid_graceful "project-chrome" "$pid"
    done <<< "$pids"
  fi
}

stop_docker_workers() {
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi
  if ! docker compose ps >/dev/null 2>&1; then
    return 0
  fi

  local running
  running="$(docker compose ps --status running --services 2>/dev/null || true)"
  if [[ -n "${running//$'\n'/}" ]]; then
    echo "DOCKER DOWN  stopping compose worker services"
    docker compose down --remove-orphans || docker compose stop || true
    docker compose kill >/dev/null 2>&1 || true
    local ids
    ids="$(docker compose ps -q 2>/dev/null || true)"
    if [[ -n "${ids//$'\n'/}" ]]; then
      echo "DOCKER RM-F  force removing remaining compose containers"
      while IFS= read -r cid; do
        [[ -z "${cid:-}" ]] && continue
        docker rm -f "$cid" >/dev/null 2>&1 || true
      done <<< "$ids"
    fi
  fi
}

collect_accounts

if [[ ${#ACCOUNTS[@]} -gt 0 ]]; then
  for account in "${ACCOUNTS[@]}"; do
    stop_tracked_pid "$account"
  done
  for account in "${ACCOUNTS[@]}"; do
    kill_account_orphans "$account"
    rm -f "log/worker-${account}.pid"
  done
else
  echo "No WORKER_ACCOUNTS/pid files; only checking docker compose"
fi

kill_all_project_orphans
stop_docker_workers

echo "Stop complete."
