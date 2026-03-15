#!/usr/bin/env bash
set -euo pipefail

# Periphery dead-code scanner for the macOS/shared Swift codebase.
#
# Self-contained script that handles installation, scanning, baseline management,
# and enforcement. Designed to be called from any CI workflow (PR, main, release)
# or locally with a single command.
#
# Enforcement uses USR set-differentiation: the script compares the exact set
# of USR identifiers in the current scan against a reference baseline. Any
# NEW USRs (present in the current scan but absent from the baseline) cause a
# failure. This prevents "violation churn" where a PR swaps one dead symbol
# for another without being flagged.
#
# Usage:
#   periphery-scan.sh                              Scan and enforce against committed baseline
#   periphery-scan.sh --ci                          CI mode: fetch baseline from origin/main, enforce
#   periphery-scan.sh --update-baseline             Re-generate the committed baseline file
#   periphery-scan.sh --reference-baseline <path>   Compare against a specific baseline file

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$CLIENTS_DIR/.periphery_baseline.json"
CONFIG_FILE="$CLIENTS_DIR/.periphery.yml"

UPDATE_BASELINE=false
REFERENCE_BASELINE=""
CI_MODE=false
while [ $# -gt 0 ]; do
  case "$1" in
    --update-baseline) UPDATE_BASELINE=true; shift ;;
    --reference-baseline)
      REFERENCE_BASELINE="$2"; shift 2 ;;
    --ci) CI_MODE=true; shift ;;
    *) echo "Unknown argument: $1"; exit 1 ;;
  esac
done

cd "$CLIENTS_DIR"

# --- Install Periphery if needed ---
if ! command -v periphery &>/dev/null; then
  echo "Installing Periphery..."
  brew install peripheryapp/periphery/periphery
fi

echo "Periphery version: $(periphery version)"

# --- Update baseline mode ---
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

# --- CI mode: fetch baseline from origin/main ---
if [ "$CI_MODE" = true ]; then
  echo "CI mode: fetching baseline from origin/main..."
  if ! git fetch origin main --depth=1 2>&1; then
    echo "Warning: Could not fetch origin/main. Falling back to committed baseline."
    # Don't set REFERENCE_BASELINE; fall through to use BASELINE_FILE
  else
    MAIN_BASELINE="/tmp/main_baseline.json"
    if git show origin/main:clients/.periphery_baseline.json > "$MAIN_BASELINE" 2>/dev/null; then
      USR_COUNT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$MAIN_BASELINE")
      if [ "$USR_COUNT" -gt 0 ]; then
        REFERENCE_BASELINE="$MAIN_BASELINE"
        echo "Main branch baseline found ($USR_COUNT violations)"
      else
        echo "Main branch baseline is empty — first-time setup."
        echo "Generating initial baseline..."
        periphery scan \
          --config "$CONFIG_FILE" \
          --write-baseline "$BASELINE_FILE" \
          --quiet
        CURRENT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$BASELINE_FILE")
        echo "Baseline generated ($CURRENT violations). Once merged, future runs will enforce."
        exit 0
      fi
    else
      echo "No baseline on main — first-time setup."
      echo "Generating initial baseline..."
      periphery scan \
        --config "$CONFIG_FILE" \
        --write-baseline "$BASELINE_FILE" \
        --quiet
      CURRENT=$(python3 -c "import json,sys; d=json.load(open(sys.argv[1])); print(len(d.get('v1',{}).get('usrs',[])))" "$BASELINE_FILE")
      echo "Baseline generated ($CURRENT violations). Once merged, future runs will enforce."
      exit 0
    fi
  fi
fi

# --- Determine which baseline to compare against ---
if [ -n "$REFERENCE_BASELINE" ]; then
  if [ ! -f "$REFERENCE_BASELINE" ]; then
    echo "Error: Reference baseline not found at $REFERENCE_BASELINE"
    exit 1
  fi
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

# --- Run scan ---
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

# --- USR set-differentiation enforcement ---
# Find NEW violations not present in the baseline.
# This catches any new dead code even if the same number of old violations were removed.
NEW_USRS=$(python3 -c "
import json, sys
baseline = set(json.load(open(sys.argv[1])).get('v1', {}).get('usrs', []))
current  = set(json.load(open(sys.argv[2])).get('v1', {}).get('usrs', []))
new_usrs = sorted(current - baseline)
for u in new_usrs:
    print(u)
" "$COMPARE_FILE" /tmp/periphery_current.json)

NEW_COUNT=$(echo "$NEW_USRS" | grep -c . || true)

if [ "$NEW_COUNT" -gt 0 ]; then
  echo ""
  echo "error: $NEW_COUNT new dead-code violation(s) introduced."
  echo "The following USRs are in the current scan but NOT in the baseline:"
  echo "$NEW_USRS"
  echo ""
  echo "Remove the unused code or update the baseline with:"
  echo "  bash clients/scripts/periphery-scan.sh --update-baseline"

  echo ""
  echo "Detailed new violations:"
  periphery scan \
    --config "$CONFIG_FILE" \
    --baseline "$COMPARE_FILE" 2>&1 || true

  exit 1
fi

if [ "$CURRENT" -lt "$BASELINE_COUNT" ]; then
  REMOVED=$((BASELINE_COUNT - CURRENT))
  echo "$REMOVED violation(s) removed. Consider updating the baseline:"
  echo "  bash clients/scripts/periphery-scan.sh --update-baseline"
fi

echo "Periphery check passed (no new violations)."
