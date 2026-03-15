#!/usr/bin/env bash
set -euo pipefail

# Periphery dead-code scanner for the macOS/shared Swift codebase.
#
# Enforcement uses a count-based threshold: Periphery scans the codebase and
# counts total violations. If the count exceeds the committed threshold, the
# check fails. This is resilient to line-number shifts from merge commits.
#
# Usage:
#   periphery-scan.sh                   Scan and enforce threshold (CI default)
#   periphery-scan.sh --update-baseline Re-generate baseline and update threshold

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$CLIENTS_DIR/.periphery_baseline.json"
THRESHOLD_FILE="$CLIENTS_DIR/.periphery_threshold"
CONFIG_FILE="$CLIENTS_DIR/.periphery.yml"

UPDATE_BASELINE=false
for arg in "$@"; do
  case "$arg" in
    --update-baseline) UPDATE_BASELINE=true ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

cd "$CLIENTS_DIR"

if ! command -v periphery &>/dev/null; then
  echo "Installing Periphery..."
  brew install peripheryapp/periphery/periphery
fi

echo "Periphery version: $(periphery version)"

if [ "$UPDATE_BASELINE" = true ]; then
  echo "Updating baseline..."
  periphery scan \
    --config "$CONFIG_FILE" \
    --write-baseline "$BASELINE_FILE" \
    --quiet
  CURRENT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$BASELINE_FILE")
  echo "$CURRENT" > "$THRESHOLD_FILE"
  echo "Baseline updated at $BASELINE_FILE ($CURRENT violations)"
  exit 0
fi

if [ ! -f "$THRESHOLD_FILE" ]; then
  echo "Error: No threshold file found at $THRESHOLD_FILE"
  echo "Run: bash clients/scripts/periphery-scan.sh --update-baseline"
  echo "Then commit the generated .periphery_threshold"
  exit 1
fi

ALLOWED=$(cat "$THRESHOLD_FILE")
echo "Allowed violation threshold: $ALLOWED"

echo "Scanning for unused code..."
periphery scan \
  --config "$CONFIG_FILE" \
  --write-baseline /tmp/periphery_current.json \
  --quiet || true

CURRENT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" /tmp/periphery_current.json)
echo "Current violations: $CURRENT (threshold: $ALLOWED)"

if [ "$CURRENT" -gt "$ALLOWED" ]; then
  DELTA=$((CURRENT - ALLOWED))
  echo "error: $DELTA new violation(s) introduced. Reduce unused code to at most $ALLOWED violations."

  # Show the diff between committed baseline and current state
  if [ -f "$BASELINE_FILE" ]; then
    echo ""
    echo "New violations not in baseline:"
    periphery scan \
      --config "$CONFIG_FILE" \
      --baseline "$BASELINE_FILE" 2>&1 || true
  fi

  exit 1
fi

if [ "$CURRENT" -lt "$ALLOWED" ]; then
  echo "Violations decreased from $ALLOWED to $CURRENT. Consider updating the threshold:"
  echo "  bash clients/scripts/periphery-scan.sh --update-baseline"
fi

echo "Periphery check passed."
