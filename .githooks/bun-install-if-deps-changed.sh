#!/usr/bin/env bash
#
# Re-run `bun install` in each sub-package whose `package.json` or `bun.lock`
# changed between two git revisions. Meant to be invoked by `post-merge` and
# `post-checkout` hooks so a `git pull` / branch switch that adds a new
# dependency does not leave `node_modules` stale.
#
# This repo has no root manifest — every package lives in its own sub-dir
# (assistant/, cli/, gateway/, credential-executor/, packages/*, etc.) with
# its own package.json and bun.lock.
#
# Usage: bun-install-if-deps-changed.sh <OLD_SHA> <NEW_SHA>
#
# Silent no-op when OLD == NEW or when no dep-tracking file changed.
# Emits a warning (and exits 0) when `bun` is not executable so `git pull`
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

# Git hooks run in non-interactive shells where ~/.zshrc PATH tweaks aren't
# sourced, so fall back to the default bun install location.
BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"

if [ ! -x "$BUN" ]; then
    echo "[git-hook] package.json/bun.lock changed but 'bun' is not available at $BUN — skipping bun install." >&2
    echo "[git-hook] Run 'bun install' manually once bun is available." >&2
    exit 0
fi

# Derive unique sub-package dirs that had a manifest change. Strip the trailing
# `package.json` / `bun.lock` segment to get the package dir (empty string means
# the repo root, which we skip since there is no root manifest).
pkgs="$(printf '%s\n' "$changed" \
    | grep -E '(^|/)(package\.json|bun\.lock)$' \
    | sed -E 's#/?(package\.json|bun\.lock)$##' \
    | awk 'NF' \
    | sort -u)"

if [ -z "$pkgs" ]; then
    exit 0
fi

# Sub-package dirs we never want to auto-install in:
#   meta/                — thin installer wrapper, only workspace dep links,
#                          ships only bin/+Dockerfile per package.json `files`.
#   plugins/* , */plugins/*
#                        — plugin packages declare only peerDependencies. The
#                          resulting bun.lock is empty noise and regenerates
#                          non-deterministically. Plugins live at the repo-root
#                          `plugins/` dir as well as nested example dirs.
# A manual `bun install` in these dirs still works — this just keeps the
# auto-install hook from making `git status` dirty after every pull/switch.
should_skip_pkg() {
    case "$1" in
        meta) return 0 ;;
        plugins/*) return 0 ;;
        */plugins/*) return 0 ;;
    esac
    return 1
}

# Serialize installs — parallel bun runs can contend on the shared ~/.bun cache.
while IFS= read -r pkg; do
    [ -n "$pkg" ] || continue
    if should_skip_pkg "$pkg"; then
        echo "[git-hook] Skipping 'bun install' in $pkg (excluded — see hook source)." >&2
        continue
    fi
    target="$REPO_ROOT/$pkg"
    [ -d "$target" ] || continue
    [ -f "$target/package.json" ] || continue
    echo "[git-hook] Dependency manifest changed — running 'bun install' in $pkg..." >&2
    ( cd "$target" && "$BUN" install ) || {
        status=$?
        echo "[git-hook] 'bun install' in $pkg exited with status $status. Run it manually to investigate." >&2
    }
done <<EOF
$pkgs
EOF

exit 0
