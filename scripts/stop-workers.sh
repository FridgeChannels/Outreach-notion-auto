#!/usr/bin/env bash
# Stop all Outreach worker processes completely:
# - tracked pid files
# - orphaned local tsx workers (match project cwd, not hardcoded paths)
# - Playwright Chromium children under .playwright-tmp
# - docker compose / outreach-notion-auto containers (incl. restart:unless-stopped)
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/workers-common.sh"
load_dotenv

mkdir -p log

kill_children_first() {
  local pid="$1"
  local child
  for child in $(pgrep -P "$pid" 2>/dev/null || true); do
    kill_children_first "$child"
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

  kill_children_first "$pid"

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

kill_account_chrome() {
  local account="$1"
  local pids
  pids="$(ps -axo pid=,args= 2>/dev/null | awk -v root="$ROOT_ABS" -v a="$account" '
    (index($0, "Google Chrome for Testing") || index($0, "chrome-headless-shell")) &&
    index($0, root) && index($0, "/.playwright-tmp/" a "/") { print $1 }'
  )"
  if [[ -n "${pids//$'\n'/}" ]]; then
    while IFS= read -r pid; do
      [[ -z "${pid:-}" ]] && continue
      kill_pid_graceful "${account}-chrome" "$pid"
    done <<< "$pids"
  fi
}

kill_all_project_workers() {
  local pid
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    kill_pid_graceful "project-worker" "$pid"
  done < <(find_project_worker_pids | sort -u)
}

kill_all_project_chrome() {
  local pid
  while IFS= read -r pid; do
    [[ -z "${pid:-}" ]] && continue
    kill_pid_graceful "project-chrome" "$pid"
  done < <(find_project_chrome_pids | sort -u)
}

stop_docker_workers() {
  if ! command -v docker >/dev/null 2>&1; then
    return 0
  fi

  if [[ -f "$ROOT/docker-compose.yml" ]]; then
    echo "DOCKER DOWN  compose (all profiles)"
    docker compose --profile single --profile multi down --remove-orphans 2>/dev/null \
      || docker compose down --remove-orphans 2>/dev/null \
      || true
    docker compose kill 2>/dev/null || true
  fi

  # Name/image match — catches containers started outside default compose profile
  # and prevents restart:unless-stopped from bringing them back.
  local ids=""
  ids="$(docker ps -aq --filter "name=outreach-notion-auto" 2>/dev/null || true)"
  if [[ -n "${ids//$'\n'/}" ]]; then
    echo "DOCKER RM-F  containers matching outreach-notion-auto"
    while IFS= read -r cid; do
      [[ -z "${cid:-}" ]] && continue
      docker update --restart=no "$cid" 2>/dev/null || true
      docker rm -f "$cid" 2>/dev/null || true
    done <<< "$ids"
  fi

  ids="$(docker ps -aq --filter "ancestor=outreach-notion-auto:latest" 2>/dev/null || true)"
  if [[ -n "${ids//$'\n'/}" ]]; then
    echo "DOCKER RM-F  containers from outreach-notion-auto:latest"
    while IFS= read -r cid; do
      [[ -z "${cid:-}" ]] && continue
      docker update --restart=no "$cid" 2>/dev/null || true
      docker rm -f "$cid" 2>/dev/null || true
    done <<< "$ids"
  fi
}

verify_stopped() {
  local workers chrome docker_left
  workers="$(find_project_worker_pids | tr '\n' ' ' | sed 's/ $//')"
  chrome="$(find_project_chrome_pids | tr '\n' ' ' | sed 's/ $//')"
  docker_left=""
  if command -v docker >/dev/null 2>&1; then
    docker_left="$(docker ps -q --filter "name=outreach-notion-auto" 2>/dev/null | tr '\n' ' ' | sed 's/ $//')"
  fi

  local ok=1
  if [[ -n "$workers" ]]; then
    echo "WARNING: worker process(es) still running: $workers"
    ok=0
  fi
  if [[ -n "$chrome" ]]; then
    echo "WARNING: Playwright Chrome still running: $chrome"
    ok=0
  fi
  if [[ -n "$docker_left" ]]; then
    echo "WARNING: Docker containers still running: $docker_left"
    ok=0
  fi

  if [[ "$ok" -eq 1 ]]; then
    echo "VERIFIED     no project workers, chrome, or docker containers remain"
  else
    echo
    echo "Manual cleanup on server:"
    echo "  ps aux | grep src/cli.ts"
    echo "  docker ps -a | grep outreach"
    echo "  npm run workers:stop   # run again"
    return 1
  fi
}

echo "Stopping workers (project=$ROOT_ABS)"
echo

collect_all_accounts

if [[ ${#ACCOUNTS[@]} -gt 0 ]]; then
  for account in "${ACCOUNTS[@]}"; do
    stop_tracked_pid "$account"
  done
  for account in "${ACCOUNTS[@]}"; do
    kill_account_chrome "$account"
    rm -f "log/worker-${account}.pid"
  done
else
  echo "No WORKER_ACCOUNTS or pid files — scanning all project workers"
fi

kill_all_project_workers
kill_all_project_chrome
stop_docker_workers

echo
if verify_stopped; then
  echo "Stop complete."
else
  echo "Stop finished with warnings — see above."
  exit 1
fi
