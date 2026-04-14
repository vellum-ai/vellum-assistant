#!/usr/bin/env bash
#
# Re-run `bun install` at the repo root when any `package.json` or `bun.lock`
# changed between two git revisions. Meant to be invoked by `post-merge` and
# `post-checkout` hooks so a `git pull` / branch switch that adds a new
# dependency does not leave `node_modules` stale.
#
# Usage: bun-install-if-deps-changed.sh <OLD_SHA> <NEW_SHA>
#
# Silent no-op when OLD == NEW or when no dep-tracking file changed.
# Emits a warning (and exits 0) when `bun` is not on PATH so `git pull`
# never fails because of this hook.

set -u

OLD="${1:-}"
NEW="${2:-}"

if [ -z "$OLD" ] || [ -z "$NEW" ] || [ "$OLD" = "$NEW" ]; then
    exit 0
fi

# Handle the null SHA git passes for post-checkout when a branch is created
# from an unborn HEAD. Nothing to compare against.
NULL_SHA="0000000000000000000000000000000000000000"
if [ "$OLD" = "$NULL_SHA" ] || [ "$NEW" = "$NULL_SHA" ]; then
    exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
    exit 0
fi

# List changed paths; bail quietly if git can't produce a diff for this range
# (e.g. one side is unknown to this worktree).
changed="$(git diff --name-only "$OLD" "$NEW" -- 2>/dev/null || true)"
if [ -z "$changed" ]; then
    exit 0
fi

if ! printf '%s\n' "$changed" | grep -Eq '(^|/)(package\.json|bun\.lock)$'; then
    exit 0
fi

if ! command -v bun >/dev/null 2>&1; then
    echo "[git-hook] package.json/bun.lock changed but 'bun' is not on PATH — skipping bun install." >&2
    echo "[git-hook] Run 'bun install' manually once bun is available." >&2
    exit 0
fi

echo "[git-hook] Dependency manifest changed — running 'bun install' at $REPO_ROOT..." >&2
( cd "$REPO_ROOT" && bun install ) || {
    status=$?
    echo "[git-hook] 'bun install' exited with status $status. Run it manually to investigate." >&2
    exit 0
}
