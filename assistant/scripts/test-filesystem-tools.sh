#!/usr/bin/env bash
set -euo pipefail

# ---------------------------------------------------------------------------
# Focused regression runner for filesystem-related tests.
#
# Runs each test file in its own Bun process (same isolation as test.sh)
# to avoid mock.module cross-contamination.
# ---------------------------------------------------------------------------

FILESYSTEM_TESTS=(
  "src/__tests__/size-guard.test.ts"
  "src/__tests__/edit-engine.test.ts"
  "src/__tests__/fuzzy-match.test.ts"
  "src/__tests__/fuzzy-match-property.test.ts"
  "src/__tests__/shared-filesystem-errors.test.ts"
  "src/__tests__/path-policy.test.ts"
  "src/__tests__/file-ops-service.test.ts"
  "src/__tests__/file-read-tool.test.ts"
  "src/__tests__/file-write-tool.test.ts"
  "src/__tests__/file-edit-tool.test.ts"
  "src/__tests__/host-file-read-tool.test.ts"
  "src/__tests__/host-file-write-tool.test.ts"
  "src/__tests__/host-file-edit-tool.test.ts"
)

passed=0
failed=0

for test_file in "${FILESYSTEM_TESTS[@]}"; do
  if [[ ! -f "${test_file}" ]]; then
    echo "SKIP ${test_file} (not found)"
    continue
  fi
  echo "==> Running ${test_file}"
  if bun test "${test_file}"; then
    ((passed++))
  else
    ((failed++))
  fi
done

echo ""
echo "=== Filesystem tools: ${passed} files passed, ${failed} files failed ==="

if [[ ${failed} -gt 0 ]]; then
  exit 1
fi
