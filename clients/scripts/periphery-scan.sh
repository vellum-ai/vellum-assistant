#!/usr/bin/env bash
set -euo pipefail

# Periphery dead-code scanner for the macOS/shared Swift codebase.
#
# Enforcement compares the current violation count (USR-based) against a
# reference baseline. In CI, the workflow fetches the baseline from the main
# branch so that only NEW violations introduced by the PR cause a failure.
# Locally, it compares against the committed baseline file.
#
# Usage:
#   periphery-scan.sh                              Scan and enforce (CI default)
#   periphery-scan.sh --update-baseline             Re-generate the baseline file
#   periphery-scan.sh --reference-baseline <path>   Compare against a specific baseline

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$CLIENTS_DIR/.periphery_baseline.json"
CONFIG_FILE="$CLIENTS_DIR/.periphery.yml"

UPDATE_BASELINE=false
REFERENCE_BASELINE=""
while [ $# -gt 0 ]; do
  case "$1" in
    --update-baseline) UPDATE_BASELINE=true; shift ;;
    --reference-baseline)
      REFERENCE_BASELINE="$2"; shift 2 ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
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
  echo "Baseline updated at $BASELINE_FILE ($CURRENT violations)"
  exit 0
fi

# Determine which baseline to compare against
if [ -n "$REFERENCE_BASELINE" ] && [ -f "$REFERENCE_BASELINE" ]; then
  COMPARE_FILE="$REFERENCE_BASELINE"
  echo "Using reference baseline: $REFERENCE_BASELINE"
elif [ -f "$BASELINE_FILE" ]; then
  COMPARE_FILE="$BASELINE_FILE"
  echo "Using committed baseline: $BASELINE_FILE"
else
  echo "Error: No baseline file found."
  echo "Run: bash clients/scripts/periphery-scan.sh --update-baseline"
  echo "Then commit the generated .periphery_baseline.json"
  exit 1
fi

BASELINE_COUNT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$COMPARE_FILE")
echo "Reference baseline violations: $BASELINE_COUNT"

echo "Scanning for unused code..."
rm -f /tmp/periphery_current.json
periphery scan \
  --config "$CONFIG_FILE" \
  --write-baseline /tmp/periphery_current.json \
  --quiet || true

if [ ! -f /tmp/periphery_current.json ]; then
  echo "error: Periphery scan failed — no output produced. Check for build errors."
  exit 1
fi

CURRENT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" /tmp/periphery_current.json)
echo "Current violations: $CURRENT (reference: $BASELINE_COUNT)"

if [ "$CURRENT" -gt "$BASELINE_COUNT" ]; then
  DELTA=$((CURRENT - BASELINE_COUNT))
  echo "error: $DELTA new violation(s) introduced (current: $CURRENT, reference: $BASELINE_COUNT)."
  echo "Remove the unused code or update the baseline with:"
  echo "  bash clients/scripts/periphery-scan.sh --update-baseline"

  echo ""
  echo "New violations not in baseline:"
  periphery scan \
    --config "$CONFIG_FILE" \
    --baseline "$COMPARE_FILE" 2>&1 || true

  exit 1
fi

if [ "$CURRENT" -lt "$BASELINE_COUNT" ]; then
  echo "Violations decreased from $BASELINE_COUNT to $CURRENT. Consider updating the baseline:"
  echo "  bash clients/scripts/periphery-scan.sh --update-baseline"
fi

echo "Periphery check passed."
