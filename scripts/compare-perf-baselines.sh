#!/usr/bin/env bash
# compare-perf-baselines.sh
# Parses XCTest performance output and compares against stored baselines.
# Exits 1 if any metric regresses by more than REGRESSION_THRESHOLD_PCT.
set -uo pipefail

BASELINE_DIR=".perf-baselines"
BASELINE_FILE="$BASELINE_DIR/baselines.json"
RESULTS_LOG="$BASELINE_DIR/results.log"
REGRESSION_THRESHOLD_PCT=15

if [[ ! -f "$RESULTS_LOG" ]]; then
  echo "No results log at $RESULTS_LOG. Skipping baseline comparison."
  exit 0
fi

# Delegate all parsing, comparison, and baseline update to Python.
# Avoids bash/sed fragility with test names that contain spaces, and handles
# the set-e + subprocess-exit-code pitfall by using a single Python invocation.
python3 - "$RESULTS_LOG" "$BASELINE_FILE" "$REGRESSION_THRESHOLD_PCT" "$BASELINE_DIR" << 'PYEOF'
import re, sys, json, os

results_log    = sys.argv[1]
baseline_file  = sys.argv[2]
threshold      = float(sys.argv[3])
baseline_dir   = sys.argv[4]

# Parse XCTest timing lines. Format:
#   Test Case '-[Suite.ClassName testMethodName]' measured [Time, seconds] average: N.NNN, ...
# The regex captures the method name (last whitespace-separated token before ']').
pattern = re.compile(
    r"-\[(?:[^\]]*\s+)?(\w+)\]\s+measured \[Time, seconds\] average:\s+([0-9.]+)"
)

results = {}
with open(results_log) as f:
    for line in f:
        m = pattern.search(line)
        if m:
            results[m.group(1)] = float(m.group(2))

if not results:
    print("No XCTest performance measurements found in log. Skipping comparison.")
    sys.exit(0)

print("=== Performance Results ===")
for name, avg in sorted(results.items()):
    print(f"  {name}: {avg:.4f}s")
print()

# First run: no baseline file yet — record current results and pass.
if not os.path.exists(baseline_file):
    os.makedirs(baseline_dir, exist_ok=True)
    with open(baseline_file, "w") as f:
        json.dump(results, f, indent=2)
    print(f"No baseline found. Recorded current results as baseline ({baseline_file}).")
    sys.exit(0)

# Load and compare against stored baseline.
with open(baseline_file) as f:
    baselines = json.load(f)

regressions = []
print("=== Regression Check (threshold: {}%) ===".format(int(threshold)))
for name, actual in sorted(results.items()):
    if name not in baselines:
        print(f"  NEW      {name}: {actual:.4f}s (no prior baseline)")
        continue
    baseline  = baselines[name]
    delta_pct = (actual - baseline) / baseline * 100
    status    = "REGRESSED" if delta_pct > threshold else "ok       "
    print(f"  {status} {name}: baseline={baseline:.4f}s actual={actual:.4f}s delta={delta_pct:+.1f}%")
    if delta_pct > threshold:
        regressions.append(name)

print()

if regressions:
    print(f"FAIL: {len(regressions)} regression(s) exceed {threshold:.0f}% threshold: {', '.join(regressions)}")
    sys.exit(1)

# Update baseline with latest results so it tracks gradual performance changes.
updated = {**baselines, **results}
with open(baseline_file, "w") as f:
    json.dump(updated, f, indent=2)

print("PASS: No regressions detected. Baseline updated.")
PYEOF
