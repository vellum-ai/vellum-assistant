import { execSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { describe, expect, test } from 'bun:test';

/**
 * Guard tests for assistant feature flags.
 *
 * 1. Key format validation: ensure production code uses the canonical
 *    `feature_flags.<flagId>.enabled` format, not the legacy
 *    `skills.<id>.enabled` format.
 *
 * 2. Declaration coverage: ensure all flag keys in the defaults registry
 *    conform to the canonical format.
 *
 * See AGENTS.md "Assistant Feature Flags" for the full convention.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Resolve repo root (tests run from assistant/) */
function getRepoRoot(): string {
  return join(process.cwd(), '..');
}

function getRegistryPath(): string {
  return join(getRepoRoot(), 'meta', 'assistant-feature-flags', 'assistant-feature-flag-defaults.json');
}

function loadRegistry(): Record<string, unknown> {
  const raw = readFileSync(getRegistryPath(), 'utf-8');
  return JSON.parse(raw);
}

const CANONICAL_KEY_RE = /^feature_flags\.[a-z0-9][a-z0-9._-]*\.enabled$/;

/**
 * Files allowed to contain the legacy `skills.<id>.enabled` key format.
 * Keep this list minimal — only files that genuinely need to reference
 * the legacy format for backward compatibility.
 */
const LEGACY_KEY_ALLOWLIST = new Set([
  // Gateway route handler: reads legacy keys from persisted config for backward compat
  'gateway/src/http/routes/feature-flags.ts',
  // Assistant resolver: maps canonical to legacy keys for backward compat reads
  'assistant/src/config/assistant-feature-flags.ts',
  // macOS client: fallback reads from legacy config section
  'clients/macos/vellum-assistant/Features/Settings/SettingsAccountTab.swift',
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
// Test: key format validation
// ---------------------------------------------------------------------------

describe('assistant feature flag guard', () => {
  test('no production files use legacy skills.<id>.enabled key format outside allowlist', () => {
    // Search for the legacy key pattern in string literals across the codebase.
    // The pattern matches quoted strings like 'skills.browser.enabled' or
    // "skills.browser.enabled".
    const pattern = `['"]skills\\.[a-z][a-z0-9._-]*\\.enabled['"]`;

    let grepOutput = '';
    try {
      grepOutput = execSync(
        `git grep -lE ${JSON.stringify(pattern)} -- '*.ts' '*.js' '*.swift'`,
        { encoding: 'utf-8', cwd: getRepoRoot() },
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
        'Found production files using the legacy `skills.<id>.enabled` key format.',
        'New code must use the canonical format: `feature_flags.<id>.enabled`.',
        'See AGENTS.md "Assistant Feature Flags" for the convention.',
        '',
        'Violations:',
        ...violations.map((f) => `  - ${f}`),
        '',
        'To fix: replace `skills.<id>.enabled` with `feature_flags.<id>.enabled`.',
        'If backward-compat access is genuinely needed, add to LEGACY_KEY_ALLOWLIST in assistant-feature-flag-guard.test.ts.',
      ].join('\n');

      expect(violations, message).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Test: defaults registry key format
  // ---------------------------------------------------------------------------

  test('all keys in the defaults registry use the canonical feature_flags.<id>.enabled format', () => {
    const registry = loadRegistry();
    const keys = Object.keys(registry);

    const violations = keys.filter((key) => !CANONICAL_KEY_RE.test(key));

    if (violations.length > 0) {
      const message = [
        'Found keys in the defaults registry that do not match the canonical format.',
        'Expected format: feature_flags.<flagId>.enabled',
        '',
        'Violations:',
        ...violations.map((k) => `  - ${k}`),
      ].join('\n');

      expect(violations, message).toEqual([]);
    }
  });

  // ---------------------------------------------------------------------------
  // Test: registry entries have required fields
  // ---------------------------------------------------------------------------

  test('all entries in the defaults registry have required fields (defaultEnabled, description)', () => {
    const registry = loadRegistry();
    const violations: string[] = [];

    for (const [key, value] of Object.entries(registry)) {
      if (!value || typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${key}: entry is not an object`);
        continue;
      }
      const entry = value as Record<string, unknown>;
      if (typeof entry.defaultEnabled !== 'boolean') {
        violations.push(`${key}: missing or non-boolean 'defaultEnabled'`);
      }
      if (typeof entry.description !== 'string' || entry.description.length === 0) {
        violations.push(`${key}: missing or empty 'description'`);
      }
    }

    if (violations.length > 0) {
      const message = [
        'Found entries in the defaults registry with missing or invalid required fields.',
        '',
        'Violations:',
        ...violations.map((v) => `  - ${v}`),
      ].join('\n');

      expect(violations, message).toEqual([]);
    }
  });
});
