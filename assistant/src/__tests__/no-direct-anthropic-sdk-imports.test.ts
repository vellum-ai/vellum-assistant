import { execSync } from 'node:child_process';
import { describe, expect, test } from 'bun:test';

/**
 * Guard test: production files under assistant/src must not import
 * `@anthropic-ai/sdk` directly. Only the canonical provider adapter is
 * allowed to use the SDK.
 *
 * Allowlist entries should be kept minimal — add a path here only if it
 * genuinely needs to talk to the Anthropic SDK without going through the
 * provider abstraction.
 */
const ALLOWED_FILES = new Set([
  'assistant/src/providers/anthropic/client.ts',
]);

describe('no direct @anthropic-ai/sdk imports', () => {
  test('production files do not import @anthropic-ai/sdk outside allowlist', () => {
    let grepOutput = '';
    try {
      grepOutput = execSync(
        `git grep -l "@anthropic-ai/sdk" -- 'assistant/src/**/*.ts'`,
        { encoding: 'utf-8', cwd: process.cwd() + '/..' },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — that's the happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput
      .split('\n')
      .filter((f) => f.length > 0)
      // Exclude test files — they legitimately mock the SDK
      .filter((f) => !f.includes('/__tests__/'));
    const violations = files.filter((f) => !ALLOWED_FILES.has(f));

    expect(violations).toEqual([]);
  });
});
