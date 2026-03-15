#!/usr/bin/env bash
set -euo pipefail

# Design token guardrail script
# Detects raw color usage that should go through the design token system.
# Usage: check-design-tokens.sh --mode=ratchet|strict

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CLIENTS_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"
BASELINE_FILE="$SCRIPT_DIR/design-token-guard-baseline.txt"

MODE="strict"
for arg in "$@"; do
  case "$arg" in
    --mode=*) MODE="${arg#--mode=}" ;;
    *) echo "Unknown argument: $arg"; exit 1 ;;
  esac
done

if [[ "$MODE" != "ratchet" && "$MODE" != "strict" ]]; then
  echo "Usage: $0 [--mode=ratchet|strict]  (default: strict)"
  exit 1
fi

# Run grep from CLIENTS_DIR so paths are relative (e.g., macos/foo/bar.swift:42:...)
cd "$CLIENTS_DIR"

# Scope: macOS + shared only (exclude ios/)
SCOPE="--include=*.swift"
SCOPE_DIRS="./macos ./shared"

VIOLATIONS=""

# Rule A: Color(hex:) outside token files
RULE_A=$(grep -rn 'Color(hex:' $SCOPE_DIRS $SCOPE | grep -v 'shared/DesignSystem/Tokens/' | sed 's|^\./||' || true)
if [[ -n "$RULE_A" ]]; then
  VIOLATIONS="${VIOLATIONS}${RULE_A}"$'\n'
fi

# Rule B: adaptiveColor( outside token files
RULE_B=$(grep -rn 'adaptiveColor(' $SCOPE_DIRS $SCOPE | grep -v 'shared/DesignSystem/Tokens/' | sed 's|^\./||' || true)
if [[ -n "$RULE_B" ]]; then
  VIOLATIONS="${VIOLATIONS}${RULE_B}"$'\n'
fi

# Rule C: Legacy CSS variable names without --v- prefix
RULE_C=$(grep -rn -E '\-\-(bg|bg-subtle|text|text-secondary|border|accent|accent-text):' $SCOPE_DIRS $SCOPE | sed 's|^\./||' || true)
if [[ -n "$RULE_C" ]]; then
  VIOLATIONS="${VIOLATIONS}${RULE_C}"$'\n'
fi

# Rule D: Legacy systemDanger* references (renamed to systemNegative*)
RULE_D=$(grep -rn 'systemDanger' $SCOPE_DIRS $SCOPE | sed 's|^\./||' || true)
if [[ -n "$RULE_D" ]]; then
  VIOLATIONS="${VIOLATIONS}${RULE_D}"$'\n'
fi

# Rule E: Raw palette enum usage outside token files
RULE_E=$(grep -rn -E '\b(Emerald|Danger|Amber|Stone|Slate|Moss|Forest|Sage)\._[0-9]' $SCOPE_DIRS $SCOPE | grep -v 'shared/DesignSystem/Tokens/' | sed 's|^\./||' || true)
if [[ -n "$RULE_E" ]]; then
  VIOLATIONS="${VIOLATIONS}${RULE_E}"$'\n'
fi

# Rule F: Direct non-semantic color literals outside token files and allowlist
# Matches: .white, .black, .red, .orange, .yellow, .green, .blue, .gray (but not .clear)
RULE_F=$(grep -rn -E '\.(white|black|red|orange|yellow|green|blue|gray)\b' $SCOPE_DIRS $SCOPE \
  | grep -v 'shared/DesignSystem/Tokens/' \
  | grep -v 'Tests/' \
  | grep -v 'VellumQLThumbnail/' \
  | grep -v '// color-literal-ok' \
  | sed 's|^\./||' || true)
if [[ -n "$RULE_F" ]]; then
  VIOLATIONS="${VIOLATIONS}${RULE_F}"$'\n'
fi

# Normalize: trim trailing newlines, sort, deduplicate
VIOLATIONS=$(echo "$VIOLATIONS" | sed '/^$/d' | sort -u)

if [[ -z "$VIOLATIONS" ]]; then
  echo "No design token violations found."
  exit 0
fi

VIOLATION_COUNT=$(echo "$VIOLATIONS" | wc -l | tr -d ' ')

if [[ "$MODE" == "strict" ]]; then
  echo "=== STRICT MODE: $VIOLATION_COUNT violation(s) found ==="
  echo "$VIOLATIONS"
  exit 1
fi

# Ratchet mode: compare against baseline
if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "ERROR: Baseline file not found at $BASELINE_FILE"
  echo "Run in strict mode first and capture output to create a baseline."
  exit 1
fi

BASELINE=$(sort -u "$BASELINE_FILE")

# Find new violations not in baseline
NEW_VIOLATIONS=""
while IFS= read -r line; do
  if ! echo "$BASELINE" | grep -qxF "$line"; then
    NEW_VIOLATIONS="${NEW_VIOLATIONS}${line}"$'\n'
  fi
done <<< "$VIOLATIONS"

NEW_VIOLATIONS=$(echo "$NEW_VIOLATIONS" | sed '/^$/d')

# Count remaining baseline violations (informational)
REMAINING_BASELINE=0
while IFS= read -r line; do
  if echo "$VIOLATIONS" | grep -qxF "$line"; then
    REMAINING_BASELINE=$((REMAINING_BASELINE + 1))
  fi
done <<< "$BASELINE"

echo "=== RATCHET MODE ==="
echo "Total violations: $VIOLATION_COUNT"
echo "Baseline violations remaining: $REMAINING_BASELINE"

if [[ -n "$NEW_VIOLATIONS" ]]; then
  NEW_COUNT=$(echo "$NEW_VIOLATIONS" | wc -l | tr -d ' ')
  echo ""
  echo "FAIL: $NEW_COUNT NEW violation(s) found (not in baseline):"
  echo "$NEW_VIOLATIONS"
  exit 1
else
  echo "PASS: No new violations found."
  exit 0
fi
