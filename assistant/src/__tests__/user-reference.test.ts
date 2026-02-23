import { describe, test, expect, mock, beforeEach } from 'bun:test';
import { join } from 'node:path';

const TEST_DIR = '/tmp/vellum-user-ref-test';

mock.module('../util/platform.js', () => ({
  getWorkspacePromptPath: (file: string) => join(TEST_DIR, file),
}));

// Mutable state the tests control
let mockFileExists = false;
let mockFileContent = '';

mock.module('node:fs', () => ({
  existsSync: (path: string) => {
    if (path === join(TEST_DIR, 'USER.md')) return mockFileExists;
    return false;
  },
  readFileSync: (path: string, _encoding: string) => {
    if (path === join(TEST_DIR, 'USER.md') && mockFileExists) return mockFileContent;
    throw new Error(`ENOENT: no such file: ${path}`);
  },
}));

// Import after mocks are in place
const { resolveUserReference } = await import('../config/user-reference.js');

describe('resolveUserReference', () => {
  beforeEach(() => {
    mockFileExists = false;
    mockFileContent = '';
  });

  test('returns "my human" when USER.md does not exist', () => {
    mockFileExists = false;
    expect(resolveUserReference()).toBe('my human');
  });

  test('returns "my human" when preferred name field is empty', () => {
    mockFileExists = true;
    mockFileContent = [
      '## Onboarding Snapshot',
      '',
      '- Preferred name/reference:',
      '- Goals:',
      '- Locale:',
    ].join('\n');
    expect(resolveUserReference()).toBe('my human');
  });

  test('returns the configured name when it is set', () => {
    mockFileExists = true;
    mockFileContent = [
      '## Onboarding Snapshot',
      '',
      '- Preferred name/reference: John',
      '- Goals: ship fast',
      '- Locale: en-US',
    ].join('\n');
    expect(resolveUserReference()).toBe('John');
  });

  test('trims whitespace around the configured name', () => {
    mockFileExists = true;
    mockFileContent = '- Preferred name/reference:   Alice   \n';
    expect(resolveUserReference()).toBe('Alice');
  });
});
