/**
 * Verifies that `emitNotificationSignal` invokes the home-feed side
 * effect after dispatching, and that the side effect's background-only
 * filter correctly suppresses interactive signals.
 *
 * The side effect itself is unit-tested in `home-feed-side-effect.test.ts`;
 * this test exercises the wire-up boundary in `emit-signal.ts` by mocking
 * at the `appendFeedItem` / `getConversation` boundary so the real
 * background-filter logic runs end-to-end.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { FeedItem } from "../../home/feed-types.js";
import type {
  NotificationDecision,
  NotificationDeliveryResult,
} from "../types.js";

// ── Module mocks ───────────────────────────────────────────────────────
//
// `mock.module` is hoisted, so these intercepts apply before the module
// under test resolves its imports. Closures over module-scoped state
// let each test reset and inspect captured calls afterwards.

const appendCalls: FeedItem[] = [];
let conversationRow: { conversationType: string } | null = null;

mock.module("../../home/feed-writer.js", () => ({
  appendFeedItem: async (item: FeedItem) => {
    appendCalls.push(item);
  },
}));

// home-feed-side-effect.ts only consumes `getConversation`.
mock.module("../../memory/conversation-crud.js", () => ({
  getConversation: () => conversationRow,
}));

// Stub the broadcaster so emit-signal's `getBroadcaster()` does not need
// to build real adapters or pull in `conversation-pairing.ts` transitively
// (which would force us to mirror the full `conversation-crud.js` surface).
class StubBroadcaster {
  setOnConversationCreated() {}
  async broadcastDecision() {
    return [];
  }
}
mock.module("../broadcaster.js", () => ({
  NotificationBroadcaster: StubBroadcaster,
}));

mock.module("../adapters/macos.js", () => ({
  VellumAdapter: class {},
}));
mock.module("../adapters/slack.js", () => ({
  SlackAdapter: class {},
}));
mock.module("../adapters/telegram.js", () => ({
  TelegramAdapter: class {},
}));

// Stub out the persistence + channel resolution layers so emitNotificationSignal
// can run end-to-end without touching the DB / contacts store / LLM.

mock.module("../events-store.js", () => ({
  createEvent: (params: { id: string }) => ({
    id: params.id,
    sourceEventName: "schedule.notify",
    sourceChannel: "scheduler",
    sourceContextId: "conv-source-1",
    attentionHintsJson: "{}",
    payloadJson: "{}",
    dedupeKey: null,
    createdAt: 0,
    updatedAt: 0,
  }),
  updateEventDedupeKey: () => {},
}));

mock.module("../decisions-store.js", () => ({
  updateDecision: () => {},
}));

mock.module("../../contacts/contact-store.js", () => ({
  findGuardianForChannel: () => null,
  listGuardianChannels: () => [],
}));

const stubDecision: NotificationDecision = {
  shouldNotify: true,
  selectedChannels: ["vellum"],
  reasoningSummary: "test",
  renderedCopy: {
    vellum: { title: "Background job done", body: "Summary of what happened." },
  },
  dedupeKey: "dk-1",
  confidence: 1,
  fallbackUsed: false,
};

mock.module("../decision-engine.js", () => ({
  evaluateSignal: async () => stubDecision,
  // Pass the decision through unchanged — emit-signal calls this after
  // evaluateSignal and only re-persists when the reference changes.
  enforceRoutingIntent: (decision: NotificationDecision) => decision,
}));

mock.module("../deterministic-checks.js", () => ({
  runDeterministicChecks: async () => ({ passed: true }),
}));

const stubDeliveryResults: NotificationDeliveryResult[] = [
  {
    channel: "vellum",
    destination: "vellum-client",
    status: "sent",
    conversationId: "conv-vellum-1",
  },
];

mock.module("../runtime-dispatch.js", () => ({
  dispatchDecision: async () => ({
    dispatched: true,
    reason: "Dispatched to 1/1 channels",
    deliveryResults: stubDeliveryResults,
  }),
}));

const { emitNotificationSignal } = await import("../emit-signal.js");

// ── Tests ──────────────────────────────────────────────────────────────

beforeEach(() => {
  appendCalls.length = 0;
  conversationRow = null;
});

describe("emitNotificationSignal home-feed wire-up", () => {
  test("background-conversation signal triggers appendFeedItem", async () => {
    conversationRow = { conversationType: "background" };

    const result = await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "conv-source-1",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });

    expect(result.dispatched).toBe(true);
    expect(appendCalls).toHaveLength(1);
    const appended = appendCalls[0]!;
    expect(appended.id).toBe(`notif:${result.signalId}`);
    expect(appended.title).toBe("Background job done");
    expect(appended.summary).toBe("Summary of what happened.");
    expect(appended.conversationId).toBe("conv-vellum-1");
  });

  test("interactive standard conversation does NOT trigger appendFeedItem", async () => {
    conversationRow = { conversationType: "standard" };

    const result = await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "conv-source-1",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: true,
      },
    });

    expect(result.dispatched).toBe(true);
    expect(appendCalls).toHaveLength(0);
  });
});
