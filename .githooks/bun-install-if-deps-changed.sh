#!/usr/bin/env bash
#
# Re-run `bun install` after a pull or branch switch changes dependency
# inputs, so node_modules doesn't go stale.
#
# One root install covers every workspace member. Directories outside the
# workspace (clients/chrome-extension, clients/ios, scripts) keep their own
# lockfiles and get a per-directory install when their manifest changes.
#
# Usage: bun-install-if-deps-changed.sh <OLD_SHA> <NEW_SHA>
#
# Silent no-op when OLD == NEW or when no dependency input changed. Emits a
# warning (and exits 0) when `bun` is not executable so `git pull` never
# fails because of this hook.

set -u

OLD="${1:-}"
NEW="${2:-}"

if [ -z "$OLD" ] || [ -z "$NEW" ] || [ "$OLD" = "$NEW" ]; then
    exit 0
fi

NULL_SHA="0000000000000000000000000000000000000000"
if [ "$OLD" = "$NULL_SHA" ] || [ "$NEW" = "$NULL_SHA" ]; then
    exit 0
fi

REPO_ROOT="$(git rev-parse --show-toplevel 2>/dev/null)"
if [ -z "$REPO_ROOT" ]; then
    exit 0
fi

changed="$(git diff --name-only "$OLD" "$NEW" -- 2>/dev/null || true)"
if [ -z "$changed" ]; then
    exit 0
fi

deps_changed="$(printf '%s\n' "$changed" | grep -E '(^|/)(package\.json|bun\.lock)$|^patches/|^clients/web/patches/' || true)"
if [ -z "$deps_changed" ]; then
    exit 0
fi

BUN="${BUN:-$(command -v bun 2>/dev/null || echo "$HOME/.bun/bin/bun")}"
if [ ! -x "$BUN" ]; then
    echo "[git-hook] Dependency inputs changed but 'bun' is not available at $BUN — run 'bun install' manually." >&2
    exit 0
fi

# Non-member directories that manage their own lockfiles. meta/ and plugin
# dirs are skipped: meta ships only bin/+Dockerfile, and plugin manifests
# declare only peerDependencies.
NON_MEMBER_DIRS="clients/chrome-extension clients/ios scripts"

run_root_install=0
non_member_installs=""

while IFS= read -r path; do
    [ -n "$path" ] || continue
    dir="${path%/*}"
    case "$path" in
        package.json|bun.lock|patches/*|clients/web/patches/*) run_root_install=1; continue ;;
    esac
    case "$dir" in
        meta|meta/*|plugins/*|*/plugins/*) continue ;;
    esac
    matched=0
    for nm in $NON_MEMBER_DIRS; do
        case "$dir" in
            "$nm"|"$nm"/*)
                case " $non_member_installs " in
                    *" $nm "*) ;;
                    *) non_member_installs="$non_member_installs $nm" ;;
                esac
                matched=1
                break
                ;;
        esac
    done
    [ "$matched" = "1" ] || run_root_install=1
done <<EOF
$deps_changed
EOF

if [ "$run_root_install" = "1" ]; then
    echo "[git-hook] Dependency inputs changed — running 'bun install' at the workspace root..." >&2
    (cd "$REPO_ROOT" && "$BUN" install) || {
        echo "[git-hook] 'bun install' exited with status $?. Run it manually to investigate." >&2
    }
fi

for nm in $non_member_installs; do
    [ -f "$REPO_ROOT/$nm/package.json" ] || continue
    echo "[git-hook] Manifest changed in $nm — running 'bun install' there..." >&2
    (cd "$REPO_ROOT/$nm" && "$BUN" install) || {
        echo "[git-hook] 'bun install' in $nm exited with status $?. Run it manually to investigate." >&2
    }
done

exit 0
