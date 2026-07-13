/**
 * Tests for the confirmation-request -> guardian.question notification bridge.
 *
 * Verifies that:
 * 1. Trusted-contact confirmation_requests emit guardian.question notifications
 * 2. Delivery rows are persisted for guardian destinations
 * 3. Guardian and unknown actor sessions are correctly skipped
 * 4. Missing guardian binding causes a skip
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

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

// The bridge records deliveries through the gateway client; serve that
// surface from the in-memory sim the assertions read.
import {
  bridgeState,
  gatewayGuardianRequestsStoreBridge,
} from "./helpers/gateway-guardian-requests-store-bridge.js";

mock.module(
  "../channels/gateway-guardian-requests.js",
  () => gatewayGuardianRequestsStoreBridge,
);

import type { TrustContext } from "../daemon/trust-context-types.js";
import { initializeDb } from "../persistence/db-init.js";
import { bridgeConfirmationRequestToGuardian } from "../runtime/confirmation-request-guardian-bridge.js";
import type { SimGuardianRequest } from "./guardian-gateway-sim.js";

await initializeDb();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeGuardianRequest(overrides: Partial<SimGuardianRequest> = {}) {
  return bridgeState.seedRequest({
    id: `req-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    kind: "tool_approval",
    sourceType: "channel",
    sourceChannel: "telegram",
    sourceConversationId: "conv-1",
    requesterExternalUserId: "requester-1",
    guardianExternalUserId: "guardian-1",
    guardianPrincipalId: "test-principal-id",
    toolName: "bash",
    status: "pending",
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
    bridgeState.reset();
    emittedSignals.length = 0;
    mockOnConversationCreatedCallbacks.length = 0;
  });

  test("emits guardian.question for trusted-contact sessions", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext();

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
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
    expect(payload.requestId).toBe(guardianRequest.id);
    expect(payload.requestCode).toBe(guardianRequest.requestCode);
    expect(payload.toolName).toBe("bash");
    expect(payload.requesterExternalUserId).toBe("requester-1");
    expect(payload.requesterIdentifier).toBe("@requester");
  });

  test("skips guardian actor sessions (self-approve)", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-1",
    };

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("not_bridgeable_trust_class");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("skips unknown actor sessions", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "unknown",
    };

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("skipped" in result && result.skipped).toBe(true);
    if ("skipped" in result) {
      expect(result.reason).toBe("not_bridgeable_trust_class");
    }
    expect(emittedSignals).toHaveLength(0);
  });

  test("skips when guardian identity is missing", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext({
      guardianExternalUserId: undefined,
    });

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
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

  test("skips when no guardian binding exists for channel", async () => {
    const guardianRequest = makeGuardianRequest({ sourceChannel: "phone" });
    const trustContext = makeTrustedContactContext({
      sourceChannel: "phone",
    });

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
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

  test("sets correct attention hints for urgency", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext();

    await bridgeConfirmationRequestToGuardian({
      guardianRequest,
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

  test("uses dedupe key scoped to guardian request ID", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext();

    await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect(emittedSignals[0].dedupeKey).toBe(
      `tc-confirmation-request:${guardianRequest.id}`,
    );
  });

  test("creates vellum delivery row via onConversationCreated callback", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext();

    await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect(mockOnConversationCreatedCallbacks).toHaveLength(1);

    // Simulate the broadcaster invoking onConversationCreated. The callback
    // kicks off an async recorder write — flush it before reading rows.
    mockOnConversationCreatedCallbacks[0]({
      conversationId: "guardian-conversation-1",
      title: "Guardian question",
      sourceEventName: "guardian.question",
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    const vellumDelivery = bridgeState.deliveries.find(
      (d) =>
        d.requestId === guardianRequest.id && d.destinationChannel === "vellum",
    );
    expect(vellumDelivery).toBeDefined();
    expect(vellumDelivery?.destinationConversationId).toBe(
      "guardian-conversation-1",
    );
  });

  test("uses custom assistantId when provided", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext();

    await bridgeConfirmationRequestToGuardian({
      guardianRequest,
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

  test("does not pass assistantId to notification signal", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext();

    // assistantId is used internally for guardian binding lookup but is no
    // longer forwarded to the notification signal after the assistantId removal refactor.
    await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect(emittedSignals[0].assistantId).toBeUndefined();
  });

  test("includes requesterChatId as null when not provided", async () => {
    const guardianRequest = makeGuardianRequest();
    const trustContext = makeTrustedContactContext({
      requesterChatId: undefined,
    });

    await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requesterChatId).toBeNull();
  });

  test("skips when binding guardian identity does not match guardian request guardian", async () => {
    // Create a guardian request where guardianExternalUserId differs from the
    // binding's guardianExternalUserId ('guardian-1' in the mock).
    const guardianRequest = makeGuardianRequest({
      guardianExternalUserId: "old-guardian-who-was-rebound",
    });
    const trustContext = makeTrustedContactContext();

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
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

  test("does not skip when guardian request guardian identity is null", async () => {
    // When guardianExternalUserId is null on the guardian request (e.g. desktop
    // flow), the identity check should be skipped and the bridge should proceed.
    const guardianRequest = makeGuardianRequest({
      guardianExternalUserId: null,
    });
    const trustContext = makeTrustedContactContext();

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("bridged" in result && result.bridged).toBe(true);
    expect(emittedSignals).toHaveLength(1);
  });
});
