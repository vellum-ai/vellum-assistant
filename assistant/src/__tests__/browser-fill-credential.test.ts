import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => '/tmp/browser-fill-credential-test',
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

let mockGetCredentialValue: ReturnType<typeof mock>;

mock.module('../tools/credentials/vault.js', () => ({
  getCredentialValue: (...args: unknown[]) => mockGetCredentialValue(...args),
}));

import { executeBrowserFillCredential } from '../tools/browser/headless-browser.js';
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
  };
}

// ── browser_fill_credential ──────────────────────────────────────────

describe('executeBrowserFillCredential', () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
    mockGetCredentialValue = mock(() => 'super-secret-password');
  });

  test('fills credential into element by element_id', async () => {
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserFillCredential(
      { service: 'gmail', field: 'password', element_id: 'e1' },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Filled password for gmail');
    expect(mockPage.fill).toHaveBeenCalledWith('[data-vellum-eid="e1"]', 'super-secret-password');
    expect(mockGetCredentialValue).toHaveBeenCalledWith('gmail', 'password');
  });

  test('fills credential by CSS selector', async () => {
    const result = await executeBrowserFillCredential(
      { service: 'github', field: 'token', selector: 'input[name="password"]' },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Filled token for github');
    expect(mockPage.fill).toHaveBeenCalledWith('input[name="password"]', 'super-secret-password');
  });

  test('returns error when credential not found', async () => {
    mockGetCredentialValue = mock(() => undefined);
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserFillCredential(
      { service: 'slack', field: 'api_key', element_id: 'e1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('No credential stored for slack/api_key');
    expect(result.content).toContain('credential_store');
    expect(mockPage.fill).not.toHaveBeenCalled();
  });

  test('returns error when element not found', async () => {
    const result = await executeBrowserFillCredential(
      { service: 'gmail', field: 'password', element_id: 'e99' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain('browser_snapshot');
  });

  test('presses Enter after fill when press_enter is true', async () => {
    snapshotMaps.set('test-session', new Map([['e2', '[data-vellum-eid="e2"]']]));
    const result = await executeBrowserFillCredential(
      { service: 'gmail', field: 'password', element_id: 'e2', press_enter: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.fill).toHaveBeenCalledWith('[data-vellum-eid="e2"]', 'super-secret-password');
    expect(mockPage.press).toHaveBeenCalledWith('[data-vellum-eid="e2"]', 'Enter');
  });

  test('credential value NEVER appears in result content', async () => {
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserFillCredential(
      { service: 'gmail', field: 'password', element_id: 'e1' },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).not.toContain('super-secret-password');
  });

  test('returns error when service is missing', async () => {
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserFillCredential(
      { field: 'password', element_id: 'e1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('service is required');
  });

  test('returns error when field is missing', async () => {
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserFillCredential(
      { service: 'gmail', element_id: 'e1' },
      ctx,
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('field is required');
  });
});
