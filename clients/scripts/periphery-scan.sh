#!/usr/bin/env bash
set -euo pipefail

# Periphery dead-code scanner for the macOS/shared Swift codebase.
#
# Self-contained script that handles installation, scanning, baseline management,
# and enforcement. Designed to be called from any CI workflow (PR, main, release)
# or locally with a single command.
#
# Enforcement uses two-layer USR set-differentiation:
#
#   Layer 1 (baseline-to-baseline): In CI mode, the PR's committed baseline
#   is compared against origin/main's baseline. Any USRs present in the PR
#   baseline but absent from main cause a failure — this prevents adding new
#   dead code to the baseline.
#
#   Layer 2 (scan-to-baseline): A fresh Periphery scan is compared against
#   the committed baseline. New USRs in the scan that aren't in the baseline
#   indicate stale or inaccurate baselines. In CI mode this is informational
#   (warning); locally it's enforced (error).
#
# This two-layer approach avoids false positives from baseline drift on main
# while still catching genuinely new dead code.
#
# Usage:
#   periphery-scan.sh                              Scan and enforce against committed baseline
#   periphery-scan.sh --ci                          CI mode: two-layer enforcement (see above)
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

# --- CI mode: verify committed baseline doesn't introduce new violations vs main ---
if [ "$CI_MODE" = true ] && [ -n "$REFERENCE_BASELINE" ] && [ -f "$BASELINE_FILE" ]; then
  BASELINE_ADDED=$(python3 -c "
import json, sys
main = set(json.load(open(sys.argv[1])).get('v1', {}).get('usrs', []))
pr   = set(json.load(open(sys.argv[2])).get('v1', {}).get('usrs', []))
for u in sorted(pr - main):
    print(u)
" "$REFERENCE_BASELINE" "$BASELINE_FILE")

  ADDED_COUNT=$(echo "$BASELINE_ADDED" | grep -c . || true)

  REMOVED_COUNT=$(python3 -c "
import json, sys
main = set(json.load(open(sys.argv[1])).get('v1', {}).get('usrs', []))
pr   = set(json.load(open(sys.argv[2])).get('v1', {}).get('usrs', []))
print(len(main - pr))
" "$REFERENCE_BASELINE" "$BASELINE_FILE")

  echo "Baseline comparison: $REMOVED_COUNT removed vs main, $ADDED_COUNT added."

  if [ "$ADDED_COUNT" -gt 0 ]; then
    echo ""
    echo "error: Committed baseline adds $ADDED_COUNT new USR(s) not present on main."
    echo "These USRs suggest new dead code was added and included in the baseline:"
    echo "$BASELINE_ADDED"
    echo ""
    echo "Remove the unused code, or if the baseline was updated on main, rebase your branch."
    exit 1
  fi
fi

# --- Determine which baseline to compare against ---
# In CI mode, use the committed baseline (not main's) for the scan comparison.
# The baseline-to-baseline check above already enforces against main.
if [ "$CI_MODE" = true ] && [ -f "$BASELINE_FILE" ]; then
  COMPARE_FILE="$BASELINE_FILE"
  echo "Using committed baseline: $BASELINE_FILE"
elif [ -n "$REFERENCE_BASELINE" ]; then
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
  if [ "$CI_MODE" = true ]; then
    echo ""
    echo "warning: $NEW_COUNT scan violation(s) not in committed baseline (likely baseline drift)."
    echo "Consider running locally: bash clients/scripts/periphery-scan.sh --update-baseline"
    SCAN_DRIFT=true
  else
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
fi

if [ "$CURRENT" -lt "$BASELINE_COUNT" ]; then
  REMOVED=$((BASELINE_COUNT - CURRENT))
  echo "$REMOVED violation(s) removed. Consider updating the baseline:"
  echo "  bash clients/scripts/periphery-scan.sh --update-baseline"
fi

if [ "${SCAN_DRIFT:-false}" = true ]; then
  echo "Periphery check passed (baseline OK vs main; scan drift noted above)."
else
  echo "Periphery check passed (no new violations)."
fi
