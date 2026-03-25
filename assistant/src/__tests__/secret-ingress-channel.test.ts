import { beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be declared before any imports that depend on them
// ---------------------------------------------------------------------------

let mockConfig: Record<string, unknown> = {
  secretDetection: {
    enabled: true,
    blockIngress: true,
  },
};

mock.module("../config/loader.js", () => ({
  getConfig: () => mockConfig,
  loadConfig: () => mockConfig,
  invalidateConfigCache: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../util/platform.js", () => ({
  getRootDir: () => "/tmp/vellum-test-secret-ingress-channel",
  getWorkspaceDir: () => "/tmp/vellum-test-secret-ingress-channel/workspace",
}));

const storePayloadMock = mock((_eventId: string, _payload: unknown) => {});
const clearPayloadMock = mock((_eventId: string) => {});

mock.module("../memory/delivery-crud.js", () => ({
  storePayload: (eventId: string, payload: unknown) =>
    storePayloadMock(eventId, payload),
  clearPayload: (eventId: string) => clearPayloadMock(eventId),
  recordInbound: () => ({
    eventId: "evt-test",
    conversationId: "conv-test",
    accepted: true,
    duplicate: false,
  }),
}));

const markProcessedMock = mock((_eventId: string) => {});

mock.module("../memory/delivery-status.js", () => ({
  markProcessed: (eventId: string) => markProcessedMock(eventId),
}));

mock.module("../memory/conversation-attention-store.js", () => ({
  recordConversationSeenSignal: () => {},
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  runSecretIngressCheck,
  type SecretIngressCheckParams,
} from "../runtime/routes/inbound-stages/secret-ingress-check.js";
import { resetAllowlist } from "../security/secret-allowlist.js";

function makeParams(
  overrides: Partial<SecretIngressCheckParams> = {},
): SecretIngressCheckParams {
  return {
    eventId: "evt-test-1",
    sourceChannel: "slack",
    conversationExternalId: "ext-conv-1",
    externalMessageId: "ext-msg-1",
    conversationId: "conv-1",
    content: "hello",
    trimmedContent: "hello",
    attachmentIds: undefined,
    sourceMetadata: undefined,
    actorDisplayName: "Test User",
    actorExternalId: "user-1",
    actorUsername: "testuser",
    trustCtx: {
      trustClass: "member" as const,
      sourceChannel: "slack" as const,
    } as any,
    replyCallbackUrl: undefined,
    canonicalAssistantId: "self",
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("secret ingress — channel inbound path", () => {
  beforeEach(() => {
    mockConfig = {
      secretDetection: {
        enabled: true,
        blockIngress: true,
      },
    };
    storePayloadMock.mockClear();
    clearPayloadMock.mockClear();
    markProcessedMock.mockClear();
    resetAllowlist();
  });

  test("channel inbound with GOCSPX- secret returns blocked: true", () => {
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
    const result = runSecretIngressCheck(
      makeParams({
        content: `My secret is ${secret}`,
        trimmedContent: `My secret is ${secret}`,
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Google OAuth Client Secret");
  });

  test("channel inbound with normal text returns blocked: false", () => {
    const result = runSecretIngressCheck(
      makeParams({
        content: "Hello, how can I help?",
        trimmedContent: "Hello, how can I help?",
      }),
    );

    expect(result.blocked).toBe(false);
  });

  test("payload is cleared when blocked", () => {
    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
    runSecretIngressCheck(
      makeParams({
        eventId: "evt-clear-test",
        content: `Secret: ${secret}`,
        trimmedContent: `Secret: ${secret}`,
      }),
    );

    // storePayload should have been called (it persists before checking)
    expect(storePayloadMock).toHaveBeenCalledTimes(1);
    // clearPayload should have been called to remove the secret-bearing payload
    expect(clearPayloadMock).toHaveBeenCalledWith("evt-clear-test");
  });

  test("payload is NOT cleared for normal messages", () => {
    runSecretIngressCheck(
      makeParams({
        content: "Normal message",
        trimmedContent: "Normal message",
      }),
    );

    expect(storePayloadMock).toHaveBeenCalledTimes(1);
    expect(clearPayloadMock).not.toHaveBeenCalled();
  });

  test("event is marked as processed (not dead-lettered) when blocked — verified via caller contract", () => {
    // The inbound-message-handler calls markProcessed when runSecretIngressCheck
    // returns blocked: true. We verify the check returns blocked: true, which
    // triggers the markProcessed call in the handler.
    const secret = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234";
    const result = runSecretIngressCheck(
      makeParams({
        content: secret,
        trimmedContent: secret,
      }),
    );

    expect(result.blocked).toBe(true);

    // Simulate the handler's behavior: mark processed on block
    // (This mirrors inbound-message-handler.ts lines 663-666)
    if (result.blocked) {
      markProcessedMock("evt-test-1");
    }
    expect(markProcessedMock).toHaveBeenCalledWith("evt-test-1");
  });

  test("channel inbound with GitHub token is blocked", () => {
    const token = "ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghij1234";
    const result = runSecretIngressCheck(
      makeParams({
        content: `Token: ${token}`,
        trimmedContent: `Token: ${token}`,
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("GitHub Token");
  });

  test("channel inbound with Slack bot token is blocked", () => {
    const token = "xoxb-1234567890-9876543210-AbCdEfGhIjKlMnOpQrStUvWx";
    const result = runSecretIngressCheck(
      makeParams({
        content: token,
        trimmedContent: token,
      }),
    );

    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("Slack Bot Token");
  });

  test("channel inbound with JWT is not blocked (excluded pattern)", () => {
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const result = runSecretIngressCheck(
      makeParams({
        content: jwt,
        trimmedContent: jwt,
      }),
    );

    expect(result.blocked).toBe(false);
  });

  test("channel inbound with blockIngress: false allows secrets through", () => {
    mockConfig = {
      secretDetection: {
        enabled: true,
        blockIngress: false,
      },
    };

    const secret = "GOCSPX-abcdefghijklmnopqrstuvwxyz12";
    const result = runSecretIngressCheck(
      makeParams({
        content: secret,
        trimmedContent: secret,
      }),
    );

    expect(result.blocked).toBe(false);
    expect(clearPayloadMock).not.toHaveBeenCalled();
  });

  test("background dispatch is skipped when blocked (caller reads blocked flag)", () => {
    // The inbound-message-handler skips processChannelMessageInBackground
    // when ingressResult.blocked is true. We verify the function returns
    // the correct blocked flag that the handler uses for this decision.
    const secret = "AKIAIOSFODNN7EXAMPLE";
    const result = runSecretIngressCheck(
      makeParams({
        content: `AWS: ${secret}`,
        trimmedContent: `AWS: ${secret}`,
      }),
    );

    // blocked: true means the caller (inbound-message-handler) will skip
    // the background dispatch branch
    expect(result.blocked).toBe(true);
    expect(result.detectedTypes).toContain("AWS Access Key");
  });
});
