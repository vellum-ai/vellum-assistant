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

mock.module("../destination-resolver.js", () => ({
  resolveDestinations: (channels: string[]) => {
    const map = new Map<string, ChannelDestination>();
    for (const ch of channels) {
      map.set(ch, { channel: ch as ChannelDestination["channel"] });
    }
    return map;
  },
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

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
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

function makeCapturingAdapter(channel: "vellum"): {
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
