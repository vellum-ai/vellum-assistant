import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => '/tmp/captcha-detector-test',
}));

let mockPage: {
  click: ReturnType<typeof mock>;
  fill: ReturnType<typeof mock>;
  press: ReturnType<typeof mock>;
  evaluate: ReturnType<typeof mock>;
  title: ReturnType<typeof mock>;
  url: ReturnType<typeof mock>;
  goto: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
  waitForSelector: ReturnType<typeof mock>;
  waitForFunction: ReturnType<typeof mock>;
  keyboard: { press: ReturnType<typeof mock> };
};

let snapshotMaps: Map<string, Map<string, string>>;

mock.module('../tools/browser/browser-manager.js', () => {
  snapshotMaps = new Map();
  return {
    browserManager: {
      getOrCreateSessionPage: async () => mockPage,
      closeSessionPage: async () => {},
      closeAllPages: async () => {},
      storeSnapshotMap: (sessionId: string, map: Map<string, string>) => {
        snapshotMaps.set(sessionId, map);
      },
      resolveSnapshotSelector: (sessionId: string, elementId: string) => {
        const map = snapshotMaps.get(sessionId);
        if (!map) return null;
        return map.get(elementId) ?? null;
      },
    },
  };
});

mock.module('../tools/network/url-safety.js', () => ({
  parseUrl: () => null,
  isPrivateOrLocalHost: () => false,
  resolveHostAddresses: async () => [],
  resolveRequestAddress: async () => ({}),
  sanitizeUrlForOutput: (url: URL) => url.href,
}));

import { detectCaptcha } from '../tools/browser/captcha-detector.js';
import { executeBrowserDetectCaptcha } from '../tools/browser/headless-browser.js';
import type { ToolContext } from '../tools/types.js';

const ctx: ToolContext = {
  sessionId: 'test-session',
  conversationId: 'test-conversation',
  workingDir: '/tmp',
};

function resetMockPage() {
  mockPage = {
    click: mock(async () => {}),
    fill: mock(async () => {}),
    press: mock(async () => {}),
    evaluate: mock(async () => ''),
    title: mock(async () => 'Test Page'),
    url: mock(() => 'https://example.com/'),
    goto: mock(async () => ({ status: () => 200, url: () => 'https://example.com/' })),
    close: async () => {},
    isClosed: () => false,
    waitForSelector: mock(async () => null),
    waitForFunction: mock(async () => null),
    keyboard: { press: mock(async () => {}) },
  };
}

// ── detectCaptcha (detector utility) ─────────────────────────────────

describe('detectCaptcha', () => {
  beforeEach(() => {
    resetMockPage();
  });

  test('detects reCAPTCHA elements', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        // Simulate selector check: return the matching selector
        return 'iframe[src*="recaptcha"]';
      }
      return '';
    });

    const result = await detectCaptcha(mockPage as unknown as Parameters<typeof detectCaptcha>[0]);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('recaptcha');
    expect(result.hint).toContain('recaptcha');
  });

  test('detects hCaptcha elements', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return '.h-captcha';
      }
      return '';
    });

    const result = await detectCaptcha(mockPage as unknown as Parameters<typeof detectCaptcha>[0]);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('hcaptcha');
    expect(result.hint).toContain('h-captcha');
  });

  test('detects Cloudflare Turnstile', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return 'iframe[src*="challenges.cloudflare.com"]';
      }
      return '';
    });

    const result = await detectCaptcha(mockPage as unknown as Parameters<typeof detectCaptcha>[0]);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('turnstile');
    expect(result.hint).toContain('cloudflare');
  });

  test('detects CAPTCHA text patterns', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        // No selector matched
        return null;
      }
      // Body text with CAPTCHA pattern
      return 'Please verify you are human to continue';
    });

    const result = await detectCaptcha(mockPage as unknown as Parameters<typeof detectCaptcha>[0]);
    expect(result.detected).toBe(true);
    expect(result.type).toBe('unknown');
    expect(result.hint).toContain('pattern');
  });

  test('returns detected: false when no CAPTCHA present', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return null;
      }
      return 'Just a normal page with no captcha indicators';
    });

    const result = await detectCaptcha(mockPage as unknown as Parameters<typeof detectCaptcha>[0]);
    expect(result.detected).toBe(false);
    expect(result.type).toBeUndefined();
    expect(result.hint).toBeUndefined();
  });

  test('handles page.evaluate errors gracefully', async () => {
    mockPage.evaluate = mock(async () => {
      throw new Error('Page is closed');
    });

    const result = await detectCaptcha(mockPage as unknown as Parameters<typeof detectCaptcha>[0]);
    expect(result.detected).toBe(false);
  });
});

// ── executeBrowserDetectCaptcha (tool) ───────────────────────────────

describe('executeBrowserDetectCaptcha', () => {
  beforeEach(() => {
    resetMockPage();
  });

  test('returns JSON with detected: true when CAPTCHA found', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return '.g-recaptcha';
      }
      return '';
    });

    const result = await executeBrowserDetectCaptcha({}, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.detected).toBe(true);
    expect(parsed.type).toBe('recaptcha');
  });

  test('returns JSON with detected: false when no CAPTCHA', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return null;
      }
      return 'Normal page content';
    });

    const result = await executeBrowserDetectCaptcha({}, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.detected).toBe(false);
  });

  test('includes hint in response when CAPTCHA detected', async () => {
    let callCount = 0;
    mockPage.evaluate = mock(async (_fn: unknown, ..._args: unknown[]) => {
      callCount++;
      if (callCount === 1) {
        return 'iframe[src*="hcaptcha"]';
      }
      return '';
    });

    const result = await executeBrowserDetectCaptcha({}, ctx);
    expect(result.isError).toBe(false);
    const parsed = JSON.parse(result.content);
    expect(parsed.detected).toBe(true);
    expect(parsed.hint).toBeTruthy();
    expect(parsed.hint).toContain('hcaptcha');
  });
});
