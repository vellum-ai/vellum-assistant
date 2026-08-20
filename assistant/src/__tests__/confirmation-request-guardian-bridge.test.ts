/**
 * Tests for the confirmation-request -> guardian.question notification bridge.
 *
 * Verifies that:
 * 1. Contact confirmation_requests emit guardian.question notifications
 * 2. A guardian's own channel prompt emits one too, because the card is its
 *    only guardian-addressed surface there, while the turns a card cannot
 *    reach (in-app, undeliverable channels) still skip
 * 3. Delivery rows are persisted for guardian destinations
 * 4. Unknown actor sessions are correctly skipped
 * 5. Missing guardian binding causes a skip
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
import {
  bridgeConfirmationRequestToGuardian,
  guardianPromptDeliveredAsCard,
} from "../runtime/confirmation-request-guardian-bridge.js";
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
    // The in-app card is pinned to the conversation the confirmation was
    // emitted in — never left to LLM conversation routing.
    expect(emittedSignals[0].conversationAffinityHint).toEqual({
      vellum: "conv-1",
    });

    const payload = emittedSignals[0].contextPayload as Record<string, unknown>;
    expect(payload.requestId).toBe(guardianRequest.id);
    expect(payload.requestCode).toBe(guardianRequest.requestCode);
    expect(payload.toolName).toBe("bash");
    expect(payload.requesterExternalUserId).toBe("requester-1");
    expect(payload.requesterIdentifier).toBe("@requester");
  });

  // A guardian clears the sensitive-tool gate, so that gate lets the call
  // proceed, but the risk/threshold policy still parks a prompt they have to
  // answer. The card is the only surface addressed to the guardian rather
  // than to whatever chat the turn is running in, which on a shared channel
  // is a room.
  test("emits guardian.question for a guardian's own channel prompt", async () => {
    const guardianRequest = makeGuardianRequest({
      requesterExternalUserId: "guardian-1",
    });
    const trustContext: TrustContext = {
      sourceChannel: "telegram",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "guardian-1",
    };

    const result = await bridgeConfirmationRequestToGuardian({
      guardianRequest,
      trustContext,
      conversationId: "conv-1",
      toolName: "bash",
    });

    expect("bridged" in result && result.bridged).toBe(true);
    expect(emittedSignals).toHaveLength(1);
    expect(emittedSignals[0].sourceEventName).toBe("guardian.question");
    // Pinned like any other guardian card, never left to conversation routing.
    expect(emittedSignals[0].conversationAffinityHint).toEqual({
      vellum: "conv-1",
    });
  });

  // In the app the client renders the confirmation itself, so a card would be
  // a second copy of a prompt already on screen.
  test("skips a guardian prompt raised in the app", async () => {
    const guardianRequest = makeGuardianRequest({ sourceChannel: "vellum" });
    const trustContext: TrustContext = {
      sourceChannel: "vellum",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "guardian-1",
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

  // The rail keeps the turns a card cannot reach, so the bridge must decline
  // them rather than emit a signal that resolves to no destination.
  test("skips a guardian prompt on a channel the pipeline cannot deliver to", async () => {
    const guardianRequest = makeGuardianRequest({ sourceChannel: "discord" });
    const trustContext: TrustContext = {
      sourceChannel: "discord",
      trustClass: "guardian",
      guardianExternalUserId: "guardian-1",
      requesterExternalUserId: "guardian-1",
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

describe("guardianPromptDeliveredAsCard", () => {
  // The rail and the bridge both read this, so the two answers have to be one
  // rule. A copy in either caller would eventually disagree and either
  // deliver the prompt twice or not at all.
  test("is true for a guardian on a channel the pipeline can deliver to", () => {
    for (const sourceChannel of ["slack", "telegram"] as const) {
      expect(
        guardianPromptDeliveredAsCard({
          trustClass: "guardian",
          sourceChannel,
        }),
      ).toBe(true);
    }
  });

  test("is false in the app, where the client renders the confirmation", () => {
    expect(
      guardianPromptDeliveredAsCard({
        trustClass: "guardian",
        sourceChannel: "vellum",
      }),
    ).toBe(false);
  });

  // `platform` is a push-only relay and a push carries no buttons; `whatsapp`
  // renders inline buttons on a direct send but has no notification adapter to
  // deliver a card through. Neither can carry a decision.
  test("is false on channels that cannot render a card", () => {
    for (const sourceChannel of [
      "discord",
      "whatsapp",
      "email",
      "platform",
    ] as const) {
      expect(
        guardianPromptDeliveredAsCard({
          trustClass: "guardian",
          sourceChannel,
        }),
      ).toBe(false);
    }
  });

  test("is false for every actor who is not the guardian", () => {
    for (const trustClass of [
      "trusted_contact",
      "unverified_contact",
      "unknown",
    ] as const) {
      expect(
        guardianPromptDeliveredAsCard({ trustClass, sourceChannel: "slack" }),
      ).toBe(false);
    }
  });
});
