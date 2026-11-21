#!/usr/bin/env bash
set -euo pipefail

# Manage a task-scoped Neon branch without putting its connection string in logs.
#
# Usage:
#   scripts/ir/neon-branch.sh create <task>
#   scripts/ir/neon-branch.sh url <task>
#   scripts/ir/neon-branch.sh delete <task>
#
# The task name is slugged and combined with the UTC date: agent/<task>-YYYYMMDD.
# The connection string is written to a private state file; it is never printed.
# See doc/increase-roas/neon-database.md.

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
PROJECT_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
cd "$PROJECT_ROOT"

TEMP_URL_FILE=""
cleanup() {
  if [[ -n "$TEMP_URL_FILE" ]]; then
    rm -f "$TEMP_URL_FILE"
  fi
}
trap cleanup EXIT

usage() {
  cat <<'EOF'
Usage: scripts/ir/neon-branch.sh <create|url|delete> <task>

  create <task>  Create agent/<task>-YYYYMMDD and save its connection string.
  url <task>     Print how to load the saved connection string.
  delete <task>  Delete the branch and remove the saved connection string.

Requires NEON_API_KEY and NEON_PROJECT_ID in the environment, plus the Neon CLI.
EOF
}

fallback_to_embedded() {
  cat >&2 <<'EOF'
NEON_API_KEY is not set, so Neon is not configured. No branch was created,
read, or deleted. Use the embedded database instead: unset DATABASE_URL (or
remove it from .env) and run `pnpm dev` (see doc/increase-roas/neon-database.md,
rule 6).
EOF
  exit 0
}

if [[ $# -ne 2 ]]; then
  usage
  exit 2
fi

command_name="$1"
task_name="$2"

case "$command_name" in
  create|url|delete) ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ -z "$task_name" ]]; then
  echo "Task name cannot be empty." >&2
  exit 2
fi

if [[ -z "${NEON_API_KEY:-}" ]]; then
  fallback_to_embedded
fi

if [[ -z "${NEON_PROJECT_ID:-}" ]]; then
  echo "NEON_PROJECT_ID is not set. Set it in the environment; see doc/increase-roas/neon-database.md." >&2
  exit 1
fi

if ! command -v neon >/dev/null 2>&1; then
  echo "The Neon CLI ('neon') is not installed. Install it or use the embedded database with 'pnpm dev'." >&2
  exit 1
fi

export NEON_API_KEY NEON_PROJECT_ID

slug="$(
  printf '%s' "$task_name" \
    | tr '[:upper:]' '[:lower:]' \
    | sed -E 's/[^a-z0-9]+/-/g; s/^-+//; s/-+$//' \
    | cut -c1-48 \
    | sed -E 's/-+$//'
)"

if [[ -z "$slug" ]]; then
  echo "Task name must contain at least one letter or digit." >&2
  exit 2
fi

branch="agent/${slug}-$(date -u +%Y%m%d)"
state_root="${XDG_STATE_HOME:-${HOME}/.local/state}/paperclip/neon"
url_file="${state_root}/${branch//\//__}.env"

write_url_file() {
  mkdir -p "$state_root"
  chmod 700 "$state_root"
  umask 077

  local connection_url
  if ! connection_url="$(neon connection-string --project-id "$NEON_PROJECT_ID" "$branch")"; then
    echo "Could not read the connection string for $branch. The branch may still exist; run 'neon branches list' to check." >&2
    exit 1
  fi
  if [[ -z "$connection_url" ]]; then
    echo "Neon returned an empty connection string for $branch." >&2
    exit 1
  fi

  TEMP_URL_FILE="${url_file}.tmp.$$"
  printf 'DATABASE_URL=%s\n' "$connection_url" > "$TEMP_URL_FILE"
  chmod 600 "$TEMP_URL_FILE"
  mv "$TEMP_URL_FILE" "$url_file"
  TEMP_URL_FILE=""
  unset connection_url
}

print_load_command() {
  printf 'Neon branch: %s\n' "$branch"
  printf 'Connection string saved (not printed) to: %s\n' "$url_file"
  printf 'Load it with: set -a; . "%s"; set +a\n' "$url_file"
}

case "$command_name" in
  create)
    if ! neon branches create --project-id "$NEON_PROJECT_ID" --name "$branch" --no-secrets >/dev/null; then
      echo "Could not create $branch. Run 'neon branches list' to check whether it already exists." >&2
      exit 1
    fi
    write_url_file
    print_load_command
    ;;
  url)
    if [[ ! -s "$url_file" ]]; then
      write_url_file
    fi
    print_load_command
    ;;
  delete)
    if ! neon branches delete --project-id "$NEON_PROJECT_ID" "$branch" >/dev/null; then
      echo "Could not delete $branch. Run 'neon branches list' to check the branch name." >&2
      exit 1
    fi
    rm -f "$url_file"
    printf 'Deleted Neon branch: %s\n' "$branch"
    ;;
esac
