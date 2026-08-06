/**
 * Regression tests for guardian-card vellum destination routing (LUM-2870).
 *
 * Two unrelated guardian requests must never share a vellum conversation:
 * un-pinned requests are forced to `start_new` by the decision engine's
 * guardian-request affinity guard (overriding any LLM `reuse_existing`
 * choice), so each request pairs with its own fresh conversation; pinned
 * requests land in their originating conversation via the affinity hint.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks — declared before imports that depend on them ─────────────

let nextConversationSeq = 0;

/** Simulated existing conversations for getConversation mock. */
let mockExistingConversations: Record<
  string,
  { id: string; source: string; title: string | null }
> = {};

const createdConversationIds: string[] = [];
const appendedMessages: Array<{ conversationId: string }> = [];

const createConversationMock = mock((_opts?: unknown) => {
  nextConversationSeq += 1;
  const id = `conv-new-${nextConversationSeq}`;
  createdConversationIds.push(id);
  return { id };
});

const addMessageMock = mock(
  (
    conversationId: string,
    _role: string,
    _content: string,
    _options?: unknown,
  ) => {
    appendedMessages.push({ conversationId });
    return { id: `msg-${conversationId}` };
  },
);

const getConversationMock = mock((id: string) => {
  return mockExistingConversations[id] ?? null;
});

mock.module("../persistence/conversation-crud.js", () => ({
  createConversation: createConversationMock,
  addMessage: addMessageMock,
  getConversation: getConversationMock,
}));

mock.module("../persistence/external-conversation-store.js", () => ({
  getBindingByChannelChat: () => null,
  upsertOutboundBinding: () => {},
}));

import { pairDeliveryWithConversation } from "../notifications/conversation-pairing.js";
import { enforceGuardianRequestConversationAffinity } from "../notifications/decision-engine.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type {
  ConversationAction,
  NotificationDecision,
} from "../notifications/types.js";

// ── Helpers ─────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: `sig-${Math.random().toString(36).slice(2, 8)}`,
    createdAt: Date.now(),
    sourceChannel: "slack",
    sourceContextId: "ctx-1",
    sourceEventName: "guardian.question",
    contextPayload: {},
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    requiresConversation: true,
    ...overrides,
  };
}

function makeLlmDecisionReusing(conversationId: string): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "llm chose reuse",
    renderedCopy: {
      vellum: { title: "Approval needed", body: "Please decide." },
    },
    conversationActions: {
      vellum: { action: "reuse_existing", conversationId },
    },
    dedupeKey: "test-key",
    confidence: 0.9,
    fallbackUsed: false,
  };
}

/** Run a signal's decision through the guard and pair the vellum delivery. */
async function routeVellumDelivery(
  signal: NotificationSignal,
  decision: NotificationDecision,
) {
  const guarded = enforceGuardianRequestConversationAffinity(decision, signal);
  const conversationAction = guarded.conversationActions?.vellum as
    | ConversationAction
    | undefined;
  return pairDeliveryWithConversation(
    signal,
    "vellum",
    guarded.renderedCopy.vellum!,
    { conversationAction },
  );
}

// ── Tests ───────────────────────────────────────────────────────────

describe("guardian vellum destination pinning", () => {
  beforeEach(() => {
    nextConversationSeq = 0;
    createdConversationIds.length = 0;
    appendedMessages.length = 0;
    mockExistingConversations = {
      // The "catch-all" — a recent guardian conversation the LLM keeps
      // offering as a reuse candidate.
      "conv-catchall": {
        id: "conv-catchall",
        source: "notification",
        title: "Access Request",
      },
      // An originating inbound conversation a producer can pin to.
      "conv-origin": { id: "conv-origin", source: "user", title: "Slack chat" },
    };
    createConversationMock.mockClear();
    addMessageMock.mockClear();
  });

  test("two unrelated un-pinned guardian requests land in two different conversations", async () => {
    // Both decisions simulate the LLM steering to the same catch-all.
    const accessRequest = makeSignal({
      sourceEventName: "ingress.access_request",
      contextPayload: { requestId: "access-req-1" },
    });
    const toolGrant = makeSignal({
      sourceEventName: "guardian.question",
      contextPayload: {
        requestId: "tool-grant-1",
        requestKind: "tool_grant_request",
        toolName: "host_bash",
      },
    });

    const first = await routeVellumDelivery(
      accessRequest,
      makeLlmDecisionReusing("conv-catchall"),
    );
    const second = await routeVellumDelivery(
      toolGrant,
      makeLlmDecisionReusing("conv-catchall"),
    );

    expect(first.conversationId).toBeTruthy();
    expect(second.conversationId).toBeTruthy();
    expect(first.conversationId).not.toBe(second.conversationId);
    expect(first.createdNewConversation).toBe(true);
    expect(second.createdNewConversation).toBe(true);
    // The catch-all never receives either card.
    expect(
      appendedMessages.filter((m) => m.conversationId === "conv-catchall"),
    ).toHaveLength(0);
  });

  test("a pinned guardian request lands in its originating conversation", async () => {
    const pinned = makeSignal({
      sourceEventName: "guardian.question",
      contextPayload: {
        requestId: "tool-approval-1",
        requestKind: "tool_approval",
        toolName: "bash",
      },
      conversationAffinityHint: { vellum: "conv-origin" },
      conversationMetadata: { source: "user" },
    });

    // With a hint the guard is a no-op; affinity enforcement (exercised in
    // decision-engine tests) rewrites the action to reuse the pinned target.
    const guarded = enforceGuardianRequestConversationAffinity(
      makeLlmDecisionReusing("conv-catchall"),
      pinned,
    );
    expect(guarded.conversationActions?.vellum).toEqual({
      action: "reuse_existing",
      conversationId: "conv-catchall",
    });

    const pairing = await pairDeliveryWithConversation(
      pinned,
      "vellum",
      guarded.renderedCopy.vellum!,
      {
        conversationAction: {
          action: "reuse_existing",
          conversationId: "conv-origin",
        },
      },
    );

    expect(pairing.conversationId).toBe("conv-origin");
    expect(pairing.createdNewConversation).toBe(false);
    expect(appendedMessages).toEqual([{ conversationId: "conv-origin" }]);
  });
});
