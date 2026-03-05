#!/usr/bin/env bash
# compare-perf-baselines.sh
# Parses XCTest performance output from swift test and compares against stored
# baselines. Exits 1 if any metric exceeds baseline by more than REGRESSION_THRESHOLD_PCT.
set -euo pipefail

BASELINE_DIR=".perf-baselines"
BASELINE_FILE="$BASELINE_DIR/baselines.json"
RESULTS_LOG="$BASELINE_DIR/results.log"
REGRESSION_THRESHOLD_PCT=15

# swift test --filter writes timing lines like:
#   measured [Time, seconds] average: 0.001234, relative standard deviation: 3.456%, values: [...]
# Capture these from the test run log (swift test output was redirected to results.log in the workflow).
# If the log doesn't exist yet (first run or no redirect), skip gracefully.
if [[ ! -f "$RESULTS_LOG" ]]; then
  echo "No results log found at $RESULTS_LOG. Skipping baseline comparison."
  exit 0
fi

# Parse average times from the log. Output: "TestName average_seconds"
parse_results() {
  grep -E "measured \[Time, seconds\] average:" "$RESULTS_LOG" | \
    sed -E 's/.*-\[.*\.([^]]+)\].* average: ([0-9.]+).*/\1 \2/'
}

RESULTS=$(parse_results)
if [[ -z "$RESULTS" ]]; then
  echo "No performance measurements found in $RESULTS_LOG. Skipping regression check."
  exit 0
fi

echo "=== Performance Results ==="
echo "$RESULTS"
echo ""

# If no stored baseline, save current as baseline and pass.
if [[ ! -f "$BASELINE_FILE" ]]; then
  echo "No baseline found. Recording current results as baseline."
  mkdir -p "$BASELINE_DIR"
  echo "$RESULTS" | python3 -c "
import sys, json
data = {}
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) == 2:
        data[parts[0]] = float(parts[1])
print(json.dumps(data, indent=2))
" > "$BASELINE_FILE"
  echo "Baseline saved to $BASELINE_FILE"
  exit 0
fi

# Compare against stored baseline.
REGRESSIONS=$(echo "$RESULTS" | python3 -c "
import sys, json

threshold = $REGRESSION_THRESHOLD_PCT
with open('$BASELINE_FILE') as f:
    baselines = json.load(f)

regressions = []
for line in sys.stdin:
    parts = line.strip().split()
    if len(parts) != 2:
        continue
    name, actual = parts[0], float(parts[1])
    if name not in baselines:
        continue
    baseline = baselines[name]
    delta_pct = (actual - baseline) / baseline * 100
    status = 'REGRESSED' if delta_pct > threshold else 'ok'
    print(f'{status:10s} {name}: baseline={baseline:.4f}s actual={actual:.4f}s delta={delta_pct:+.1f}%')
    if delta_pct > threshold:
        regressions.append(name)

if regressions:
    sys.exit(1)
")

EXIT_CODE=$?
echo "$REGRESSIONS"
echo ""

if [[ $EXIT_CODE -ne 0 ]]; then
  echo "FAIL: Performance regressions detected (threshold: ${REGRESSION_THRESHOLD_PCT}%)."
  exit 1
fi

echo "PASS: No performance regressions detected."
exit 0
