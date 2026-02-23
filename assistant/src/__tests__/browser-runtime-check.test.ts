import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock playwright before importing runtime-check.
// Use real filesystem paths so we don't need to mock node:fs
// (mocking node:fs globally poisons other test files in the same worker).
let mockExecPath = '/bin/sh'; // a path that always exists
let mockExecThrows = false;

mock.module('playwright', () => {
  return {
    chromium: {
      executablePath: () => {
        if (mockExecThrows) throw new Error('Browser not found');
        return mockExecPath;
      },
    },
  };
});

// Re-import after mocks
const { checkBrowserRuntime } = await import('../tools/browser/runtime-check.js');

describe('browser runtime check', () => {
  beforeEach(() => {
    mockExecPath = '/bin/sh';
    mockExecThrows = false;
  });

  test('reports success when playwright and chromium are available', async () => {
    const status = await checkBrowserRuntime();
    expect(status.playwrightAvailable).toBe(true);
    expect(status.chromiumInstalled).toBe(true);
    expect(status.chromiumPath).toBe('/bin/sh');
    expect(status.error).toBeNull();
  });

  test('reports chromium not installed when executable is missing', async () => {
    mockExecPath = '/nonexistent/chromium/path';
    const status = await checkBrowserRuntime();
    expect(status.playwrightAvailable).toBe(true);
    expect(status.chromiumInstalled).toBe(false);
    expect(status.chromiumPath).toBeNull();
    expect(status.error).toContain('Chromium not found');
    expect(status.error).toContain('bun x playwright install chromium');
  });

  test('handles executablePath throwing an error', async () => {
    mockExecThrows = true;
    const status = await checkBrowserRuntime();
    expect(status.playwrightAvailable).toBe(true);
    expect(status.chromiumInstalled).toBe(false);
    expect(status.chromiumPath).toBeNull();
    expect(status.error).toBe('Browser not found');
  });
});
