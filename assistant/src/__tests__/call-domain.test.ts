/**
 * Unit tests for caller identity resolution and pointer message regression
 * in call-domain.ts.
 *
 * Validates:
 * - Strict implicit-default policy for caller identity.
 * - Voice-ingress preflight blocks doomed outbound calls before Twilio dialing.
 * - Pointer messages are written on successful call start and on failure.
 */
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = realpathSync(mkdtempSync(join(tmpdir(), "call-domain-test-")));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Track whether the Twilio provider's initiateCall should succeed or throw
let twilioInitiateCallBehavior: "success" | "error" = "success";
let twilioInitiateCallCount = 0;
let twilioInitiateCallArgs: Array<Record<string, unknown>> = [];
let mockIngressEnabled = true;
let mockIngressPublicBaseUrl = "https://test.example.com";

interface MockGatewayHealthResult {
  target: string;
  healthy: boolean;
  localDeployment: boolean;
  error?: string;
}

interface MockEnsureLocalGatewayReadyResult extends MockGatewayHealthResult {
  recovered: boolean;
  recoveryAttempted: boolean;
  recoverySkipped: boolean;
}

let probeLocalGatewayHealthResults: MockGatewayHealthResult[] = [];
let probeLocalGatewayHealthCallCount = 0;
let ensureLocalGatewayReadyResult: MockEnsureLocalGatewayReadyResult;
let ensureLocalGatewayReadyCallCount = 0;

function makeGatewayHealthResult(
  overrides: Partial<MockGatewayHealthResult> = {},
): MockGatewayHealthResult {
  return {
    target: "http://127.0.0.1:7830",
    healthy: true,
    localDeployment: true,
    ...overrides,
  };
}

function makeRecoveryResult(
  overrides: Partial<MockEnsureLocalGatewayReadyResult> = {},
): MockEnsureLocalGatewayReadyResult {
  return {
    ...makeGatewayHealthResult(),
    recovered: false,
    recoveryAttempted: false,
    recoverySkipped: false,
    ...overrides,
  };
}

mock.module("../calls/twilio-config.js", () => ({
  getTwilioConfig: (assistantId?: string) => ({
    accountSid: "AC_test",
    authToken: "test_token",
    phoneNumber: assistantId === "ast-alpha" ? "+15550003333" : "+15550001111",
    webhookBaseUrl: "https://test.example.com",
    wssBaseUrl: "wss://test.example.com",
  }),
}));

mock.module("../calls/twilio-provider.js", () => ({
  TwilioConversationRelayProvider: class {
    async checkCallerIdEligibility(number: string) {
      if (number === "+15550002222") return { eligible: true };
      return {
        eligible: false,
        reason: `${number} is not eligible as a caller ID`,
      };
    }
    async initiateCall(args: Record<string, unknown>) {
      twilioInitiateCallCount++;
      twilioInitiateCallArgs.push(args);
      if (twilioInitiateCallBehavior === "error")
        throw new Error("Twilio unavailable");
      return { callSid: "CA_test_123" };
    }
    async endCall() {
      return;
    }
  },
}));

mock.module("../security/secure-keys.js", () => ({
  getSecureKeyAsync: async () => ({ value: undefined, unreachable: false }),
}));

mock.module("../config/loader.js", () => ({
  loadConfig: () => ({
    calls: {
      enabled: true,
      provider: "twilio",
      callerIdentity: { allowPerCallOverride: true },
    },
    ingress: {
      enabled: mockIngressEnabled,
      publicBaseUrl: mockIngressPublicBaseUrl,
    },
    memory: { enabled: false },
  }),
  getConfig: () => ({
    calls: {
      enabled: true,
      provider: "twilio",
      callerIdentity: { allowPerCallOverride: true },
    },
    ingress: {
      enabled: mockIngressEnabled,
      publicBaseUrl: mockIngressPublicBaseUrl,
    },
    memory: { enabled: false },
  }),
}));

mock.module("../inbound/platform-callback-registration.js", () => ({
  resolveCallbackUrl: async (fn: () => string) => fn(),
  shouldUsePlatformCallbacks: () => false,
}));

mock.module("../inbound/public-ingress-urls.js", () => ({
  getTwilioVoiceWebhookUrl: () =>
    "https://test.example.com/webhooks/twilio/voice/test",
  getTwilioStatusCallbackUrl: () =>
    "https://test.example.com/webhooks/twilio/status",
}));

mock.module("../memory/conversation-title-service.js", () => ({
  queueGenerateConversationTitle: () => {},
}));

mock.module("../runtime/local-gateway-health.js", () => ({
  probeLocalGatewayHealth: async () => {
    probeLocalGatewayHealthCallCount++;
    const next =
      probeLocalGatewayHealthResults.shift() ?? makeGatewayHealthResult();
    return next;
  },
  ensureLocalGatewayReady: async () => {
    ensureLocalGatewayReadyCallCount++;
    return ensureLocalGatewayReadyResult;
  },
}));

