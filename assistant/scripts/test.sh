#!/usr/bin/env bash
set -uo pipefail

# ---------------------------------------------------------------------------
# Test runner with full process isolation for Bun mock.module conflicts
#
# Bun's mock.module is process-global: the last mock.module call for a given
# specifier wins across ALL test files in the process.  This means test files
# that mock a module break other test files that need the real implementation.
# To avoid order-dependent CI flakes, run each test file in its own Bun process.
#
# Files run in parallel (configurable via TEST_WORKERS, default: CPU count).
# ---------------------------------------------------------------------------

EXCLUDE_EXPERIMENTAL="${EXCLUDE_EXPERIMENTAL:-false}"
WORKERS="${TEST_WORKERS:-$(sysctl -n hw.logicalcpu 2>/dev/null || nproc 2>/dev/null || echo 8)}"

EXPERIMENTAL_FILES=(
  "skill-load-tool.test.ts"
  "memory-regressions.experimental.test.ts"
)

# Collect test files, filtering experimental if needed
test_files=()
while IFS= read -r test_file; do
  if [[ "${EXCLUDE_EXPERIMENTAL}" == "true" ]]; then
    base_name="$(basename "${test_file}")"
    skip=0
    for ef in "${EXPERIMENTAL_FILES[@]}"; do
      if [[ "${base_name}" == "${ef}" ]]; then
        skip=1
        break
      fi
    done
    if [[ ${skip} -eq 1 ]]; then
      continue
    fi
  fi
  # Always exclude benchmark files — run them with `bun run test:bench` instead
  if [[ "$(basename "${test_file}")" == *.benchmark.test.ts ]]; then
    continue
  fi

  test_files+=("${test_file}")
done < <(find src/__tests__ -maxdepth 1 -type f -name '*.test.ts' | sort)

if [[ ${#test_files[@]} -eq 0 ]]; then
  echo "No test files found under src/__tests__"
  exit 1
fi

echo "Running ${#test_files[@]} test files (${WORKERS} workers)"

# Temp dir for per-file output capture and failure tracking
results_dir="$(mktemp -d)"
trap 'rm -rf "${results_dir}"' EXIT

# Run tests in parallel, capturing output per file
printf '%s\n' "${test_files[@]}" | xargs -P "${WORKERS}" -I {} bash -c '
  test_file="$1"
  results_dir="$2"
  exclude_exp="$3"

  safe_name="$(echo "${test_file}" | tr "/" "_")"
  out_file="${results_dir}/${safe_name}.out"
  time_file="${results_dir}/${safe_name}.time"

  start_ms=$(perl -MTime::HiRes=time -e "printf \"%d\", time*1000")

  if [[ "${exclude_exp}" == "true" ]]; then
    bun test --test-name-pattern "^(?!.*\\[experimental\\])" "${test_file}" > "${out_file}" 2>&1
  else
    bun test "${test_file}" > "${out_file}" 2>&1
  fi
  exit_code=$?

  end_ms=$(perl -MTime::HiRes=time -e "printf \"%d\", time*1000")
  elapsed=$(( end_ms - start_ms ))

  base="$(basename "${test_file}")"
  if [[ ${exit_code} -ne 0 ]]; then
    echo "${test_file}" >> "${results_dir}/failures"
    echo "  ✗ ${base} (${elapsed}ms)"
  else
    echo "  ✓ ${base} (${elapsed}ms)"
  fi
' _ {} "${results_dir}" "${EXCLUDE_EXPERIMENTAL}"
xargs_exit=$?

# Verify tests actually ran — catch xargs startup failures (e.g. invalid TEST_WORKERS)
actual_runs=$(ls "${results_dir}"/*.out 2>/dev/null | wc -l)
if [[ ${actual_runs} -eq 0 ]]; then
  echo "ERROR: No tests were executed (xargs exit code: ${xargs_exit})"
  exit 1
fi

# xargs exits 125-127 for its own errors (not child failures) — treat as hard failure
if [[ ${xargs_exit} -ge 125 ]]; then
  echo "ERROR: xargs failed with exit code ${xargs_exit}"
  exit 1
fi

# Print output for any failed tests
if [[ -f "${results_dir}/failures" ]]; then
  echo ""
  failed_count=0
  while IFS= read -r f; do
    failed_count=$((failed_count + 1))
    safe_name="$(echo "${f}" | tr "/" "_")"
    echo "──────────────────────────────────────────"
    echo "FAIL: ${f}"
    echo "──────────────────────────────────────────"
    cat "${results_dir}/${safe_name}.out"
    echo ""
  done < "${results_dir}/failures"

  echo "========================================"
  echo "  FAILED TEST FILES (${failed_count}):"
  echo "========================================"
  while IFS= read -r f; do
    echo "  ✗ ${f}"
  done < "${results_dir}/failures"
  echo "========================================"
  exit 1
fi

echo "All ${#test_files[@]} test files passed"
