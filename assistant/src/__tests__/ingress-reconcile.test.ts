import { mkdtempSync } from "node:fs";
import * as net from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({ isHttpAuthDisabled: () => true }));

const testDir = mkdtempSync(join(tmpdir(), "ingress-reconcile-test-"));

// Track loadRawConfig / saveRawConfig calls
let rawConfigStore: Record<string, unknown> = {};

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
  }),
  loadConfig: () => ({}),
  loadRawConfig: () => ({ ...rawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    rawConfigStore = { ...cfg };
  },
  saveConfig: () => {},
  invalidateConfigCache: () => {},
}));

// eslint-disable-next-line @typescript-eslint/no-require-imports
const realPlatform = require("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getIpcBlobDir: () => join(testDir, "ipc-blobs"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
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
mock.module("../providers/registry.js", () => ({
  initializeProviders: () => {},
}));

// Mock token service — triggerGatewayReconcile uses mintDaemonDeliveryToken
// for the Bearer token.
let mintedToken: string | null = null;
mock.module("../runtime/auth/token-service.js", () => ({
  mintDaemonDeliveryToken: () => mintedToken ?? "test-delivery-token",
}));

import { handleIngressConfig } from "../daemon/handlers/config.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type {
  IngressConfigRequest,
  ServerMessage,
} from "../daemon/ipc-protocol.js";
import { DebouncerMap } from "../util/debounce.js";

// Capture fetch calls for reconcile trigger verification
interface ReconcileCall {
  kind: "telegram" | "twilio";
  url: string;
  method: string;
  headers: Record<string, string>;
  body: string;
}

let reconcileCalls: ReconcileCall[] = [];
let fetchShouldFail = false;
const originalFetch = globalThis.fetch;

function getReconcileCalls(kind?: "telegram" | "twilio"): ReconcileCall[] {
  return kind
    ? reconcileCalls.filter((call) => call.kind === kind)
    : reconcileCalls;
}

function expectSingleReconcileCall(kind: "telegram" | "twilio"): ReconcileCall {
  const calls = getReconcileCalls(kind);
  expect(calls).toHaveLength(1);
  return calls[0]!;
}

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
    send: (_socket, msg) => {
      sent.push(msg);
    },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => {
      throw new Error("not implemented");
    },
    touchSession: () => {},
  };
  return { ctx, sent };
}

