/**
 * Guard tests for assistant feature flag conventions:
 *
 * 1. Key format: all feature flag keys used in production code must follow the
 *    canonical `feature_flags.<flag_id>.enabled` format. Any remaining
 *    `skills.<id>.enabled` usage outside of migration/backward-compat code is
 *    flagged.
 *
 * 2. Declaration coverage: every flag key used in `isAssistantFeatureFlagEnabled`
 *    or `isAssistantSkillEnabled` calls must be declared in the defaults registry
 *    at `meta/assistant-feature-flags/assistant-feature-flag-defaults.json`.
 *    This prevents drift between code and registry.
 */

import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve the repo root from the assistant/ package directory. */
function getRepoRoot(): string {
  return join(process.cwd(), '..');
}

/**
 * Files allowed to contain `skills.<id>.enabled` string literals because they
 * are part of the backward-compat / migration layer or are test files
 * exercising legacy paths.
 */
const LEGACY_KEY_ALLOWLIST = new Set([
  // Canonical resolver: contains the legacy key mapping function
  'assistant/src/config/assistant-feature-flags.ts',
  // Legacy wrapper (deprecated, kept for migration)
  'assistant/src/config/skill-state.ts',
  // Type definitions documenting the legacy format
  'assistant/src/config/types.ts',
  // Gateway feature flags route: reads legacy keys for backward compat
  'gateway/src/http/routes/feature-flags.ts',
  // Gateway feature flag defaults loader
  'gateway/src/feature-flag-defaults.ts',
]);

function isTestFile(filePath: string): boolean {
  return (
    filePath.includes('/__tests__/') ||
    filePath.endsWith('.test.ts') ||
    filePath.endsWith('.test.js') ||
    filePath.endsWith('.spec.ts') ||
    filePath.endsWith('.spec.js')
  );
}

// ---------------------------------------------------------------------------
// Guard 1: Key format — no stale `skills.<id>.enabled` in production code
// ---------------------------------------------------------------------------

describe('assistant feature flag key format guard', () => {
  test('no production TypeScript files use skills.<id>.enabled outside allowlist', () => {
    const repoRoot = getRepoRoot();

    // Search for string literals containing `skills.*.enabled` in .ts files
    // under assistant/src/ (excluding test files and allowlisted paths)
    let grepOutput = '';
    try {
      grepOutput = execSync(
        `git grep -lE "skills\\.[a-z0-9_-]+\\.enabled" -- 'assistant/src/**/*.ts'`,
        { encoding: 'utf-8', cwd: repoRoot },
      ).trim();
    } catch (err) {
      // Exit code 1 means no matches — happy path
      if ((err as { status?: number }).status === 1) {
        return;
      }
      throw err;
    }

    const files = grepOutput.split('\n').filter((f) => f.length > 0);
    const violations = files.filter((f) => {
      if (isTestFile(f)) return false;
      if (LEGACY_KEY_ALLOWLIST.has(f)) return false;
      return true;
    });

    if (violations.length > 0) {
      const message = [
        'Found production TypeScript files using legacy `skills.<id>.enabled` key format.',
        'Use the canonical `feature_flags.<id>.enabled` format instead.',
        'Call `isAssistantSkillEnabled(skillId, config)` which constructs the canonical key automatically.',
        '',
        'Violations:',
        ...violations.map((f) => `  - ${f}`),
        '',
        'If this is a legitimate backward-compat path, add it to LEGACY_KEY_ALLOWLIST in',
        'assistant-feature-flag-guardrails.test.ts.',
      ].join('\n');

      expect(violations, message).toEqual([]);
    }
  });
});

// ---------------------------------------------------------------------------
// Guard 2: Declaration coverage — every flag used in code is in the registry
// ---------------------------------------------------------------------------

describe('assistant feature flag declaration coverage guard', () => {
  test('all flag keys referenced in isAssistantFeatureFlagEnabled/isAssistantSkillEnabled calls are declared in the defaults registry', () => {
    const repoRoot = getRepoRoot();

    // Load the defaults registry
    const registryPath = join(repoRoot, 'meta', 'assistant-feature-flags', 'assistant-feature-flag-defaults.json');
    const registry: Record<string, unknown> = JSON.parse(
      readFileSync(registryPath, 'utf-8'),
    );
    const declaredKeys = new Set(Object.keys(registry));

    // Collect skill IDs from isAssistantSkillEnabled calls in production code.
    // We use git grep with -P (perl regex) for reliable parenthesis handling.
    const usedKeys = new Set<string>();

    // Extract skill IDs from isAssistantSkillEnabled('<skillId>', ...) in non-test files
    let skillLines = '';
    try {
      skillLines = execSync(
        `git grep -n "isAssistantSkillEnabled" -- 'assistant/src/**/*.ts' ':!assistant/src/__tests__/**'`,
        { encoding: 'utf-8', cwd: repoRoot },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }

    if (skillLines) {
      for (const line of skillLines.split('\n')) {
        // Match isAssistantSkillEnabled('skillId' or "skillId"
        const match = line.match(/isAssistantSkillEnabled\(\s*['"]([a-z0-9_-]+)['"]/);
        if (match) {
          usedKeys.add(`feature_flags.${match[1]}.enabled`);
        }
      }
    }

    // Extract full keys from isAssistantFeatureFlagEnabled('<key>', ...) in non-test files
    let flagLines = '';
    try {
      flagLines = execSync(
        `git grep -n "isAssistantFeatureFlagEnabled" -- 'assistant/src/**/*.ts' ':!assistant/src/__tests__/**'`,
        { encoding: 'utf-8', cwd: repoRoot },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }

    if (flagLines) {
      for (const line of flagLines.split('\n')) {
        // Match isAssistantFeatureFlagEnabled('key' or "key"
        const match = line.match(/isAssistantFeatureFlagEnabled\(\s*['"]([^'"]+)['"]/);
        if (match) {
          usedKeys.add(match[1]);
        }
      }
    }

    // Filter out the function definitions themselves (export function ...) and
    // the generic delegation in assistant-feature-flags.ts that uses a
    // template expression rather than a literal key
    // e.g. `isAssistantFeatureFlagEnabled(\`feature_flags.${skillId}.enabled\`, config)`

    // Check that all used keys are declared in the registry
    const undeclared: string[] = [];
    for (const key of usedKeys) {
      if (!declaredKeys.has(key)) {
        undeclared.push(key);
      }
    }

    if (undeclared.length > 0) {
      const message = [
        'Found feature flag keys used in production code that are NOT declared in the defaults registry.',
        `Registry: meta/assistant-feature-flags/assistant-feature-flag-defaults.json`,
        '',
        'Undeclared keys:',
        ...undeclared.map((k) => `  - ${k}`),
        '',
        'To fix: add the missing key(s) to the defaults registry with a defaultEnabled value and description.',
      ].join('\n');

      expect(undeclared, message).toEqual([]);
    }
  });
});
