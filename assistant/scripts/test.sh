#!/usr/bin/env bash
set -e

# ---------------------------------------------------------------------------
# Test runner with process isolation for mock.module conflicts
#
# Bun's mock.module is process-global: the last mock.module call for a given
# specifier wins across ALL test files in the process.  This means test files
# that mock a module break other test files that need the real implementation.
#
# Conflicting pairs:
#   secure-keys.test.ts  mocks  keychain.js              → breaks  keychain.test.ts
#   secret-scanner-executor.test.ts  mocks  config/loader.js     → breaks  key-migration.test.ts
#   secret-scanner-executor.test.ts  mocks  tool-usage-store.js  → breaks  audit-log-rotation.test.ts
#
# We run the "victim" files in their own bun processes, then run the rest
# together in a single process for speed.
# ---------------------------------------------------------------------------

# Files that need process isolation (their dependencies are mocked by other files)
bun test src/__tests__/keychain.test.ts
bun test src/__tests__/key-migration.test.ts
bun test src/__tests__/audit-log-rotation.test.ts

# Remaining tests run together — no mock conflicts among these
bun test \
  src/__tests__/checker.test.ts \
  src/__tests__/clipboard.test.ts \
  src/__tests__/diff.test.ts \
  src/__tests__/encrypted-store.test.ts \
  src/__tests__/fuzzy-match.test.ts \
  src/__tests__/parser.test.ts \
  src/__tests__/ratelimit.test.ts \
  src/__tests__/secret-allowlist.test.ts \
  src/__tests__/secret-scanner.test.ts \
  src/__tests__/secret-scanner-executor.test.ts \
  src/__tests__/secure-keys.test.ts \
  src/__tests__/trust-store.test.ts \
  src/__tests__/web-search.test.ts
