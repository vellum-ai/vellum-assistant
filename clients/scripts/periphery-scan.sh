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
  echo "No baseline file found at $BASELINE_FILE"
  echo "Run: bash clients/scripts/periphery-scan.sh --update-baseline"
  echo "Then commit the generated .periphery_baseline.json"
  exit 1
fi

echo "Scanning for unused code (against baseline)..."
periphery scan \
  --config "$CONFIG_FILE" \
  --baseline "$BASELINE_FILE" \
  --strict
