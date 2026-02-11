import { describe, test, expect, beforeEach, mock } from 'bun:test';

// ── Mocks ────────────────────────────────────────────────────────────

mock.module('../util/logger.js', () => ({
  getLogger: () => new Proxy({} as Record<string, unknown>, {
    get: () => () => {},
  }),
}));

mock.module('../util/platform.js', () => ({
  getDataDir: () => '/tmp/headless-browser-interactions-test',
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

import {
  executeBrowserClick,
  executeBrowserType,
} from '../tools/browser/headless-browser.js';
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

// ── browser_click ────────────────────────────────────────────────────

describe('executeBrowserClick', () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test('clicks by element_id via snapshot map', async () => {
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserClick({ element_id: 'e1' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Clicked element');
    expect(mockPage.click).toHaveBeenCalledWith('[data-vellum-eid="e1"]');
  });

  test('clicks by raw selector', async () => {
    const result = await executeBrowserClick({ selector: '#submit-btn' }, ctx);
    expect(result.isError).toBe(false);
    expect(mockPage.click).toHaveBeenCalledWith('#submit-btn');
  });

  test('prefers element_id over selector', async () => {
    snapshotMaps.set('test-session', new Map([['e1', '[data-vellum-eid="e1"]']]));
    const result = await executeBrowserClick({ element_id: 'e1', selector: '#other' }, ctx);
    expect(result.isError).toBe(false);
    expect(mockPage.click).toHaveBeenCalledWith('[data-vellum-eid="e1"]');
  });

  test('errors when neither element_id nor selector provided', async () => {
    const result = await executeBrowserClick({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Either element_id or selector is required');
  });

  test('errors when element_id not found in snapshot map', async () => {
    const result = await executeBrowserClick({ element_id: 'e99' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
    expect(result.content).toContain('browser_snapshot');
  });

  test('errors when snapshot map is missing for session', async () => {
    const result = await executeBrowserClick({ element_id: 'e1' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('not found');
  });

  test('handles click error from page', async () => {
    mockPage.click = mock(async () => { throw new Error('Element not visible'); });
    const result = await executeBrowserClick({ selector: '#hidden' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Click failed');
    expect(result.content).toContain('Element not visible');
  });
});

// ── browser_type ─────────────────────────────────────────────────────

describe('executeBrowserType', () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test('types with element_id and default clear_first=true', async () => {
    snapshotMaps.set('test-session', new Map([['e3', '[data-vellum-eid="e3"]']]));
    const result = await executeBrowserType({ element_id: 'e3', text: 'hello' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Typed into element');
    expect(result.content).toContain('cleared existing content');
    expect(mockPage.fill).toHaveBeenCalledWith('[data-vellum-eid="e3"]', 'hello');
  });

  test('types with raw selector', async () => {
    const result = await executeBrowserType({ selector: 'input[name="email"]', text: 'test' }, ctx);
    expect(result.isError).toBe(false);
    expect(mockPage.fill).toHaveBeenCalledWith('input[name="email"]', 'test');
  });

  test('appends text when clear_first=false', async () => {
    mockPage.evaluate = mock(async () => 'existing');
    const result = await executeBrowserType(
      { selector: '#input', text: ' more', clear_first: false },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(mockPage.evaluate).toHaveBeenCalled();
    expect(mockPage.fill).toHaveBeenCalledWith('#input', 'existing more');
    expect(result.content).not.toContain('cleared');
  });

  test('presses Enter after typing when press_enter=true', async () => {
    const result = await executeBrowserType(
      { selector: '#search', text: 'query', press_enter: true },
      ctx,
    );
    expect(result.isError).toBe(false);
    expect(result.content).toContain('pressed Enter');
    expect(mockPage.fill).toHaveBeenCalledWith('#search', 'query');
    expect(mockPage.press).toHaveBeenCalledWith('#search', 'Enter');
  });

  test('errors when text is missing', async () => {
    const result = await executeBrowserType({ selector: '#input' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('text is required');
  });

  test('errors when text is empty string', async () => {
    const result = await executeBrowserType({ selector: '#input', text: '' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('text is required');
  });

  test('errors when neither element_id nor selector provided', async () => {
    const result = await executeBrowserType({ text: 'hello' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Either element_id or selector is required');
  });

  test('errors when element_id not found', async () => {
    const result = await executeBrowserType({ element_id: 'e99', text: 'hello' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
  });

  test('handles type error from page', async () => {
    mockPage.fill = mock(async () => { throw new Error('Element is not an input'); });
    const result = await executeBrowserType({ selector: '#div', text: 'hello' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Type failed');
    expect(result.content).toContain('Element is not an input');
  });
});
