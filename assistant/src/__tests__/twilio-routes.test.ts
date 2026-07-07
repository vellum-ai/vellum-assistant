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
    mockSecureKeyStore[credentialKey("twilio", "account_sid")]
  );
}

function readMockTwilioAuthToken(): string | undefined {
  return mockSecureKeyStore[credentialKey("twilio", "auth_token")];
}

function readMockTwilioPhoneNumber(): string | undefined {
  const twilio = (mockRawConfigStore.twilio ?? {}) as Record<string, unknown>;
  return twilio.phoneNumber as string | undefined;
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

// routeSetup mock — TwiML generation must never invoke it (setup routing
// is owned by the media-stream server at stream start). Tests set
// `mockRouteSetupResult` to interactive outcomes and assert the webhook
// still returns Stream TwiML without consulting the router.
let mockRouteSetupResult: {
  outcome: { action: string; [key: string]: unknown };
  resolved: {
    assistantId: string;
    isInbound: boolean;
    otherPartyNumber: string;
    actorTrust: { trustClass: string; memberRecord: null };
  };
} = {
  outcome: { action: "normal_call", isInbound: true },
  resolved: {
    assistantId: "self",
    isInbound: true,
    otherPartyNumber: "+15559998888",
    actorTrust: { trustClass: "guardian", memberRecord: null },
  },
};

// Captures the last context passed to routeSetup so preflight tests can
// assert the resolved phone admission policy was threaded through.
let lastRouteSetupCtx: Record<string, unknown> | null = null;
mock.module("../calls/call-setup-router.js", () => ({
  routeSetup: (ctx: Record<string, unknown>) => {
    lastRouteSetupCtx = ctx;
    return mockRouteSetupResult;
  },
}));

// Mock the phone channel admission reader and inbound trust reader.
// TwiML generation must not consult either — both are stream-start
// concerns owned by the media-stream server.
let mockAdmissionPolicy: unknown = null;
let admissionPolicyReads = 0;
mock.module("../calls/channel-admission-reader.js", () => ({
  getChannelAdmissionPolicy: async () => {
    admissionPolicyReads++;
    return { ok: true as const, policy: mockAdmissionPolicy };
  },
}));

let mockInboundVerdict: unknown = null;
let lastInboundVerdictArgs: Record<string, unknown> | null = null;
mock.module("../calls/inbound-trust-reader.js", () => ({
  getInboundTrustVerdict: async (args: Record<string, unknown>) => {
    lastInboundVerdictArgs = args;
    return mockInboundVerdict;
  },
  getPhoneCallerVerdict: async (otherPartyNumber: string | undefined) => {
    lastInboundVerdictArgs = {
      channelType: "phone",
      actorExternalId: otherPartyNumber || undefined,
    };
    return mockInboundVerdict;
  },
}));

// Mock the STT+TTS credential-readiness preflight consulted at TwiML time.
// Tests override `mockCredentialReadiness` to exercise the not-ready gate.
let mockCredentialReadiness: Record<string, unknown> = { status: "ready" };
mock.module("../calls/telephony-credential-preflight.js", () => ({
  resolveTelephonyCredentialReadiness: async () => mockCredentialReadiness,
}));

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://gateway.internal:7830",
  getIngressPublicBaseUrl: () => mockIngressPublicBaseUrl,
  setIngressPublicBaseUrl: (value: string | undefined) => {
    mockIngressPublicBaseUrl = value ?? "";
  },
}));

mock.module("../util/logger.js", () => ({
  getLogger: () => ({
    info: () => {},
    warn: () => {},
    error: () => {},
    debug: () => {},
    trace: () => {},
    fatal: () => {},
    child: () => ({
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    }),
  }),
}));

const mockConfigObj = {
  model: "test",
  provider: "test",
  memory: { enabled: false },
  rateLimit: { maxRequestsPerMinute: 0 },
  secretDetection: { enabled: false },
  elevenlabs: { voiceId: DEFAULT_ELEVENLABS_VOICE_ID },
  calls: {
    voice: {
      language: "en-US",
      transcriptionProvider: "Deepgram",
      elevenlabs: {},
    },
  },
  services: {
    stt: {
      mode: "your-own" as const,
      provider: "deepgram" as const,
      providers: {},
    },
    tts: {
      mode: "your-own" as const,
      provider: "elevenlabs" as const,
      providers: {
        elevenlabs: {
          voiceId: DEFAULT_ELEVENLABS_VOICE_ID,
          voiceModelId: "",
          speed: 1.0,
          stability: 0.5,
          similarityBoost: 0.75,
          conversationTimeoutSeconds: 30,
        },
        "fish-audio": {
          referenceId: "",
          chunkLength: 200,
          format: "mp3" as const,
          latency: "normal" as const,
          speed: 1.0,
        },
      },
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
  TwilioVoiceProvider: class {
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
  }),
  resolveTwilioPhoneNumber: () => readMockTwilioPhoneNumber(),
}));

