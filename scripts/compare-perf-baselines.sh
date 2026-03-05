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
UPDATE_BASELINE="${UPDATE_BASELINE:-true}"

python3 - "$RESULTS_LOG" "$BASELINE_FILE" "$REGRESSION_THRESHOLD_PCT" "$BASELINE_DIR" "$UPDATE_BASELINE" << 'PYEOF'
import re, sys, json, os

results_log      = sys.argv[1]
baseline_file    = sys.argv[2]
threshold        = float(sys.argv[3])
baseline_dir     = sys.argv[4]
update_baseline  = sys.argv[5].lower() == "true"

# Parse XCTest timing lines. Format (macOS XCTest via swift test):
#   Test Case '-[Suite.ClassName testMethodName]' measured [Clock Monotonic Time, s] average: N.NNN, ...
#
# The metric type varies across Xcode versions — older: "[Time, seconds]",
# newer (Xcode 15+): "[Clock Monotonic Time, s]".  After the closing ']' of the
# test name the output includes a single-quote "'" before the space and "measured".
# We track "Clock Monotonic Time" (wall clock) and fall back to any "Time, seconds"
# line.  Multiple metric lines appear per test; the first matching one wins so
# subsequent CPU-cycles/instructions lines don't overwrite the wall-time result.
pattern = re.compile(
    r"-\[(?:[^\]]*\s+)?(\w+)\]['\"]*\s+measured \[(?:Clock Monotonic Time, s|Time, seconds)\] average:\s+([0-9.]+)"
)

results = {}
with open(results_log) as f:
    for line in f:
        m = pattern.search(line)
        if m:
            results[m.group(1)] = float(m.group(2))

if not results:
    print("ERROR: No XCTest performance measurements found in log.")
    print("This likely means the performance tests did not run or produced no output.")
    print("Check that MarkdownPerformanceTests executed successfully.")
    sys.exit(1)

print("=== Performance Results ===")
for name, avg in sorted(results.items()):
    print(f"  {name}: {avg:.4f}s")
print()

# First run: no baseline file yet.
# On main push runs, record current results as baseline and pass.
# On PR runs (update_baseline=false), skip comparison rather than silently
# establishing a baseline from the PR — that would let regressions slip through.
if not os.path.exists(baseline_file):
    if update_baseline:
        os.makedirs(baseline_dir, exist_ok=True)
        with open(baseline_file, "w") as f:
            json.dump(results, f, indent=2)
        print(f"No baseline found. Recorded current results as baseline ({baseline_file}).")
    else:
        print("WARNING: No baseline found and this is a PR run (UPDATE_BASELINE=false).")
        print("Run the workflow on main to establish a baseline before regressions can be detected.")
        print("Skipping regression check for this PR run.")
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
    if baseline == 0:
        delta_pct = float('inf') if actual > 0 else 0.0
    else:
        delta_pct = (actual - baseline) / baseline * 100
    status    = "REGRESSED" if delta_pct > threshold else "ok       "
    print(f"  {status} {name}: baseline={baseline:.4f}s actual={actual:.4f}s delta={delta_pct:+.1f}%")
    if delta_pct > threshold:
        regressions.append(name)

print()

if regressions:
    print(f"FAIL: {len(regressions)} regression(s) exceed {threshold:.0f}% threshold: {', '.join(regressions)}")
    sys.exit(1)

# Update baseline only on main-branch pushes to prevent PR runs from
# ratcheting the baseline downward and masking future regressions.
if update_baseline:
    updated = {**baselines, **results}
    with open(baseline_file, "w") as f:
        json.dump(updated, f, indent=2)
    print("PASS: No regressions detected. Baseline updated.")
else:
    print("PASS: No regressions detected. (Baseline not updated on PR run.)")
PYEOF
