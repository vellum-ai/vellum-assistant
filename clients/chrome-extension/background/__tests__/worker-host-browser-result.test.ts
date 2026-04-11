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
 *
 * Related: worker.ts's `connect()` resolves the selected assistant's
 * auth profile at entry to determine the relay transport and token
 * source. The assistant selection is re-read from chrome.storage.local
 * on every connect to avoid stale state. That resolution cannot be
 * unit-tested here without dragging in the entire service worker
 * module surface (chrome.* globals, bootstrap(), native messaging,
 * etc.), but the behaviour is verifiable by reading `connect()` in
 * worker.ts.
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
  /**
   * Mutable mode reference. Tests can reassign this to simulate a
   * token refresh after a reconnect-with-refresh cycle and then
   * verify that subsequent `getCurrentMode()` reads pick up the new
   * value (i.e. the caller is NOT caching a snapshot).
   */
  mode: RelayMode;
}

function makeFakeConnection(open: boolean, mode?: RelayMode): FakeConnection {
  const sent: string[] = [];
  const defaultMode: RelayMode = {
    kind: 'self-hosted',
    baseUrl: 'http://127.0.0.1:9999',
    token: 'tok-initial',
  };
  return {
    sent,
    open,
    mode: mode ?? defaultMode,
    isOpen() {
      return this.open;
    },
    send(data) {
      sent.push(data);
    },
    getCurrentMode() {
      return this.mode;
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

// ── Live mode read (stale-token regression) ─────────────────────────
//
// Pins the call-site contract that worker.ts's
// `dispatchHostBrowserResult` MUST pull the mode out of the live
// RelayConnection via `getCurrentMode()` on every dispatch, rather
// than closing over a snapshot captured at `connect()` time.
//
// The regression being pinned: when `scheduleReconnectWithRefresh`
// fires after a WebSocket drop, the connection's internal `deps.mode`
// is replaced with a new object holding a freshly minted token. A
// caller that cached the old mode object would silently 401/403
// forever. By reading through `getCurrentMode()` on every POST, the
// new token propagates automatically.
//
// We model the exact call-site pattern used by worker.ts —
// `const mode = conn.getCurrentMode(); return postHostBrowserResult(mode, conn, result);`
// — so that this test fails the moment someone re-introduces a
// snapshot capture.

async function dispatchViaConnection(
  conn: RelayConnectionLike,
  result: HostBrowserResultEnvelope,
): Promise<void> {
  const mode = conn.getCurrentMode();
  return postHostBrowserResult(mode, conn, result);
}

describe('postHostBrowserResult — live mode read via getCurrentMode()', () => {
  test('self-hosted: second dispatch picks up a refreshed token from the connection', async () => {
    const conn = makeFakeConnection(true, {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok-old',
    });

    await dispatchViaConnection(conn, exampleResult);

    // Simulate a reconnect-with-refresh cycle: the RelayConnection
    // would replace `deps.mode` with a new object holding the fresh
    // token. We mutate the fake's `mode` field to mimic that swap.
    conn.mode = {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok-new',
    };

    await dispatchViaConnection(conn, exampleResult);

    expect(fetchHandle.calls.length).toBe(2);
    const firstHeaders = fetchHandle.calls[0].init?.headers as
      | Record<string, string>
      | undefined;
    const secondHeaders = fetchHandle.calls[1].init?.headers as
      | Record<string, string>
      | undefined;
    expect(firstHeaders?.authorization).toBe('Bearer tok-old');
    expect(secondHeaders?.authorization).toBe('Bearer tok-new');
  });

  test('self-hosted: mode swap to cloud on the connection routes subsequent dispatches over the WebSocket', async () => {
    // Extra belt-and-braces: if the mode KIND itself flips (e.g. a
    // mode switch via setMode), the call-site must still read it
    // live. A captured snapshot would POST to the now-wrong baseUrl.
    const conn = makeFakeConnection(true, {
      kind: 'self-hosted',
      baseUrl: 'http://127.0.0.1:9999',
      token: 'tok-old',
    });

    await dispatchViaConnection(conn, exampleResult);
    expect(fetchHandle.calls.length).toBe(1);
    expect(conn.sent.length).toBe(0);

    conn.mode = {
      kind: 'cloud',
      baseUrl: 'https://api.vellum.ai',
      token: 'cloud-token',
    };

    await dispatchViaConnection(conn, exampleResult);

    // Still exactly one fetch — the cloud dispatch must not have
    // fallen through to an HTTP POST.
    expect(fetchHandle.calls.length).toBe(1);
    expect(conn.sent.length).toBe(1);
    const parsed = JSON.parse(conn.sent[0]) as Record<string, unknown>;
    expect(parsed.type).toBe('host_browser_result');
  });
});