mock.module("../daemon/handlers/config-ingress.js", () => ({
  computeGatewayTarget: () => "http://127.0.0.1:7830",
  handleIngressConfig: async () => {},
  syncTwilioWebhooks: async () => ({ success: true }),
}));

import {
  clearActiveCallLeases,
  getActiveCallLease,
  listActiveCallLeases,
} from "../calls/active-call-lease.js";
import {
  cancelCall,
  resolveCallerIdentity,
  startCall,
} from "../calls/call-domain.js";
import type { AssistantConfig } from "../config/types.js";
import { getMessages } from "../memory/conversation-crud.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversations } from "../memory/schema.js";

initializeDb();

beforeEach(() => {
  resetTables();
  clearActiveCallLeases();
  twilioInitiateCallBehavior = "success";
  twilioInitiateCallCount = 0;
  twilioInitiateCallArgs = [];
  mockIngressEnabled = true;
  mockIngressPublicBaseUrl = "https://test.example.com";
  probeLocalGatewayHealthResults = [
    makeGatewayHealthResult(),
    makeGatewayHealthResult(),
  ];
  probeLocalGatewayHealthCallCount = 0;
  ensureLocalGatewayReadyResult = makeRecoveryResult();
  ensureLocalGatewayReadyCallCount = 0;
});

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

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM call_sessions");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  ensuredConvIds = new Set();
}

function getLatestAssistantText(conversationId: string): string | null {
  const msgs = getMessages(conversationId).filter(
    (m) => m.role === "assistant",
  );
  if (msgs.length === 0) return null;
  const latest = msgs[msgs.length - 1];
  try {
    const parsed = JSON.parse(latest.content) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .filter(
          (b): b is { type: string; text?: string } =>
            typeof b === "object" && b != null,
        )
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
    }
    if (typeof parsed === "string") return parsed;
  } catch {
    /* fall through */
  }
  return latest.content;
}

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function makeConfig(
  overrides: {
    allowPerCallOverride?: boolean;
    userNumber?: string;
  } = {},
): AssistantConfig {
  return {
    calls: {
      callerIdentity: {
        allowPerCallOverride: overrides.allowPerCallOverride ?? true,
        userNumber: overrides.userNumber,
      },
    },
  } as unknown as AssistantConfig;
}

describe("resolveCallerIdentity — strict implicit-default policy", () => {
  test("implicit call defaults to assistant_number", async () => {
    const result = await resolveCallerIdentity(makeConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("assistant_number");
      expect(result.fromNumber).toBe("+15550001111");
      expect(result.source).toBe("implicit_default");
    }
  });

  test("implicit call uses assistant_number even when userNumber is configured", async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ userNumber: "+15550002222" }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("assistant_number");
      expect(result.fromNumber).toBe("+15550001111");
      expect(result.source).toBe("implicit_default");
    }
  });

  test("assistant_number resolves from twilio config phone number", async () => {
    const result = await resolveCallerIdentity(makeConfig());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("assistant_number");
      expect(result.fromNumber).toBe("+15550001111");
      expect(result.source).toBe("implicit_default");
    }
  });

  test("explicit user_number succeeds when eligible", async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ userNumber: "+15550002222" }),
      "user_number",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("user_number");
      expect(result.fromNumber).toBe("+15550002222");
      expect(result.source).toBe("user_config");
    }
  });

  test("explicit user_number fails when no user phone configured", async () => {
    const result = await resolveCallerIdentity(makeConfig(), "user_number");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("user_number");
      expect(result.error).toContain("user phone number");
    }
  });

  test("explicit user_number fails when number is ineligible", async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ userNumber: "+15559999999" }),
      "user_number",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("not eligible");
    }
  });

  test("explicit override rejected when allowPerCallOverride=false", async () => {
    const result = await resolveCallerIdentity(
      makeConfig({ allowPerCallOverride: false, userNumber: "+15550002222" }),
      "user_number",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("override is disabled");
    }
  });

  test("explicit assistant_number override succeeds when allowed", async () => {
    const result = await resolveCallerIdentity(
      makeConfig(),
      "assistant_number",
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.mode).toBe("assistant_number");
      expect(result.source).toBe("per_call_override");
    }
  });

  test("invalid mode returns error", async () => {
    const result = await resolveCallerIdentity(
      makeConfig(),
      "custom_number" as "assistant_number",
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error).toContain("Invalid callerIdentityMode");
    }
  });
});

// ── Pointer message regression tests ──────────────────────────────

