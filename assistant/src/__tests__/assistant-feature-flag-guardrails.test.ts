/**
 * Guard tests for assistant feature flag conventions:
 *
 * 1. Key format: all feature flag keys used in production code must follow the
 *    canonical `feature_flags.<flag_id>.enabled` format. Any remaining
 *    `skills.<id>.enabled` usage outside of migration/backward-compat code is
 *    flagged — including template literal forms like `skills.${skillId}.enabled`.
 *
 * 2. Declaration coverage: every bundled skill and vellum skill must have a
 *    corresponding `feature_flags.<id>.enabled` entry in the defaults registry
 *    at `meta/assistant-feature-flags/assistant-feature-flag-defaults.json`.
 *    This prevents drift between registered skills and the feature flag registry.
 */

import { execSync } from 'node:child_process';
import { readdirSync, readFileSync, statSync } from 'node:fs';
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

    // Search for string literals and template literals containing
    // `skills.<id>.enabled` or `skills.${...}.enabled` in .ts files
    // under assistant/src/ and gateway/src/ (excluding test files and
    // allowlisted paths). The pattern catches both literal keys
    // (e.g., `skills.foo.enabled`) and template literal forms
    // (e.g., `skills.${skillId}.enabled`).
    let grepOutput = '';
    try {
      grepOutput = execSync(
        `git grep -lE "skills\\.[a-z0-9_-]+\\.enabled|skills\\.\\$\\{" -- 'assistant/src/**/*.ts' 'gateway/src/**/*.ts'`,
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
  test('all bundled and vellum skill IDs have a corresponding entry in the defaults registry', () => {
    const repoRoot = getRepoRoot();

    // Load the defaults registry
    const registryPath = join(repoRoot, 'meta', 'assistant-feature-flags', 'assistant-feature-flag-defaults.json');
    const registry: Record<string, unknown> = JSON.parse(
      readFileSync(registryPath, 'utf-8'),
    );
    const declaredKeys = new Set(Object.keys(registry));

    // Collect all skill IDs from bundled skills and vellum skills.
    // The runtime passes these IDs dynamically to isAssistantSkillEnabled,
    // so rather than trying to parse variable names from call sites, we
    // enumerate the skill directories directly.
    const allSkillIds = new Set<string>();

    // 1. Bundled skills: each subdirectory in bundled-skills/ is a skill ID
    const bundledSkillsDir = join(repoRoot, 'assistant', 'src', 'config', 'bundled-skills');
    const bundledEntries = readdirSync(bundledSkillsDir);
    for (const entry of bundledEntries) {
      const fullPath = join(bundledSkillsDir, entry);
      if (statSync(fullPath).isDirectory()) {
        allSkillIds.add(entry);
      }
    }

    // 2. Vellum skills: read IDs from the catalog.json manifest
    const catalogPath = join(repoRoot, 'assistant', 'src', 'config', 'vellum-skills', 'catalog.json');
    const catalog = JSON.parse(readFileSync(catalogPath, 'utf-8'));
    for (const skill of catalog.skills) {
      allSkillIds.add(skill.id);
    }

    // Verify that each skill ID has a corresponding feature flag entry
    const undeclared: string[] = [];
    for (const skillId of allSkillIds) {
      const key = `feature_flags.${skillId}.enabled`;
      if (!declaredKeys.has(key)) {
        undeclared.push(key);
      }
    }

    if (undeclared.length > 0) {
      const message = [
        'Found skill IDs without a corresponding entry in the feature flag defaults registry.',
        `Registry: meta/assistant-feature-flags/assistant-feature-flag-defaults.json`,
        '',
        'Missing entries:',
        ...undeclared.sort().map((k) => `  - ${k}`),
        '',
        'To fix: add the missing key(s) to the defaults registry with a defaultEnabled value and description.',
      ].join('\n');

      expect(undeclared, message).toEqual([]);
    }
  });

  test('all literal flag keys in isAssistantFeatureFlagEnabled calls are declared in the defaults registry', () => {
    const repoRoot = getRepoRoot();

    // Load the defaults registry
    const registryPath = join(repoRoot, 'meta', 'assistant-feature-flags', 'assistant-feature-flag-defaults.json');
    const registry: Record<string, unknown> = JSON.parse(
      readFileSync(registryPath, 'utf-8'),
    );
    const declaredKeys = new Set(Object.keys(registry));

    // Extract full keys from isAssistantFeatureFlagEnabled('<key>', ...) calls
    // in non-test production files. We read each matching file and apply a
    // multiline regex so that calls split across lines are still caught:
    //
    //   isAssistantFeatureFlagEnabled(
    //     'feature_flags.foo.enabled',
    //     config,
    //   )
    //
    const usedKeys = new Set<string>();
    let matchingFiles = '';
    try {
      matchingFiles = execSync(
        `git grep -l "isAssistantFeatureFlagEnabled" -- 'assistant/src/**/*.ts' ':!assistant/src/__tests__/**'`,
        { encoding: 'utf-8', cwd: repoRoot },
      ).trim();
    } catch (err) {
      if ((err as { status?: number }).status !== 1) throw err;
    }

    if (matchingFiles) {
      // Multiline regex: match the function name, optional whitespace/newlines,
      // opening paren, optional whitespace/newlines, then a quoted string key.
      const multilinePattern = /isAssistantFeatureFlagEnabled\(\s*['"]([^'"]+)['"]/g;
      for (const relPath of matchingFiles.split('\n')) {
        if (!relPath) continue;
        const absPath = join(repoRoot, relPath);
        const content = readFileSync(absPath, 'utf-8');
        let match: RegExpExecArray | null;
        while ((match = multilinePattern.exec(content))) {
          usedKeys.add(match[1]!);
        }
        // Reset lastIndex since we reuse the regex across files
        multilinePattern.lastIndex = 0;
      }
    }

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
