#!/usr/bin/env bash
# compare-perf-baselines.sh
# Parses XCTest performance output and compares against stored baselines.
# Informational only — prints a summary table and posts to PR comments
# but never fails CI. Regressions exceeding the threshold are flagged
# with a warning emoji for human review.
set -uo pipefail

BASELINE_DIR=".perf-baselines"
BASELINE_FILE="$BASELINE_DIR/baselines.json"
RESULTS_LOG="$BASELINE_DIR/results.log"
REGRESSION_THRESHOLD_PCT=80
# Minimum absolute increase (in seconds) required to flag a regression.
# Differences below this are noise regardless of percentage (e.g., 0.0000s→0.0010s = +inf% but only 1ms).
MIN_ABSOLUTE_DELTA=0.010

if [[ ! -f "$RESULTS_LOG" ]]; then
  echo "No results log at $RESULTS_LOG. Skipping baseline comparison."
  exit 0
fi

# Delegate all parsing, comparison, and baseline update to Python.
UPDATE_BASELINE="${UPDATE_BASELINE:-true}"

# Run comparison in Python. The `|| true` ensures CI never fails even if
# the Python script hits an unexpected error (e.g., malformed baseline JSON).
python3 - "$RESULTS_LOG" "$BASELINE_FILE" "$REGRESSION_THRESHOLD_PCT" "$BASELINE_DIR" "$UPDATE_BASELINE" "$MIN_ABSOLUTE_DELTA" << 'PYEOF' || true
import re, sys, json, os, traceback

results_log      = sys.argv[1]
baseline_file    = sys.argv[2]
threshold        = float(sys.argv[3])
baseline_dir     = sys.argv[4]
update_baseline  = sys.argv[5].lower() == "true"
min_abs_delta    = float(sys.argv[6])

# Human-readable descriptions for each performance test.
DESCRIPTIONS = {
    "testAnchorVisibilityTrackerRapidUpdateStress": "Scroll anchor rapid updates",
    "testAttributedStringCacheHitPerformance": "Attributed string cache hit",
    "testFullRenderPipelinePerformance": "Full markdown render pipeline",
    "testGroupedSegmentsPerformance": "Grouped message segments",
    "testLargeConversationMarkdownPipelineThroughput": "Large conversation markdown",
    "testLargeTreeCompleteReplacement": "AX tree full replacement",
    "testLargeTreeIdentical": "AX tree identical diff",
    "testMarkdownParsePerformance": "Markdown parse (small)",
    "testMarkdownParsePerformanceLargeInput": "Markdown parse (large)",
    "testMediumTreeManyChanges": "AX tree medium many changes",
    "testSmallTreeSmallDiff": "AX tree small diff",
}

def label(name):
    return DESCRIPTIONS.get(name, name)

# Parse XCTest metric lines. We extract three metrics per test:
#   - CPU Time, s          (thread-level CPU time)
#   - CPU Instructions Retired, kI  (hardware counter — may be 0 on shared CI)
#   - CPU Cycles, kC       (hardware counter — may be 0 on shared CI)
#
# Format: Test Case '-[Suite.Class testMethod]' measured [<metric>] average: N.NNN, ...
METRICS = {
    "CPU Time, s":                   "cpu_time",
    "CPU Instructions Retired, kI":  "cpu_instructions",
    "CPU Cycles, kC":                "cpu_cycles",
}

metric_pattern = re.compile(
    r"(?:"
    r"-\[(?:[^\]]*\s+)?(\w+)\]['\"]?"
    r"|Test Case '(?:[^/']+/)?(\w+)'"
    r")"
    r"\s+measured \[([^\]]+)\] average:\s+([0-9.]+)"
)

# results[test_name] = {"cpu_time": float, "cpu_instructions": float, "cpu_cycles": float}
results = {}
with open(results_log) as f:
    for line in f:
        m = metric_pattern.search(line)
        if m:
            test_name = m.group(1) or m.group(2)
            metric_label = m.group(3)
            value = float(m.group(4))
            if metric_label in METRICS:
                key = METRICS[metric_label]
                if test_name not in results:
                    results[test_name] = {}
                if key not in results[test_name]:
                    results[test_name][key] = value

summary_file = os.path.join(baseline_dir, "summary.md")

if not results:
    print("ERROR: No XCTest performance measurements found in log.")
    print("This likely means the performance tests did not run or produced no output.")
    with open(summary_file, "w") as sf:
        sf.write("## Performance Baselines\n\nNo performance measurements found in test output.\n")
    # Informational only — do not fail CI
    sys.exit(0)

print("=== Performance Results ===")
for name in sorted(results):
    m = results[name]
    parts = []
    if "cpu_time" in m:
        parts.append(f"cpu={m['cpu_time']:.4f}s")
    if "cpu_instructions" in m:
        parts.append(f"instr={m['cpu_instructions']:.0f}kI")
    if "cpu_cycles" in m:
        parts.append(f"cycles={m['cpu_cycles']:.0f}kC")
    print(f"  {label(name)}: {', '.join(parts)}")
