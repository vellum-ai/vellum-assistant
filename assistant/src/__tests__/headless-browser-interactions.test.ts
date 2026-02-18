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
  screenshot: ReturnType<typeof mock>;
  close: () => Promise<void>;
  isClosed: () => boolean;
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

mock.module('../tools/browser/browser-screencast.js', () => ({
  getSender: () => undefined,
  stopBrowserScreencast: async () => {},
  stopAllScreencasts: async () => {},
  ensureScreencast: async () => {},
  updateBrowserStatus: () => {},
  updatePagesList: async () => {},
  getElementBounds: async () => null,
  updateHighlights: () => {},
}));

import {
  executeBrowserClick,
  executeBrowserType,
  executeBrowserSnapshot,
  executeBrowserScreenshot,
  executeBrowserClose,
  executeBrowserExtract,
  executeBrowserPressKey,
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
    screenshot: mock(async () => Buffer.from('fake-jpeg-data')),
    close: async () => {},
    isClosed: () => false,
    keyboard: { press: mock(async () => {}) },
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

// ── browser_snapshot ──────────────────────────────────────────────────

describe('executeBrowserSnapshot', () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test('returns element list with eid format', async () => {
    const sampleElements = [
      { eid: 'e1', tag: 'a', attrs: { href: '/about' }, text: 'About Us' },
      { eid: 'e2', tag: 'button', attrs: { type: 'submit' }, text: 'Submit' },
      { eid: 'e3', tag: 'input', attrs: { type: 'text', name: 'email', placeholder: 'Enter email' }, text: '' },
    ];
    mockPage.evaluate = mock(async () => sampleElements);
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('[e1]');
    expect(result.content).toContain('[e2]');
    expect(result.content).toContain('[e3]');
    expect(result.content).toContain('<a');
    expect(result.content).toContain('<button');
    expect(result.content).toContain('<input');
    expect(result.content).toContain('3 interactive elements found');
  });

  test('stores snapshot map for later element resolution', async () => {
    const sampleElements = [
      { eid: 'e1', tag: 'a', attrs: { href: '/' }, text: 'Home' },
    ];
    mockPage.evaluate = mock(async () => sampleElements);
    await executeBrowserSnapshot({}, ctx);
    const map = snapshotMaps.get('test-session');
    expect(map).toBeDefined();
    expect(map!.get('e1')).toBe('[data-vellum-eid="e1"]');
  });

  test('reports no interactive elements when page is empty', async () => {
    mockPage.evaluate = mock(async () => []);
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('no interactive elements found');
  });

  test('includes page URL and title', async () => {
    mockPage.evaluate = mock(async () => []);
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.content).toContain('URL: https://example.com/');
    expect(result.content).toContain('Title: Test Page');
  });

  test('handles snapshot error from page', async () => {
    mockPage.evaluate = mock(async () => { throw new Error('Page crashed'); });
    const result = await executeBrowserSnapshot({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Snapshot failed');
    expect(result.content).toContain('Page crashed');
  });
});

// ── browser_screenshot ───────────────────────────────────────────────

describe('executeBrowserScreenshot', () => {
  beforeEach(() => {
    resetMockPage();
  });

  test('captures and returns image content', async () => {
    const fakeBuffer = Buffer.from('fake-jpeg-screenshot-data');
    mockPage.screenshot = mock(async () => fakeBuffer);
    const result = await executeBrowserScreenshot({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Screenshot captured');
    expect(result.content).toContain(`${fakeBuffer.length} bytes`);
    expect(result.content).toContain('viewport');
    expect(result.contentBlocks).toBeDefined();
    expect(result.contentBlocks!.length).toBe(1);
    const imageBlock = result.contentBlocks![0] as { type: string; source: { type: string; media_type: string; data: string } };
    expect(imageBlock.type).toBe('image');
    expect(imageBlock.source.media_type).toBe('image/jpeg');
    expect(imageBlock.source.data).toBe(fakeBuffer.toString('base64'));
  });

  test('supports full_page mode', async () => {
    mockPage.screenshot = mock(async () => Buffer.from('full'));
    const result = await executeBrowserScreenshot({ full_page: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('full page');
    expect(mockPage.screenshot).toHaveBeenCalledWith({ type: 'jpeg', quality: 80, fullPage: true });
  });

  test('handles screenshot error from page', async () => {
    mockPage.screenshot = mock(async () => { throw new Error('Render failed'); });
    const result = await executeBrowserScreenshot({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Screenshot failed');
    expect(result.content).toContain('Render failed');
  });
});

// ── browser_close ────────────────────────────────────────────────────

describe('executeBrowserClose', () => {
  beforeEach(() => {
    resetMockPage();
  });

  test('closes session page', async () => {
    const result = await executeBrowserClose({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Browser page closed for this session');
  });

  test('closes all pages when close_all_pages=true', async () => {
    const result = await executeBrowserClose({ close_all_pages: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('All browser pages and context closed');
  });
});

// ── browser_extract ──────────────────────────────────────────────────

describe('executeBrowserExtract', () => {
  beforeEach(() => {
    resetMockPage();
  });

  test('extracts text content from page', async () => {
    mockPage.evaluate = mock(async () => 'Hello, this is the page text content.');
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('URL: https://example.com/');
    expect(result.content).toContain('Title: Test Page');
    expect(result.content).toContain('Hello, this is the page text content.');
  });

  test('includes links when include_links=true', async () => {
    // First call returns text content, second returns link list
    let callCount = 0;
    mockPage.evaluate = mock(async () => {
      callCount++;
      if (callCount === 1) return 'Some text';
      return [
        { text: 'Example Link', href: 'https://example.com/link1' },
        { text: 'Another', href: 'https://example.com/link2' },
      ];
    });
    const result = await executeBrowserExtract({ include_links: true }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Links:');
    expect(result.content).toContain('[Example Link](https://example.com/link1)');
    expect(result.content).toContain('[Another](https://example.com/link2)');
  });

  test('handles empty page', async () => {
    mockPage.evaluate = mock(async () => '');
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('(empty page)');
  });

  test('handles extract error from page', async () => {
    mockPage.evaluate = mock(async () => { throw new Error('Page not loaded'); });
    const result = await executeBrowserExtract({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Extract failed');
    expect(result.content).toContain('Page not loaded');
  });
});

// ── browser_press_key ────────────────────────────────────────────────

describe('executeBrowserPressKey', () => {
  beforeEach(() => {
    resetMockPage();
    snapshotMaps.clear();
  });

  test('presses key on page (focused element) when no target', async () => {
    const result = await executeBrowserPressKey({ key: 'Enter' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Enter"');
    expect(mockPage.keyboard.press).toHaveBeenCalledWith('Enter');
  });

  test('presses key on targeted element via element_id', async () => {
    snapshotMaps.set('test-session', new Map([['e5', '[data-vellum-eid="e5"]']]));
    const result = await executeBrowserPressKey({ key: 'Tab', element_id: 'e5' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Tab" on element');
    expect(mockPage.press).toHaveBeenCalledWith('[data-vellum-eid="e5"]', 'Tab');
  });

  test('presses key on targeted element via selector', async () => {
    const result = await executeBrowserPressKey({ key: 'Escape', selector: '#dialog' }, ctx);
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Pressed "Escape" on element');
    expect(mockPage.press).toHaveBeenCalledWith('#dialog', 'Escape');
  });

  test('errors when key is missing', async () => {
    const result = await executeBrowserPressKey({}, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('key is required');
  });

  test('errors when element_id not found', async () => {
    const result = await executeBrowserPressKey({ key: 'Enter', element_id: 'e99' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('element_id "e99" not found');
  });

  test('handles press key error from page', async () => {
    mockPage.keyboard.press = mock(async () => { throw new Error('Key not recognized'); });
    const result = await executeBrowserPressKey({ key: 'InvalidKey' }, ctx);
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Press key failed');
    expect(result.content).toContain('Key not recognized');
  });
});
