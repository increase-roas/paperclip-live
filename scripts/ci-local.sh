#!/usr/bin/env bash
# Local stand-in for the PR workflow in .github/workflows/pr-trusted.yml.
#
# GitHub Actions cannot run for this repository right now, so this script runs
# the same substance on one machine:
#
#   build      pnpm build
#   typecheck  the four typecheck programs the typecheck job runs
#   lint       pnpm lint (scripts/check-lint.mjs)
#   tokens     pnpm check:token-gates
#   general    General tests matrix, read from .github/ci-task-matrix.json
#   serialized Verify serialized server suites matrix, read from the same file
#
# The matrices come from .github/ci-task-matrix.json, so a change to the
# workflow's shard layout reaches this script without a second edit.
#
# It does not replace CI: no runner image, no platform matrix, no browser or
# release suites, and no required-check status. Record its output next to the
# revision it ran on.
#
# Usage:
#   scripts/ci-local.sh                      # everything
#   scripts/ci-local.sh --only typecheck,lint
#   scripts/ci-local.sh --skip build,serialized
#   scripts/ci-local.sh --concurrency 4
#   scripts/ci-local.sh --dry-run            # print the plan as JSON
#
# Environment:
#   CI_LOCAL_CONCURRENCY   Default parallelism for independent steps (2).
#   CI_LOCAL_DIR           Output directory (default: .ci-local).
#   PAPERCLIP_TEST_POSTGRES_ADMIN_URL
#                          Point embedded-Postgres suites at a real server
#                          when initdb cannot run as the current user.
#
# Exit code is 0 only when every selected step passed.

set -uo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
cd "$ROOT" || exit 1

OUT_DIR=${CI_LOCAL_DIR:-.ci-local}
CONCURRENCY=${CI_LOCAL_CONCURRENCY:-2}
ONLY=""
SKIP=""
DRY_RUN=false

usage() {
  cat <<'USAGE'
Usage: scripts/ci-local.sh [options]

Options:
  --only LIST         Run only these steps (build,typecheck,lint,tokens,general,serialized)
  --skip LIST         Skip these steps
  --concurrency N     Independent steps to run at once (default 3)
  --dry-run           Print the step plan as JSON and exit
  -h, --help          Show this help

Environment:
  CI_LOCAL_CONCURRENCY                 default parallelism (3)
  CI_LOCAL_DIR                         output directory (default .ci-local)
  PAPERCLIP_TEST_POSTGRES_ADMIN_URL    real Postgres for embedded-Postgres suites
USAGE
}

while [ $# -gt 0 ]; do
  case "$1" in
    --only) ONLY=${2:-}; shift 2 ;;
    --only=*) ONLY=${1#*=}; shift ;;
    --skip) SKIP=${2:-}; shift 2 ;;
    --skip=*) SKIP=${1#*=}; shift ;;
    --concurrency) CONCURRENCY=${2:-}; shift 2 ;;
    --concurrency=*) CONCURRENCY=${1#*=}; shift ;;
    --dry-run) DRY_RUN=true; shift ;;
    --help|-h) usage; exit 0 ;;
    *) echo "Unknown argument: $1" >&2; usage >&2; exit 2 ;;
  esac
done

if ! [[ "$CONCURRENCY" =~ ^[1-9][0-9]*$ ]]; then
  echo "--concurrency must be a positive integer" >&2
  exit 2
fi

if ! command -v node >/dev/null 2>&1; then
  echo "node is required" >&2
  exit 2
fi
if [ ! -x node_modules/.bin/vitest ] || [ ! -d node_modules/.pnpm ]; then
  echo "Workspace dependencies are missing. Run: pnpm install --frozen-lockfile" >&2
  exit 2
fi

want() {
  local category=$1 name=$2 list=$3
  local item
  [ -z "$list" ] && return 0
  local IFS=,
  for item in $list; do
    [ "$item" = "$category" ] && return 0
    [ "$item" = "$name" ] && return 0
    case "$name" in "$item"-*) return 0 ;; esac
  done
  return 1
}

selected() {
  local category=$1 name=$2
  want "$category" "$name" "$ONLY" || return 1
  if [ -n "$SKIP" ] && want "$category" "$name" "$SKIP"; then return 1; fi
  return 0
}