mock.module("../calls/twilio-rest.js", () => ({
  fetchMessageStatus: async () => ({ status: "delivered" }),
  getPhoneNumberSid: async () => "PN_test",
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
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getTwilioMediaStreamUrl: (ingressConfig: unknown) => {
    const base = resolveIngressBaseUrlFromConfig(ingressConfig);
    const wsBase = base.replace(/^http(s?)/, "ws$1");
    return `${wsBase}/webhooks/twilio/media-stream`;
  },
  getTwilioVoiceWebhookUrl: (ingressConfig: unknown) =>
    `${resolveIngressBaseUrlFromConfig(ingressConfig)}/webhooks/twilio/voice`,
  getTwilioStatusCallbackUrl: (ingressConfig: unknown) =>
    `${resolveIngressBaseUrlFromConfig(ingressConfig)}/webhooks/twilio/status`,
}));

mock.module("../runtime/auth/token-service.js", () => ({}));

mock.module("../tools/credentials/metadata-store.js", () => ({
  deleteCredentialMetadata: () => {},
  upsertCredentialMetadata: () => {},
}));

mock.module("../providers/registry.js", () => ({
  initializeProviders: async () => {},
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
  handleInternalVoiceWebhook,
  handleStatusCallback,
  handleVoiceWebhook,
} from "../calls/twilio-routes.js";
import { DEFAULT_ELEVENLABS_VOICE_ID } from "../config/schemas/elevenlabs.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { conversations } from "../persistence/schema/index.js";
import {
  handleAssignTwilioNumber,
  handleClearTwilioCredentials,
  handleProvisionTwilioNumber,
  handleSetTwilioCredentials,
} from "../runtime/routes/integrations/twilio.js";
import { credentialKey } from "../security/credential-key.js";
import { resetDbForTesting } from "./db-test-helpers.js";

await initializeDb();

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
      [credentialKey("twilio", "account_sid")]: "AC_existing",
      [credentialKey("twilio", "auth_token")]: "test-auth-token",
    };
    mockAvailableNumbers = [{ phoneNumber: "+15556667777" }];
    mockProvisionedNumber = { phoneNumber: "+15556667777" };
    updatePhoneNumberWebhookCalls = [];
    mockTwilioApiValidationStatus = 200;
    mockTwilioApiValidationBody = JSON.stringify({ sid: "AC_validated" });
    // Reset STT config to defaults between tests
    mockConfigObj.services.stt.provider = "deepgram" as any;
    // Reset admission policy + captured routeSetup context between tests
    mockAdmissionPolicy = null;
    admissionPolicyReads = 0;
    lastRouteSetupCtx = null;
    mockInboundVerdict = null;
    lastInboundVerdictArgs = null;
    // Reset credential readiness to ready
    mockCredentialReadiness = { status: "ready" };
    // Reset routeSetup mock to default normal_call
    mockRouteSetupResult = {
      outcome: { action: "normal_call", isInbound: true },
      resolved: {
        assistantId: "self",
        isInbound: true,
        otherPartyNumber: "+15559998888",
        actorTrust: { trustClass: "guardian", memberRecord: null },
      },
    };

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
    resetDbForTesting();
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

  // ── TwiML stream URL generation ─────────────────────────────────────
  // Call handleVoiceWebhook directly since direct routes are blocked.

  describe("voice webhook TwiML stream URL", () => {
    test("TwiML stream URL uses placeholder for gateway resolution", async () => {
      const session = createTestSession("conv-twiml-1", "CA_twiml_1");
      const req = makeVoiceRequest(session.id, { CallSid: "CA_twiml_1" });

      const res = await handleVoiceWebhook(req);

      expect(res.status).toBe(200);
      const twiml = await res.text();
      expect(twiml).toContain(
        `wss://__VELLUM_PUBLIC_BASE_URL__/webhooks/twilio/media-stream/${session.id}`,
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
      expect(twiml).toContain("<Stream");
      expect(twiml).toContain('<Parameter name="callSessionId"');

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
      expect(twiml).toContain("<Stream");
      expect(twiml).toContain(`/webhooks/twilio/media-stream/${session.id}`);
    });
  });

  // ── Provider-independent Stream TwiML ───────────────────────────────
  // Every call runs over the media-stream transport regardless of the
  // configured STT provider — the webhook always emits <Connect><Stream>.

  describe("Stream TwiML for every STT provider", () => {
    const providers = [
      "deepgram",
      "google-gemini",
      "openai-whisper",
      "xai",
    ] as const;

    for (const provider of providers) {
      test(`outbound: ${provider} -> Stream TwiML`, async () => {
        mockConfigObj.services.stt.provider = provider as any;
        const session = createTestSession(
          `conv-stt-${provider}-1`,
          `CA_stt_${provider}_1`,
        );
        const req = makeVoiceRequest(session.id, {
          CallSid: `CA_stt_${provider}_1`,
        });

        const res = await handleVoiceWebhook(req);
        expect(res.status).toBe(200);

        const twiml = await res.text();
        expect(twiml).toContain("<Stream");
        expect(twiml).not.toContain("transcriptionProvider=");
        // callSessionId is in the URL path, not as a query param
        expect(twiml).toContain(
          `wss://__VELLUM_PUBLIC_BASE_URL__/webhooks/twilio/media-stream/${session.id}`,
        );
        expect(twiml).not.toContain("?callSessionId=");
      });

      test(`inbound: ${provider} -> Stream TwiML`, async () => {
        mockConfigObj.services.stt.provider = provider as any;
        const req = makeInboundVoiceRequest({
          CallSid: `CA_stt_${provider}_inbound_1`,
          From: "+14155551234",
          To: "+15550001111",
        });

        const res = await handleVoiceWebhook(req);
        expect(res.status).toBe(200);

        const twiml = await res.text();
        expect(twiml).toContain("<Stream");
        expect(twiml).not.toContain("transcriptionProvider=");
      });
    }

    test("Stream TwiML includes auth token as Parameter", async () => {
      const session = createTestSession(
        "conv-stt-token-1",
        "CA_stt_token_1",
      );
      const req = makeVoiceRequest(session.id, {
        CallSid: "CA_stt_token_1",
      });

      const res = await handleVoiceWebhook(req);
      expect(res.status).toBe(200);

      const twiml = await res.text();
      expect(twiml).toContain('<Parameter name="token"');
      expect(twiml).toContain('<Parameter name="callSessionId"');
    });
  });

  // ── Setup outcomes never affect TwiML ────────────────────────────────
  // Setup routing is owned by the media-stream server: it re-runs
  // routeSetup when Twilio's `start` frame arrives and drives every
  // outcome (verification, invite redemption, name capture, deny, normal)
  // over the stream. TwiML generation neither consults the router nor
  // branches on its outcome.

  describe("setup outcomes never affect TwiML", () => {
    const outcomes: Array<Record<string, unknown>> = [
      { action: "normal_call", isInbound: true },
      {
        action: "deny",
        message: "This number is not authorized.",
        logReason: "Inbound voice ACL: blocked caller",
      },
      { action: "verification", assistantId: "self", fromNumber: "+14155551234" },
      { action: "name_capture", assistantId: "self", fromNumber: "+14155551234" },
      {
        action: "invite_redemption",
        assistantId: "self",
        fromNumber: "+14155551234",
        inviteeName: "Alice",
      },
    ];

    for (const outcome of outcomes) {
      test(`${outcome.action as string} setup outcome still yields Stream TwiML`, async () => {
        mockRouteSetupResult = {
          outcome: outcome as { action: string },
          resolved: {
            assistantId: "self",
            isInbound: true,
            otherPartyNumber: "+14155551234",
            actorTrust: { trustClass: "unknown", memberRecord: null },
          },
        };

        const session = createTestSession(
          `conv-outcome-${outcome.action as string}`,
          `CA_outcome_${outcome.action as string}`,
        );
        const req = makeVoiceRequest(session.id, {
          CallSid: `CA_outcome_${outcome.action as string}`,
        });

        const res = await handleVoiceWebhook(req);
        expect(res.status).toBe(200);

        const twiml = await res.text();
        expect(twiml).toContain("<Stream");
      });
    }

    test("TwiML generation does not invoke routeSetup or the admission/trust readers", async () => {
      mockAdmissionPolicy = "guardian_only";
      mockInboundVerdict = {
        channelType: "phone",
        actorExternalId: "+14155551234",
        status: "verified",
        policy: "allow",
        resolutionFailed: false,
      };

      const req = makeInboundVoiceRequest({
        CallSid: "CA_no_routing_at_twiml_1",
        From: "+14155551234",
        To: "+15550001111",
      });

      const res = await handleVoiceWebhook(req);
      expect(res.status).toBe(200);

      // Routing and its inputs are resolved at stream start, not TwiML time.
      expect(lastRouteSetupCtx).toBeNull();
      expect(admissionPolicyReads).toBe(0);
      expect(lastInboundVerdictArgs).toBeNull();
    });
  });

  // ── Credential-readiness gate ─────────────────────────────────────────
  // The daemon performs STT and TTS for every call; when credentials are
  // missing the webhook returns audible <Say> setup-required TwiML plus
  // <Hangup/> instead of connecting a doomed stream, and records the gap
  // on the session.

  describe("credential-readiness TwiML gate", () => {
    const notReady = {
      status: "not-ready",
      missing: [
        {
          kind: "stt",
          providerId: "deepgram",
          reason: 'No API key configured for credential provider "deepgram"',
        },
      ],
      userMessage:
        'Phone calls are unavailable because they require an API key for the speech-to-text provider "deepgram".',
    };

    test("inbound not-ready returns <Say> + <Hangup/> and records the preflight event", async () => {
      mockCredentialReadiness = notReady;

      const req = makeInboundVoiceRequest({
        CallSid: "CA_preflight_inbound_1",
        From: "+14155551234",
        To: "+15550001111",
      });

      const res = await handleVoiceWebhook(req);
      expect(res.status).toBe(200);

      const twiml = await res.text();
      expect(twiml).toContain("<Say>");
      expect(twiml).toContain("<Hangup/>");
      expect(twiml).toContain("speech-to-text provider");
      expect(twiml).not.toContain("<Stream");

      const session = getCallSessionByCallSid("CA_preflight_inbound_1");
      expect(session).not.toBeNull();
      const events = getCallEvents(session!.id);
      const preflightEvents = events.filter(
        (e) => e.eventType === "telephony_credential_preflight_failed",
      );
      expect(preflightEvents.length).toBe(1);
      const payload = JSON.parse(preflightEvents[0]!.payloadJson) as {
        missing: Array<{ kind: string; providerId: string }>;
      };
      expect(payload.missing).toHaveLength(1);
      expect(payload.missing[0]!.kind).toBe("stt");
      expect(payload.missing[0]!.providerId).toBe("deepgram");
    });

    test("outbound webhook not-ready returns <Say> + <Hangup/> and records the preflight event", async () => {
      mockCredentialReadiness = notReady;

      const session = createTestSession(
        "conv-preflight-out-1",
        "CA_preflight_out_1",
      );
      const req = makeVoiceRequest(session.id, {
        CallSid: "CA_preflight_out_1",
      });

      const res = await handleVoiceWebhook(req);
      expect(res.status).toBe(200);

      const twiml = await res.text();
      expect(twiml).toContain("<Say>");
      expect(twiml).toContain("<Hangup/>");
      expect(twiml).not.toContain("<Stream");

      const events = getCallEvents(session.id);
      expect(
        events.filter(
          (e) => e.eventType === "telephony_credential_preflight_failed",
        ).length,
      ).toBe(1);
    });

    test("ready readiness produces Stream TwiML with no preflight event", async () => {
      const session = createTestSession(
        "conv-preflight-ready-1",
        "CA_preflight_ready_1",
      );
      const req = makeVoiceRequest(session.id, {
        CallSid: "CA_preflight_ready_1",
      });

      const res = await handleVoiceWebhook(req);
      expect(res.status).toBe(200);

      const twiml = await res.text();
      expect(twiml).toContain("<Stream");
      expect(twiml).not.toContain("<Say>");

      const events = getCallEvents(session.id);
      expect(
        events.filter(
          (e) => e.eventType === "telephony_credential_preflight_failed",
        ).length,
      ).toBe(0);
    });
  });

  // ── Internal voice webhook (gateway forward) ─────────────────────────
  // The gateway's <Gather> voice-verify success path forwards through
  // /v1/internal/twilio/voice-webhook, which shares processVoiceWebhook.

  describe("internal voice webhook (gateway forward)", () => {
    test("inbound forward yields Stream TwiML", async () => {
      const result = await handleInternalVoiceWebhook({
        body: {
          params: {
            CallSid: "CA_internal_fwd_1",
            From: "+14155551234",
            To: "+15550001111",
          },
          originalUrl: "https://ingress.example.com/webhooks/twilio/voice",
        },
      });

      const twiml = result.body as string;
      expect(twiml).toContain("<Stream");
    });

    test("outbound forward (callSessionId in originalUrl) yields Stream TwiML", async () => {
      const session = createTestSession(
        "conv-internal-fwd-2",
        "CA_internal_fwd_2",
      );
      const result = await handleInternalVoiceWebhook({
        body: {
          params: { CallSid: "CA_internal_fwd_2" },
          originalUrl: `https://ingress.example.com/webhooks/twilio/voice?callSessionId=${session.id}`,
        },
      });

      const twiml = result.body as string;
      expect(twiml).toContain("<Stream");
      expect(twiml).toContain(`/webhooks/twilio/media-stream/${session.id}`);
    });

    test("inbound forward not-ready yields <Say> + <Hangup/>", async () => {
      mockCredentialReadiness = {
        status: "not-ready",
        missing: [
          { kind: "tts", providerId: "elevenlabs", reason: "missing key" },
        ],
        userMessage:
          'Phone calls are unavailable because they require an API key for the text-to-speech provider "elevenlabs".',
      };

      const result = await handleInternalVoiceWebhook({
        body: {
          params: {
            CallSid: "CA_internal_fwd_3",
            From: "+14155551234",
            To: "+15550001111",
          },
          originalUrl: "https://ingress.example.com/webhooks/twilio/voice",
        },
      });

      const twiml = result.body as string;
      expect(twiml).toContain("<Say>");
      expect(twiml).toContain("<Hangup/>");
      expect(twiml).not.toContain("<Stream");
    });
  });

  describe("Twilio control-plane credential and number operations", () => {
    test("setting credentials stores them and returns success", async () => {
      mockRawConfigStore = {};
      mockSecureKeyStore = {};

      const result = await handleSetTwilioCredentials({
        body: {
          accountSid: "AC_new_credentials",
          authToken: "new_auth_token_value",
        },
      });

      expect(result.success).toBe(true);
      expect(result.hasCredentials).toBe(true);
      expect(mockRawConfigStore.twilio).toEqual({
        accountSid: "AC_new_credentials",
        setupStarted: true,
      });
    });

    test("clearing credentials succeeds", async () => {
      const result = await handleClearTwilioCredentials();

      expect(result).toEqual({ success: true, hasCredentials: false });
    });

    test("provisioning a number syncs Twilio webhooks", async () => {
      mockIngressPublicBaseUrl = "https://numbers.example.com";
      mockAvailableNumbers = [{ phoneNumber: "+15557778888" }];
      mockProvisionedNumber = { phoneNumber: "+15557778888" };
      mockRawConfigStore = {
        twilio: { accountSid: "AC_existing" },
      };

      const result = await handleProvisionTwilioNumber({
        body: { country: "US" },
      });

      expect(result.success).toBe(true);
      expect(result.hasCredentials).toBe(true);
      expect(result.phoneNumber).toBe("+15557778888");
      expect(updatePhoneNumberWebhookCalls).toHaveLength(1);
      expect(updatePhoneNumberWebhookCalls[0]!.urls).toEqual({
        voiceUrl: "https://numbers.example.com/webhooks/twilio/voice",
        statusCallbackUrl: "https://numbers.example.com/webhooks/twilio/status",
      });
    });

    test("assigning a number syncs Twilio webhooks", async () => {
      mockIngressPublicBaseUrl = "https://assign.example.com";

      const result = await handleAssignTwilioNumber({
        body: { phoneNumber: "+15558889999" },
      });

      expect(result.success).toBe(true);
      expect(result.hasCredentials).toBe(true);
      expect(result.phoneNumber).toBe("+15558889999");
      expect(updatePhoneNumberWebhookCalls).toHaveLength(1);
    });
  });
});
