#!/usr/bin/env bash
#
# npm-generate-meta-shrinkwrap.sh
#
# Regenerate meta/npm-shrinkwrap.json from the stamped meta/package.json.
#
# npm only honors "overrides" in the root package.json, so they are ignored
# when end users run `npm install -g vellum`. Shipping an npm-shrinkwrap.json
# generated with the overrides applied makes npm follow the same resolution
# for installed copies of the package.
#
# The install is retried because registry reads immediately after a publish
# are the least reliable point in the release; run
# scripts/npm-wait-for-meta-deps.sh first so the retries cover transient
# registry errors rather than a dependency that has not finished publishing.
#
# Usage:
#   ./scripts/npm-generate-meta-shrinkwrap.sh

set -euo pipefail

MAX_ATTEMPTS="${MAX_ATTEMPTS:-3}"
RETRY_DELAY_SECONDS="${RETRY_DELAY_SECONDS:-15}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$REPO_ROOT/meta"

for attempt in $(seq 1 "$MAX_ATTEMPTS"); do
  if npm install --package-lock-only; then
    break
  fi
  if [ "$attempt" -eq "$MAX_ATTEMPTS" ]; then
    echo "::error::npm install --package-lock-only failed after $MAX_ATTEMPTS attempts"
    exit 1
  fi
  echo "npm install failed (attempt $attempt); retrying in ${RETRY_DELAY_SECONDS}s..."
  sleep "$RETRY_DELAY_SECONDS"
done

npm shrinkwrap
