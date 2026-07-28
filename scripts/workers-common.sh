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
