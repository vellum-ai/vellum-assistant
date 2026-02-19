import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { createHash } from 'node:crypto';

// Mock the logger before importing the module under test
mock.module('../util/logger.js', () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { extractRemoteUrls, materializeAssets } from '../bundler/app-bundler.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Compute expected asset filename for a URL (mirrors the production logic). */
function expectedFilename(url: string): string {
  const hash = createHash('sha256').update(url).digest('hex').slice(0, 12);
  let ext = '';
  try {
    const parsed = new URL(url);
    const match = parsed.pathname.match(/\.\w+$/);
    ext = match ? match[0] : '';
  } catch {
    // no extension
  }
  if (!ext || ext.length > 10 || !/^\.\w+$/.test(ext)) {
    ext = '';
  }
  return `${hash}${ext}`;
}

// ---------------------------------------------------------------------------
// extractRemoteUrls
// ---------------------------------------------------------------------------

describe('extractRemoteUrls', () => {
  test('extracts src attributes with double quotes', () => {
    const html = '<img src="https://cdn.example.com/logo.png">';
    expect(extractRemoteUrls(html)).toEqual(['https://cdn.example.com/logo.png']);
  });

  test('extracts src attributes with single quotes', () => {
    const html = "<img src='https://cdn.example.com/logo.png'>";
    expect(extractRemoteUrls(html)).toEqual(['https://cdn.example.com/logo.png']);
  });

  test('extracts unquoted src attributes', () => {
    const html = '<img src=https://cdn.example.com/logo.png>';
    expect(extractRemoteUrls(html)).toEqual(['https://cdn.example.com/logo.png']);
  });

  test('extracts href attributes', () => {
    const html = '<link rel="stylesheet" href="https://fonts.googleapis.com/css?family=Roboto">';
    expect(extractRemoteUrls(html)).toEqual([
      'https://fonts.googleapis.com/css?family=Roboto',
    ]);
  });

  test('extracts CSS url() references with double quotes', () => {
    const html = '<div style="background: url(&quot;https://cdn.example.com/bg.jpg&quot;)"></div>';
    // The regex matches url("...") literally, not HTML entities
    expect(extractRemoteUrls(html)).toEqual([]);

    // With actual quotes in a <style> block
    const html2 = '<style>body { background: url("https://cdn.example.com/bg.jpg"); }</style>';
    expect(extractRemoteUrls(html2)).toEqual(['https://cdn.example.com/bg.jpg']);
  });

  test('extracts CSS url() references with single quotes', () => {
    const html = "<style>body { background: url('https://cdn.example.com/bg.jpg'); }</style>";
    expect(extractRemoteUrls(html)).toEqual(['https://cdn.example.com/bg.jpg']);
  });

  test('extracts CSS url() references without quotes', () => {
    const html = '<style>body { background: url(https://cdn.example.com/bg.jpg); }</style>';
    expect(extractRemoteUrls(html)).toEqual(['https://cdn.example.com/bg.jpg']);
  });

  test('ignores relative URLs', () => {
    const html = '<img src="images/logo.png"><link href="./style.css">';
    expect(extractRemoteUrls(html)).toEqual([]);
  });

  test('ignores data URIs', () => {
    const html = '<img src="data:image/png;base64,iVBORw0KGgo=">';
    expect(extractRemoteUrls(html)).toEqual([]);
  });

  test('deduplicates identical URLs', () => {
    const html = `
      <img src="https://cdn.example.com/logo.png">
      <img src="https://cdn.example.com/logo.png">
    `;
    expect(extractRemoteUrls(html)).toEqual(['https://cdn.example.com/logo.png']);
  });

  test('extracts multiple different URLs', () => {
    const html = `
      <img src="https://cdn.example.com/logo.png">
      <link href="https://fonts.example.com/style.css">
      <script src="https://cdn.example.com/app.js"></script>
    `;
    const urls = extractRemoteUrls(html);
    expect(urls).toHaveLength(3);
    expect(urls).toContain('https://cdn.example.com/logo.png');
    expect(urls).toContain('https://fonts.example.com/style.css');
    expect(urls).toContain('https://cdn.example.com/app.js');
  });

  test('returns empty array for HTML with no remote URLs', () => {
    const html = '<html><body><p>Hello World</p></body></html>';
    expect(extractRemoteUrls(html)).toEqual([]);
  });

  test('handles mixed src, href, and url() in a single document', () => {
    const html = `
      <link href="https://example.com/a.css">
      <img src="https://example.com/b.png">
      <style>div { background: url(https://example.com/c.jpg); }</style>
    `;
    const urls = extractRemoteUrls(html);
    expect(urls).toHaveLength(3);
  });

  test('handles HTTP (not just HTTPS)', () => {
    const html = '<img src="http://cdn.example.com/legacy.png">';
    expect(extractRemoteUrls(html)).toEqual(['http://cdn.example.com/legacy.png']);
  });
});

// ---------------------------------------------------------------------------
// materializeAssets
// ---------------------------------------------------------------------------

describe('materializeAssets', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('returns unchanged HTML when there are no remote URLs', async () => {
    const html = '<html><body>No remote assets</body></html>';
    const result = await materializeAssets(html);
    expect(result.rewrittenHtml).toBe(html);
    expect(result.assets).toEqual([]);
  });

  test('fetches remote assets and rewrites URLs', async () => {
    const imageUrl = 'https://cdn.example.com/image.png';
    const imageData = Buffer.from('fake-image-data');

    globalThis.fetch = mock((url: string) => {
      if (url === imageUrl) {
        return Promise.resolve(new Response(imageData, { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}">`;
    const result = await materializeAssets(html);

    const filename = expectedFilename(imageUrl);
    expect(result.rewrittenHtml).toBe(`<img src="assets/${filename}">`);
    expect(result.assets).toHaveLength(1);
    expect(result.assets[0].archivePath).toBe(`assets/${filename}`);
    expect(result.assets[0].data).toEqual(imageData);
  });

  test('handles multiple distinct assets', async () => {
    const urls = [
      'https://cdn.example.com/a.png',
      'https://cdn.example.com/b.css',
      'https://cdn.example.com/c.js',
    ];

    globalThis.fetch = mock((url: string) => {
      return Promise.resolve(new Response(Buffer.from(`data-for-${url}`), { status: 200 }));
    }) as unknown as typeof fetch;

    const html = `
      <img src="${urls[0]}">
      <link href="${urls[1]}">
      <script src="${urls[2]}"></script>
    `;
    const result = await materializeAssets(html);

    expect(result.assets).toHaveLength(3);
    for (const url of urls) {
      const filename = expectedFilename(url);
      expect(result.rewrittenHtml).toContain(`assets/${filename}`);
      expect(result.rewrittenHtml).not.toContain(url);
    }
  });

  test('keeps original URL when fetch returns non-OK status', async () => {
    const imageUrl = 'https://cdn.example.com/missing.png';

    globalThis.fetch = mock(() => {
      return Promise.resolve(new Response(null, { status: 404 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}">`;
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toBe(html);
    expect(result.assets).toEqual([]);
  });

  test('keeps original URL when fetch throws (network error)', async () => {
    const imageUrl = 'https://cdn.example.com/unreachable.png';

    globalThis.fetch = mock(() => {
      return Promise.reject(new Error('Network error'));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}">`;
    const result = await materializeAssets(html);

    expect(result.rewrittenHtml).toBe(html);
    expect(result.assets).toEqual([]);
  });

  test('partially succeeds: fetched assets are rewritten, failed ones remain', async () => {
    const goodUrl = 'https://cdn.example.com/good.png';
    const badUrl = 'https://cdn.example.com/bad.png';

    globalThis.fetch = mock((url: string) => {
      if (url === goodUrl) {
        return Promise.resolve(new Response(Buffer.from('good-data'), { status: 200 }));
      }
      return Promise.resolve(new Response(null, { status: 500 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${goodUrl}"><img src="${badUrl}">`;
    const result = await materializeAssets(html);

    const goodFilename = expectedFilename(goodUrl);
    expect(result.rewrittenHtml).toContain(`assets/${goodFilename}`);
    expect(result.rewrittenHtml).toContain(badUrl);
    expect(result.assets).toHaveLength(1);
  });

  test('deduplicates same URL appearing multiple times in HTML', async () => {
    const imageUrl = 'https://cdn.example.com/icon.png';
    let fetchCount = 0;

    globalThis.fetch = mock(() => {
      fetchCount++;
      return Promise.resolve(new Response(Buffer.from('icon-data'), { status: 200 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${imageUrl}"><div style="background: url(${imageUrl})"></div>`;
    const result = await materializeAssets(html);

    // Should only fetch once since extractRemoteUrls deduplicates
    expect(fetchCount).toBe(1);
    expect(result.assets).toHaveLength(1);

    // Both occurrences should be rewritten
    const filename = expectedFilename(imageUrl);
    expect(result.rewrittenHtml).not.toContain(imageUrl);
    const matches = result.rewrittenHtml.match(new RegExp(`assets/${filename}`, 'g'));
    expect(matches).toHaveLength(2);
  });

  test('preserves file extensions in asset filenames', async () => {
    const pngUrl = 'https://cdn.example.com/image.png';
    const cssUrl = 'https://cdn.example.com/style.css';
    const noExtUrl = 'https://cdn.example.com/api/data';

    globalThis.fetch = mock(() => {
      return Promise.resolve(new Response(Buffer.from('data'), { status: 200 }));
    }) as unknown as typeof fetch;

    const html = `<img src="${pngUrl}"><link href="${cssUrl}"><img src="${noExtUrl}">`;
    const result = await materializeAssets(html);

    expect(result.assets).toHaveLength(3);

    const pngAsset = result.assets.find((a) => a.archivePath.endsWith('.png'));
    const cssAsset = result.assets.find((a) => a.archivePath.endsWith('.css'));
    const noExtAsset = result.assets.find(
      (a) => !a.archivePath.endsWith('.png') && !a.archivePath.endsWith('.css'),
    );

    expect(pngAsset).toBeDefined();
    expect(cssAsset).toBeDefined();
    expect(noExtAsset).toBeDefined();
  });

  test('rewrites CSS url() references alongside src/href', async () => {
    const cssUrl = 'https://cdn.example.com/bg.jpg';

    globalThis.fetch = mock(() => {
      return Promise.resolve(new Response(Buffer.from('jpg-data'), { status: 200 }));
    }) as unknown as typeof fetch;

    const html = '<style>body { background: url("https://cdn.example.com/bg.jpg"); }</style>';
    const result = await materializeAssets(html);

    const filename = expectedFilename(cssUrl);
    expect(result.rewrittenHtml).toContain(`assets/${filename}`);
    expect(result.rewrittenHtml).not.toContain(cssUrl);
  });
});
