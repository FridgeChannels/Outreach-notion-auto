#!/usr/bin/env bash
# Shared helpers for multi-account worker scripts.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

load_dotenv() {
  if [[ -f "$ROOT/.env" ]]; then
    set -a
    # shellcheck disable=SC1091
    source "$ROOT/.env"
    set +a
  fi
}

# Populate ACCOUNTS array from WORKER_ACCOUNTS (comma-separated).
parse_worker_accounts() {
  ACCOUNTS=()
  local raw="${WORKER_ACCOUNTS:-}"
  if [[ -z "$raw" ]]; then
    echo "ERROR: WORKER_ACCOUNTS is empty. Set e.g. WORKER_ACCOUNTS=mark,hayes in .env" >&2
    exit 1
  fi
  local IFS=','
  # shellcheck disable=SC2206
  local parts=($raw)
  local a
  for a in "${parts[@]}"; do
    a="$(echo "$a" | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')"
    [[ -z "$a" ]] && continue
    if [[ ! "$a" =~ ^[a-zA-Z0-9._-]+$ ]]; then
      echo "ERROR: invalid account name: $a" >&2
      exit 1
    fi
    ACCOUNTS+=("$a")
  done
  if [[ ${#ACCOUNTS[@]} -eq 0 ]]; then
    echo "ERROR: WORKER_ACCOUNTS parsed to zero accounts" >&2
    exit 1
  fi
}

auth_path_for() {
  local account="$1"
  echo "${NOTION_AUTH_DIR:-./auth}/${account}.json"
}

stagger_sec() {
  echo "${WORKER_STAGGER_SEC:-8}"
}

# Absolute project root (used to match processes by cwd on servers).
ROOT_ABS="$(cd "$ROOT" && pwd -P 2>/dev/null || pwd)"

# Best-effort cwd for a PID (Linux /proc, macOS lsof).
process_cwd() {
  local pid="$1"
  if [[ -d "/proc/$pid" ]]; then
    readlink -f "/proc/$pid/cwd" 2>/dev/null || true
    return 0
  fi
  if command -v lsof >/dev/null 2>&1; then
    lsof -a -d cwd -p "$pid" 2>/dev/null | awk 'NR==2 {print $NF; exit}' || true
  fi
}

# True when pid is tsx/node worker for this repo (match cwd or cmd path).
is_project_worker_pid() {
  local pid="$1"
  local cmd cwd
  cmd="$(ps -p "$pid" -o args= 2>/dev/null || ps -p "$pid" -o command= 2>/dev/null || true)"
  [[ -z "$cmd" ]] && return 1
  [[ "$cmd" != *"src/cli.ts"* ]] && return 1

  cwd="$(process_cwd "$pid")"
  if [[ -n "$cwd" && "$cwd" == "$ROOT_ABS" ]]; then
    return 0
  fi
  if [[ "$cmd" == *"$ROOT_ABS"* ]]; then
    return 0
  fi
  local repo_name
  repo_name="$(basename "$ROOT_ABS")"
  if [[ -n "$repo_name" && "$cmd" == *"$repo_name"* ]]; then
    return 0
  fi
  return 1
}

# All local worker PIDs for this project (tracked or orphaned).
find_project_worker_pids() {
  local pid
  for pid in $(pgrep -f "src/cli.ts" 2>/dev/null || true); do
    if is_project_worker_pid "$pid"; then
      echo "$pid"
    fi
  done
}

# Playwright Chromium processes using this repo's temp dir.
find_project_chrome_pids() {
  ps -axo pid=,args= 2>/dev/null | awk -v root="$ROOT_ABS" '
    (index($0, "Google Chrome for Testing") || index($0, "chrome-headless-shell")) &&
    index($0, root) && index($0, "/.playwright-tmp/") { print $1 }
  '
}

# Merge WORKER_ACCOUNTS with any log/worker-*.pid account names.
collect_all_accounts() {
  if [[ -n "${WORKER_ACCOUNTS:-}" ]]; then
    parse_worker_accounts
  else
    ACCOUNTS=()
  fi

  shopt -s nullglob
  local pid_file base account found a
  for pid_file in log/worker-*.pid; do
    base="$(basename "$pid_file" .pid)"
    account="${base#worker-}"
    found=0
    for a in "${ACCOUNTS[@]}"; do
      if [[ "$a" == "$account" ]]; then
        found=1
        break
      fi
    done
    if [[ "$found" -eq 0 ]]; then
      ACCOUNTS+=("$account")
    fi
  done
}
