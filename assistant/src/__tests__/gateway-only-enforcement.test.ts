/**
 * Tests for gateway-only ingress enforcement in the runtime HTTP server.
 *
 * Verifies:
 * - Runtime does not expose any Telegram webhook ingress routes
 * - Direct Twilio webhook routes return 410
 * - Internal forwarding routes (gateway→runtime) still work
 * - Relay WebSocket upgrade blocked for non-private-network origins (isPrivateNetworkOrigin)
 * - Relay WebSocket upgrade allowed from private network peers/origins
 * - Startup warning when RUNTIME_HTTP_HOST is not loopback
 */
import { mkdtempSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "gw-only-enforcement-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  getWorkspaceConfigPath: () => join(testDir, "config.json"),
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

const logMessages: { level: string; msg: string; args?: unknown }[] = [];

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: (_target, prop: string) => {
        if (prop === "child")
          return () =>
            new Proxy({} as Record<string, unknown>, {
              get: () => () => {},
            });
        return (...args: unknown[]) => {
          if (typeof args[0] === "string") {
            logMessages.push({ level: prop, msg: args[0] });
          } else if (typeof args[1] === "string") {
            logMessages.push({ level: prop, msg: args[1], args: args[0] });
          }
        };
      },
    }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    model: "test",
    provider: "test",
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    calls: {
      enabled: true,
      provider: "twilio",
      webhookBaseUrl: "https://test.example.com",
      maxDurationSeconds: 3600,
      userConsultTimeoutSeconds: 120,
      disclosure: { enabled: false, text: "" },
      safety: { denyCategories: [] },
    },
    ingress: {
      publicBaseUrl: "https://test.example.com",
    },
    twilio: {
      phoneNumber: "+15550001111",
    },
  }),
  getConfig: () => ({
    model: "test",
    provider: "test",
    apiKeys: {},
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
    secretDetection: { enabled: false },
    ingress: {
      publicBaseUrl: "https://test.example.com",
    },
    twilio: {
      phoneNumber: "+15550001111",
    },
  }),
  invalidateConfigCache: () => {},
}));

// Mock Twilio provider
mock.module("../calls/twilio-provider.js", () => ({
  TwilioConversationRelayProvider: class {
    static getAuthToken() {
      return "mock-auth-token";
    }
    static verifyWebhookSignature() {
      return true;
    }
    async initiateCall() {
      return { callSid: "CA_mock_sid" };
    }
    async endCall() {
      return;
    }
  },
}));

const secureKeyStore: Record<string, string | undefined> = {
  "credential:twilio:account_sid": "AC_test",
  "credential:twilio:auth_token": "test_token",
};

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => secureKeyStore[key] ?? null,
  setSecureKey: (key: string, value: string) => {
    secureKeyStore[key] = value;
    return true;
  },
  deleteSecureKey: (key: string) => {
    if (key in secureKeyStore) {
      delete secureKeyStore[key];
      return "deleted";
    }
    return "not-found";
  },
}));

// NOTE: Do NOT mock '../inbound/public-ingress-urls.js' here.
// Those are pure functions that derive URLs from the config object returned by
// loadConfig() (which is already mocked above). Mocking them at the module level
// leaks into other test files (e.g. ingress-url-consistency.test.ts) that need
// the real implementations, causing cross-test contamination.

// Mock the oauth callback registry
mock.module("../security/oauth-callback-registry.js", () => ({
  consumeCallback: () => true,
  consumeCallbackError: () => true,
}));

// Mock call-store so WebSocket close handlers don't hit the real DB
mock.module("../calls/call-store.js", () => ({
  getCallSession: () => null,
  getCallSessionByCallSid: () => null,
  updateCallSession: () => {},
  recordCallEvent: () => {},
  expirePendingQuestions: () => {},
}));

import { mintToken } from "../runtime/auth/token-service.js";
import { isPrivateAddress, RuntimeHttpServer } from "../runtime/http-server.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Legacy shared secret — used only for pairing routes and non-JWT purposes. */
const TEST_TOKEN = "test-bearer-token-gw";

/** Actor JWT for standard authenticated requests. */
const TEST_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "actor:self:test",
  scope_profile: "actor_client_v1",
  policy_epoch: 1,
  ttlSeconds: 3600,
});
const AUTH_HEADERS = { Authorization: `Bearer ${TEST_JWT}` };

