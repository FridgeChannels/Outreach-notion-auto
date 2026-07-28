#!/usr/bin/env bash
# Show status for WORKER_ACCOUNTS (or all log/worker-*.pid).
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "$SCRIPT_DIR/workers-common.sh"
load_dotenv

mkdir -p log

print_one() {
  local account="$1"
  local pid_file="log/worker-${account}.pid"
  local log_file="log/worker-${account}.log"
  local auth
  auth="$(auth_path_for "$account")"
  local auth_ok="missing-auth"
  [[ -f "$auth" ]] && auth_ok="auth-ok"

  if [[ ! -f "$pid_file" ]]; then
    printf "%-16s  %-10s  %s  log=%s\n" "$account" "stopped" "$auth_ok" "$log_file"
    return 0
  fi
  local pid
  pid="$(cat "$pid_file" 2>/dev/null || true)"
  if [[ -n "${pid:-}" ]] && kill -0 "$pid" 2>/dev/null; then
    local last=""
    if [[ -f "$log_file" ]]; then
      last="$(tail -n 1 "$log_file" 2>/dev/null | cut -c1-100 || true)"
    fi
    printf "%-16s  %-10s  pid=%-7s  %s\n" "$account" "alive" "$pid" "$auth_ok"
    [[ -n "$last" ]] && printf "  last: %s\n" "$last"
  else
    printf "%-16s  %-10s  stale-pid=%s  %s\n" "$account" "dead" "${pid:-?}" "$auth_ok"
  fi
}

echo "Multi-account worker status (cwd=$ROOT)"
echo

if [[ -n "${WORKER_ACCOUNTS:-}" ]]; then
  parse_worker_accounts
  echo "WORKER_ACCOUNTS (${#ACCOUNTS[@]}): ${ACCOUNTS[*]}"
  echo
  for account in "${ACCOUNTS[@]}"; do
    print_one "$account"
  done
else
  echo "WORKER_ACCOUNTS unset — scanning log/worker-*.pid"
  echo
  shopt -s nullglob
  found=0
  for pid_file in log/worker-*.pid; do
    base="$(basename "$pid_file" .pid)"
    account="${base#worker-}"
    print_one "$account"
    found=1
  done
  if [[ "$found" -eq 0 ]]; then
    echo "(no worker pid files)"
  fi
fi
