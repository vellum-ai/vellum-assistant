#!/usr/bin/env bash
#
# Checks client documentation for known stale patterns.
# Run from the repo root: ./scripts/check-client-docs.sh
#
# Exit codes:
#   0 — all checks pass
#   1 — stale patterns detected (details printed to stderr)

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CLIENTS_DIR="$REPO_ROOT/clients"

errors=0

# Helper: grep for a pattern in a file; if found, report it as stale.
check_absent() {
  local file="$1"
  local pattern="$2"
  local description="$3"

  if [ ! -f "$file" ]; then
    return
  fi

  if grep -qiE "$pattern" "$file"; then
    echo "ERROR: $description" >&2
    echo "  File: $file" >&2
    echo "  Pattern: $pattern" >&2
    echo "" >&2
    errors=$((errors + 1))
  fi
}

echo "Checking client docs for stale patterns..."

# --- iOS TCP transport claims ---
check_absent "$CLIENTS_DIR/README.md" \
  "iOS.*TCP|TCP.*iOS|iOS:.*TCP connection" \
  "clients/README.md still claims iOS uses TCP transport"

check_absent "$CLIENTS_DIR/ios/README.md" \
  "over TCP|via TCP|TCP proxy|TCP connection" \
  "clients/ios/README.md still contains TCP transport wording"

# --- Stale test counts ---
check_absent "$CLIENTS_DIR/README.md" \
  "\b70 (tests|integration)" \
  "clients/README.md still references stale '70 tests' count"

check_absent "$CLIENTS_DIR/ios/README.md" \
  "\b70 (iOS|tests|integration)" \
  "clients/ios/README.md still references stale '70 tests' count"

# --- Stale dependency claims ---
# Match "HotKey" as a dependency/package name (capitalized), not the generic word "hotkeys".
check_absent "$CLIENTS_DIR/README.md" \
  "Dependencies:.*HotKey|HotKey,|, HotKey" \
  "clients/README.md still lists HotKey as a dependency (should be Sentry)"

check_absent "$CLIENTS_DIR/macos/CLAUDE.md" \
  "HotKey package" \
  "clients/macos/CLAUDE.md still references 'HotKey package' (uses Carbon RegisterEventHotKey)"

# --- Stale roadmap/deferment references ---
check_absent "$CLIENTS_DIR/macos/README.md" \
  "Deferred to PR [0-9]" \
  "clients/macos/README.md still contains stale roadmap deferment references"

# --- iOS signing limitation (stale wording) ---
check_absent "$CLIENTS_DIR/README.md" \
  "Cannot send error responses.*protocol limitation" \
  "clients/README.md still contains outdated iOS signing limitation wording"

# --- Transport consistency with ARCHITECTURE.md ---
# ARCHITECTURE.md says iOS connects "exclusively via HTTPS through the gateway"
# Ensure READMEs don't contradict this with direct-connection claims.
check_absent "$CLIENTS_DIR/README.md" \
  "iOS:.*Unix.*socket|iOS.*direct.*TCP" \
  "clients/README.md contradicts ARCHITECTURE.md iOS transport invariant"

check_absent "$CLIENTS_DIR/ios/README.md" \
  "Unix.*socket|direct.*TCP|direct.*socket" \
  "clients/ios/README.md contradicts ARCHITECTURE.md iOS transport invariant"

if [ "$errors" -gt 0 ]; then
  echo "Found $errors stale pattern(s) in client docs." >&2
  exit 1
else
  echo "All client doc checks passed."
  exit 0
fi