# name|category|wave|command. Commands are internal constants; the runner
# evaluates them with `bash -c` so the plan stays readable.
PLAN=()
plan() {
  local category=$1 name=$2 wave=$3 command=$4
  selected "$category" "$name" || return 0
  PLAN+=("$name|$category|$wave|$command")
}

plan build build 1 "pnpm build"
plan typecheck typecheck 2 "\
pnpm run typecheck:build-gaps && \
node scripts/typecheck-test-programs.mjs --low-memory && \
pnpm --filter @paperclipai/server typecheck && \
node scripts/typecheck-test-projects.mjs --low-memory --reuse-declarations"
plan lint lint 3 "pnpm lint"
plan tokens tokens 3 "pnpm check:token-gates"

# Read the workflow's matrices instead of duplicating the shard layout.
MATRIX_STEPS=$(node --input-type=module -e '
import { readFileSync } from "node:fs";
const matrix = JSON.parse(readFileSync(".github/ci-task-matrix.json", "utf8"));
const slug = (entry) => {
  const base = entry.group_label ? entry.group_label.split(" ")[0] : entry.task.replace(/^ci:/, "");
  return entry.shard_count ? `${base}-${entry.shard_index + 1}-of-${entry.shard_count}` : base;
};
const emit = (entry, args) => console.log([slug(entry), args.join(" ")].join("\t"));
for (const entry of matrix.general_tests) {
  const args = ["node scripts/run-vitest-stable.mjs --mode general"];
  if (entry.group) args.push("--group", entry.group);
  if (entry.shard_count) args.push("--shard-index", String(entry.shard_index), "--shard-count", String(entry.shard_count));
  emit(entry, args);
}
for (const entry of matrix.verify_serialized_server) {
  emit(entry, ["node scripts/run-vitest-stable.mjs --mode serialized",
    "--shard-index", String(entry.shard_index), "--shard-count", String(entry.shard_count)]);
}
')

while IFS=$'\t' read -r name command; do
  [ -n "${name:-}" ] || continue
  case "$name" in
    serialized-*) plan serialized "$name" 3 "$command" ;;
    *) plan general "$name" 3 "$command" ;;
  esac
done <<< "$MATRIX_STEPS"

