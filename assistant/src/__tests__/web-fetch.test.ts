/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, test, expect, beforeEach, afterEach } from 'bun:test';
import { executeWebFetch } from '../tools/network/web-fetch.js';

describe('web_fetch tool', () => {
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('rejects missing url', async () => {
    const result = await executeWebFetch({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url is required');
  });

  test('rejects non-http schemes', async () => {
    const result = await executeWebFetch({ url: 'ftp://example.com/file.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url must use http or https');
  });

  test('adds https:// for bare hostnames', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({ url: 'example.com/docs' });
    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe('https://example.com/docs');
  });

  test('blocks localhost targets unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({ url: 'http://localhost:3000/health' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing to fetch local/private network target');
    expect(called).toBe(false);
  });

  test('blocks bracketed IPv6 localhost targets unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({ url: 'http://[::1]:3000/health' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing to fetch local/private network target');
    expect(called).toBe(false);
  });

  test('blocks IPv4-mapped IPv6 localhost targets unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({ url: 'http://[::ffff:127.0.0.1]:3000/health' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing to fetch local/private network target');
    expect(called).toBe(false);
  });

  test('allows localhost when allow_private_network=true', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('local ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({
      url: 'http://localhost:3000/health',
      allow_private_network: true,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('local ok');
    expect(called).toBe(true);
  });

  test('extracts readable text and metadata from HTML', async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          '<html><head>',
          '<title>Example Title</title>',
          '<meta name="description" content="Example Description">',
          '</head><body>',
          '<script>window.evil = "ignore me";</script>',
          '<h1>Hello</h1><p>World</p>',
          '</body></html>',
        ].join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      )
    ) as any;

    const result = await executeWebFetch({ url: 'https://example.com' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Title: Example Title');
    expect(result.content).toContain('Description: Example Description');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
    expect(result.content).not.toContain('window.evil');
  });

  test('supports character windowing with start_index and max_chars', async () => {
    globalThis.fetch = (async () =>
      new Response('ABCDEFGHIJKLMNOPQRSTUVWXYZ', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    ) as any;

    const result = await executeWebFetch({
      url: 'https://example.com/letters',
      start_index: 5,
      max_chars: 4,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Character Window: 5-9 of 26');
    expect(result.content).toContain('FGHI');
    expect(result.status).toContain('Output truncated by max_chars=4.');
  });

  test('rejects binary-like content types', async () => {
    globalThis.fetch = (async () =>
      new Response('PNGDATA', {
        status: 200,
        headers: { 'content-type': 'image/png' },
      })
    ) as any;

    const result = await executeWebFetch({ url: 'https://example.com/image.png' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Unsupported content type');
  });

  test('returns error results for non-2xx responses', async () => {
    globalThis.fetch = (async () =>
      new Response('missing page', {
        status: 404,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
        statusText: 'Not Found',
      })
    ) as any;

    const result = await executeWebFetch({ url: 'https://example.com/missing' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Error: HTTP 404');
    expect(result.content).toContain('missing page');
  });

  test('blocks redirects to localhost/private targets when allow_private_network is false', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://localhost:3000/internal' },
        });
      }
      return new Response('should-not-be-fetched', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({ url: 'https://example.com/start' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing redirect to local/private network target');
    expect(callCount).toBe(1);
  });

  test('blocks redirects to IPv4-mapped IPv6 private targets when allow_private_network is false', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://[::ffff:7f00:1]:3000/internal' },
        });
      }
      return new Response('should-not-be-fetched', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({ url: 'https://example.com/start' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing redirect to local/private network target');
    expect(callCount).toBe(1);
  });

  test('allows redirects to localhost/private targets when allow_private_network is true', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://localhost:3000/internal' },
        });
      }
      return new Response('internal ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWebFetch({
      url: 'https://example.com/start',
      allow_private_network: true,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('internal ok');
    expect(result.status).toContain('Followed 1 redirect(s).');
    expect(callCount).toBe(2);
  });
});
