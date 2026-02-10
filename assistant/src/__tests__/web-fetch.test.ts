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

  const executeWithMockFetch = (
    input: Record<string, unknown>,
    options?: {
      resolveHostAddresses?: (hostname: string) => Promise<string[]>;
      requestExecutor?: (
        url: URL,
        requestOptions: {
          signal: AbortSignal;
          headers: Record<string, string>;
          resolvedAddress?: string;
        },
      ) => Promise<Response>;
    },
  ) =>
    executeWebFetch(input, {
      ...options,
      requestExecutor:
        options?.requestExecutor
        ?? ((url, requestOptions) =>
          globalThis.fetch(url.href, {
            method: 'GET',
            redirect: 'manual',
            signal: requestOptions.signal,
            headers: requestOptions.headers,
          }) as Promise<Response>),
    });

  test('rejects missing url', async () => {
    const result = await executeWithMockFetch({});
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url is required');
  });

  test('rejects non-http schemes', async () => {
    const result = await executeWithMockFetch({ url: 'ftp://example.com/file.txt' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url must use http or https');
  });

  test('rejects path-only urls', async () => {
    const result = await executeWithMockFetch({ url: '/docs/getting-started' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('url is required');
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

    const result = await executeWithMockFetch({ url: 'example.com/docs' });
    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe('https://example.com/docs');
  });

  test('adds https:// for scheme-less host:port inputs', async () => {
    let requestedUrl = '';
    globalThis.fetch = (async (url: string) => {
      requestedUrl = url;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: 'example.com:8443/docs' });
    expect(result.isError).toBe(false);
    expect(requestedUrl).toBe('https://example.com:8443/docs');
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

    const result = await executeWithMockFetch({ url: 'http://localhost:3000/health' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing to fetch local/private network target');
    expect(called).toBe(false);
  });

  test('blocks IPv4 limited broadcast targets unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: 'http://255.255.255.255/' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing to fetch local/private network target');
    expect(called).toBe(false);
  });

  test('blocks hostnames that resolve to private addresses unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: 'https://example.com/health' },
      {
        resolveHostAddresses: async (hostname) =>
          hostname === 'example.com' ? ['127.0.0.1'] : ['93.184.216.34'],
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('resolves to local/private network address 127.0.0.1');
    expect(called).toBe(false);
  });

  test('pins outbound requests to pre-resolved addresses when allow_private_network is false', async () => {
    const resolvedAddresses: string[] = [];

    const result = await executeWithMockFetch(
      { url: 'https://example.com/health' },
      {
        resolveHostAddresses: async () => ['93.184.216.34'],
        requestExecutor: async (_url, requestOptions) => {
          resolvedAddresses.push(requestOptions.resolvedAddress ?? '');
          return new Response('ok', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(resolvedAddresses).toEqual(['93.184.216.34']);
  });

  test('retries pinned requests across resolved addresses when earlier addresses fail', async () => {
    const resolvedAddresses: string[] = [];

    const result = await executeWithMockFetch(
      { url: 'https://example.com/health' },
      {
        resolveHostAddresses: async () => ['2001:db8::1', '93.184.216.34'],
        requestExecutor: async (_url, requestOptions) => {
          resolvedAddresses.push(requestOptions.resolvedAddress ?? '');
          if (requestOptions.resolvedAddress === '2001:db8::1') {
            throw new Error('connect ECONNREFUSED');
          }
          return new Response('ok', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(resolvedAddresses).toEqual(['2001:db8::1', '93.184.216.34']);
  });

  test('includes URL userinfo credentials in authorization header for pinned requests', async () => {
    let authorizationHeader = '';

    const result = await executeWithMockFetch(
      { url: 'https://user%20name:p%40ss@example.com/protected' },
      {
        resolveHostAddresses: async () => ['93.184.216.34'],
        requestExecutor: async (_url, requestOptions) => {
          authorizationHeader = requestOptions.headers.authorization ?? '';
          return new Response('ok', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(authorizationHeader).toBe(`Basic ${Buffer.from('user name:p@ss', 'utf8').toString('base64')}`);
  });

  test('redacts URL userinfo in output metadata', async () => {
    const username = 'demo';
    const credential = ['c', 'r', 'e', 'd', '1', '2', '3'].join('');
    const credentialedUrl = new URL('https://example.com/protected');
    credentialedUrl.username = username;
    credentialedUrl.password = credential;

    const result = await executeWithMockFetch(
      { url: credentialedUrl.href },
      {
        resolveHostAddresses: async () => ['93.184.216.34'],
        requestExecutor: async () =>
          new Response('ok', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          }),
      },
    );

    expect(result.isError).toBe(false);
    expect(result.content).toContain('Requested URL: https://example.com/protected');
    expect(result.content).toContain('Final URL: https://example.com/protected');
    expect(result.content).not.toContain('demo:cred123@');
  });

  test('redacts URL userinfo in resolution error messages', async () => {
    const username = 'demo';
    const credential = ['c', 'r', 'e', 'd', '1', '2', '3'].join('');
    const credentialedUrl = new URL('https://example.com/protected');
    credentialedUrl.username = username;
    credentialedUrl.password = credential;

    const result = await executeWithMockFetch(
      { url: credentialedUrl.href },
      {
        resolveHostAddresses: async () => [],
      },
    );

    expect(result.isError).toBe(true);
    expect(result.content).toContain('while fetching https://example.com/protected');
    expect(result.content).not.toContain('demo:cred123@');
  });

  test('allows hostnames that resolve to private addresses when allow_private_network=true', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: 'https://example.com/health', allow_private_network: true },
      {
        resolveHostAddresses: async () => ['127.0.0.1'],
      },
    );
    expect(result.isError).toBe(false);
    expect(called).toBe(true);
  });

  test('blocks subdomain localhost targets unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: 'http://foo.localhost:3000/health' });
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

    const result = await executeWithMockFetch({ url: 'http://[::1]:3000/health' });
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

    const result = await executeWithMockFetch({ url: 'http://[::ffff:127.0.0.1]:3000/health' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing to fetch local/private network target');
    expect(called).toBe(false);
  });

  test('blocks IPv4-compatible IPv6 localhost targets unless explicitly enabled', async () => {
    let called = false;
    globalThis.fetch = (async () => {
      called = true;
      return new Response('ok', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: 'http://[::7f00:1]:3000/health' });
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

    const result = await executeWithMockFetch({
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

    const result = await executeWithMockFetch({ url: 'https://example.com' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Title: Example Title');
    expect(result.content).toContain('Description: Example Description');
    expect(result.content).toContain('Hello');
    expect(result.content).toContain('World');
    expect(result.content).not.toContain('window.evil');
  });

  test('extracts full meta descriptions that contain apostrophes', async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          '<html><head>',
          `<meta name="description" content="We've updated our privacy policy">`,
          '</head><body>Body</body></html>',
        ].join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      )
    ) as any;

    const result = await executeWithMockFetch({ url: 'https://example.com' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain(`Description: We've updated our privacy policy`);
  });

  test('extracts full og:description when quoted value contains double quotes', async () => {
    globalThis.fetch = (async () =>
      new Response(
        [
          '<html><head>',
          `<meta content='She said "hello" today' property='og:description'>`,
          '</head><body>Body</body></html>',
        ].join(''),
        {
          status: 200,
          headers: { 'content-type': 'text/html; charset=utf-8' },
        },
      )
    ) as any;

    const result = await executeWithMockFetch({ url: 'https://example.com' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Description: She said "hello" today');
  });

  test('keeps malformed decimal entities unchanged', async () => {
    globalThis.fetch = (async () =>
      new Response('<html><body><p>Value: &#1a;</p></body></html>', {
        status: 200,
        headers: { 'content-type': 'text/html; charset=utf-8' },
      })
    ) as any;

    const result = await executeWithMockFetch({ url: 'https://example.com/entities' });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('Value: &#1a;');
  });

  test('supports character windowing with start_index and max_chars', async () => {
    globalThis.fetch = (async () =>
      new Response('ABCDEFGHIJKLMNOPQRSTUVWXYZ', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      })
    ) as any;

    const result = await executeWithMockFetch({
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

    const result = await executeWithMockFetch({ url: 'https://example.com/image.png' });
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

    const result = await executeWithMockFetch({ url: 'https://example.com/missing' });
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

    const result = await executeWithMockFetch({ url: 'https://example.com/start' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing redirect to local/private network target');
    expect(callCount).toBe(1);
  });

  test('pins redirect hops to their own pre-resolved addresses when allow_private_network is false', async () => {
    let callCount = 0;
    const resolvedAddresses: string[] = [];

    const result = await executeWithMockFetch(
      { url: 'https://example.com/start' },
      {
        resolveHostAddresses: async (hostname) => {
          if (hostname === 'example.com') return ['93.184.216.34'];
          if (hostname === 'redirect.example') return ['203.0.113.8'];
          return ['93.184.216.34'];
        },
        requestExecutor: async (_url, requestOptions) => {
          callCount++;
          resolvedAddresses.push(requestOptions.resolvedAddress ?? '');
          if (callCount === 1) {
            return new Response('', {
              status: 302,
              headers: { location: 'https://redirect.example/internal' },
            });
          }
          return new Response('ok', {
            status: 200,
            headers: { 'content-type': 'text/plain; charset=utf-8' },
          });
        },
      },
    );

    expect(result.isError).toBe(false);
    expect(resolvedAddresses).toEqual(['93.184.216.34', '203.0.113.8']);
  });

  test('blocks redirects to subdomain localhost targets when allow_private_network is false', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://foo.localhost:3000/internal' },
        });
      }
      return new Response('should-not-be-fetched', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: 'https://example.com/start' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing redirect to local/private network target');
    expect(callCount).toBe(1);
  });

  test('blocks redirects when target host resolves to private addresses and allow_private_network is false', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'https://internal.example/internal' },
        });
      }
      return new Response('should-not-be-fetched', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch(
      { url: 'https://example.com/start' },
      {
        resolveHostAddresses: async (hostname) => {
          if (hostname === 'example.com') return ['93.184.216.34'];
          if (hostname === 'internal.example') return ['10.0.0.8'];
          return ['93.184.216.34'];
        },
      },
    );
    expect(result.isError).toBe(true);
    expect(result.content).toContain('resolves to local/private network address 10.0.0.8');
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

    const result = await executeWithMockFetch({ url: 'https://example.com/start' });
    expect(result.isError).toBe(true);
    expect(result.content).toContain('Refusing redirect to local/private network target');
    expect(callCount).toBe(1);
  });

  test('blocks redirects to IPv4-compatible IPv6 private targets when allow_private_network is false', async () => {
    let callCount = 0;
    globalThis.fetch = (async (_url: string) => {
      callCount++;
      if (callCount === 1) {
        return new Response('', {
          status: 302,
          headers: { location: 'http://[::7f00:1]:3000/internal' },
        });
      }
      return new Response('should-not-be-fetched', {
        status: 200,
        headers: { 'content-type': 'text/plain; charset=utf-8' },
      });
    }) as any;

    const result = await executeWithMockFetch({ url: 'https://example.com/start' });
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

    const result = await executeWithMockFetch({
      url: 'https://example.com/start',
      allow_private_network: true,
    });
    expect(result.isError).toBe(false);
    expect(result.content).toContain('internal ok');
    expect(result.status).toContain('Followed 1 redirect(s).');
    expect(callCount).toBe(2);
  });
});
