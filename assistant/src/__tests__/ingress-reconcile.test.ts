import { describe, test, expect, mock, beforeEach, afterEach } from 'bun:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as net from 'node:net';

const testDir = mkdtempSync(join(tmpdir(), 'ingress-reconcile-test-'));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};

mock.module('../config/loader.js', () => ({
  getConfig: () => ({}),
  loadConfig: () => ({}),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

// readHttpToken return value — controlled per test
let httpTokenValue: string | null = null;

mock.module('../util/platform.js', () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => join(testDir, 'ipc-blobs'),
  isMacOS: () => process.platform === 'darwin',
  isLinux: () => process.platform === 'linux',
  isWindows: () => process.platform === 'win32',
  getSocketPath: () => join(testDir, 'test.sock'),
  getPidPath: () => join(testDir, 'test.pid'),
  getDbPath: () => join(testDir, 'test.db'),
  getLogPath: () => join(testDir, 'test.log'),
  ensureDataDir: () => {},
  readHttpToken: () => httpTokenValue,
}));

mock.module('../util/logger.js', () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    isDebug: () => false,
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
      isDebug: () => false,
    }),
  }),
}));

// Mock providers registry to avoid side effects
mock.module('../providers/registry.js', () => ({
  initializeProviders: () => {},
}));

import { handleIngressConfig } from '../daemon/handlers/config.js';
import type { HandlerContext } from '../daemon/handlers/shared.js';
import type {
  IngressConfigRequest,
  ServerMessage,
} from '../daemon/ipc-contract.js';
import { DebouncerMap } from '../util/debounce.js';

// Capture fetch calls for reconcile trigger verification
interface ReconcileCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let reconcileCalls: ReconcileCall[] = [];
let fetchShouldFail = false;
const originalFetch = globalThis.fetch;

