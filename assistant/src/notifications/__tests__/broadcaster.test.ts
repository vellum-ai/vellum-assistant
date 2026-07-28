/**
 * Verifies the NotificationBroadcaster's fail-closed copy-resolution
 * invariant: when neither `decision.renderedCopy[channel]` nor
 * `composeFallbackCopy(...)[channel]` produces usable copy, the channel
 * must be dropped rather than delivered with a synthesized body.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { NotificationSignal } from "../signal.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationDecision,
} from "../types.js";

// ── Module mocks ────────────────────────────────────────────────────────
//
// `mock.module` is hoisted, so these intercepts apply before the module
// under test resolves its imports. State is reset in `beforeEach`.

let composeFallbackReturn: Record<string, unknown> = {};

mock.module("../copy-composer.js", () => ({
  composeFallbackCopy: () => composeFallbackReturn,
}));

// Stub only getGuardianDelivery; keep the real selectors so this mock is
// harmless if it leaks into destination-resolver.test.ts under a shared run.
const realGuardianReader =
  await import("../../contacts/guardian-delivery-reader.js");
mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  ...realGuardianReader,
  getGuardianDelivery: async () => null,
}));

mock.module("../conversation-pairing.js", () => ({
  pairDeliveryWithConversation: async () => ({
    conversationId: undefined,
    messageId: undefined,
    strategy: "start_new_conversation",
    createdNewConversation: false,
    conversationFallbackUsed: false,
  }),
}));

mock.module("../deliveries-store.js", () => ({
  createDelivery: () => {},
  updateDeliveryStatus: () => {},
  findDeliveryByDecisionAndChannel: () => undefined,
}));

mock.module("../adapters/macos.js", () => ({
  isGuardianSensitiveEvent: () => false,
}));

// Mock conversation-crud so deep-link fallback tests can control which
// conversation ids resolve to real rows.
let knownConversations: Set<string> = new Set();
mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: (id: string) =>
    knownConversations.has(id) ? { id } : undefined,
}));

// Mock destination-resolver so platform channel tests get a destination
// without needing guardian-delivery data.
mock.module("../destination-resolver.js", () => ({
  resolveDestinations: (channels: readonly string[], _guardians: unknown) => {
    const map = new Map();
    for (const ch of channels) {
      map.set(ch, { channel: ch, endpoint: ch, metadata: {} });
    }
    return map;
  },
}));

const { NotificationBroadcaster } = await import("../broadcaster.js");

// ── Test fixtures ───────────────────────────────────────────────────────

function makeSignal(
  overrides: Partial<NotificationSignal> = {},
): NotificationSignal {
  return {
    signalId: "sig-test-1",
    createdAt: 1700000000000,
    sourceChannel: "scheduler",
    sourceContextId: "ctx-1",
    sourceEventName: "user.send_notification",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeDecision(
  overrides: Partial<NotificationDecision> = {},
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "test",
    renderedCopy: {},
    dedupeKey: "dk-1",
    confidence: 1,
    fallbackUsed: false,
    persistedDecisionId: "dec-1",
    ...overrides,
  };
}

interface CapturedSend {
  payload: ChannelDeliveryPayload;
  destination: ChannelDestination;
}

function makeCapturingAdapter(channel: "vellum" | "platform"): {
  adapter: ChannelAdapter;
  sends: CapturedSend[];
} {
  const sends: CapturedSend[] = [];
  const adapter: ChannelAdapter = {
    channel,
    async send(
      payload: ChannelDeliveryPayload,
      destination: ChannelDestination,
    ): Promise<DeliveryResult> {
      sends.push({ payload, destination });
      return { success: true };
    },
  };
  return { adapter, sends };
}

beforeEach(() => {
  composeFallbackReturn = {};
  knownConversations = new Set();
});

// ── Tests ───────────────────────────────────────────────────────────────

describe("NotificationBroadcaster last-resort copy resolution", () => {
  test(
    "skips channel and does not leak raw event name when both decision " +
      "copy and fallback composer return no usable copy",
    async () => {
      // Fallback composer returns nothing for the channel — the formerly
      // leaky `??` branch in broadcaster.ts would synthesize
      // `{ title: "Notification", body: signal.sourceEventName }`.
      composeFallbackReturn = {};

      const { adapter, sends } = makeCapturingAdapter("vellum");
      const broadcaster = new NotificationBroadcaster([adapter]);

      const signal = makeSignal();
      const decision = makeDecision({ renderedCopy: {} });

      const results = await broadcaster.broadcastDecision(signal, decision);

      // Adapter must NOT receive a payload at all — the channel is skipped
      // before the adapter is invoked, so the leak path cannot fire.
      expect(sends.length).toBe(0);

      expect(results.length).toBe(1);
      expect(results[0]?.status).toBe("skipped");
      expect(results[0]?.errorMessage).toContain("rendered copy");
    },
  );

  test("skips channel when fallback composer returns an entry with an empty body", async () => {
    // `composeFallbackCopy` can produce empty bodies via `buildGenericCopy`
    // when no template matches the source event. The broadcaster must
    // refuse to deliver empty-body copy rather than passing it through.
    composeFallbackReturn = {
      vellum: { title: "Notification", body: "" },
    };

    const { adapter, sends } = makeCapturingAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([adapter]);

    const signal = makeSignal();
    const decision = makeDecision({ renderedCopy: {} });

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(sends.length).toBe(0);
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("skipped");
  });

  test("delivers normally when fallback composer returns a usable body", async () => {
    composeFallbackReturn = {
      vellum: { title: "Reminder", body: "Time to drink water" },
    };

    const { adapter, sends } = makeCapturingAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([adapter]);

    const signal = makeSignal();
    const decision = makeDecision({ renderedCopy: {} });

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(sends.length).toBe(1);
    expect(sends[0]?.payload.copy.body).toBe("Time to drink water");
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("sent");
  });
});

describe("NotificationBroadcaster platform deep-link from contextPayload", () => {
  test("uses deepLinkConversationId from contextPayload when no pairing exists", async () => {
    composeFallbackReturn = {
      platform: { title: "Reminder", body: "Check the oven" },
    };

    knownConversations = new Set(["conv-origin-1"]);

    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    const signal = makeSignal({
      sourceContextId: "schedule-job-1",
      contextPayload: { deepLinkConversationId: "conv-origin-1" },
    });
    const decision = makeDecision({
      selectedChannels: ["platform"],
      renderedCopy: {},
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(sends.length).toBe(1);
    expect(sends[0]?.payload.deepLinkTarget).toEqual({
      conversationId: "conv-origin-1",
    });
  });

  test("does not use deepLinkConversationId when it does not resolve to a real conversation", async () => {
    composeFallbackReturn = {
      platform: { title: "Reminder", body: "Check the oven" },
    };

    // conv-stale is NOT in knownConversations
    knownConversations = new Set();

    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    const signal = makeSignal({
      sourceContextId: "schedule-job-1",
      contextPayload: { deepLinkConversationId: "conv-stale" },
    });
    const decision = makeDecision({
      selectedChannels: ["platform"],
      renderedCopy: {},
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(sends.length).toBe(1);
    expect(sends[0]?.payload.deepLinkTarget).toBeUndefined();
  });

  test("omits deepLinkConversationId when not present in contextPayload", async () => {
    composeFallbackReturn = {
      platform: { title: "Reminder", body: "Check the oven" },
    };

    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    const signal = makeSignal({
      sourceContextId: "schedule-job-1",
      contextPayload: {},
    });
    const decision = makeDecision({
      selectedChannels: ["platform"],
      renderedCopy: {},
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(sends.length).toBe(1);
    expect(sends[0]?.payload.deepLinkTarget).toBeUndefined();
  });
});

// The card context is built once per broadcast (adapters render only); an
// answer-mode pending_question with structured options renders them as
// tappable card actions in the answer-token scheme the reply router
// recognizes.
describe("NotificationBroadcaster question option actions", () => {
  function questionSignal(payload: Record<string, unknown>) {
    return makeSignal({
      sourceEventName: "guardian.question",
      contextPayload: payload,
    });
  }

  const decisionForPlatform = () =>
    makeDecision({
      selectedChannels: ["platform"],
      renderedCopy: { platform: { title: "Question", body: "Which fruit?" } },
    });

  test("renders pending_question options as answer-token actions plus Skip", async () => {
    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    await broadcaster.broadcastDecision(
      questionSignal({
        requestKind: "pending_question",
        requestId: "req-q1",
        requestCode: "abc123",
        questionText: "Which fruit?",
        options: [
          { id: "apple", label: "Apple" },
          { id: "banana", label: "Banana" },
        ],
      }),
      decisionForPlatform(),
    );

    expect(sends.length).toBe(1);
    const approval = sends[0]?.payload.approvalContext;
    expect(approval?.requestId).toBe("req-q1");
    expect(approval?.actions).toEqual([
      { id: "answer_0", label: "Apple" },
      { id: "answer_1", label: "Banana" },
      { id: "answer_skip", label: "Skip" },
    ]);
    // The plain-text fallback keeps the answer-mode request-code instruction.
    expect(approval?.plainTextFallback).toContain("ABC123");
    expect(approval?.plainTextFallback).toContain("your answer");
  });

  test("an option-less pending_question (voice) carries no card actions", async () => {
    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    await broadcaster.broadcastDecision(
      questionSignal({
        requestKind: "pending_question",
        requestId: "req-v1",
        requestCode: "def456",
        questionText: "What time works?",
        callSessionId: "call-1",
        activeGuardianRequestCount: 1,
      }),
      decisionForPlatform(),
    );

    expect(sends.length).toBe(1);
    // Answer-mode without options renders as plain text with request-code
    // instructions — no approve/reject pair is ever attached to a question.
    expect(sends[0]?.payload.approvalContext).toBeUndefined();
  });

  test("tool_approval payloads keep the approve/reject action pair", async () => {
    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    await broadcaster.broadcastDecision(
      questionSignal({
        requestKind: "tool_approval",
        requestId: "req-t1",
        requestCode: "ghi789",
        questionText: "Approve tool: bash",
        toolName: "bash",
      }),
      decisionForPlatform(),
    );

    expect(sends.length).toBe(1);
    const approval = sends[0]?.payload.approvalContext;
    expect(approval?.actions?.map((a) => a.id)).toEqual([
      "approve_once",
      "reject",
    ]);
  });
});