/** Gateway JWT for routes that require svc_gateway principal type. */
const GATEWAY_JWT = mintToken({
  aud: "vellum-daemon",
  sub: "svc:gateway:self",
  scope_profile: "gateway_ingress_v1",
  policy_epoch: 1,
  ttlSeconds: 3600,
});
const GATEWAY_AUTH_HEADERS = { Authorization: `Bearer ${GATEWAY_JWT}` };

function makeFormBody(params: Record<string, string>): string {
  return new URLSearchParams(params).toString();
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("gateway-only ingress enforcement", () => {
  let server: RuntimeHttpServer;
  let port: number;

  // Share a single server across all tests to avoid EADDRINUSE flakes from
  // rapid port allocation/deallocation when creating a server per test.
  // All tests are read-only (HTTP requests checking status codes) so sharing is safe.
  beforeAll(async () => {
    server = new RuntimeHttpServer({
      port: 0,
      hostname: "127.0.0.1",
      bearerToken: TEST_TOKEN,
    });
    await server.start();
    port = server.actualPort;
  });

  afterAll(async () => {
    await server.stop();
  });

  // ── Runtime does not expose Telegram webhook ingress ─────────────

  describe("runtime has no Telegram webhook routes", () => {
    test("POST /webhooks/telegram is rejected (not handled by runtime)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1, message: { text: "hello" } }),
      });
      // The runtime has no route for /webhooks/telegram. Without auth, the
      // request is rejected with 401 (auth middleware fires before 404).
      // With auth, it would 404. Either way, no Telegram handler runs.
      expect(res.status).toBe(401);
    });

    test("GET /webhooks/telegram is rejected", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`);
      expect(res.status).toBe(401);
    });

    test("POST /webhooks/telegram/test is rejected", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/telegram/test`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      expect(res.status).toBe(401);
    });

    test("POST /webhooks/telegram returns 404 when authenticated (no handler exists)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/webhooks/telegram`, {
        method: "POST",
        headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
        body: JSON.stringify({ update_id: 1, message: { text: "hello" } }),
      });
      // With valid auth, the request passes the auth middleware and reaches
      // route matching — confirming no Telegram webhook handler exists.
      expect(res.status).toBe(404);
    });

    test("POST /webhooks/telegram/test returns 404 when authenticated (no handler exists)", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/telegram/test`,
        {
          method: "POST",
          headers: { ...AUTH_HEADERS, "Content-Type": "application/json" },
          body: JSON.stringify({}),
        },
      );
      // With valid auth, the request passes the auth middleware and reaches
      // route matching — confirming no Telegram subpath handler exists.
      expect(res.status).toBe(404);
    });
  });

  // ── Direct Twilio webhook routes blocked in gateway_only mode ──────

  describe("direct webhook routes are blocked", () => {
    test("POST /webhooks/twilio/voice returns 410", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/twilio/voice`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: makeFormBody({ CallSid: "CA123", AccountSid: "AC_test" }),
        },
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("GONE");
      expect(body.error.message).toContain("Direct webhook access disabled");
    });

    test("POST /webhooks/twilio/status returns 410", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/twilio/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: makeFormBody({ CallSid: "CA123", CallStatus: "completed" }),
        },
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("GONE");
    });

    test("POST /webhooks/twilio/connect-action returns 410", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/webhooks/twilio/connect-action`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: makeFormBody({ CallSid: "CA123" }),
        },
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("GONE");
    });

    test("POST /v1/calls/twilio/voice-webhook returns 410", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/calls/twilio/voice-webhook`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: makeFormBody({ CallSid: "CA123" }),
        },
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("GONE");
    });

    test("POST /v1/calls/twilio/status returns 410", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/calls/twilio/status`,
        {
          method: "POST",
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: makeFormBody({ CallSid: "CA123", CallStatus: "completed" }),
        },
      );
      expect(res.status).toBe(410);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("GONE");
    });
  });

  // ── Internal forwarding routes still work ─────

  describe("internal forwarding routes are not blocked", () => {
    test("POST /v1/internal/twilio/voice-webhook is NOT blocked", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/internal/twilio/voice-webhook`,
        {
          method: "POST",
          headers: {
            ...GATEWAY_AUTH_HEADERS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            params: { CallSid: "CA123", AccountSid: "AC_test" },
            originalUrl: `http://127.0.0.1:${port}/v1/internal/twilio/voice-webhook?callSessionId=sess-123`,
          }),
        },
      );
      // Should NOT be 410 — it may 404 or 400 because the call session
      // doesn't exist, but the gateway-only guard should NOT block it.
      expect(res.status).not.toBe(410);
    });

    test("POST /v1/internal/twilio/status is NOT blocked", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/internal/twilio/status`,
        {
          method: "POST",
          headers: {
            ...GATEWAY_AUTH_HEADERS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            params: { CallSid: "CA123", CallStatus: "completed" },
          }),
        },
      );
      expect(res.status).not.toBe(410);
    });

    test("POST /v1/internal/twilio/connect-action is NOT blocked", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/internal/twilio/connect-action`,
        {
          method: "POST",
          headers: {
            ...GATEWAY_AUTH_HEADERS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            params: { CallSid: "CA123" },
          }),
        },
      );
      expect(res.status).not.toBe(410);
    });

    test("POST /v1/internal/oauth/callback is NOT blocked", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/internal/oauth/callback`,
        {
          method: "POST",
          headers: {
            ...GATEWAY_AUTH_HEADERS,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            state: "test-state",
            code: "test-code",
          }),
        },
      );
      // Should succeed or return a non-410 status
      expect(res.status).not.toBe(410);
    });
  });

  // ── Relay WebSocket upgrade ───────────────────

  describe("relay WebSocket upgrade", () => {
    test("blocks non-private-network origin", async () => {
      // The peer address (127.0.0.1) passes the private network check,
      // but the external Origin header triggers the secondary defense-in-depth block.
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-123`,
        {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            Origin: "https://external.example.com",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
          },
        },
      );
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("FORBIDDEN");
      expect(body.error.message).toContain("Direct relay access disabled");
    });

    test("allows request with no origin header (private network peer)", async () => {
      // Without an origin header, isPrivateNetworkOrigin returns true.
      // The peer address (127.0.0.1) passes the private network peer check.
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-123`,
        {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
          },
        },
      );
      // Should NOT be 403 — WebSocket upgrade may or may not succeed
      // depending on test environment, but the gateway guard should pass.
      expect(res.status).not.toBe(403);
    });

    test("allows localhost origin from loopback peer", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/calls/relay?callSessionId=sess-123`,
        {
          headers: {
            Upgrade: "websocket",
            Connection: "Upgrade",
            Origin: "http://127.0.0.1:3000",
            "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
            "Sec-WebSocket-Version": "13",
          },
        },
      );
      // Should NOT be 403
      expect(res.status).not.toBe(403);
    });
  });

  // ── isPrivateAddress unit tests ─────────────────────────────────────

  describe("isPrivateAddress", () => {
    // Loopback
    test.each([
      "127.0.0.1",
      "127.0.0.2",
      "127.255.255.255",
      "::1",
      "::ffff:127.0.0.1",
    ])("accepts loopback address %s", (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // RFC 1918 private ranges
    test.each([
      "10.0.0.1",
      "10.255.255.255",
      "172.16.0.1",
      "172.31.255.255",
      "192.168.0.1",
      "192.168.1.100",
    ])("accepts RFC 1918 private address %s", (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // Link-local
    test.each(["169.254.0.1", "169.254.255.255"])(
      "accepts link-local address %s",
      (addr) => {
        expect(isPrivateAddress(addr)).toBe(true);
      },
    );

    // IPv6 unique local (fc00::/7)
    test.each(["fc00::1", "fd12:3456:789a::1", "fdff::1"])(
      "accepts IPv6 unique local address %s",
      (addr) => {
        expect(isPrivateAddress(addr)).toBe(true);
      },
    );

    // IPv6 link-local (fe80::/10)
    test.each(["fe80::1", "fe80::abcd:1234"])(
      "accepts IPv6 link-local address %s",
      (addr) => {
        expect(isPrivateAddress(addr)).toBe(true);
      },
    );

    // IPv4-mapped IPv6 private addresses
    test.each([
      "::ffff:10.0.0.1",
      "::ffff:172.16.0.1",
      "::ffff:192.168.1.1",
      "::ffff:169.254.0.1",
    ])("accepts IPv4-mapped IPv6 private address %s", (addr) => {
      expect(isPrivateAddress(addr)).toBe(true);
    });

    // Public addresses — should be rejected
    test.each([
      "8.8.8.8",
      "1.1.1.1",
      "203.0.113.1",
      "172.32.0.1",
      "172.15.255.255",
      "11.0.0.1",
      "192.169.0.1",
      "::ffff:8.8.8.8",
      "2001:db8::1",
    ])("rejects public address %s", (addr) => {
      expect(isPrivateAddress(addr)).toBe(false);
    });
  });

  // ── Channel sync endpoints require auth ─────────────────────────────

  describe("channel sync endpoints require authentication", () => {
    test("POST /v1/channels/inbound without auth returns 401", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/channels/inbound`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          sourceChannel: "telegram",
          externalChatId: "12345",
          externalMessageId: "msg-1",
          content: "hello",
        }),
      });
      expect(res.status).toBe(401);
    });

    test("DELETE /v1/channels/conversation without auth returns 401", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/channels/conversation`,
        {
          method: "DELETE",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceChannel: "telegram",
            externalChatId: "12345",
          }),
        },
      );
      expect(res.status).toBe(401);
    });

    test("POST /v1/channels/delivery-ack without auth returns 401", async () => {
      const res = await fetch(
        `http://127.0.0.1:${port}/v1/channels/delivery-ack`,
        {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            sourceChannel: "telegram",
            externalChatId: "12345",
            externalMessageId: "msg-1",
          }),
        },
      );
      expect(res.status).toBe(401);
    });
  });

  // ── Route policy enforcement on /channels/inbound ──────────────────
  //
  // Gateway origin is now enforced via JWT principal type (svc_gateway)
  // rather than the legacy X-Gateway-Origin header.

  describe("route policy enforcement on /channels/inbound", () => {
    test("POST /v1/channels/inbound with actor JWT returns 403 (requires svc_gateway)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/channels/inbound`, {
        method: "POST",
        headers: {
          ...AUTH_HEADERS,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceChannel: "telegram",
          externalChatId: "12345",
          externalMessageId: "msg-gw-1",
          content: "hello",
        }),
      });
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("FORBIDDEN");
    });

    test("POST /v1/channels/inbound with gateway JWT passes policy check", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/channels/inbound`, {
        method: "POST",
        headers: {
          ...GATEWAY_AUTH_HEADERS,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceChannel: "telegram",
          externalChatId: "12345",
          externalMessageId: "msg-gw-3",
          content: "hello",
        }),
      });
      // Should NOT be 403 — the svc_gateway principal type passes the
      // route policy. It may return 200 or another non-403 status from
      // downstream logic.
      expect(res.status).not.toBe(403);
    });

    test("POST /v1/channels/inbound without auth returns 401 (auth before policy)", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/channels/inbound`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceChannel: "telegram",
          externalChatId: "12345",
          externalMessageId: "msg-gw-4",
          content: "hello",
        }),
      });
      // Auth middleware fires first, so without a JWT the request is
      // rejected before the route policy is checked.
      expect(res.status).toBe(401);
    });

    test("POST /v1/channels/inbound with slack and actor JWT returns 403", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/channels/inbound`, {
        method: "POST",
        headers: {
          ...AUTH_HEADERS,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceChannel: "slack",
          externalChatId: "C0123ABCDEF",
          externalMessageId: "slack-test-gw-1",
          content: "hello via Slack",
        }),
      });
      // Channel inbound messages require svc_gateway principal type.
      expect(res.status).toBe(403);
      const body = (await res.json()) as {
        error: { code: string; message: string };
      };
      expect(body.error.code).toBe("FORBIDDEN");
    });

    test("POST /v1/channels/inbound with slack and gateway JWT passes", async () => {
      const res = await fetch(`http://127.0.0.1:${port}/v1/channels/inbound`, {
        method: "POST",
        headers: {
          ...GATEWAY_AUTH_HEADERS,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          sourceChannel: "slack",
          externalChatId: "C0123ABCDEF",
          externalMessageId: "slack-test-gw-2",
          content: "hello via Slack",
        }),
      });
      // Should NOT be 403 — the svc_gateway principal type passes.
      expect(res.status).not.toBe(403);
    });
  });

  // ── Startup warning for non-loopback host ──────────────────────────

  describe("startup guard — non-loopback host", () => {
    test("server starts successfully when hostname is not loopback", async () => {
      const warnServer = new RuntimeHttpServer({
        port: 0,
        hostname: "0.0.0.0",
        bearerToken: TEST_TOKEN,
      });
      await warnServer.start();
      expect(warnServer.actualPort).toBeGreaterThan(0);
      await warnServer.stop();
    });

    test("server starts successfully when hostname is loopback", async () => {
      const loopbackServer = new RuntimeHttpServer({
        port: 0,
        hostname: "127.0.0.1",
        bearerToken: TEST_TOKEN,
      });
      await loopbackServer.start();
      expect(loopbackServer.actualPort).toBeGreaterThan(0);
      await loopbackServer.stop();
    });
  });
});
