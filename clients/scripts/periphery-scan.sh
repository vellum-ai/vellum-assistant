#!/usr/bin/env bash
set -euo pipefail

# Periphery dead-code scanner for the macOS/shared Swift codebase.
# Uses Periphery's built-in baseline feature for incremental adoption:
#   --baseline <file>        filters out known violations
#   --write-baseline <file>  captures current violations as the new baseline
#
# Usage:
#   periphery-scan.sh                   Scan against committed baseline (CI default)
#   periphery-scan.sh --update-baseline Re-generate the baseline file

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$CLIENTS_DIR/.periphery_baseline.json"
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
  echo "Baseline updated at $BASELINE_FILE"
  exit 0
fi

if [ ! -f "$BASELINE_FILE" ]; then
  echo "Error: No baseline file found at $BASELINE_FILE"
  echo "Run: bash clients/scripts/periphery-scan.sh --update-baseline"
  echo "Then commit the generated .periphery_baseline.json"
  exit 1
fi

# Check if baseline has been populated
BASELINE_USRS=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$BASELINE_FILE" 2>/dev/null || echo "0")

if [ "$BASELINE_USRS" = "0" ]; then
  echo "Baseline is empty — generating baseline from current state..."
  periphery scan \
    --config "$CONFIG_FILE" \
    --write-baseline "$BASELINE_FILE" \
    --quiet
  BASELINE_USRS=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$BASELINE_FILE" 2>/dev/null || echo "0")
  echo "Baseline generated with $BASELINE_USRS known violations."
  echo "Download the periphery-baseline artifact and commit it to the repo."
  exit 0
fi

echo "Scanning for unused code (against baseline with $BASELINE_USRS known violations)..."
periphery scan \
  --config "$CONFIG_FILE" \
  --baseline "$BASELINE_FILE" \
  --strict
