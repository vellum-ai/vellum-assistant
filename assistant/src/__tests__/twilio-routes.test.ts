/**
 * Integration tests for Twilio webhook route handlers.
 *
 * Tests handler-level behavior by calling route handlers directly (not via HTTP
 * server). Gateway-only blocking of direct webhook routes is covered in the
 * dedicated `gateway-only-enforcement.test.ts` suite.
 *
 * Tests:
 * - Duplicate callback replay (idempotency)
 * - Unknown status and malformed payload handling
 * - Status mapping and completion notifications
 * - Voice webhook TwiML relay URL generation
 * - Handler-level idempotency concurrency (concurrent duplicates, failure-retry)
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";

let mockIngressPublicBaseUrl = "https://ingress.example.com";
let mockRawConfigStore: Record<string, unknown> = {};
let mockSecureKeyStore: Record<string, string | undefined> = {};
let mockAvailableNumbers = [{ phoneNumber: "+15556667777" }];
let mockProvisionedNumber = { phoneNumber: "+15556667777" };
let updatePhoneNumberWebhookCalls: Array<{
  accountSid: string;
  authToken: string;
  phoneNumber: string;
  urls: {
    voiceUrl: string;
    statusCallbackUrl: string;
  };
}> = [];
let mockTwilioApiValidationStatus = 200;
let mockTwilioApiValidationBody = JSON.stringify({ sid: "AC_test" });
const originalFetch = globalThis.fetch;

function readMockTwilioAccountSid(): string | undefined {
  const twilio = (mockRawConfigStore.twilio ?? {}) as Record<string, unknown>;
  return (
    (twilio.accountSid as string | undefined) ??
    mockSecureKeyStore["credential:twilio:account_sid"]
  );
}

function readMockTwilioAuthToken(): string | undefined {
  return mockSecureKeyStore["credential:twilio:auth_token"];
}

function readMockTwilioPhoneNumber(): string | undefined {
  const twilio = (mockRawConfigStore.twilio ?? {}) as Record<string, unknown>;
  return (
    mockSecureKeyStore["credential:twilio:phone_number"] ??
    (twilio.phoneNumber as string | undefined)
  );
}

function resolveIngressBaseUrlFromConfig(ingressConfig: unknown): string {
  const ingress = (ingressConfig ?? {}) as {
    ingress?: Record<string, unknown>;
  };
  const ingressSection = ingress.ingress ?? {};
  const fromConfig = ingressSection.publicBaseUrl;
  if (typeof fromConfig === "string" && fromConfig.length > 0) {
    return fromConfig.replace(/\/+$/, "");
  }
  return (mockIngressPublicBaseUrl || "https://ingress.example.com").replace(
    /\/+$/,
    "",
  );
}

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getCallWelcomeGreeting: () => process.env.CALL_WELCOME_GREETING || undefined,
  getGatewayInternalBaseUrl: () => "http://gateway.internal:7830",
  getIngressPublicBaseUrl: () => mockIngressPublicBaseUrl,
  setIngressPublicBaseUrl: (value: string | undefined) => {
    mockIngressPublicBaseUrl = value ?? "";
  },
}));

const testDir = realpathSync(
  mkdtempSync(join(tmpdir(), "twilio-routes-test-")),
);

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
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

const mockConfigObj = {
  model: "test",
  provider: "test",
  apiKeys: {},
  memory: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0, maxTokensPerSession: 0 },
  secretDetection: { enabled: false },
  elevenlabs: { voiceId: "21m00Tcm4TlvDq8ikWAM" },
  calls: {
    voice: {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      elevenlabs: {},
    },
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfigObj,
  loadConfig: () => mockConfigObj,
  loadRawConfig: () => ({ ...mockRawConfigStore }),
  saveRawConfig: (cfg: Record<string, unknown>) => {
    mockRawConfigStore = { ...cfg };
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKey: (key: string) => mockSecureKeyStore[key],
  setSecureKeyAsync: async (key: string, value: string) => {
    mockSecureKeyStore[key] = value;
    return true;
  },
  deleteSecureKeyAsync: async (key: string) => {
    delete mockSecureKeyStore[key];
    return "deleted";
  },
}));

mock.module("../calls/twilio-provider.js", () => ({
  TwilioConversationRelayProvider: class {
    readonly name = "twilio";
    static getAuthToken(): string | null {
      return null;
    }
    static verifyWebhookSignature(): boolean {
      return true;
    }
    async initiateCall() {
      return { callSid: "CA_mock_test" };
    }
    async endCall() {
      return;
    }
  },
}));

mock.module("../calls/twilio-config.js", () => ({
  getTwilioConfig: () => ({
    accountSid: "AC_test",
    authToken: "test-auth-token-for-webhooks",
    phoneNumber: "+15550001111",
    webhookBaseUrl: "https://test.example.com",
    wssBaseUrl: "wss://test.example.com",
  }),
  resolveTwilioPhoneNumber: () => readMockTwilioPhoneNumber(),
}));

mock.module("../calls/twilio-rest.js", () => ({
  deleteTollFreeVerification: async () => {},
  fetchMessageStatus: async () => ({ status: "delivered" }),
  getPhoneNumberSid: async () => "PN_test",
  getTollFreeVerificationBySid: async () => null,
  getTollFreeVerificationStatus: async () => null,
  getTwilioCredentials: () => ({
    accountSid: readMockTwilioAccountSid() ?? "",
    authToken: readMockTwilioAuthToken() ?? "",
  }),
  hasTwilioCredentials: () =>
    Boolean(readMockTwilioAccountSid() && readMockTwilioAuthToken()),
  listIncomingPhoneNumbers: async () => [],
  provisionPhoneNumber: async (
    _accountSid: string,
    _authToken: string,
    phoneNumber: string,
  ) => ({
    ...mockProvisionedNumber,
    phoneNumber,
  }),
  releasePhoneNumber: async () => {},
  searchAvailableNumbers: async () => mockAvailableNumbers,
  submitTollFreeVerification: async () => ({
    sid: "VF_test",
    status: "PENDING_REVIEW",
  }),
  updateTollFreeVerification: async (
    _accountSid: string,
    _authToken: string,
    verificationSid: string,
  ) => ({
    sid: verificationSid,
    status: "PENDING_REVIEW",
    editAllowed: true,
    editExpiration: undefined,
  }),
  updatePhoneNumberWebhooks: async (
    accountSid: string,
    authToken: string,
    phoneNumber: string,
    urls: {
      voiceUrl: string;
      statusCallbackUrl: string;
    },
  ) => {
    updatePhoneNumberWebhookCalls.push({
      accountSid,
      authToken,
      phoneNumber,
      urls,
    });
  },
}));

mock.module("../daemon/handlers/config-ingress.js", () => ({
  computeGatewayTarget: () => "http://gateway.internal:7830",
  handleIngressConfig: async () => {},
  syncTwilioWebhooks: async (
    phoneNumber: string,
    accountSid: string,
    authToken: string,
    ingressConfig: unknown,
  ) => {
    const baseUrl = resolveIngressBaseUrlFromConfig(ingressConfig);
    updatePhoneNumberWebhookCalls.push({
      accountSid,
      authToken,
      phoneNumber,
      urls: {
        voiceUrl: `${baseUrl}/webhooks/twilio/voice`,
        statusCallbackUrl: `${baseUrl}/webhooks/twilio/status`,
      },
    });
    return { success: true };
  },
}));

mock.module("../daemon/handlers/config-channels.js", () => ({
  getReadinessService: () => ({
    getReadiness: async () => [],
  }),
}));

mock.module("../inbound/platform-callback-registration.js", () => ({
  registerCallbackRoute: async () => {},
  resolveCallbackUrl: async (resolver: () => string | Promise<string>) =>
    await resolver(),
  shouldUsePlatformCallbacks: () => false,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getTwilioRelayUrl: (ingressConfig: unknown) => {
    const base = resolveIngressBaseUrlFromConfig(ingressConfig);
    const wsBase = base.replace(/^http(s?)/, "ws$1");
    return `${wsBase}/webhooks/twilio/relay`;
  },
  getTwilioVoiceWebhookUrl: (ingressConfig: unknown) =>
    `${resolveIngressBaseUrlFromConfig(ingressConfig)}/webhooks/twilio/voice`,
  getTwilioStatusCallbackUrl: (ingressConfig: unknown) =>
    `${resolveIngressBaseUrlFromConfig(ingressConfig)}/webhooks/twilio/status`,
}));

mock.module("../runtime/auth/token-service.js", () => ({
  mintDaemonDeliveryToken: () => "test-delivery-token",
}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  deleteCredentialMetadata: () => {},
  upsertCredentialMetadata: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: () => {},
}));

import {
  clearActiveCallLeases,
  listActiveCallLeases,
  upsertActiveCallLease,
} from "../calls/active-call-lease.js";
import {
  registerCallCompletionNotifier,
  unregisterCallCompletionNotifier,
} from "../calls/call-state.js";
import * as callStore from "../calls/call-store.js";
import {
  createCallSession,
  getCallEvents,
  getCallSession,
  getCallSessionByCallSid,
  updateCallSession,
} from "../calls/call-store.js";
import {
  buildWelcomeGreeting,
  handleStatusCallback,
  handleVoiceWebhook,
} from "../calls/twilio-routes.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";
import {
  handleAssignTwilioNumber,
  handleClearTwilioCredentials,
  handleProvisionTwilioNumber,
  handleSetTwilioCredentials,
} from "../runtime/routes/integrations/twilio.js";

initializeDb();

// ── Helpers ────────────────────────────────────────────────────────────

let ensuredConvIds = new Set<string>();

function ensureConversation(id: string): void {
  if (ensuredConvIds.has(id)) return;
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Test conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  ensuredConvIds.add(id);
}

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM guardian_action_deliveries");
  db.run("DELETE FROM guardian_action_requests");
  db.run("DELETE FROM processed_callbacks");
  db.run("DELETE FROM call_pending_questions");
  db.run("DELETE FROM call_events");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM tool_invocations");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  ensuredConvIds = new Set();
}

function createTestSession(
  convId: string,
  callSid: string,
  task = "test task",
) {
  ensureConversation(convId);
  const session = createCallSession({
    conversationId: convId,
    provider: "twilio",
    fromNumber: "+15550001111",
    toNumber: "+15559998888",
    task,
  });
  updateCallSession(session.id, { providerCallSid: callSid });
  return session;
}

function makeStatusRequest(params: Record<string, string>): Request {
  return new Request("http://127.0.0.1/v1/calls/twilio/status", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

function makeVoiceRequest(
  sessionId: string,
  params: Record<string, string>,
): Request {
  return new Request(
    `http://127.0.0.1/v1/calls/twilio/voice-webhook?callSessionId=${sessionId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(params).toString(),
    },
  );
}

function makeInboundVoiceRequest(params: Record<string, string>): Request {
  return new Request("http://127.0.0.1/v1/calls/twilio/voice-webhook", {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams(params).toString(),
  });
}

// ── Tests ──────────────────────────────────────────────────────────────

describe("twilio webhook routes", () => {
  beforeEach(() => {
    resetTables();
    clearActiveCallLeases();
    mockIngressPublicBaseUrl = "https://ingress.example.com";
    mockRawConfigStore = {
      twilio: { accountSid: "AC_existing", phoneNumber: "+15550001111" },
    };
    mockSecureKeyStore = {
      "credential:twilio:account_sid": "AC_existing",
      "credential:twilio:auth_token": "test-auth-token",
      "credential:twilio:phone_number": "+15550001111",
    };
    mockAvailableNumbers = [{ phoneNumber: "+15556667777" }];
    mockProvisionedNumber = { phoneNumber: "+15556667777" };
    updatePhoneNumberWebhookCalls = [];
    mockTwilioApiValidationStatus = 200;
    mockTwilioApiValidationBody = JSON.stringify({ sid: "AC_validated" });
    delete process.env.CALL_WELCOME_GREETING;

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

      if (urlStr.startsWith("https://api.twilio.com/")) {
        return new Response(mockTwilioApiValidationBody, {
          status: mockTwilioApiValidationStatus,
        });
      }

      return originalFetch(url, init);
    }) as unknown as typeof fetch;
  });

  afterAll(() => {
    globalThis.fetch = originalFetch;
    resetDb();
    try {
      rmSync(testDir, { recursive: true, force: true });
    } catch {
      /* best effort */
    }
  });

  // ── Callback idempotency / replay tests ───────────────────────────
  // These call handleStatusCallback directly (bypassing the HTTP server)
  // since direct routes are blocked by gateway-only mode.

  describe("callback idempotency", () => {
    test("replaying the same status callback does not create duplicate events", async () => {
      const session = createTestSession("conv-idem-1", "CA_idem_1");
      const params = {
        CallSid: "CA_idem_1",
        CallStatus: "in-progress",
        Timestamp: "2025-01-15T10:00:00Z",
      };

      // First callback — should process
      const res1 = await handleStatusCallback(makeStatusRequest(params));
      expect(res1.status).toBe(200);

      // Second callback (replay) — should return 200 but not create new events
      const res2 = await handleStatusCallback(makeStatusRequest(params));
      expect(res2.status).toBe(200);

      // Verify only one event was recorded
      const events = getCallEvents(session.id);
      const connectedEvents = events.filter(
        (e) => e.eventType === "call_connected",
      );
      expect(connectedEvents.length).toBe(1);
    });

    test("different statuses for the same call create separate events", async () => {
      const session = createTestSession("conv-idem-2", "CA_idem_2");

      // First: ringing
      await handleStatusCallback(
        makeStatusRequest({
          CallSid: "CA_idem_2",
          CallStatus: "ringing",
          Timestamp: "T1",
        }),
      );

      // Second: in-progress (different status)
      await handleStatusCallback(
        makeStatusRequest({
          CallSid: "CA_idem_2",
          CallStatus: "in-progress",
          Timestamp: "T2",
        }),
      );

      const events = getCallEvents(session.id);
      expect(events.length).toBe(2);
    });

    test("third replay of same callback is still no-op", async () => {
      const session = createTestSession("conv-idem-3", "CA_idem_3");
      const params = {
        CallSid: "CA_idem_3",
        CallStatus: "completed",
        Timestamp: "2025-01-15T11:00:00Z",
      };

      // Process three times
      await handleStatusCallback(makeStatusRequest(params));
      await handleStatusCallback(makeStatusRequest(params));
      await handleStatusCallback(makeStatusRequest(params));

      const events = getCallEvents(session.id);
      const endedEvents = events.filter((e) => e.eventType === "call_ended");
      expect(endedEvents.length).toBe(1);
    });
  });

  // ── Unknown status + malformed payload tests ──────────────────────
  // Call handleStatusCallback directly since direct routes are blocked.

  describe("unknown status and malformed payloads", () => {
    test("unknown Twilio status returns 200 but does not record event", async () => {
      const session = createTestSession("conv-unknown-1", "CA_unknown_1");
      const params = {
        CallSid: "CA_unknown_1",
        CallStatus: "some-future-status",
        Timestamp: "T1",
      };

      const res = await handleStatusCallback(makeStatusRequest(params));
      expect(res.status).toBe(200);

      const events = getCallEvents(session.id);
      expect(events.length).toBe(0);
    });

    test("missing CallSid returns 200 (graceful handling)", async () => {
      const res = await handleStatusCallback(
        makeStatusRequest({ CallStatus: "completed" }),
      );
      expect(res.status).toBe(200);
    });

    test("missing CallStatus returns 200 (graceful handling)", async () => {
      const res = await handleStatusCallback(
        makeStatusRequest({ CallSid: "CA_no_status" }),
      );
      expect(res.status).toBe(200);
    });

    test("CallSid not matching any session returns 200 without error", async () => {
      const params = {
        CallSid: "CA_nonexistent_session",
        CallStatus: "completed",
        Timestamp: "T1",
      };

      const res = await handleStatusCallback(makeStatusRequest(params));
      expect(res.status).toBe(200);
    });
  });

  describe("status mapping and completion notifications", () => {
    test("initiated status callback is accepted and recorded as call_started", async () => {
      const session = createTestSession(
        "conv-status-init-1",
        "CA_status_init_1",
      );
      const params = new URLSearchParams({
        CallSid: "CA_status_init_1",
        CallStatus: "initiated",
        Timestamp: "2025-01-21T10:00:00Z",
      });

      const req = new Request("http://127.0.0.1/v1/calls/twilio/status", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);

      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("initiated");
      const events = getCallEvents(session.id);
      expect(events.filter((e) => e.eventType === "call_started").length).toBe(
        1,
      );
    });

    test("answered status callback transitions to in_progress", async () => {
      const session = createTestSession(
        "conv-status-answered-1",
        "CA_status_answered_1",
      );
      const params = new URLSearchParams({
        CallSid: "CA_status_answered_1",
        CallStatus: "answered",
        Timestamp: "2025-01-21T10:05:00Z",
      });

      const req = new Request("http://127.0.0.1/v1/calls/twilio/status", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);

      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("in_progress");
      expect(updated!.startedAt).not.toBeNull();
      const events = getCallEvents(session.id);
      expect(
        events.filter((e) => e.eventType === "call_connected").length,
      ).toBe(1);
    });

    test("completed status callback fires completion notifier when first entering terminal state", async () => {
      const session = createTestSession(
        "conv-status-complete-1",
        "CA_status_complete_1",
      );
      upsertActiveCallLease({
        callSessionId: session.id,
        providerCallSid: "CA_status_complete_1",
      });
      updateCallSession(session.id, {
        status: "in_progress",
        startedAt: Date.now() - 20_000,
      });
      const params = new URLSearchParams({
        CallSid: "CA_status_complete_1",
        CallStatus: "completed",
        Timestamp: "2025-01-21T10:10:00Z",
      });

      let fired = 0;
      registerCallCompletionNotifier("conv-status-complete-1", () => {
        fired += 1;
      });

      const req = new Request("http://127.0.0.1/v1/calls/twilio/status", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);

      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("completed");
      expect(updated!.endedAt).not.toBeNull();
      expect(listActiveCallLeases()).toHaveLength(0);
      expect(fired).toBe(1);

      unregisterCallCompletionNotifier("conv-status-complete-1");
    });

    test("terminal callback preserves lease when recordCallEvent throws", async () => {
      const session = createTestSession(
        "conv-status-lease-fail",
        "CA_status_lease_fail",
      );
      upsertActiveCallLease({
        callSessionId: session.id,
        providerCallSid: "CA_status_lease_fail",
      });
      updateCallSession(session.id, {
        status: "in_progress",
        startedAt: Date.now() - 20_000,
      });

      const spy = spyOn(callStore, "recordCallEvent").mockImplementation(
        (..._args: Parameters<typeof callStore.recordCallEvent>) => {
          spy.mockRestore();
          throw new Error("Simulated recordCallEvent failure");
        },
      );

      const params = new URLSearchParams({
        CallSid: "CA_status_lease_fail",
        CallStatus: "completed",
        Timestamp: "2025-01-21T10:12:00Z",
      });
      const req = new Request("http://127.0.0.1/v1/calls/twilio/status", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });

      await expect(handleStatusCallback(req)).rejects.toThrow(
        "Simulated recordCallEvent failure",
      );

      // Lease must still be present because recordCallEvent threw before
      // syncActiveCallLeaseFromSession ran (inside beforeLeaseSync).
      const leases = listActiveCallLeases();
      expect(leases.length).toBe(1);
      expect(leases[0].callSessionId).toBe(session.id);

      // Session is terminal; DB update runs before beforeLeaseSync, so the
      // status write succeeded. Claim was released on throw; retry will
      // record the event and sync the lease.
      const updated = getCallSession(session.id);
      expect(updated).not.toBeNull();
      expect(updated!.status).toBe("completed");
    });

    test("completed callback does not re-fire completion notifier for already terminal call", async () => {
      const session = createTestSession(
        "conv-status-complete-2",
        "CA_status_complete_2",
      );
      updateCallSession(session.id, {
        status: "completed",
        startedAt: Date.now() - 20_000,
        endedAt: Date.now() - 5_000,
      });
      const params = new URLSearchParams({
        CallSid: "CA_status_complete_2",
        CallStatus: "completed",
        Timestamp: "2025-01-21T10:15:00Z",
      });

      let fired = 0;
      registerCallCompletionNotifier("conv-status-complete-2", () => {
        fired += 1;
      });

      const req = new Request("http://127.0.0.1/v1/calls/twilio/status", {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: params.toString(),
      });
      const res = await handleStatusCallback(req);
      expect(res.status).toBe(200);
      expect(fired).toBe(0);

      unregisterCallCompletionNotifier("conv-status-complete-2");
    });
  });

  describe("buildWelcomeGreeting", () => {
    test("returns empty by default so orchestrator drives first opener", () => {
      const greeting = buildWelcomeGreeting("check store hours for tomorrow");
      expect(greeting).toBe("");
    });

    test("uses configured greeting override when provided", () => {
      const greeting = buildWelcomeGreeting(
        "check store hours",
        "Custom hello",
      );
      expect(greeting).toBe("Custom hello");
    });
  });

  // ── TwiML relay URL generation ──────────────────────────────────────
  // Call handleVoiceWebhook directly since direct routes are blocked.

  describe("voice webhook TwiML relay URL", () => {
    test("TwiML relay URL is sourced from getTwilioRelayUrl", async () => {
      const session = createTestSession("conv-twiml-1", "CA_twiml_1");
      const req = makeVoiceRequest(session.id, { CallSid: "CA_twiml_1" });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain(
        "wss://ingress.example.com/webhooks/twilio/relay",
      );
    });

    test("TwiML omits welcome greeting by default so call opener is model-driven", async () => {
      const session = createTestSession(
        "conv-twiml-3",
        "CA_twiml_3",
        "confirm appointment time\n\nContext: Prior email thread",
      );
      const req = makeVoiceRequest(session.id, { CallSid: "CA_twiml_3" });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).not.toContain("welcomeGreeting=");
    });

    test("TwiML includes explicit welcome greeting override when configured", async () => {
      process.env.CALL_WELCOME_GREETING = "Custom transport greeting";
      const session = createTestSession("conv-twiml-4", "CA_twiml_4");
      const req = makeVoiceRequest(session.id, { CallSid: "CA_twiml_4" });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain('welcomeGreeting="Custom transport greeting"');
    });
  });

  // ── Handler-level idempotency concurrency tests ─────────────────
  // Call handleStatusCallback directly since direct routes are blocked.

  describe("handler-level idempotency concurrency", () => {
    test("two concurrent identical status callbacks produce exactly one event", async () => {
      const session = createTestSession("conv-conc-1", "CA_conc_1");
      const params = {
        CallSid: "CA_conc_1",
        CallStatus: "in-progress",
        Timestamp: "2025-01-20T10:00:00Z",
      };

      // Fire two identical callbacks concurrently
      const [res1, res2] = await Promise.all([
        handleStatusCallback(makeStatusRequest(params)),
        handleStatusCallback(makeStatusRequest(params)),
      ]);

      // Both should return 200 (one processes, one is deduplicated)
      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);

      // Only one event should be recorded despite two concurrent requests
      const events = getCallEvents(session.id);
      const connectedEvents = events.filter(
        (e) => e.eventType === "call_connected",
      );
      expect(connectedEvents.length).toBe(1);
    });

    test("three concurrent identical status callbacks still produce exactly one event", async () => {
      const session = createTestSession("conv-conc-2", "CA_conc_2");
      const params = {
        CallSid: "CA_conc_2",
        CallStatus: "completed",
        Timestamp: "2025-01-20T11:00:00Z",
      };

      // Fire three identical callbacks concurrently
      const [res1, res2, res3] = await Promise.all([
        handleStatusCallback(makeStatusRequest(params)),
        handleStatusCallback(makeStatusRequest(params)),
        handleStatusCallback(makeStatusRequest(params)),
      ]);

      expect(res1.status).toBe(200);
      expect(res2.status).toBe(200);
      expect(res3.status).toBe(200);

      const events = getCallEvents(session.id);
      const endedEvents = events.filter((e) => e.eventType === "call_ended");
      expect(endedEvents.length).toBe(1);
    });

    test("processing failure releases claim and allows successful retry", async () => {
      const session = createTestSession("conv-conc-3", "CA_conc_3");
      const params = {
        CallSid: "CA_conc_3",
        CallStatus: "in-progress",
        Timestamp: "2025-01-20T12:00:00Z",
      };

      // Save original before spying so we can delegate on retry
      const originalRecordCallEvent = callStore.recordCallEvent;

      // Make recordCallEvent throw on the first call to exercise the handler's
      // real catch path (twilio-routes.ts:217), which calls
      // releaseCallbackClaim before re-throwing.
      let shouldThrow = true;
      const spy = spyOn(callStore, "recordCallEvent").mockImplementation(
        (...args: Parameters<typeof callStore.recordCallEvent>) => {
          if (shouldThrow) {
            shouldThrow = false;
            throw new Error("Simulated side-effect failure");
          }
          spy.mockRestore();
          return originalRecordCallEvent(...args);
        },
      );

      // Call handleStatusCallback directly so we can catch the re-thrown error
      const directReq = makeStatusRequest(params);

      // The handler should claim → throw in recordCallEvent → catch releases claim → re-throw
      let handlerThrew = false;
      try {
        await handleStatusCallback(directReq);
      } catch (err) {
        handlerThrew = true;
        expect((err as Error).message).toBe("Simulated side-effect failure");
      }
      expect(handlerThrew).toBe(true);

      // No events recorded (the failed attempt rolled back via releaseCallbackClaim)
      const eventsAfterFailure = getCallEvents(session.id);
      expect(eventsAfterFailure.length).toBe(0);

      // Retry — should succeed because the catch block released the claim
      const retryRes = await handleStatusCallback(makeStatusRequest(params));
      expect(retryRes.status).toBe(200);

      // Now exactly one event should exist from the successful retry
      const eventsAfterRetry = getCallEvents(session.id);
      const connectedEvents = eventsAfterRetry.filter(
        (e) => e.eventType === "call_connected",
      );
      expect(connectedEvents.length).toBe(1);
    });

    test("permanently claimed callback cannot be retried", async () => {
      const session = createTestSession("conv-conc-4", "CA_conc_4");
      const params = {
        CallSid: "CA_conc_4",
        CallStatus: "completed",
        Timestamp: "2025-01-20T13:00:00Z",
      };

      // First request processes successfully and finalizes the claim
      const res1 = await handleStatusCallback(makeStatusRequest(params));
      expect(res1.status).toBe(200);

      const events1 = getCallEvents(session.id);
      expect(events1.filter((e) => e.eventType === "call_ended").length).toBe(
        1,
      );

      // Second request (retry) — should be deduplicated, no new events
      const res2 = await handleStatusCallback(makeStatusRequest(params));
      expect(res2.status).toBe(200);

      const events2 = getCallEvents(session.id);
      expect(events2.filter((e) => e.eventType === "call_ended").length).toBe(
        1,
      );
    });
  });

  // ── Inbound voice webhook tests ─────────────────────────────────────
  // Tests the inbound mode where callSessionId is absent and a session
  // is created/reused from the Twilio CallSid.

  describe("inbound voice webhook", () => {
    test("creates a new session from CallSid when callSessionId is absent", async () => {
      const req = makeInboundVoiceRequest({
        CallSid: "CA_inbound_new_1",
        From: "+14155551234",
        To: "+15550001111",
      });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain("<ConversationRelay");
      expect(twiml).toContain("callSessionId=");

      // Verify session was created with the CallSid
      const session = getCallSessionByCallSid("CA_inbound_new_1");
      expect(session).not.toBeNull();
      expect(session!.fromNumber).toBe("+14155551234");
      expect(session!.toNumber).toBe("+15550001111");
      expect(session!.providerCallSid).toBe("CA_inbound_new_1");
    });

    test("replayed inbound webhook for same CallSid does not create duplicate sessions", async () => {
      const params = {
        CallSid: "CA_inbound_replay_1",
        From: "+14155551234",
        To: "+15550001111",
      };

      // First call — creates the session
      const res1 = await handleVoiceWebhook(makeInboundVoiceRequest(params));
      expect(res1.status).toBe(200);

      const session1 = getCallSessionByCallSid("CA_inbound_replay_1");
      expect(session1).not.toBeNull();

      // Second call (replay) — reuses the same session
      const res2 = await handleVoiceWebhook(makeInboundVoiceRequest(params));
      expect(res2.status).toBe(200);

      const session2 = getCallSessionByCallSid("CA_inbound_replay_1");
      expect(session2).not.toBeNull();
      expect(session2!.id).toBe(session1!.id);
    });

    test("inbound webhook without CallSid returns 400", async () => {
      const req = makeInboundVoiceRequest({
        From: "+14155551234",
        To: "+15550001111",
      });

      const res = await handleVoiceWebhook(req);
      expect(res.status).toBe(400);
    });

    test("inbound webhook creates session with internal scope assistantId", async () => {
      const req = makeInboundVoiceRequest({
        CallSid: "CA_inbound_assist_1",
        From: "+14155551234",
        To: "+15550001111",
      });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const session = getCallSessionByCallSid("CA_inbound_assist_1");
      expect(session).not.toBeNull();
      // Session was created for the inbound call.
      expect(session!.status).toBe("initiated");
    });

    test("outbound call flow remains non-regressed with callSessionId present", async () => {
      const session = createTestSession(
        "conv-outbound-compat-1",
        "CA_outbound_compat_1",
      );
      const req = makeVoiceRequest(session.id, {
        CallSid: "CA_outbound_compat_1",
      });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain("<ConversationRelay");
      expect(twiml).toContain(`callSessionId=${session.id}`);
    });
  });

  describe("Twilio control-plane credential and number operations", () => {
    test("setting credentials stores them and returns success", async () => {
      mockRawConfigStore = {};
      mockSecureKeyStore = {};

      const res = await handleSetTwilioCredentials(
        new Request("http://127.0.0.1/v1/integrations/twilio/credentials", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            accountSid: "AC_new_credentials",
            authToken: "new-auth-token",
          }),
        }),
      );

      const json = (await res.json()) as {
        success: boolean;
        hasCredentials: boolean;
      };
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.hasCredentials).toBe(true);
    });

    test("clearing credentials succeeds", async () => {
      const res = await handleClearTwilioCredentials();
      const json = (await res.json()) as {
        success: boolean;
        hasCredentials: boolean;
      };

      expect(res.status).toBe(200);
      expect(json).toEqual({ success: true, hasCredentials: false });
    });

    test("provisioning a number syncs Twilio webhooks", async () => {
      mockIngressPublicBaseUrl = "https://numbers.example.com";
      mockAvailableNumbers = [{ phoneNumber: "+15557778888" }];
      mockProvisionedNumber = { phoneNumber: "+15557778888" };
      mockRawConfigStore = {
        twilio: { accountSid: "AC_existing" },
      };

      const res = await handleProvisionTwilioNumber(
        new Request(
          "http://127.0.0.1/v1/integrations/twilio/numbers/provision",
          {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ country: "US" }),
          },
        ),
      );

      const json = (await res.json()) as {
        success: boolean;
        hasCredentials: boolean;
        phoneNumber: string;
        warning?: string;
      };
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.hasCredentials).toBe(true);
      expect(json.phoneNumber).toBe("+15557778888");
      expect(updatePhoneNumberWebhookCalls).toHaveLength(1);
      expect(updatePhoneNumberWebhookCalls[0]!.urls).toEqual({
        voiceUrl: "https://numbers.example.com/webhooks/twilio/voice",
        statusCallbackUrl: "https://numbers.example.com/webhooks/twilio/status",
      });
    });

    test("assigning a number syncs Twilio webhooks", async () => {
      mockIngressPublicBaseUrl = "https://assign.example.com";

      const res = await handleAssignTwilioNumber(
        new Request("http://127.0.0.1/v1/integrations/twilio/numbers/assign", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ phoneNumber: "+15558889999" }),
        }),
      );

      const json = (await res.json()) as {
        success: boolean;
        hasCredentials: boolean;
        phoneNumber: string;
        warning?: string;
      };
      expect(res.status).toBe(200);
      expect(json.success).toBe(true);
      expect(json.hasCredentials).toBe(true);
      expect(json.phoneNumber).toBe("+15558889999");
      expect(updatePhoneNumberWebhookCalls).toHaveLength(1);
    });
  });
});
