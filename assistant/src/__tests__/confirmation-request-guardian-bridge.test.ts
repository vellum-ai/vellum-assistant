/**
 * Tests for the confirmation-request -> guardian.question notification bridge.
 *
 * Verifies that:
 * 1. Trusted-contact confirmation_requests emit guardian.question notifications
 * 2. Canonical delivery rows are persisted for guardian destinations
 * 3. Guardian and unknown actor sessions are correctly skipped
 * 4. Missing guardian binding causes a skip
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { _setOverridesForTesting } from "../config/assistant-feature-flags.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

// Mock notification emission — capture calls without running the full pipeline
const emittedSignals: Array<Record<string, unknown>> = [];
const mockOnConversationCreatedCallbacks: Array<
  (info: {
    conversationId: string;
    title: string;
    sourceEventName: string;
  }) => void
> = [];
mock.module("../notifications/emit-signal.js", () => ({
  emitNotificationSignal: async (params: Record<string, unknown>) => {
    emittedSignals.push(params);
    // Capture onConversationCreated callback so tests can invoke it
    if (typeof params.onConversationCreated === "function") {
      mockOnConversationCreatedCallbacks.push(
        params.onConversationCreated as (info: {
          conversationId: string;
          title: string;
          sourceEventName: string;
        }) => void,
      );
    }
    return {
      signalId: "test-signal",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [
        { channel: "telegram", destination: "guardian-chat-1", success: true },
      ],
    };
  },
  registerBroadcastFn: () => {},
}));

// Mock channel guardian service — provide a guardian binding for 'self' + 'telegram'
mock.module("../runtime/channel-verification-service.js", () => ({
  getGuardianBinding: (assistantId: string, channel: string) => {
    if (assistantId === "self" && channel === "telegram") {
      return {
        id: "binding-1",
        assistantId: "self",
        channel: "telegram",
        guardianExternalUserId: "guardian-1",
        guardianDeliveryChatId: "guardian-chat-1",
        status: "active",
      };
    }
    return null;
  },
}));

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  createCanonicalGuardianRequest,
  generateCanonicalRequestCode,
  listCanonicalGuardianDeliveries,
} from "../memory/canonical-guardian-store.js";
import { getDb, initializeDb } from "../memory/db.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";

initializeDb();

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM canonical_guardian_deliveries");
  db.run("DELETE FROM canonical_guardian_requests");
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCanonicalRequest(overrides: Record<string, unknown> = {}) {
  return createCanonicalGuardianRequest({
    id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "telegram",
    conversationId: "conv-1",
    requesterExternalUserId: "requester-1",
    guardianExternalUserId: "guardian-1",
    guardianPrincipalId: "test-principal-id",
    toolName: "bash",
    status: "pending",
    requestCode: generateCanonicalRequestCode(),
    expiresAt: Date.now() + 5 * 60 * 1000,
    ...overrides,
  });
}

function makeTrustedContactContext(
  overrides: Partial<TrustContext> = {},
): TrustContext {
  return {
    sourceChannel: "telegram",
    trustClass: "trusted_contact",
    guardianExternalUserId: "guardian-1",
    guardianChatId: "guardian-chat-1",
    requesterExternalUserId: "requester-1",
    requesterChatId: "requester-chat-1",
    requesterIdentifier: "@requester",
    ...overrides,
  };
}

// ===========================================================================
// TESTS
// ===========================================================================

describe("bridgeConfirmationRequestToGuardian", () => {
  beforeEach(() => {
    resetTables();
    emittedSignals.length = 0;
    mockOnConversationCreatedCallbacks.length = 0;
    _setOverridesForTesting({});
  });

  test("emits guardian.question for trusted-contact sessions", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("bridged" in result && result.bridged).toBe(true);
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0].sourceEventName).toBe("guardian.question");
    expect(emittedSignals[0].sourceChannel).toBe("telegram");
    expect(emittedSignals[0].sourceContextId).toBe("conv-1");

    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requestId).toBe(canonicalRequest.id);
    expect(payload.requestCode).toBe(canonicalRequest.requestCode);
    expect(payload.toolName).toBe("bash");
    expect(payload.requesterExternalUserId).toBe("requester-1");
    expect(payload.requesterIdentifier).toBe("@requester");
  });

  test("skips guardian actor sessions (self-approve)", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-1",
    };

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("not_trusted_contact");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("skips unknown actor sessions", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
    };

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("not_trusted_contact");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("skips when guardian identity is missing", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext({
      guardianExternalUserId: undefined,
    });

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("missing_guardian_identity");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("skips trusted-contact bridging entirely under permission-controls-v2", () => {
    _setOverridesForTesting({ "permission-controls-v2": true });

    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("v2_model_mediated");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("skips when no guardian binding exists for channel", () => {
    const canonicalRequest = makeCanonicalRequest({ sourceChannel: "phone" });
    const trustContext = makeTrustedContactContext({
      sourceChannel: "phone",
    });

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("no_guardian_binding");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("sets correct attention hints for urgency", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    const hints = emittedSignals[0].attentionHints as Record<string, unknown>;
    expect(hints.requiresAction).toBe(true);
    expect(hints.urgency).toBe("high");
    expect(hints.isAsyncBackground).toBe(false);
    expect(hints.visibleInSourceNow).toBe(false);
  });

  test("uses dedupe key scoped to canonical request ID", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect(emittedSignals[0].dedupeKey).toBe(
      `tc-confirmation-request:${canonicalRequest.id}`,
    );
  });

  test("creates vellum delivery row via onConversationCreated callback", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect(mockOnConversationCreatedCallbacks).toHaveLength(1);

    // Simulate the broadcaster invoking onConversationCreated
    mockOnConversationCreatedCallbacks[0]({
      conversationId: "guardian-conversation-1",
      title: "Guardian question",
      sourceEventName: "guardian.question",
    });

    const deliveries = listCanonicalGuardianDeliveries(canonicalRequest.id);
    expect(deliveries).toHaveLength(1);
    expect(deliveries[0].destinationChannel).toBe("vellum");
    expect(deliveries[0].destinationConversationId).toBe(
      "guardian-conversation-1",
    );
  });

  test("uses custom assistantId when provided", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
      assistantId: "custom-assistant",
    });

    // The mock only returns a binding for 'self', so 'custom-assistant'
    // should fail with no_guardian_binding.
    // Actually let's verify the signal uses the right assistantId.
    // Since mock only has binding for 'self', this will skip.
    expect(emittedSignals).toHaveLength(0);
  });

  test("does not pass assistantId to notification signal", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext();

    // assistantId is used internally for guardian binding lookup but is no
    // longer forwarded to the notification signal after the assistantId removal refactor.
    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect(emittedSignals[0].assistantId).toBeUndefined();
  });

  test("includes requesterChatId as null when not provided", () => {
    const canonicalRequest = makeCanonicalRequest();
    const trustContext = makeTrustedContactContext({
      requesterChatId: undefined,
    });

    bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requesterChatId).toBeNull();
  });

  test("skips when binding guardian identity does not match canonical request guardian", () => {
    // Create a canonical request where guardianExternalUserId differs from the
    // binding's guardianExternalUserId ('guardian-1' in the mock).
    const canonicalRequest = makeCanonicalRequest({
      guardianExternalUserId: "old-guardian-who-was-rebound",
    });
    const trustContext = makeTrustedContactContext();

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("binding_identity_mismatch");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("does not skip when canonical request guardian identity is null", () => {
    // When guardianExternalUserId is null on the canonical request (e.g. desktop
    // flow), the identity check should be skipped and the bridge should proceed.
    const canonicalRequest = makeCanonicalRequest({
      guardianExternalUserId: null,
    });
    const trustContext = makeTrustedContactContext();

    const result = bridgeConfirmationRequestToGuardian({
      canonicalRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("bridged" in result && result.bridged).toBe(true);
    expect(emittedSignals).toHaveLength(1);
  });
});