if [ ${#PLAN[@]} -eq 0 ]; then
  echo "No steps selected." >&2
  exit 2
fi

HEAD_SHA=$(git rev-parse HEAD 2>/dev/null || echo unknown)
HEAD_SHORT=${HEAD_SHA:0:10}

if $DRY_RUN; then
  node --input-type=module -e '
const head = process.argv[1];
const plan = process.argv.slice(2).map((entry) => {
  const [name, category, wave, command] = entry.split("|");
  return { name, category, wave: Number(wave), command };
});
console.log(JSON.stringify({ head, steps: plan }, null, 2));
' "$HEAD_SHA" "${PLAN[@]}"
  exit 0
fi

mkdir -p "$OUT_DIR/logs" "$OUT_DIR/status"
rm -f "$OUT_DIR"/logs/*.log "$OUT_DIR"/status/* "$OUT_DIR/summary.json"

# The workflow runs each job in a fresh runner with installed dependencies. Keep
# this run off any developer database and out of the telemetry stream.
export CI=1
export TURBO_TELEMETRY_DISABLED=1
export PAPERCLIP_TELEMETRY_DISABLED=1
export DO_NOT_TRACK=1
unset DATABASE_URL

echo "[ci-local] head $HEAD_SHORT; ${#PLAN[@]} steps; concurrency $CONCURRENCY"
echo "[ci-local] logs in $OUT_DIR/logs"

run_step() {
  local entry=$1
  local name category command started ended code
  name=${entry%%|*}
  entry=${entry#*|}
  category=${entry%%|*}
  entry=${entry#*|}
  command=${entry#*|}
  started=$(date +%s)
  echo "[ci-local] start $name"
  bash -c "$command" >"$OUT_DIR/logs/$name.log" 2>&1
  code=$?
  ended=$(date +%s)
  echo "$code" >"$OUT_DIR/status/$name.code"
  echo "$category" >"$OUT_DIR/status/$name.category"
  echo "$((ended - started))" >"$OUT_DIR/status/$name.seconds"
  if [ "$code" -eq 0 ]; then
    echo "[ci-local] pass  $name ($((ended - started))s)"
  else
    echo "[ci-local] FAIL  $name (exit $code, $((ended - started))s) — see $OUT_DIR/logs/$name.log"
  fi
}

# Steps run in waves: build, then typecheck, then lint and the test shards.
# Typecheck reads the build output, and its own preparation rebuilds the server,
# so the two cannot share a working tree at the same time.
running=0
for entry in "${PLAN[@]}"; do
  run_step "$entry" &
  running=$((running + 1))
  if [ "$running" -ge "$CONCURRENCY" ]; then
    wait -n
    running=$((running - 1))
  fi
done
wait

# Aggregate the Vitest summaries. Every step records one result row, and steps
# that do not run Vitest record zeros.
node --input-type=module -e '
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename } from "node:path";

const dir = process.argv[1];
const head = process.argv[2];
const plan = process.argv.slice(3).map((entry) => {
  const [name, category] = entry.split("|");
  return { name, category };
});

const parseCounts = (text, label) => {
  const line = text.split("\n").reverse()
    .find((candidate) => new RegExp(`^\\s*${label}\\s`).test(candidate));
  const counts = { passed: 0, failed: 0, skipped: 0 };
  if (!line) return counts;
  for (const match of line.matchAll(/(\d+) (passed|failed|skipped|todo)/g)) {
    const state = match[2] === "todo" ? "skipped" : match[2];
    counts[state] += Number(match[1]);
  }
  return counts;
};

const steps = plan.map(({ name, category }) => {
  const read = (file, fallback) => {
    try { return readFileSync(`${dir}/status/${name}.${file}`, "utf8").trim(); }
    catch { return fallback; }
  };
  const code = Number(read("code", "1"));
  const seconds = Number(read("seconds", "0"));
  let text = "";
  try { text = readFileSync(`${dir}/logs/${name}.log`, "utf8"); } catch {}
  return {
    name, category, status: code === 0 ? "pass" : "fail", exitCode: code, seconds,
    tests: parseCounts(text, "Tests"), files: parseCounts(text, "Test Files"),
  };
});

const totals = steps.reduce((sum, step) => {
  sum.tests.passed += step.tests.passed;
  sum.tests.failed += step.tests.failed;
  sum.tests.skipped += step.tests.skipped;
  sum.files.passed += step.files.passed;
  sum.files.failed += step.files.failed;
  sum.files.skipped += step.files.skipped;
  return sum;
}, { tests: { passed: 0, failed: 0, skipped: 0 }, files: { passed: 0, failed: 0, skipped: 0 } });

const failed = steps.filter((step) => step.status === "fail");
const ok = failed.length === 0;
const summary = { version: 1, head, finishedAt: new Date().toISOString(), ok, steps, totals };
writeFileSync(`${dir}/summary.json`, `${JSON.stringify(summary, null, 2)}\n`);

const width = Math.max(...steps.map((step) => step.name.length), 4);
console.log("");
console.log("local CI results");
console.log(`  ${"step".padEnd(width)}  result  tests                 files`);
for (const step of steps) {
  const tests = step.tests.passed || step.tests.failed
    ? `${step.tests.passed} passed, ${step.tests.failed} failed` : "-";
  const files = step.files.passed || step.files.failed
    ? `${step.files.passed} passed, ${step.files.failed} failed` : "-";
  console.log(`  ${step.name.padEnd(width)}  ${step.status.padEnd(6)}  ${tests.padEnd(21)} ${files}`);
}
console.log("");
if (!ok) {
  console.log(`local CI: fail, ${head}, ${totals.tests.passed} tests passed, ${totals.tests.failed} failed, ${failed.length}/${steps.length} steps failed`);
  console.log(`failed steps: ${failed.map((step) => step.name).join(", ")}`);
  process.exitCode = 1;
} else {
  console.log(`local CI: pass, ${head}, ${totals.tests.passed} tests passed, ${totals.files.passed} test files, ${steps.length} steps`);
}
' "$OUT_DIR" "$HEAD_SHA" "${PLAN[@]}"
exit $?
