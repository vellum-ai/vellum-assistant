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
#   Test Case '-[Suite.ClassName testMethodName]' measured [CPU Time, s] average: N.NNN, ...
#
# We track "CPU Time" rather than wall clock ("Clock Monotonic Time") because
# CPU time is far more stable on shared CI runners, eliminating false regression
# alerts caused by noisy wall-clock measurements.  Multiple metric lines appear
# per test; we match only the CPU Time line.
pattern = re.compile(
    r"(?:"
    r"-\[(?:[^\]]*\s+)?(\w+)\]['\"]?"          # ObjC: -[Suite.Class testMethod]
    r"|Test Case '(?:[^/']+/)?(\w+)'"           # SwiftPM: Test Case 'Module.Class/testMethod'
    r")"
    r"\s+measured \[CPU Time, s\] average:\s+([0-9.]+)"
)

results = {}
with open(results_log) as f:
    for line in f:
        m = pattern.search(line)
        if m:
            test_name = m.group(1) or m.group(2)
            if test_name not in results:  # first match wins (CPU Time appears once per test)
                results[test_name] = float(m.group(3))

summary_file = os.path.join(baseline_dir, "summary.md")

if not results:
    print("ERROR: No XCTest performance measurements found in log.")
    print("This likely means the performance tests did not run or produced no output.")
    print("Check that MarkdownPerformanceTests executed successfully.")
    with open(summary_file, "w") as sf:
        sf.write("## Performance Baselines\n\nNo performance measurements found in test output.\n")
    sys.exit(1)

print("=== Performance Results ===")
for name, avg in sorted(results.items()):
    print(f"  {name}: {avg:.4f}s")
print()

# Metric version tag stored in baselines.json.  When the metric type changes
# (e.g., from wall-clock to CPU time), stored values are invalid and must be
# re-established — otherwise the comparison exits with false regressions before
# updating the baseline, creating a stuck state.
METRIC_VERSION = "cpu-time-v1"

# First run or metric migration: no baseline file, or baseline from a different metric.
needs_fresh_baseline = False
if not os.path.exists(baseline_file):
    needs_fresh_baseline = True
else:
    with open(baseline_file) as f:
        stored = json.load(f)
    if stored.get("_metric") != METRIC_VERSION:
        print(f"Baseline metric mismatch (expected '{METRIC_VERSION}', got '{stored.get('_metric', 'none')}'). Re-establishing baseline.")
        needs_fresh_baseline = True

if needs_fresh_baseline:
    if update_baseline:
        os.makedirs(baseline_dir, exist_ok=True)
        with open(baseline_file, "w") as f:
            json.dump({"_metric": METRIC_VERSION, **results}, f, indent=2)
        print(f"No valid baseline found. Recorded current results as baseline ({baseline_file}).")
        with open(summary_file, "w") as sf:
            sf.write("## Performance Baselines\n\nBaseline recorded for the first time. Future runs will compare against these values.\n")
    else:
        print("WARNING: No valid baseline found and this is a PR run (UPDATE_BASELINE=false).")
        print("Run the workflow on main to establish a baseline before regressions can be detected.")
        print("Skipping regression check for this PR run.")
        with open(summary_file, "w") as sf:
            sf.write("## Performance Baselines\n\nNo baseline available yet. Run the workflow on `main` to establish baselines.\n")
    sys.exit(0)

# Load and compare against stored baseline (metric version already verified).
baselines = {k: v for k, v in stored.items() if k != "_metric"}

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

# Write summary.md with a formatted table for PR comments and step summaries.
rows = []
for name, actual in sorted(results.items()):
    if name not in baselines:
        rows.append(f"| {name} | — | {actual:.4f}s | — | 🆕 NEW |")
        continue
    baseline = baselines[name]
    if baseline == 0:
        dp = float('inf') if actual > 0 else 0.0
    else:
        dp = (actual - baseline) / baseline * 100
    status = "❌ REGRESSED" if dp > threshold else "✅ ok"
    rows.append(f"| {name} | {baseline:.4f}s | {actual:.4f}s | {dp:+.1f}% | {status} |")

with open(summary_file, "w") as sf:
    sf.write("## Performance Baselines\n\n")
    sf.write("| Test | Baseline | Actual | Delta | Status |\n")
    sf.write("|------|----------|--------|-------|--------|\n")
    for row in rows:
        sf.write(row + "\n")
    sf.write(f"\n**Threshold**: {int(threshold)}%\n")

if regressions:
    print(f"FAIL: {len(regressions)} regression(s) exceed {threshold:.0f}% threshold: {', '.join(regressions)}")
    sys.exit(1)

# Update baseline only on main-branch pushes to prevent PR runs from
# ratcheting the baseline downward and masking future regressions.
if update_baseline:
    updated = {"_metric": METRIC_VERSION, **baselines, **results}
    with open(baseline_file, "w") as f:
        json.dump(updated, f, indent=2)
    print("PASS: No regressions detected. Baseline updated.")
else:
    print("PASS: No regressions detected. (Baseline not updated on PR run.)")
PYEOF
