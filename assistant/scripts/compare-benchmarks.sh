#!/usr/bin/env bash
set -uo pipefail

# ---------------------------------------------------------------------------
# Compare current benchmark results against a baseline and alert on >10%
# regressions. Exits non-zero if any benchmark regressed beyond the threshold.
#
# Usage: compare-benchmarks.sh <baseline.json> <current.json>
# ---------------------------------------------------------------------------

THRESHOLD="${BENCHMARK_REGRESSION_THRESHOLD:-10}"

if [[ $# -lt 2 ]]; then
  echo "Usage: $0 <baseline.json> <current.json>"
  exit 1
fi

BASELINE="$1"
CURRENT="$2"

if [[ ! -f "${BASELINE}" ]]; then
  echo "No baseline found at ${BASELINE} — skipping regression check (first run)"
  exit 0
fi

if [[ ! -f "${CURRENT}" ]]; then
  echo "ERROR: Current results not found at ${CURRENT}"
  exit 1
fi

echo "Comparing benchmarks (regression threshold: ${THRESHOLD}%)"
echo "Baseline commit: $(jq -r '.commit // "unknown"' "${BASELINE}")"
echo "Current commit:  $(jq -r '.commit // "unknown"' "${CURRENT}")"
echo ""

regressions=0
comparisons=0

# For each file in the current results, find its baseline and compare
while IFS= read -r file; do
  current_ms=$(jq -r --arg f "$file" '.results[] | select(.file == $f) | .duration_ms' "${CURRENT}")
  baseline_ms=$(jq -r --arg f "$file" '.results[] | select(.file == $f) | .duration_ms' "${BASELINE}")

  if [[ -z "${baseline_ms}" || "${baseline_ms}" == "null" ]]; then
    echo "  NEW  ${file}: ${current_ms}ms (no baseline)"
    continue
  fi

  comparisons=$((comparisons + 1))

  if [[ "${baseline_ms}" -eq 0 ]]; then
    echo "  SKIP ${file}: baseline was 0ms"
    continue
  fi

  # Calculate percentage change: (current - baseline) / baseline * 100
  pct_change=$(( (current_ms - baseline_ms) * 100 / baseline_ms ))

  if [[ ${pct_change} -gt ${THRESHOLD} ]]; then
    echo "  REGR ${file}: ${baseline_ms}ms -> ${current_ms}ms (+${pct_change}%)"
    regressions=$((regressions + 1))
  elif [[ ${pct_change} -lt -${THRESHOLD} ]]; then
    echo "  IMPR ${file}: ${baseline_ms}ms -> ${current_ms}ms (${pct_change}%)"
  else
    echo "  OK   ${file}: ${baseline_ms}ms -> ${current_ms}ms (${pct_change:+${pct_change}}%)"
  fi
done < <(jq -r '.results[].file' "${CURRENT}")

echo ""
echo "Compared ${comparisons} benchmarks, found ${regressions} regression(s)"

if [[ ${regressions} -gt 0 ]]; then
  echo ""
  echo "WARNING: ${regressions} benchmark(s) regressed by more than ${THRESHOLD}%"
  # Write to GitHub step summary if available
  if [[ -n "${GITHUB_STEP_SUMMARY:-}" ]]; then
    {
      echo "### Benchmark Regression Detected"
      echo ""
      echo "${regressions} benchmark(s) regressed by more than ${THRESHOLD}%."
      echo "Check the workflow output for details."
    } >> "${GITHUB_STEP_SUMMARY}"
  fi
  exit 1
fi

echo "No regressions detected"
