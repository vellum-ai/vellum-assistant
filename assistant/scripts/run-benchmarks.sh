#!/usr/bin/env bash
set -uo pipefail

# ---------------------------------------------------------------------------
# Benchmark runner that outputs JSON results for CI regression detection.
#
# Runs each *.benchmark.test.ts file in its own process (same isolation
# strategy as test.sh) and captures pass/fail + wall-clock duration.
#
# Output: writes benchmark-results.json to the working directory with
# per-file timing data suitable for baseline comparison.
# ---------------------------------------------------------------------------

RESULTS_FILE="${BENCHMARK_RESULTS_FILE:-benchmark-results.json}"

results_dir="$(mktemp -d)"
trap 'rm -rf "${results_dir}"' EXIT

bench_files=()
while IFS= read -r f; do
  bench_files+=("$f")
done < <(find src/__tests__ -maxdepth 1 -type f -name '*.benchmark.test.ts' | sort)

if [[ ${#bench_files[@]} -eq 0 ]]; then
  echo "No benchmark files found"
  exit 1
fi

echo "Running ${#bench_files[@]} benchmark files"

overall_pass=true

for bench_file in "${bench_files[@]}"; do
  base="$(basename "${bench_file}")"
  safe_name="$(echo "${bench_file}" | tr "/" "_")"
  out_file="${results_dir}/${safe_name}.out"

  start_ms=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')
  bun test "${bench_file}" > "${out_file}" 2>&1
  exit_code=$?
  end_ms=$(perl -MTime::HiRes=time -e 'printf "%d", time*1000')

  elapsed=$(( end_ms - start_ms ))

  if [[ ${exit_code} -ne 0 ]]; then
    echo "  FAIL ${base} (${elapsed}ms)"
    echo "${bench_file}" >> "${results_dir}/failures"
    overall_pass=false
  else
    echo "  PASS ${base} (${elapsed}ms)"
  fi

  # Store per-file result as a line of JSON
  echo "{\"file\":\"${base}\",\"duration_ms\":${elapsed},\"passed\":$([ ${exit_code} -eq 0 ] && echo true || echo false)}" >> "${results_dir}/results.jsonl"
done

# Build final JSON output
{
  echo "{"
  echo "  \"timestamp\": \"$(date -u +%Y-%m-%dT%H:%M:%SZ)\","
  echo "  \"commit\": \"${GITHUB_SHA:-$(git rev-parse HEAD 2>/dev/null || echo unknown)}\","
  echo "  \"results\": ["
  first=true
  while IFS= read -r line; do
    if [ "$first" = true ]; then
      first=false
    else
      echo ","
    fi
    printf "    %s" "$line"
  done < "${results_dir}/results.jsonl"
  echo ""
  echo "  ]"
  echo "}"
} > "${RESULTS_FILE}"

echo ""
echo "Results written to ${RESULTS_FILE}"

# Print failures if any
if [[ -f "${results_dir}/failures" ]]; then
  echo ""
  echo "Failed benchmarks:"
  while IFS= read -r f; do
    safe_name="$(echo "${f}" | tr "/" "_")"
    echo "──────────────────────────────────────────"
    echo "FAIL: ${f}"
    echo "──────────────────────────────────────────"
    cat "${results_dir}/${safe_name}.out"
    echo ""
  done < "${results_dir}/failures"
  exit 1
fi

echo "All ${#bench_files[@]} benchmark files passed"
