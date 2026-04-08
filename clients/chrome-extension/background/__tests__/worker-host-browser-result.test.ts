/**
 * Tests for the relay-aware host_browser result poster.
 *
 * Drives `postHostBrowserResult` against a fake `fetch` and a fake
 * `RelayConnection` so we can exercise both transport branches without
 * standing up a real socket or local daemon. Covers:
 *
 *   - self-hosted mode: POSTs to `${baseUrl}/v1/host-browser-result`
 *     with `Authorization: Bearer <token>` and the JSON-serialised
 *     result envelope as the body.
 *   - cloud mode with an OPEN connection: sends a JSON-stringified
 *     `host_browser_result` frame via `connection.send` and never
 *     touches `fetch`.
 *   - cloud mode with a closed or null connection: logs a warning,
 *     never touches `fetch`, and never throws.
 *
 * The function lives in `relay-connection.ts` (rather than `worker.ts`)
 * so the test can import it directly without dragging in the chrome
 * service worker module surface.
 */

import { describe, test, expect, beforeEach, afterEach } from 'bun:test';

import {
  postHostBrowserResult,
  type RelayConnectionLike,
  type RelayMode,
} from '../relay-connection.js';
import type { HostBrowserResultEnvelope } from '../host-browser-dispatcher.js';

// ── Fake transports ─────────────────────────────────────────────────

interface FakeFetchCall {
  input: string;
  init?: RequestInit;
}

interface FakeFetchHandle {
  calls: FakeFetchCall[];
  /** Sets the response returned by the next fetch call. */
  setNextResponse(resp: Response): void;
  restore(): void;
}

function installFakeFetch(): FakeFetchHandle {
  const calls: FakeFetchCall[] = [];
  let nextResponse: Response = new Response(null, { status: 200 });
  const original = (globalThis as { fetch?: typeof fetch }).fetch;
  (globalThis as { fetch: typeof fetch }).fetch = (async (
    input: RequestInfo | URL,
    init?: RequestInit,
  ) => {
    calls.push({ input: String(input), init });
    return nextResponse;
  }) as typeof fetch;
  return {
    calls,
    setNextResponse(resp) {
      nextResponse = resp;
    },
    restore() {
      if (original) {
        (globalThis as { fetch: typeof fetch }).fetch = original;
      } else {
        delete (globalThis as { fetch?: typeof fetch }).fetch;
      }
    },
  };
}

interface FakeConnection extends RelayConnectionLike {
  sent: string[];
  /** Toggle whether `isOpen()` returns true or false. */
  open: boolean;
}

function makeFakeConnection(open: boolean): FakeConnection {
  const sent: string[] = [];
  return {
    sent,
    open,
    isOpen() {
      return this.open;
    },
    send(data) {
      sent.push(data);
    },
  };
}

interface ConsoleSpy {
  warnings: unknown[][];
  restore(): void;
}

function spyConsoleWarn(): ConsoleSpy {
  const warnings: unknown[][] = [];
  const original = console.warn;
  console.warn = (...args: unknown[]) => {
    warnings.push(args);
  };
  return {
    warnings,
    restore() {
      console.warn = original;
    },
  };
}

// ── Fixtures ────────────────────────────────────────────────────────

const exampleResult: HostBrowserResultEnvelope = {
  requestId: 'req-abc',
  content: '{"frameId":"42"}',
  isError: false,
};

let fetchHandle: FakeFetchHandle;
let consoleSpy: ConsoleSpy;

beforeEach(() => {
  fetchHandle = installFakeFetch();
  consoleSpy = spyConsoleWarn();
});

afterEach(() => {
  fetchHandle.restore();
  consoleSpy.restore();
});

// ── Self-hosted mode ────────────────────────────────────────────────

describe('postHostBrowserResult — self-hosted mode', () => {
  test('POSTs to ${baseUrl}/v1/host-browser-result with bearer auth', async () => {
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok-1',
    };

    await postHostBrowserResult(mode, null, exampleResult);

    expect(fetchHandle.calls.length).toBe(1);
    const call = fetchHandle.calls[0];
    expect(call.input).toBe('http://127.0.0.1:9999/v1/host-browser-result');
    expect(call.init?.method).toBe('POST');
    const headers = call.init?.headers as Record<string, string> | undefined;
    expect(headers?.authorization).toBe('Bearer tok-1');
    expect(headers?.['content-type']).toBe('application/json');
    expect(call.init?.body).toBe(JSON.stringify(exampleResult));
  });

  test('omits the authorization header when no token is configured', async () => {
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: null,
    };

    await postHostBrowserResult(mode, null, exampleResult);

    expect(fetchHandle.calls.length).toBe(1);
    const headers = fetchHandle.calls[0].init?.headers as
      | Record<string, string>
      | undefined;
    expect(headers?.authorization).toBeUndefined();
  });

  test('strips a trailing slash from the base URL', async () => {
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999/',
      token: 'tok-1',
    };

    await postHostBrowserResult(mode, null, exampleResult);

    expect(fetchHandle.calls[0].input).toBe(
      'http://127.0.0.1:9999/v1/host-browser-result',
    );
  });

  test('logs a warning when the daemon returns a non-2xx status', async () => {
    fetchHandle.setNextResponse(new Response(null, { status: 503 }));
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok-1',
    };

    await postHostBrowserResult(mode, null, exampleResult);

    expect(consoleSpy.warnings.length).toBeGreaterThanOrEqual(1);
    const flat = consoleSpy.warnings.flat().join(' ');
    expect(flat).toContain('503');
  });

  test('ignores the supplied connection in self-hosted mode', async () => {
    const conn = makeFakeConnection(true);
    const mode: RelayMode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok-1',
    };

    await postHostBrowserResult(mode, conn, exampleResult);

    expect(fetchHandle.calls.length).toBe(1);
    expect(conn.sent).toEqual([]);
  });
});

// ── Cloud mode ──────────────────────────────────────────────────────

describe('postHostBrowserResult — cloud mode', () => {
  test('sends a host_browser_result frame over an open connection and skips fetch', async () => {
    const conn = makeFakeConnection(true);
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://api.vellum.ai',
      token: 'cloud-token',
    };

    await postHostBrowserResult(mode, conn, exampleResult);

    expect(fetchHandle.calls).toEqual([]);
    expect(conn.sent.length).toBe(1);
    const parsed = JSON.parse(conn.sent[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('host_browser_result');
    expect(parsed.requestId).toBe(exampleResult.requestId);
    expect(parsed.content).toBe(exampleResult.content);
    expect(parsed.isError).toBe(exampleResult.isError);
  });

  test('warns and no-ops when the connection is not open', async () => {
    const conn = makeFakeConnection(false);
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://api.vellum.ai',
      token: 'cloud-token',
    };

    const returned = await postHostBrowserResult(mode, conn, exampleResult);
    expect(returned).toBeUndefined();

    expect(fetchHandle.calls).toEqual([]);
    expect(conn.sent).toEqual([]);
    const flat = consoleSpy.warnings.flat().join(' ');
    expect(flat).toContain('cloud relay not connected');
  });

  test('warns and no-ops when the connection is null', async () => {
    const mode: RelayMode = {
      kind: 'cloud',
      baseUrl: 'https://api.vellum.ai',
      token: 'cloud-token',
    };

    const returned = await postHostBrowserResult(mode, null, exampleResult);
    expect(returned).toBeUndefined();

    expect(fetchHandle.calls).toEqual([]);
    const flat = consoleSpy.warnings.flat().join(' ');
    expect(flat).toContain('cloud relay not connected');
  });
});
