/**
 * Verifies the NotificationBroadcaster's fail-closed copy-resolution
 * invariant: when neither `decision.renderedCopy[channel]` nor
 * `composeFallbackCopy(...)[channel]` produces usable copy, the channel
 * must be dropped rather than delivered with a synthesized body.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { PairingResult } from "../conversation-pairing.js";
import type { NotificationSignal } from "../signal.js";
import type {
  ChannelAdapter,
  ChannelDeliveryObserver,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  DestinationBindingContext,
  NotificationChannel,
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

function defaultPairing(): PairingResult {
  return {
    conversationId: null,
    messageId: null,
    strategy: "start_new_conversation",
    createdNewConversation: false,
    conversationFallbackUsed: false,
  };
}

let pairingByChannel: Record<string, PairingResult> = {};
let pairingErrorByChannel: Record<string, Error> = {};

mock.module("../conversation-pairing.js", () => ({
  pairDeliveryWithConversation: async (_signal: unknown, channel: string) => {
    const error = pairingErrorByChannel[channel];
    if (error) {
      throw error;
    }
    return pairingByChannel[channel] ?? defaultPairing();
  },
}));

// Status writes are inert by default; tests that need a failing store swap
// the implementation in, and tests that need the patch read it.
let updateDeliveryStatusImpl: (
  status: string,
  patch?: { messageId?: string; canonicalMessageId?: string },
) => void = () => {};

mock.module("../deliveries-store.js", () => ({
  createDelivery: () => {},
  updateDeliveryStatus: (
    _deliveryId: string,
    status: string,
    _error?: unknown,
    patch?: { messageId?: string; canonicalMessageId?: string },
  ) => updateDeliveryStatusImpl(status, patch),
  findDeliveryByDecisionAndChannel: () => undefined,
}));

// The post-acknowledgement row write is observed, never performed: the
// broadcaster's contract is when it calls this and with what.
let recordedPosts: Array<Record<string, unknown>> = [];
let recordDeliveredChannelPostImpl: (
  post: Record<string, unknown>,
) => Promise<{ messageId: string }> = async () => ({ messageId: "row-1" });

mock.module("../delivered-post-record.js", () => ({
  recordDeliveredChannelPost: async (post: Record<string, unknown>) => {
    recordedPosts.push(post);
    return recordDeliveredChannelPostImpl(post);
  },
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
// without needing guardian-delivery data. A channel listed in
// `destinationBindingContexts` gets that binding context, as a resolved
// external chat would.
let destinationBindingContexts: Record<string, DestinationBindingContext> = {};
mock.module("../destination-resolver.js", () => ({
  resolveDestinations: (channels: readonly string[], _guardians: unknown) => {
    const map = new Map();
    for (const ch of channels) {
      const bindingContext = destinationBindingContexts[ch];
      map.set(ch, {
        channel: ch,
        endpoint: bindingContext?.externalChatId ?? ch,
        metadata: {},
        ...(bindingContext ? { bindingContext } : {}),
      });
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

function makeCapturingAdapter(
  channel: NotificationChannel,
  result: DeliveryResult = { success: true },
): {
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
      return result;
    },
  };
  return { adapter, sends };
}

beforeEach(() => {
  composeFallbackReturn = {};
  knownConversations = new Set();
  pairingByChannel = {};
  pairingErrorByChannel = {};
  updateDeliveryStatusImpl = () => {};
  destinationBindingContexts = {};
  recordedPosts = [];
  recordDeliveredChannelPostImpl = async () => ({ messageId: "row-1" });
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

describe("NotificationBroadcaster delivery status recording", () => {
  test("a successful send is recorded as sent even when its status write throws", async () => {
    // The results array is what `emitNotificationSignal` reads to decide
    // whether a retry would re-deliver. Reporting a real send as failed
    // releases the signal's dedupe claim, so the retry sends this message a
    // second time. The lost status write only costs the delivery row.
    composeFallbackReturn = {
      vellum: { title: "Reminder", body: "Time to drink water" },
    };
    updateDeliveryStatusImpl = (status: string) => {
      if (status === "sent") {
        throw new Error("deliveries store is locked");
      }
    };

    const { adapter, sends } = makeCapturingAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([adapter]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      makeDecision({ renderedCopy: {} }),
    );

    expect(sends.length).toBe(1);
    expect(results.length).toBe(1);
    expect(results[0]?.status).toBe("sent");
    expect(results[0]?.errorMessage).toBeUndefined();
  });
});

describe("NotificationBroadcaster records a channel delivery after acknowledgement", () => {
  const slackHome: PairingResult = {
    conversationId: "conv-home",
    messageId: null,
    strategy: "continue_existing_conversation",
    createdNewConversation: false,
    conversationFallbackUsed: false,
  };

  test("a successful Slack send is recorded with the channel's message id, and the audit names the row", async () => {
    composeFallbackReturn = {
      slack: { title: "Check-in", body: "Two items need your eyes today." },
    };
    pairingByChannel = { slack: slackHome };
    destinationBindingContexts = {
      slack: { sourceChannel: "slack", externalChatId: "D0123456789" },
    };
    const patches: Array<{
      status: string;
      patch?: { messageId?: string; canonicalMessageId?: string };
    }> = [];
    updateDeliveryStatusImpl = (status, patch) => {
      patches.push({ status, patch });
    };

    const { adapter, sends } = makeCapturingAdapter("slack", {
      success: true,
      messageId: "1756800000.000100",
    });
    const broadcaster = new NotificationBroadcaster([adapter]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      makeDecision({ selectedChannels: ["slack"], renderedCopy: {} }),
    );

    expect(sends.length).toBe(1);
    expect(results[0]?.status).toBe("sent");
    expect(recordedPosts).toHaveLength(1);
    expect(recordedPosts[0]).toEqual({
      conversationId: "conv-home",
      channel: "slack",
      externalChatId: "D0123456789",
      text: "Two items need your eyes today.",
      providerMessageId: "1756800000.000100",
    });
    const sent = patches.find((p) => p.status === "sent");
    expect(sent?.patch).toEqual({
      messageId: "1756800000.000100",
      canonicalMessageId: "row-1",
    });
  });

  test("a failed Slack send records nothing", async () => {
    composeFallbackReturn = {
      slack: { title: "Check-in", body: "Two items need your eyes today." },
    };
    pairingByChannel = { slack: slackHome };
    destinationBindingContexts = {
      slack: { sourceChannel: "slack", externalChatId: "D0123456789" },
    };

    const { adapter } = makeCapturingAdapter("slack", {
      success: false,
      error: "channel_not_found",
    });
    const broadcaster = new NotificationBroadcaster([adapter]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      makeDecision({ selectedChannels: ["slack"], renderedCopy: {} }),
    );

    expect(results[0]?.status).toBe("failed");
    expect(recordedPosts).toHaveLength(0);
  });

  test("a successful send whose row write fails still reads as sent, without a row reference", async () => {
    composeFallbackReturn = {
      slack: { title: "Check-in", body: "Two items need your eyes today." },
    };
    pairingByChannel = { slack: slackHome };
    destinationBindingContexts = {
      slack: { sourceChannel: "slack", externalChatId: "D0123456789" },
    };
    recordDeliveredChannelPostImpl = async () => {
      throw new Error("messages table is locked");
    };
    const patches: Array<{
      status: string;
      patch?: { messageId?: string; canonicalMessageId?: string };
    }> = [];
    updateDeliveryStatusImpl = (status, patch) => {
      patches.push({ status, patch });
    };

    const { adapter } = makeCapturingAdapter("slack", {
      success: true,
      messageId: "1756800000.000100",
    });
    const broadcaster = new NotificationBroadcaster([adapter]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      makeDecision({ selectedChannels: ["slack"], renderedCopy: {} }),
    );

    expect(results[0]?.status).toBe("sent");
    const sent = patches.find((p) => p.status === "sent");
    expect(sent?.patch).toEqual({ messageId: "1756800000.000100" });
  });

  test("a vellum delivery is not recorded through this path", async () => {
    composeFallbackReturn = {
      vellum: { title: "Reminder", body: "Time to drink water" },
    };

    const { adapter } = makeCapturingAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([adapter]);

    await broadcaster.broadcastDecision(
      makeSignal(),
      makeDecision({ renderedCopy: {} }),
    );

    expect(recordedPosts).toHaveLength(0);
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

describe("NotificationBroadcaster remotePushDispatched flag", () => {
  const bothChannelsCopy = () => {
    composeFallbackReturn = {
      vellum: { title: "Reminder", body: "Hello" },
      platform: { title: "Reminder", body: "Hello" },
    };
  };

  const bothChannelsDecision = () =>
    makeDecision({
      selectedChannels: ["vellum", "platform"],
      renderedCopy: {},
    });

  test("vellum payload carries true when the platform adapter reports an accepted push; platform payload omits it", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: true,
      remotePushAccepted: true,
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(true);
    expect(platform.sends.length).toBe(1);
    expect(platform.sends[0]?.payload.correlationId).toBe(
      vellum.sends[0]?.payload.correlationId,
    );
    expect(platform.sends[0]?.payload.remotePushDispatched).toBeUndefined();
  });

  test("vellum payload carries false when the platform dispatch fails", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: false,
      error: "HTTP 503",
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
  });

  test("vellum payload carries platforms accepted before a partial failure", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: false,
      error: "FCM failed",
      remotePushPlatforms: ["ios"],
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(vellum.sends[0]?.payload.remotePushPlatforms).toEqual(["ios"]);
  });

  test("vellum payload carries false when the platform reports no accepted push (skipped or zero tokens)", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: true,
      remotePushAccepted: false,
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
  });

  test("vellum payload carries false when the platform result omits remotePushAccepted", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", { success: true });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
  });

  test("vellum payload carries false when the platform adapter throws", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform: ChannelAdapter = {
      channel: "platform",
      async send(): Promise<DeliveryResult> {
        throw new Error("boom");
      },
    };
    const broadcaster = new NotificationBroadcaster([vellum.adapter, platform]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      bothChannelsDecision(),
    );

    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
    expect(results.find((r) => r.channel === "platform")?.status).toBe(
      "failed",
    );
    expect(results.find((r) => r.channel === "vellum")?.status).toBe("sent");
  });

  test("vellum intent still flushes with false when the platform channel's prep throws", async () => {
    bothChannelsCopy();
    pairingErrorByChannel = { platform: new Error("pairing exploded") };

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: true,
      remotePushAccepted: true,
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await expect(
      broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision()),
    ).rejects.toThrow("pairing exploded");

    // The platform adapter never ran, but the deferred vellum send must not
    // be lost -- its pending delivery row would block retries forever.
    expect(platform.sends.length).toBe(0);
    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
  });

  test("deadline expiry flushes vellum with false while the platform dispatch finishes in the background", async () => {
    bothChannelsCopy();

    let resolvePlatform: ((result: DeliveryResult) => void) | undefined;
    const platformSends: CapturedSend[] = [];
    const platform: ChannelAdapter = {
      channel: "platform",
      send(
        payload: ChannelDeliveryPayload,
        destination: ChannelDestination,
        observer?: ChannelDeliveryObserver,
      ): Promise<DeliveryResult> {
        platformSends.push({ payload, destination });
        observer?.onRemotePushPlatforms(["ios"]);
        return new Promise<DeliveryResult>((resolve) => {
          resolvePlatform = resolve;
        });
      },
    };
    const vellum = makeCapturingAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellum.adapter, platform]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      bothChannelsDecision(),
      { platformOutcomeDeadlineMs: 20 },
    );

    expect(platformSends.length).toBe(1);
    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
    expect(vellum.sends[0]?.payload.remotePushPlatforms).toEqual(["ios"]);
    expect(results.find((r) => r.channel === "platform")?.status).toBe(
      "pending",
    );

    // The dispatch settling after the deadline must not re-send vellum.
    resolvePlatform?.({ success: true, remotePushAccepted: true });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(false);
  });

  test("platform completing before the deadline sets the real outcome on the vellum payload", async () => {
    bothChannelsCopy();

    const vellum = makeCapturingAdapter("vellum");
    const platform: ChannelAdapter = {
      channel: "platform",
      async send(): Promise<DeliveryResult> {
        await new Promise((resolve) => setTimeout(resolve, 5));
        return { success: true, remotePushAccepted: true };
      },
    };
    const broadcaster = new NotificationBroadcaster([vellum.adapter, platform]);

    const results = await broadcaster.broadcastDecision(
      makeSignal(),
      bothChannelsDecision(),
      { platformOutcomeDeadlineMs: 1_000 },
    );

    expect(vellum.sends.length).toBe(1);
    expect(vellum.sends[0]?.payload.remotePushDispatched).toBe(true);
    expect(results.find((r) => r.channel === "platform")?.status).toBe("sent");
  });

  test("dispatches the platform adapter before the vellum intent when both are selected", async () => {
    bothChannelsCopy();

    const callOrder: string[] = [];
    const vellum: ChannelAdapter = {
      channel: "vellum",
      async send(): Promise<DeliveryResult> {
        callOrder.push("vellum");
        return { success: true };
      },
    };
    const platform: ChannelAdapter = {
      channel: "platform",
      async send(): Promise<DeliveryResult> {
        callOrder.push("platform");
        return { success: true, remotePushAccepted: true };
      },
    };
    const broadcaster = new NotificationBroadcaster([vellum, platform]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(callOrder).toEqual(["platform", "vellum"]);
  });

  test("platform deep link still carries the vellum pairing when the vellum send is deferred", async () => {
    bothChannelsCopy();

    pairingByChannel = {
      vellum: {
        conversationId: "conv-vellum-1",
        messageId: "msg-1",
        strategy: "start_new_conversation",
        createdNewConversation: false,
        conversationFallbackUsed: false,
      },
    };

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: true,
      remotePushAccepted: true,
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(makeSignal(), bothChannelsDecision());

    expect(platform.sends.length).toBe(1);
    expect(platform.sends[0]?.payload.deepLinkTarget).toEqual({
      conversationId: "conv-vellum-1",
      messageId: "msg-1",
    });
  });
});

describe("NotificationBroadcaster forced-platform copy reuse", () => {
  test("platform payload reuses the vellum rendered copy instead of template fallback", async () => {
    // A urgency-forced platform channel has no rendered copy of its own; the
    // template fallback must lose to the vellum channel's rendered copy.
    composeFallbackReturn = {
      platform: { title: "Template title", body: "Template body" },
    };

    const vellum = makeCapturingAdapter("vellum");
    const platform = makeCapturingAdapter("platform", {
      success: true,
      remotePushAccepted: true,
    });
    const broadcaster = new NotificationBroadcaster([
      vellum.adapter,
      platform.adapter,
    ]);

    await broadcaster.broadcastDecision(
      makeSignal(),
      makeDecision({
        selectedChannels: ["vellum", "platform"],
        renderedCopy: {
          vellum: { title: "Rendered title", body: "Rendered body" },
        },
      }),
    );

    expect(platform.sends.length).toBe(1);
    expect(platform.sends[0]?.payload.copy.title).toBe("Rendered title");
    expect(platform.sends[0]?.payload.copy.body).toBe("Rendered body");
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

  test("an option-less pending_question (voice) carries the typed-reply instruction and no actions", async () => {
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
    // No buttons to draw, so the transports send text and append the
    // instruction; an approve/reject pair is never attached to a question.
    const approval = sends[0]?.payload.approvalContext;
    expect(approval?.requestId).toBe("req-v1");
    expect(approval?.actions).toEqual([]);
    expect(approval?.intent).toBe("question");
    expect(approval?.plainTextFallback).toBe(
      'Reference code: DEF456. Reply "DEF456 <your answer>".',
    );
  });

  test("a coded question that fails strict parsing still carries its typed-reply instruction", async () => {
    const { adapter, sends } = makeCapturingAdapter("platform");
    const broadcaster = new NotificationBroadcaster([adapter]);

    await broadcaster.broadcastDecision(
      questionSignal({
        requestKind: "pending_question",
        requestId: "req-lenient-1",
        requestCode: "abc999",
        // A null requester id fails the strict schema (string | undefined).
        requesterExternalUserId: null,
        questionText: "What time works?",
      }),
      decisionForPlatform(),
    );

    expect(sends.length).toBe(1);
    const approval = sends[0]?.payload.approvalContext;
    expect(approval?.requestId).toBe("req-lenient-1");
    expect(approval?.actions).toEqual([]);
    expect(approval?.plainTextFallback).toBe(
      'Reference code: ABC999. Reply "ABC999 <your answer>".',
    );
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
