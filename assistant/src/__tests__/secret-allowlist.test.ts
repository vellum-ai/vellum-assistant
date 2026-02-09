import { describe, test, expect, beforeEach, afterEach, mock } from 'bun:test';
import { writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

// Mock the data dir to a temp directory so tests don't touch ~/.vellum/
let testDir: string;

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => testDir,
}));

import { isAllowlisted, resetAllowlist, loadAllowlist } from '../security/secret-allowlist.js';
import { scanText } from '../security/secret-scanner.js';

describe('secret-allowlist', () => {
  beforeEach(() => {
    testDir = join(tmpdir(), `vellum-allowlist-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    mkdirSync(testDir, { recursive: true });
    resetAllowlist();
  });

  afterEach(() => {
    resetAllowlist();
    if (existsSync(testDir)) {
      rmSync(testDir, { recursive: true, force: true });
    }
  });

  // -----------------------------------------------------------------------
  // No file — should not error, everything still detected
  // -----------------------------------------------------------------------
  test('works when no allowlist file exists', () => {
    expect(isAllowlisted('AKIAIOSFODNN7REALKEY')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Exact values
  // -----------------------------------------------------------------------
  test('suppresses exact values', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ values: ['my-test-api-key-12345'] }),
    );
    expect(isAllowlisted('my-test-api-key-12345')).toBe(true);
    expect(isAllowlisted('my-test-api-key-99999')).toBe(false);
  });

  test('exact values are case-sensitive', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ values: ['MyTestKey'] }),
    );
    expect(isAllowlisted('MyTestKey')).toBe(true);
    expect(isAllowlisted('mytestkey')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Prefix matching
  // -----------------------------------------------------------------------
  test('suppresses values matching a prefix', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ prefixes: ['my-internal-'] }),
    );
    expect(isAllowlisted('my-internal-key-abc123')).toBe(true);
    expect(isAllowlisted('other-key-abc123')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Regex patterns
  // -----------------------------------------------------------------------
  test('suppresses values matching a regex pattern', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ patterns: ['^ci-test-[a-z0-9]+$'] }),
    );
    expect(isAllowlisted('ci-test-abc123')).toBe(true);
    expect(isAllowlisted('ci-prod-abc123')).toBe(false);
  });

  test('invalid regex is skipped without crashing', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ patterns: ['[invalid', '^valid$'] }),
    );
    loadAllowlist();
    // The valid pattern should still work
    expect(isAllowlisted('valid')).toBe(true);
    // Invalid regex is skipped, not thrown
    expect(isAllowlisted('other')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Combined rules
  // -----------------------------------------------------------------------
  test('combines values, prefixes, and patterns', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({
        values: ['exact-match-value'],
        prefixes: ['test-prefix-'],
        patterns: ['^regex-[0-9]+$'],
      }),
    );
    expect(isAllowlisted('exact-match-value')).toBe(true);
    expect(isAllowlisted('test-prefix-anything')).toBe(true);
    expect(isAllowlisted('regex-12345')).toBe(true);
    expect(isAllowlisted('none-of-the-above')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Malformed file
  // -----------------------------------------------------------------------
  test('handles malformed JSON gracefully', () => {
    writeFileSync(join(testDir, 'secret-allowlist.json'), 'not json{{{');
    loadAllowlist();
    // Should not throw, just log warning
    expect(isAllowlisted('anything')).toBe(false);
  });

  test('handles non-array fields gracefully', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ values: 'not-an-array', prefixes: 42 }),
    );
    loadAllowlist();
    expect(isAllowlisted('not-an-array')).toBe(false);
  });

  // -----------------------------------------------------------------------
  // Integration with scanText
  // -----------------------------------------------------------------------
  test('allowlisted values are suppressed by scanText', () => {
    const awsKey = 'AKIAIOSFODNN7REALKEY';
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ values: [awsKey] }),
    );
    resetAllowlist();

    const matches = scanText(`Found key: ${awsKey}`);
    const aws = matches.filter((m) => m.type === 'AWS Access Key');
    expect(aws).toHaveLength(0);
  });

  test('non-allowlisted values are still detected by scanText', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ values: ['AKIAIOSFODNN7OTHERKE'] }),
    );
    resetAllowlist();

    const matches = scanText('Found key: AKIAIOSFODNN7REALKEY');
    const aws = matches.filter((m) => m.type === 'AWS Access Key');
    expect(aws).toHaveLength(1);
  });

  test('prefix allowlist suppresses pattern matches', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ prefixes: ['ghp_AAAA'] }),
    );
    resetAllowlist();

    const token = `ghp_AAAA${'B'.repeat(32)}`;
    const matches = scanText(`token=${token}`);
    const gh = matches.filter((m) => m.type === 'GitHub Token');
    expect(gh).toHaveLength(0);
  });

  // -----------------------------------------------------------------------
  // resetAllowlist
  // -----------------------------------------------------------------------
  test('resetAllowlist clears cached state', () => {
    writeFileSync(
      join(testDir, 'secret-allowlist.json'),
      JSON.stringify({ values: ['test-value'] }),
    );
    loadAllowlist();
    expect(isAllowlisted('test-value')).toBe(true);

    // Reset and remove file — should no longer be allowlisted
    resetAllowlist();
    rmSync(join(testDir, 'secret-allowlist.json'));
    expect(isAllowlisted('test-value')).toBe(false);
  });
});