print()

# Metric version tag for baseline migration detection.
METRIC_VERSION = "multi-metric-v1"

# First run or metric migration.
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
        blob = {"_metric": METRIC_VERSION}
        for name, metrics in results.items():
            blob[name] = metrics
        with open(baseline_file, "w") as f:
            json.dump(blob, f, indent=2)
        print(f"No valid baseline found. Recorded current results as baseline ({baseline_file}).")
        with open(summary_file, "w") as sf:
            sf.write("## Performance Baselines\n\nBaseline recorded for the first time. Future runs will compare against these values.\n")
    else:
        print("WARNING: No valid baseline found and this is a PR run (UPDATE_BASELINE=false).")
        print("Skipping regression check for this PR run.")
        with open(summary_file, "w") as sf:
            sf.write("## Performance Baselines\n\nNo baseline available yet. Run the workflow on `main` to establish baselines.\n")
    sys.exit(0)

# Load stored baselines (metric version already verified).
baselines = {k: v for k, v in stored.items() if k != "_metric"}

def fmt_delta(baseline_val, actual_val):
    """Return (delta_pct, abs_delta, is_regressed) for a single metric value."""
    ad = actual_val - baseline_val
    if baseline_val == 0:
        dp = float('inf') if actual_val > 0 else 0.0
    else:
        dp = (actual_val - baseline_val) / baseline_val * 100
    regressed = dp > threshold and ad > min_abs_delta
    return dp, ad, regressed

# Compare and build table rows.
regressions = []
rows = []
print("=== Regression Check (threshold: {}%, min delta: {:.3f}s) ===".format(int(threshold), min_abs_delta))

for name in sorted(results):
    actual = results[name]
    bl = baselines.get(name)

    # Format metric cells: "value (delta%)" for each metric
    def metric_cell(key, unit, fmt_val, fmt_bl):
        a = actual.get(key)
        if a is None:
            return "—"
        if bl is None or key not in bl:
            return fmt_val(a)
        b = bl[key]
        dp, ad, _ = fmt_delta(b, a)
        if dp == float('inf'):
            return f"{fmt_val(a)} (+inf%)"
        return f"{fmt_val(a)} ({dp:+.0f}%)"

    def fmt_s(v):
        return f"{v:.4f}s"
    def fmt_ki(v):
        return f"{v:.0f}kI" if v > 0 else "0"
    def fmt_kc(v):
        return f"{v:.0f}kC" if v > 0 else "0"

    cpu_time_cell = metric_cell("cpu_time", "s", fmt_s, fmt_s)
    instr_cell = metric_cell("cpu_instructions", "kI", fmt_ki, fmt_ki)
    cycles_cell = metric_cell("cpu_cycles", "kC", fmt_kc, fmt_kc)

    # Regression is based on cpu_time only (instructions/cycles may be 0 on GH Actions).
    if bl is None or "cpu_time" not in actual:
        status = "🆕 NEW"
        print(f"  NEW      {label(name)}")
    else:
        cpu_bl = bl.get("cpu_time", 0)
        cpu_act = actual["cpu_time"]
        dp, ad, is_reg = fmt_delta(cpu_bl, cpu_act)
        if is_reg:
            status = "⚠️ regressed"
            regressions.append(name)
        else:
            status = "✅ ok"
        print(f"  {'WARN' if is_reg else 'ok  ':9s} {label(name)}: cpu={cpu_bl:.4f}s→{cpu_act:.4f}s ({dp:+.1f}%, abs={ad:+.4f}s)")

    rows.append(f"| {label(name)} | {cpu_time_cell} | {instr_cell} | {cycles_cell} | {status} |")

print()

with open(summary_file, "w") as sf:
    sf.write("## Performance Baselines\n\n")
    sf.write("| Test | CPU Time | Instructions | Cycles | Status |\n")
    sf.write("|------|----------|-------------|--------|--------|\n")
    for row in rows:
        sf.write(row + "\n")
    sf.write(f"\n**Regression gate**: informational only (threshold: {int(threshold)}% AND >{min_abs_delta:.3f}s)\n")

if regressions:
    print(f"WARNING: {len(regressions)} test(s) exceed {threshold:.0f}% threshold: {', '.join(label(n) for n in regressions)}")
    print("This is informational only — CI will not fail.")

# Update baseline only on main-branch pushes.
if update_baseline:
    updated = {"_metric": METRIC_VERSION}
    for name in set(list(baselines.keys()) + list(results.keys())):
        if name in results:
            updated[name] = results[name]
        elif name in baselines:
            updated[name] = baselines[name]
    with open(baseline_file, "w") as f:
        json.dump(updated, f, indent=2)
    print("Baseline updated.")
else:
    print("Baseline not updated (PR run).")

# Informational only — always exit 0.
sys.exit(0)
PYEOF
