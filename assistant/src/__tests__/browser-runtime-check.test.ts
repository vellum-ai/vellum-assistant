import { describe, test, expect, mock, beforeEach } from 'bun:test';

// Mock playwright before importing runtime-check
let mockExecPath = '/fake/chromium';
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

// Mock fs.existsSync for Chromium path checks
let mockFileExists = true;
mock.module('node:fs', () => {
  const actual = require('node:fs');
  return {
    ...actual,
    existsSync: (path: string) => {
      if (path === mockExecPath) return mockFileExists;
      return actual.existsSync(path);
    },
  };
});

// Re-import after mocks
const { checkBrowserRuntime } = await import('../tools/browser/runtime-check.js');

describe('browser runtime check', () => {
  beforeEach(() => {
    mockExecPath = '/fake/chromium';
    mockExecThrows = false;
    mockFileExists = true;
  });

  test('reports success when playwright and chromium are available', async () => {
    const status = await checkBrowserRuntime();
    expect(status.playwrightAvailable).toBe(true);
    expect(status.chromiumInstalled).toBe(true);
    expect(status.chromiumPath).toBe('/fake/chromium');
    expect(status.error).toBeNull();
  });

  test('reports chromium not installed when executable is missing', async () => {
    mockFileExists = false;
    const status = await checkBrowserRuntime();
    expect(status.playwrightAvailable).toBe(true);
    expect(status.chromiumInstalled).toBe(false);
    expect(status.chromiumPath).toBeNull();
    expect(status.error).toContain('Chromium not found');
    expect(status.error).toContain('bunx playwright install chromium');
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