describe("startCall — pointer message regression", () => {
  test("successful call writes a started pointer to the initiating conversation", async () => {
    const convId = "conv-domain-ptr-start";
    ensureConversation(convId);

    const result = await startCall({
      phoneNumber: "+15559876543",
      task: "Test call",
      conversationId: convId,
    });

    expect(result.ok).toBe(true);
    expect(twilioInitiateCallCount).toBe(1);
    expect(twilioInitiateCallArgs).toEqual([
      {
        from: "+15550001111",
        to: "+15559876543",
        webhookUrl: "https://test.example.com/webhooks/twilio/voice/test",
        statusCallbackUrl: "https://test.example.com/webhooks/twilio/status",
      },
    ]);
    // Gateway reconcile triggers have been removed; the gateway reads
    // credentials and config via TTL caches.
    if (result.ok) {
      expect(getActiveCallLease(result.session.id)).toEqual({
        callSessionId: result.session.id,
        providerCallSid: "CA_test_123",
        updatedAt: expect.any(Number),
      });
    }
    // Allow async pointer write to flush
    await new Promise((r) => setTimeout(r, 50));

    const text = getLatestAssistantText(convId);
    expect(text).not.toBeNull();
    expect(text!).toContain("+15559876543");
    expect(text!).toContain("started");
  });

  test("fails fast when ingress is disabled and never reaches Twilio dialing", async () => {
    const convId = "conv-domain-ingress-disabled";
    ensureConversation(convId);
    mockIngressEnabled = false;

    const result = await startCall({
      phoneNumber: "+15559876543",
      task: "Test call",
      conversationId: convId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("Public ingress");
    }
    expect(probeLocalGatewayHealthCallCount).toBe(0);
    expect(ensureLocalGatewayReadyCallCount).toBe(0);
    // No reconcile calls expected (reconcile triggers removed).
    expect(twilioInitiateCallCount).toBe(0);

    await new Promise((r) => setTimeout(r, 50));

    const text = getLatestAssistantText(convId);
    expect(text).not.toBeNull();
    expect(text!).toContain("+15559876543");
    expect(text!).toContain("failed");
  });

  test("never dials Twilio when the local callback gateway stays unhealthy", async () => {
    const convId = "conv-domain-preflight-unhealthy";
    ensureConversation(convId);
    probeLocalGatewayHealthResults = [
      makeGatewayHealthResult({
        healthy: false,
        error: "Gateway health check returned HTTP 503",
      }),
      makeGatewayHealthResult({
        healthy: false,
        error: "Gateway health check returned HTTP 503",
      }),
    ];
    ensureLocalGatewayReadyResult = makeRecoveryResult({
      healthy: false,
      error: "Gateway health check returned HTTP 503",
      recovered: false,
      recoveryAttempted: true,
    });

    const result = await startCall({
      phoneNumber: "+15559876543",
      task: "Test call",
      conversationId: convId,
    });

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(503);
      expect(result.error).toContain("still unhealthy");
    }
    expect(probeLocalGatewayHealthCallCount).toBe(2);
    expect(ensureLocalGatewayReadyCallCount).toBe(1);
    // No reconcile calls expected (reconcile triggers removed).
    expect(twilioInitiateCallCount).toBe(0);
  });

  test("can recover a local gateway and then place exactly one outbound Twilio call", async () => {
    const convId = "conv-domain-preflight-recovery";
    ensureConversation(convId);
    probeLocalGatewayHealthResults = [
      makeGatewayHealthResult({
        healthy: false,
        error: "Gateway health check returned HTTP 503",
      }),
      makeGatewayHealthResult(),
    ];
    ensureLocalGatewayReadyResult = makeRecoveryResult({
      healthy: true,
      recovered: true,
      recoveryAttempted: true,
    });

    const result = await startCall({
      phoneNumber: "+15559876543",
      task: "Test call",
      conversationId: convId,
    });

    expect(result.ok).toBe(true);
    expect(probeLocalGatewayHealthCallCount).toBe(2);
    expect(ensureLocalGatewayReadyCallCount).toBe(1);
    // Gateway reconcile triggers have been removed; the gateway reads
    // credentials and config via TTL caches.
    expect(twilioInitiateCallCount).toBe(1);
  });

  test("failed call writes a failed pointer to the initiating conversation", async () => {
    const convId = "conv-domain-ptr-fail";
    ensureConversation(convId);
    twilioInitiateCallBehavior = "error";

    const result = await startCall({
      phoneNumber: "+15559876543",
      task: "Test call",
      conversationId: convId,
    });

    expect(result.ok).toBe(false);
    expect(twilioInitiateCallCount).toBe(1);
    expect(listActiveCallLeases()).toHaveLength(0);
    // Allow async pointer write to flush
    await new Promise((r) => setTimeout(r, 50));

    const text = getLatestAssistantText(convId);
    expect(text).not.toBeNull();
    expect(text!).toContain("+15559876543");
    expect(text!).toContain("failed");
  });

  test("canceling an active call releases its persisted keepalive lease", async () => {
    const convId = "conv-domain-cancel-releases-lease";
    ensureConversation(convId);

    const startResult = await startCall({
      phoneNumber: "+15559876543",
      task: "Test call",
      conversationId: convId,
    });

    expect(startResult.ok).toBe(true);
    if (!startResult.ok) {
      return;
    }

    expect(getActiveCallLease(startResult.session.id)).not.toBeNull();

    const cancelResult = await cancelCall({
      callSessionId: startResult.session.id,
      reason: "User requested",
    });

    expect(cancelResult.ok).toBe(true);
    expect(getActiveCallLease(startResult.session.id)).toBeNull();
  });
});
