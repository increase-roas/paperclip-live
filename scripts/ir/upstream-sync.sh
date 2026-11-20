#!/usr/bin/env bash
# Increase ROAS: open one pull request per new upstream Paperclip release.
#
# A "release" is an upstream GitHub Release (stable, vYYYY.MDD.P) of
# paperclipai/paperclip. For each release whose tag is not yet in our base
# branch, this script merges the tag into a branch `upstream-sync/<tag>` and
# opens a PR. IR CI then runs on it. If the merge clashes with our changes,
# the conflicted files are committed with their conflict markers, the PR is
# opened as a draft titled "[CONFLICT]" and its body lists every clashing file.
#
# Runs in .github/workflows/ir-upstream-sync.yml, or locally:
#   GH_TOKEN=$(gh auth token) scripts/ir/upstream-sync.sh
# Env: REPO (default increase-roas/paperclip), BASE (default master),
#      DRY_RUN=1 to only report, DISPATCH_CI=1 to start IR CI explicitly
#      (needed when the PR is opened with the Actions GITHUB_TOKEN, whose
#      events do not trigger other workflows).
set -euo pipefail

REPO="${REPO:-increase-roas/paperclip}"
BASE="${BASE:-master}"
UPSTREAM_REPO="paperclipai/paperclip"
SUMMARY="${GITHUB_STEP_SUMMARY:-/dev/stdout}"

git config user.name  >/dev/null 2>&1 || git config user.name  "ir-upstream-sync"
git config user.email >/dev/null 2>&1 || git config user.email "ir-upstream-sync@users.noreply.github.com"

git remote get-url upstream >/dev/null 2>&1 || git remote add upstream "https://github.com/$UPSTREAM_REPO.git"
git fetch --quiet --no-tags upstream "+refs/heads/master:refs/remotes/upstream/master"
git fetch --quiet --force upstream "+refs/tags/v*:refs/tags/v*"
git fetch --quiet origin "+refs/heads/$BASE:refs/remotes/origin/$BASE"

TAGS=()
while IFS= read -r t; do [ -n "$t" ] && TAGS+=("$t"); done < <(gh release list -R "$UPSTREAM_REPO" --limit 30 --exclude-drafts --exclude-pre-releases \
  --json tagName,publishedAt --jq 'sort_by(.publishedAt) | .[].tagName')

# Only releases published after the newest release already in our copy.
# (Older hotfix tags such as v2026.824.1 live off master and are never "new".)
NEW_TAGS=()
for tag in ${TAGS[@]+"${TAGS[@]}"}; do
  if git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null \
     && git merge-base --is-ancestor "refs/tags/$tag" "origin/$BASE"; then
    NEW_TAGS=()            # everything up to here is already included
  else
    NEW_TAGS+=("$tag")
  fi
done
TAGS=(${NEW_TAGS[@]+"${NEW_TAGS[@]}"})

echo "## Upstream sync ($(date -u +%Y-%m-%dT%H:%MZ))" >> "$SUMMARY"
opened=0

for tag in ${TAGS[@]+"${TAGS[@]}"}; do
  if ! git rev-parse -q --verify "refs/tags/$tag^{commit}" >/dev/null; then
    echo "- $tag: tag not fetched, skipped" >> "$SUMMARY"; continue
  fi
  if git merge-base --is-ancestor "refs/tags/$tag" "origin/$BASE"; then
    continue   # already part of our copy
  fi
  branch="upstream-sync/$tag"
  existing="$(gh pr list -R "$REPO" --head "$branch" --state all --json number,url --jq '.[0].url // ""')"
  if [ -n "$existing" ]; then
    echo "- $tag: PR already exists: $existing" >> "$SUMMARY"; continue
  fi
  if [ "${DRY_RUN:-0}" = 1 ]; then
    echo "- $tag: would open a PR (dry run)" >> "$SUMMARY"; opened=$((opened + 1)); continue
  fi

  git checkout --quiet -B "$branch" "origin/$BASE"
  conflicts=""
  if ! git merge --no-ff --no-edit -m "Merge upstream Paperclip $tag" "refs/tags/$tag" > /tmp/ir-merge.log 2>&1; then
    conflicts="$(git diff --name-only --diff-filter=U)"
    if [ -z "$conflicts" ]; then
      cat /tmp/ir-merge.log; echo "merge of $tag failed without conflicts" >&2; exit 1
    fi
    git add -A
    git commit --quiet --no-verify --no-edit -m "Merge upstream Paperclip $tag (CONFLICTS: resolve before merging)"
  fi
  git push --quiet --force origin "$branch"

  ours="$(git diff --name-only "$(git merge-base "origin/$BASE" "refs/tags/$tag")" "origin/$BASE" | head -200)"
  body="$(mktemp)"
  {
    echo "Upstream release: https://github.com/$UPSTREAM_REPO/releases/tag/$tag"
    echo ""
    echo "Merges \`$tag\` ($(git rev-parse --short "refs/tags/$tag")) into \`$BASE\`. IR CI runs on this PR."
    echo ""
    if [ -n "$conflicts" ]; then
      echo "## ⚠️ Merge clashes with our changes"
      echo ""
      echo "These files conflict. They are committed **with conflict markers**, so CI will fail until they are resolved on this branch:"
      echo ""
      # shellcheck disable=SC2016 # backticks are literal Markdown
      printf '%s\n' "$conflicts" | sed 's/^/- `/; s/$/`/'
      echo ""
      echo "Resolve on \`$branch\` (keep our intent, take upstream's other changes), push, and wait for IR CI to pass."
    else
      echo "## Merge"
      echo ""
      echo "Clean merge: no clashes with our changes."
    fi
    echo ""
    echo "<details><summary>Files we changed since the last common point with upstream</summary>"
    echo ""
    # shellcheck disable=SC2016 # backticks are literal Markdown
    printf '%s\n' "$ours" | sed 's/^/- `/; s/$/`/'
    echo ""
    echo "</details>"
    echo ""
    echo "Before merging: IR CI green. After merging: IR image publishes a new digest; switch the server only with SWAP.md in increase-roas/paperclip-server."
  } > "$body"

  title="Upstream Paperclip $tag"
  args=(--base "$BASE" --head "$branch" --body-file "$body")
  if [ -n "$conflicts" ]; then
    title="[CONFLICT] $title"; args+=(--draft)
  fi
  url="$(gh pr create -R "$REPO" --title "$title" "${args[@]}")"
  echo "- $tag: opened $url$([ -n "$conflicts" ] && echo " (conflicts: $(printf '%s' "$conflicts" | wc -l | tr -d ' ') files)")" >> "$SUMMARY"
  if [ "${DISPATCH_CI:-0}" = 1 ]; then
    gh workflow run ir-ci.yml -R "$REPO" --ref "$branch" || echo "- could not dispatch IR CI for $branch" >> "$SUMMARY"
  fi
  opened=$((opened + 1))
  git checkout --quiet --detach "origin/$BASE"
done

[ "$opened" -eq 0 ] && echo "- No new upstream releases." >> "$SUMMARY"
exit 0