function createTestContext(): { ctx: HandlerContext; sent: ServerMessage[] } {
  const sent: ServerMessage[] = [];
  const ctx: HandlerContext = {
    sessions: new Map(),
    socketToSession: new Map(),
    cuSessions: new Map(),
    socketToCuSession: new Map(),
    cuObservationParseSequence: new Map(),
    socketSandboxOverride: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: new DebouncerMap({ defaultDelayMs: 200 }),
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (_socket, msg) => { sent.push(msg); },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => { throw new Error('not implemented'); },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe('Ingress reconcile trigger in handleIngressConfig', () => {
  let savedIngressEnv: string | undefined;
  let savedGatewayBaseEnv: string | undefined;
  let savedGatewayPortEnv: string | undefined;

  beforeEach(() => {
    rawConfigStore = {};
    httpTokenValue = null;
    reconcileCalls = [];
    fetchShouldFail = false;

    savedIngressEnv = process.env.INGRESS_PUBLIC_BASE_URL;
    savedGatewayBaseEnv = process.env.GATEWAY_INTERNAL_BASE_URL;
    savedGatewayPortEnv = process.env.GATEWAY_PORT;
    delete process.env.INGRESS_PUBLIC_BASE_URL;
    delete process.env.GATEWAY_INTERNAL_BASE_URL;
    delete process.env.GATEWAY_PORT;

    // Install fetch interceptor
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('/internal/telegram/reconcile')) {
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = init.headers as Record<string, string>;
          for (const [k, v] of Object.entries(h)) {
            headers[k] = v;
          }
        }
        reconcileCalls.push({
          url: urlStr,
          method: init?.method ?? 'GET',
          headers,
          body: (init?.body as string) ?? '',
        });
        if (fetchShouldFail) {
          throw new Error('ECONNREFUSED: gateway unavailable');
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    if (savedIngressEnv !== undefined) {
      process.env.INGRESS_PUBLIC_BASE_URL = savedIngressEnv;
    } else {
      delete process.env.INGRESS_PUBLIC_BASE_URL;
    }
    if (savedGatewayBaseEnv !== undefined) {
      process.env.GATEWAY_INTERNAL_BASE_URL = savedGatewayBaseEnv;
    } else {
      delete process.env.GATEWAY_INTERNAL_BASE_URL;
    }
    if (savedGatewayPortEnv !== undefined) {
      process.env.GATEWAY_PORT = savedGatewayPortEnv;
    } else {
      delete process.env.GATEWAY_PORT;
    }
  });

  // ── Token present/missing behavior ──────────────────────────────────────

  test('skips reconcile trigger when no HTTP bearer token is available', async () => {
    httpTokenValue = null;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://my-tunnel.example.com',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    // Allow any pending microtasks to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // No reconcile call should have been made
    expect(reconcileCalls).toHaveLength(0);
  });

  test('triggers reconcile when HTTP bearer token is available', async () => {
    httpTokenValue = 'test-bearer-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://my-tunnel.example.com',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.headers['Authorization']).toBe('Bearer test-bearer-token');
  });

  // ── Request payload normalization ───────────────────────────────────────

  test('sends ingressPublicBaseUrl in reconcile body when URL is set', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://my-tunnel.example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    const body = JSON.parse(reconcileCalls[0]!.body);
    expect(body.ingressPublicBaseUrl).toBe('https://my-tunnel.example.com');
  });

  test('sends POST to /internal/telegram/reconcile with correct content type', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.method).toBe('POST');
    expect(reconcileCalls[0]!.headers['Content-Type']).toBe('application/json');
  });

  test('normalizes trailing slashes in publicBaseUrl before sending reconcile', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://my-tunnel.example.com///',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    const body = JSON.parse(reconcileCalls[0]!.body);
    // The handler trims trailing slashes before storing and propagating
    expect(body.ingressPublicBaseUrl).toBe('https://my-tunnel.example.com');
  });

  test('uses GATEWAY_INTERNAL_BASE_URL when set', async () => {
    httpTokenValue = 'test-token';
    process.env.GATEWAY_INTERNAL_BASE_URL = 'http://custom-gateway:9999';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.url).toBe('http://custom-gateway:9999/internal/telegram/reconcile');
  });

  test('defaults to localhost:7830 when no GATEWAY env vars set', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.url).toBe('http://127.0.0.1:7830/internal/telegram/reconcile');
  });

  test('uses GATEWAY_PORT when GATEWAY_INTERNAL_BASE_URL is not set', async () => {
    httpTokenValue = 'test-token';
    process.env.GATEWAY_PORT = '8888';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    expect(reconcileCalls[0]!.url).toBe('http://127.0.0.1:8888/internal/telegram/reconcile');
  });

  // ── Non-fatal failure behavior ──────────────────────────────────────────

  test('reconcile failure does not cause handleIngressConfig to fail', async () => {
    httpTokenValue = 'test-token';
    fetchShouldFail = true;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://my-tunnel.example.com',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    // The handler should still succeed even though reconcile fetch threw
    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean; publicBaseUrl: string };
    expect(res.type).toBe('ingress_config_response');
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.publicBaseUrl).toBe('https://my-tunnel.example.com');

    // The reconcile attempt was still made (it just failed gracefully)
    expect(reconcileCalls).toHaveLength(1);
  });

  test('response is sent before reconcile fetch completes', async () => {
    httpTokenValue = 'test-token';

    // Track timing: response should be sent before fetch resolves
    let fetchResolved = false;
    const originalMockFetch = globalThis.fetch;
    globalThis.fetch = (async (url: string | URL | Request, init?: RequestInit) => {
      const urlStr = typeof url === 'string' ? url : url instanceof URL ? url.toString() : url.url;
      if (urlStr.includes('/internal/telegram/reconcile')) {
        // Delay the response to simulate network latency
        await new Promise((r) => setTimeout(r, 100));
        fetchResolved = true;
        reconcileCalls.push({
          url: urlStr,
          method: init?.method ?? 'GET',
          headers: {},
          body: (init?.body as string) ?? '',
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as typeof fetch;

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://example.com',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    // Response should be available immediately (before fetch resolves)
    expect(sent).toHaveLength(1);
    expect(fetchResolved).toBe(false);

    // Clean up: wait for the delayed fetch to complete
    await new Promise((r) => setTimeout(r, 150));
    globalThis.fetch = originalMockFetch;
  });

  // ── Set flow ────────────────────────────────────────────────────────────

  test('set action with enabled=true and URL triggers reconcile with the URL', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://set-test.example.com',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean };
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);

    expect(reconcileCalls).toHaveLength(1);
    const body = JSON.parse(reconcileCalls[0]!.body);
    expect(body.ingressPublicBaseUrl).toBe('https://set-test.example.com');
  });

  // ── Clear flow ──────────────────────────────────────────────────────────

  test('set action with empty URL and enabled=true (clear URL) still triggers reconcile', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: '',
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // Reconcile is called unconditionally on set action
    // When no URL and no env fallback, effectiveUrl is undefined so
    // the reconcile body should send empty string (clears the gateway's URL)
    expect(reconcileCalls).toHaveLength(1);
    const body = JSON.parse(reconcileCalls[0]!.body);
    expect(body.ingressPublicBaseUrl).toBe('');
  });

  // ── Disable flow ────────────────────────────────────────────────────────

  test('set action with enabled=false triggers reconcile with empty URL', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://disabled-test.example.com',
      enabled: false,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean };
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(false);

    // Reconcile should still fire (to clear gateway's in-memory URL)
    expect(reconcileCalls).toHaveLength(1);
    const body = JSON.parse(reconcileCalls[0]!.body);
    // When disabled, effectiveUrl is undefined, so the body sends empty string
    expect(body.ingressPublicBaseUrl).toBe('');
  });

  test('disabling ingress removes INGRESS_PUBLIC_BASE_URL env var', () => {
    httpTokenValue = 'test-token';

    // First set ingress to populate env var
    process.env.INGRESS_PUBLIC_BASE_URL = 'https://should-be-removed.example.com';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://disabled-test.example.com',
      enabled: false,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    // Env var should be cleared
    expect(process.env.INGRESS_PUBLIC_BASE_URL).toBeUndefined();
  });

  // ── Get action does not trigger reconcile ───────────────────────────────

  test('get action does not trigger reconcile', async () => {
    httpTokenValue = 'test-token';
    rawConfigStore = {
      ingress: { publicBaseUrl: 'https://existing.example.com', enabled: true },
    };

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'get',
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; publicBaseUrl: string };
    expect(res.success).toBe(true);
    expect(res.publicBaseUrl).toBe('https://existing.example.com');

    // No reconcile should have been triggered for a get action
    expect(reconcileCalls).toHaveLength(0);
  });

  // ── Env var propagation ─────────────────────────────────────────────────

  test('set action propagates URL to process.env when enabled', () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://env-propagation.example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    expect(process.env.INGRESS_PUBLIC_BASE_URL).toBe('https://env-propagation.example.com');
  });

  test('reconcile uses effective URL from process.env (not raw value)', async () => {
    httpTokenValue = 'test-token';

    const msg: IngressConfigRequest = {
      type: 'ingress_config',
      action: 'set',
      publicBaseUrl: 'https://effective-url.example.com',
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(reconcileCalls).toHaveLength(1);
    const body = JSON.parse(reconcileCalls[0]!.body);
    // The URL in the reconcile body should match the effective env var
    expect(body.ingressPublicBaseUrl).toBe('https://effective-url.example.com');
  });
});
