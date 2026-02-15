#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Test runner with full process isolation for Bun mock.module conflicts
#
# Bun's mock.module is process-global: the last mock.module call for a given
# specifier wins across ALL test files in the process.  This means test files
# that mock a module break other test files that need the real implementation.
# To avoid order-dependent CI flakes, run each test file in its own Bun process.
# ---------------------------------------------------------------------------

EXCLUDE_EXPERIMENTAL="${EXCLUDE_EXPERIMENTAL:-false}"

EXPERIMENTAL_FILES=(
  "skill-load-tool.test.ts"
  "memory-regressions.experimental.test.ts"
)

found_test=0
while IFS= read -r test_file; do
  found_test=1

  if [[ "${EXCLUDE_EXPERIMENTAL}" == "true" ]]; then
    base_name="$(basename "${test_file}")"
    skip=0
    for ef in "${EXPERIMENTAL_FILES[@]}"; do
      if [[ "${base_name}" == "${ef}" ]]; then skip=1; break; fi
    done
    if [[ ${skip} -eq 1 ]]; then
      echo "==> Skipping ${test_file} (experimental)"
      continue
    fi
    echo "==> Running ${test_file}"
    bun test --test-name-pattern '^(?!.*\[experimental\])' "${test_file}"
  else
    echo "==> Running ${test_file}"
    bun test "${test_file}"
  fi
done < <(find src/__tests__ -maxdepth 1 -type f -name '*.test.ts' | sort)

if [[ ${found_test} -eq 0 ]]; then
  echo "No test files found under src/__tests__"
  exit 1
fi
