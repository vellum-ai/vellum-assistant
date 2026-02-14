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

found_test=0
while IFS= read -r test_file; do
  found_test=1
  echo "==> Running ${test_file}"
  if [[ "${EXCLUDE_EXPERIMENTAL}" == "true" ]]; then
    bun test --test-name-pattern '^(?!.*\[experimental\])' "${test_file}"
  else
    bun test "${test_file}"
  fi
done < <(find src/__tests__ -maxdepth 1 -type f -name '*.test.ts' | sort)

if [[ ${found_test} -eq 0 ]]; then
  echo "No test files found under src/__tests__"
  exit 1
fi