describe("Ingress reconcile trigger in handleIngressConfig", () => {
  let savedIngressEnv: string | undefined;
  let savedGatewayBaseEnv: string | undefined;
  let savedGatewayPortEnv: string | undefined;

  beforeEach(() => {
    rawConfigStore = {};
    mintedToken = null;
    reconcileCalls = [];
    fetchShouldFail = false;

    savedIngressEnv = process.env.INGRESS_PUBLIC_BASE_URL;
    savedGatewayBaseEnv = process.env.GATEWAY_INTERNAL_BASE_URL;
    savedGatewayPortEnv = process.env.GATEWAY_PORT;
    delete process.env.INGRESS_PUBLIC_BASE_URL;
    delete process.env.GATEWAY_INTERNAL_BASE_URL;
    delete process.env.GATEWAY_PORT;

    // Install fetch interceptor
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const kind = urlStr.includes("/internal/telegram/reconcile")
        ? "telegram"
        : urlStr.includes("/internal/twilio/reconcile")
          ? "twilio"
          : undefined;
      if (kind) {
        const headers: Record<string, string> = {};
        if (init?.headers) {
          const h = init.headers as Record<string, string>;
          for (const [k, v] of Object.entries(h)) {
            headers[k] = v;
          }
        }
        reconcileCalls.push({
          kind,
          url: urlStr,
          method: init?.method ?? "GET",
          headers,
          body: (init?.body as string) ?? "",
        });
        if (fetchShouldFail) {
          throw new Error("ECONNREFUSED: gateway unavailable");
        }
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;
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

  test("always triggers reconcile using mintDaemonDeliveryToken", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://my-tunnel.example.com",
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    // Allow any pending microtasks to flush
    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean };
    expect(res.success).toBe(true);

    // Reconcile is always triggered using mintDaemonDeliveryToken
    expect(getReconcileCalls()).toHaveLength(2);
  });

  test("triggers reconcile with mintDaemonDeliveryToken bearer token", async () => {
    mintedToken = "test-bearer-token";

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://my-tunnel.example.com",
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    expect(getReconcileCalls()).toHaveLength(2);
    expect(expectSingleReconcileCall("telegram").headers["Authorization"]).toBe(
      "Bearer test-bearer-token",
    );
    expect(expectSingleReconcileCall("twilio").headers["Authorization"]).toBe(
      "Bearer test-bearer-token",
    );
  });

  // ── Request payload normalization ───────────────────────────────────────

  test("sends ingressPublicBaseUrl in reconcile body when URL is set", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://my-tunnel.example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    const telegramBody = JSON.parse(expectSingleReconcileCall("telegram").body);
    const twilioBody = JSON.parse(expectSingleReconcileCall("twilio").body);
    expect(telegramBody.ingressPublicBaseUrl).toBe(
      "https://my-tunnel.example.com",
    );
    expect(twilioBody.ingressPublicBaseUrl).toBe(
      "https://my-tunnel.example.com",
    );
  });

  test("sends POST to /internal/telegram/reconcile with correct content type", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    expect(expectSingleReconcileCall("telegram").method).toBe("POST");
    expect(expectSingleReconcileCall("twilio").method).toBe("POST");
    expect(expectSingleReconcileCall("telegram").headers["Content-Type"]).toBe(
      "application/json",
    );
    expect(expectSingleReconcileCall("twilio").headers["Content-Type"]).toBe(
      "application/json",
    );
  });

  test("normalizes trailing slashes in publicBaseUrl before sending reconcile", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://my-tunnel.example.com///",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    const telegramBody = JSON.parse(expectSingleReconcileCall("telegram").body);
    const twilioBody = JSON.parse(expectSingleReconcileCall("twilio").body);
    // The handler trims trailing slashes before storing and propagating
    expect(telegramBody.ingressPublicBaseUrl).toBe(
      "https://my-tunnel.example.com",
    );
    expect(twilioBody.ingressPublicBaseUrl).toBe(
      "https://my-tunnel.example.com",
    );
  });

  test("uses GATEWAY_INTERNAL_BASE_URL when set", async () => {
    process.env.GATEWAY_INTERNAL_BASE_URL = "http://custom-gateway:9999";

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    expect(expectSingleReconcileCall("telegram").url).toBe(
      "http://custom-gateway:9999/internal/telegram/reconcile",
    );
    expect(expectSingleReconcileCall("twilio").url).toBe(
      "http://custom-gateway:9999/internal/twilio/reconcile",
    );
  });

  test("defaults to localhost:7830 when no GATEWAY env vars set", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    expect(expectSingleReconcileCall("telegram").url).toBe(
      "http://127.0.0.1:7830/internal/telegram/reconcile",
    );
    expect(expectSingleReconcileCall("twilio").url).toBe(
      "http://127.0.0.1:7830/internal/twilio/reconcile",
    );
  });

  test("uses GATEWAY_PORT when GATEWAY_INTERNAL_BASE_URL is not set", async () => {
    process.env.GATEWAY_PORT = "8888";

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    expect(expectSingleReconcileCall("telegram").url).toBe(
      "http://127.0.0.1:8888/internal/telegram/reconcile",
    );
    expect(expectSingleReconcileCall("twilio").url).toBe(
      "http://127.0.0.1:8888/internal/twilio/reconcile",
    );
  });

  // ── Non-fatal failure behavior ──────────────────────────────────────────

  test("reconcile failure does not cause handleIngressConfig to fail", async () => {
    fetchShouldFail = true;

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://my-tunnel.example.com",
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    // The handler should still succeed even though reconcile fetch threw
    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      enabled: boolean;
      publicBaseUrl: string;
    };
    expect(res.type).toBe("ingress_config_response");
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);
    expect(res.publicBaseUrl).toBe("https://my-tunnel.example.com");

    // Both reconcile attempts were still made (they just failed gracefully)
    expect(getReconcileCalls()).toHaveLength(2);
  });

  test("response is sent before reconcile fetch completes", async () => {
    // Track timing: response should be sent before fetch resolves
    let fetchResolved = false;
    const originalMockFetch = globalThis.fetch;
    globalThis.fetch = (async (
      url: string | URL | Request,
      init?: RequestInit,
    ) => {
      const urlStr =
        typeof url === "string"
          ? url
          : url instanceof URL
            ? url.toString()
            : url.url;
      const kind = urlStr.includes("/internal/telegram/reconcile")
        ? "telegram"
        : urlStr.includes("/internal/twilio/reconcile")
          ? "twilio"
          : undefined;
      if (kind) {
        // Delay the response to simulate network latency
        await new Promise((r) => setTimeout(r, 100));
        fetchResolved = true;
        reconcileCalls.push({
          kind,
          url: urlStr,
          method: init?.method ?? "GET",
          headers: {},
          body: (init?.body as string) ?? "",
        });
        return new Response(JSON.stringify({ ok: true }), { status: 200 });
      }
      return originalFetch(url, init);
    }) as unknown as typeof fetch;

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://example.com",
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

  test("set action with enabled=true and URL triggers reconcile with the URL", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://set-test.example.com",
      enabled: true,
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as { type: string; success: boolean; enabled: boolean };
    expect(res.success).toBe(true);
    expect(res.enabled).toBe(true);

    expect(getReconcileCalls()).toHaveLength(2);
    const telegramBody = JSON.parse(expectSingleReconcileCall("telegram").body);
    const twilioBody = JSON.parse(expectSingleReconcileCall("twilio").body);
    expect(telegramBody.ingressPublicBaseUrl).toBe(
      "https://set-test.example.com",
    );
    expect(twilioBody.ingressPublicBaseUrl).toBe(
      "https://set-test.example.com",
    );
  });

  // ── Clear flow ──────────────────────────────────────────────────────────

  test("set action with empty URL and enabled=true (clear URL) still triggers reconcile", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "",
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
    expect(getReconcileCalls()).toHaveLength(2);
    const telegramBody = JSON.parse(expectSingleReconcileCall("telegram").body);
    const twilioBody = JSON.parse(expectSingleReconcileCall("twilio").body);
    expect(telegramBody.ingressPublicBaseUrl).toBe("");
    expect(twilioBody.ingressPublicBaseUrl).toBe("");
  });

  // ── Disable flow ────────────────────────────────────────────────────────

  test("set action with enabled=false triggers reconcile with empty URL", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://disabled-test.example.com",
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
    expect(getReconcileCalls()).toHaveLength(2);
    const telegramBody = JSON.parse(expectSingleReconcileCall("telegram").body);
    const twilioBody = JSON.parse(expectSingleReconcileCall("twilio").body);
    // When disabled, effectiveUrl is undefined, so the body sends empty string
    expect(telegramBody.ingressPublicBaseUrl).toBe("");
    expect(twilioBody.ingressPublicBaseUrl).toBe("");
  });

  test("disabling ingress removes INGRESS_PUBLIC_BASE_URL env var", () => {
    // First set ingress to populate env var
    process.env.INGRESS_PUBLIC_BASE_URL =
      "https://should-be-removed.example.com";

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://disabled-test.example.com",
      enabled: false,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    // Env var should be cleared
    expect(process.env.INGRESS_PUBLIC_BASE_URL).toBeUndefined();
  });

  // ── Get action does not trigger reconcile ───────────────────────────────

  test("get action does not trigger reconcile", async () => {
    rawConfigStore = {
      ingress: { publicBaseUrl: "https://existing.example.com", enabled: true },
    };

    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "get",
    };

    const { ctx, sent } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(sent).toHaveLength(1);
    const res = sent[0] as {
      type: string;
      success: boolean;
      publicBaseUrl: string;
    };
    expect(res.success).toBe(true);
    expect(res.publicBaseUrl).toBe("https://existing.example.com");

    // No reconcile should have been triggered for a get action
    expect(getReconcileCalls()).toHaveLength(0);
  });

  // ── Env var propagation ─────────────────────────────────────────────────

  test("set action propagates URL to process.env when enabled", () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://env-propagation.example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    expect(process.env.INGRESS_PUBLIC_BASE_URL).toBe(
      "https://env-propagation.example.com",
    );
  });

  test("reconcile uses effective URL from process.env (not raw value)", async () => {
    const msg: IngressConfigRequest = {
      type: "ingress_config",
      action: "set",
      publicBaseUrl: "https://effective-url.example.com",
      enabled: true,
    };

    const { ctx } = createTestContext();
    handleIngressConfig(msg, {} as net.Socket, ctx);

    await new Promise((r) => setTimeout(r, 50));

    expect(getReconcileCalls()).toHaveLength(2);
    const twilioBody = JSON.parse(expectSingleReconcileCall("twilio").body);
    // The URL in the reconcile body should match the effective env var
    expect(twilioBody.ingressPublicBaseUrl).toBe(
      "https://effective-url.example.com",
    );
  });
});
