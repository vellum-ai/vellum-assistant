#!/usr/bin/env bash
#
# npm-wait-for-meta-deps.sh
#
# Block until every @vellumai/* dependency pinned in meta/package.json is
# resolvable on the npm registry.
#
# `npm publish` exiting 0 does not mean the version can be installed yet: npm
# queues some publishes for asynchronous processing ("Your package is being
# processed and may take a few minutes to become available"). @vellumai/cli
# lands in that queue on every release and appears on the registry roughly
# five minutes after its publish job goes green. The meta package is stamped
# to depend on exact versions published moments earlier, so a shrinkwrap
# install that starts before processing finishes fails with ETARGET.
#
# The deadline covers that processing window with room to spare.
#
# Usage:
#   ./scripts/npm-wait-for-meta-deps.sh

set -euo pipefail

DEADLINE_SECONDS="${DEADLINE_SECONDS:-900}"
POLL_INTERVAL_SECONDS="${POLL_INTERVAL_SECONDS:-10}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/meta"

deadline=$((SECONDS + DEADLINE_SECONDS))

while read -r spec; do
  [ -z "$spec" ] && continue
  until npm view "$spec" version >/dev/null 2>&1; do
    if [ "$SECONDS" -ge "$deadline" ]; then
      echo "::error::$spec still not resolvable on the registry after waiting ${DEADLINE_SECONDS}s"
      exit 1
    fi
    echo "  $spec not yet available; retrying in ${POLL_INTERVAL_SECONDS}s..."
    sleep "$POLL_INTERVAL_SECONDS"
  done
  echo "  ✓ $spec available"
done < <(node -e '
  const deps = require("./package.json").dependencies || {};
  for (const [name, version] of Object.entries(deps)) {
    if (name.startsWith("@vellumai/")) console.log(`${name}@${version}`);
  }
')
