/**
 * Tests for the pass-through paths in the notification decision engine. When a
 * producer hands us a verbatim message via contextPayload.requestedMessage, the
 * engine must skip the LLM call entirely and use the copy as-is.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports from mocked modules) ──────────────────

mock.module("../../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum", "telegram", "platform"],
}));

let persistedDecisions: Array<Record<string, unknown>> = [];

mock.module("../decisions-store.js", () => ({
  createDecision: (row: Record<string, unknown>) => {
    persistedDecisions.push(row);
  },
}));

mock.module("../preference-summary.js", () => ({
  getPreferenceSummary: () => undefined,
}));

mock.module("../conversation-candidates.js", () => ({
  buildConversationCandidates: () => undefined,
  serializeCandidatesForPrompt: () => undefined,
}));

mock.module("../../prompts/persona-resolver.js", () => ({
  resolveGuardianPersona: () => null,
}));

mock.module("../../prompts/system-prompt.js", () => ({
  buildCoreIdentityContext: () => null,
}));

// Guardian binding (ACL) is resolved via the gateway pull; notes (INFO) are
// joined locally by contactId. Tests drive both via mutable slots.
let guardianDeliveryFixture: Array<{ contactId: string }> = [];
let contactInfoFixture: Record<string, { notes: string | null } | null> = {};

mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => guardianDeliveryFixture,
  anyGuardian: (list: Array<{ contactId: string }>) => list[0],
}));

mock.module("../../contacts/contact-store.js", () => ({
  findContactInfoById: (contactId: string) =>
    contactInfoFixture[contactId] ?? null,
}));

// Provider mock. By default `sendMessage` throws so the pass-through paths
// (which must skip the LLM) fail loudly if they reach the provider. LLM-path
// tests override `providerSendMessage` to capture inputs.
let providerSendMessage: (
  messages: unknown[],
  opts: { systemPrompt?: string },
) => Promise<unknown> = () => {
  throw new Error(
    "provider.sendMessage should NOT be invoked for pass-through decisions",
  );
};

mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({
    sendMessage: (messages: unknown[], opts: { systemPrompt?: string }) =>
      providerSendMessage(messages, opts),
  }),
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => null,
  userMessage: (text: string) => ({ role: "user", content: text }),
}));

// ── Imports (after all mocks) ─────────────────────────────────────────

import { enforceRoutingIntent, evaluateSignal } from "../decision-engine.js";
import type { NotificationSignal } from "../signal.js";
import type { NotificationChannel } from "../types.js";

// ── Helpers ───────────────────────────────────────────────────────────

function makeAssistantToolSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-assistant-tool-test-1",
    createdAt: Date.now(),
    sourceChannel: "assistant_tool",
    sourceContextId: "tool-call-1",
    sourceEventName: "user.send_notification",
    contextPayload: {
      requestedMessage: "exact verbatim text here",
      requestedTitle: "Custom Title",
    },
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeAssistantReplySignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-assistant-reply-test-1",
    createdAt: Date.now(),
    sourceChannel: "vellum",
    sourceContextId: "conv-1",
    sourceEventName: "chat.assistant_reply",
    contextPayload: {
      requestedMessage: "Here is your answer.",
      requestedTitle: "Assistant",
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("assistant_tool pass-through in notification decision engine", () => {
  test("uses producer-supplied title and body verbatim, no LLM call", async () => {
    const signal = makeAssistantToolSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.selectedChannels).toContain("vellum");
    expect(decision.renderedCopy.vellum?.body).toBe("exact verbatim text here");
    expect(decision.renderedCopy.vellum?.title).toBe("Custom Title");
    expect(decision.conversationActions?.vellum?.action).toBe("start_new");
    expect(decision.reasoningSummary).toBe("assistant_tool pass-through");
    expect(decision.verbatimCopy).toBe(true);
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.confidence).toBe(1.0);
    expect(decision.dedupeKey).toBe(signal.signalId);
  });

  // `notify --dedupe-key` reaches the signal, so the decision has to carry it
  // through; falling back to the per-emit signal id would collapse nothing.
  test("uses the producer-supplied dedupeKey", async () => {
    const signal = makeAssistantToolSignal({
      dedupeKey: "deploy-status:prod",
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.dedupeKey).toBe("deploy-status:prod");
  });

  test("derives title from body when requestedTitle is not supplied", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "First sentence. Second sentence follows here.",
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.renderedCopy.vellum?.body).toBe(
      "First sentence. Second sentence follows here.",
    );
    expect(decision.renderedCopy.vellum?.title).toBe("First sentence.");
    expect(decision.reasoningSummary).toBe("assistant_tool pass-through");
  });

  test("critical urgency selects all available channels", async () => {
    const signal = makeAssistantToolSignal({
      attentionHints: {
        requiresAction: true,
        urgency: "critical",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });
    const availableChannels = ["vellum", "telegram"] as NotificationChannel[];
    const decision = await evaluateSignal(signal, availableChannels);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.selectedChannels).toEqual(
      expect.arrayContaining(availableChannels),
    );
    expect(decision.selectedChannels.length).toBe(availableChannels.length);
    expect(decision.renderedCopy.vellum?.body).toBe("exact verbatim text here");
    expect(decision.renderedCopy.telegram?.body).toBe(
      "exact verbatim text here",
    );
    expect(decision.conversationActions?.vellum?.action).toBe("start_new");
    expect(decision.conversationActions?.telegram?.action).toBe("start_new");
  });

  test("threads contextPayload.deepLinkMetadata through to decision.deepLinkTarget", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "with deep link",
        deepLinkMetadata: { route: "settings", anchor: "notifications" },
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.deepLinkTarget).toEqual({
      route: "settings",
      anchor: "notifications",
    });
  });

  test("omits deepLinkTarget when deepLinkMetadata is not a plain object", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "no deep link",
        deepLinkMetadata: ["not", "a", "plain", "object"],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.deepLinkTarget).toBeUndefined();
  });

  test("preferredChannels adds to the default channel set (additive, not replacement)", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "also push to telegram",
        preferredChannels: ["telegram"],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    // Vellum (canonical inbox) stays in selectedChannels; telegram is
    // added on top. `--preferred-channels` is additive push, never a
    // replacement for the inbox.
    expect(decision.selectedChannels).toContain("vellum");
    expect(decision.selectedChannels).toContain("telegram");
    expect(decision.selectedChannels.length).toBe(2);
    expect(decision.renderedCopy.vellum?.body).toBe("also push to telegram");
    expect(decision.renderedCopy.telegram?.body).toBe("also push to telegram");
  });

  test("urgent + preferredChannels keeps urgent's full broadcast intact", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "urgent broadcast",
        requestedTitle: "Heads up",
        preferredChannels: ["telegram"],
      },
      attentionHints: {
        requiresAction: true,
        urgency: "critical",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });
    const available = ["vellum", "telegram", "slack"] as NotificationChannel[];
    const decision = await evaluateSignal(signal, available);

    // Urgent broadcasts to every available channel; the additive union
    // with preferredChannels is idempotent (telegram already included).
    expect(decision.selectedChannels).toEqual(
      expect.arrayContaining(available),
    );
    expect(decision.selectedChannels.length).toBe(available.length);
    for (const ch of available) {
      expect(decision.renderedCopy[ch]?.body).toBe("urgent broadcast");
      expect(decision.renderedCopy[ch]?.title).toBe("Heads up");
    }
  });

  test("routing-intent expansion to all_channels preserves verbatim copy on added channels", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "verbatim broadcast body",
        requestedTitle: "verbatim broadcast title",
      },
      routingIntent: "all_channels",
    });
    const connected = ["vellum", "telegram"] as NotificationChannel[];
    const decision = await evaluateSignal(signal, connected);
    const enforced = enforceRoutingIntent(
      decision,
      "all_channels",
      connected,
      "assistant_tool",
    );

    expect(enforced.selectedChannels).toEqual(
      expect.arrayContaining(["vellum", "telegram"]),
    );
    for (const ch of enforced.selectedChannels) {
      expect(enforced.renderedCopy[ch]?.body).toBe("verbatim broadcast body");
      expect(enforced.renderedCopy[ch]?.title).toBe("verbatim broadcast title");
    }
  });

  test("preferredChannels falls back to default channel set when no overlap with availableChannels", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "fyi",
        preferredChannels: ["disconnected_channel"],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["vellum"]);
    expect(decision.renderedCopy.vellum?.body).toBe("fyi");
  });
});

describe("chat.assistant_reply pass-through in notification decision engine", () => {
  beforeEach(() => {
    persistedDecisions = [];
  });

  test("uses producer-supplied title and body verbatim, no LLM call", async () => {
    const signal = makeAssistantReplySignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
      "platform",
    ] as NotificationChannel[]);

    expect(decision.shouldNotify).toBe(true);
    expect(decision.renderedCopy.platform?.body).toBe("Here is your answer.");
    expect(decision.renderedCopy.platform?.title).toBe("Assistant");
    expect(decision.reasoningSummary).toBe("assistant_reply pass-through");
    expect(decision.verbatimCopy).toBe(true);
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.confidence).toBe(1.0);
  });

  test("selects exactly the platform channel when platform is available", async () => {
    const decision = await evaluateSignal(makeAssistantReplySignal(), [
      "vellum",
      "telegram",
      "platform",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["platform"]);
    expect(decision.shouldNotify).toBe(true);
  });

  test("selects nothing and suppresses when platform is unavailable", async () => {
    const decision = await evaluateSignal(makeAssistantReplySignal(), [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual([]);
    expect(decision.shouldNotify).toBe(false);
  });

  test("seeds rendered copy for every available channel, not just the selected one", async () => {
    // A future channel added to ASSISTANT_REPLY_CHANNELS (or appended by a
    // downstream guard) inherits the verbatim copy instead of falling back.
    const available = [
      "vellum",
      "telegram",
      "platform",
    ] as NotificationChannel[];
    const decision = await evaluateSignal(
      makeAssistantReplySignal(),
      available,
    );

    for (const ch of available) {
      expect(decision.renderedCopy[ch]?.body).toBe("Here is your answer.");
      expect(decision.renderedCopy[ch]?.title).toBe("Assistant");
      expect(decision.conversationActions?.[ch]?.action).toBe("start_new");
    }
  });

  test("derives the title from the body when requestedTitle is not supplied", async () => {
    const signal = makeAssistantReplySignal({
      contextPayload: {
        requestedMessage: "First sentence. Second sentence follows here.",
      },
    });
    const decision = await evaluateSignal(signal, [
      "platform",
    ] as NotificationChannel[]);

    expect(decision.renderedCopy.platform?.title).toBe("First sentence.");
  });

  test("uses the producer-supplied dedupeKey", async () => {
    const signal = makeAssistantReplySignal({
      dedupeKey: "chat.assistant_reply:conv-1:msg-1",
    });
    const decision = await evaluateSignal(signal, [
      "platform",
    ] as NotificationChannel[]);

    expect(decision.dedupeKey).toBe("chat.assistant_reply:conv-1:msg-1");
  });

  test("falls back to the signal id when the producer supplies no dedupeKey", async () => {
    const signal = makeAssistantReplySignal();
    const decision = await evaluateSignal(signal, [
      "platform",
    ] as NotificationChannel[]);

    expect(decision.dedupeKey).toBe(signal.signalId);
  });

  test("threads contextPayload.deepLinkMetadata through to decision.deepLinkTarget", async () => {
    const signal = makeAssistantReplySignal({
      contextPayload: {
        requestedMessage: "Here is your answer.",
        deepLinkMetadata: { conversationId: "conv-1" },
      },
    });
    const decision = await evaluateSignal(signal, [
      "platform",
    ] as NotificationChannel[]);

    expect(decision.deepLinkTarget).toEqual({ conversationId: "conv-1" });
  });

  test("persists the decision", async () => {
    const signal = makeAssistantReplySignal();
    const decision = await evaluateSignal(signal, [
      "platform",
    ] as NotificationChannel[]);

    expect(decision.persistedDecisionId).toBeDefined();
    expect(persistedDecisions.length).toBe(1);
    expect(persistedDecisions[0]?.notificationEventId).toBe(signal.signalId);
    expect(persistedDecisions[0]?.reasoningSummary).toBe(
      "assistant_reply pass-through",
    );
  });

  test("an empty body skips the pass-through branch entirely", async () => {
    const signal = makeAssistantReplySignal({
      contextPayload: { requestedMessage: "   ", requestedTitle: "Assistant" },
    });
    const previousSendMessage = providerSendMessage;
    let providerCalled = false;
    providerSendMessage = async () => {
      providerCalled = true;
      return {};
    };

    try {
      const decision = await evaluateSignal(signal, [
        "platform",
      ] as NotificationChannel[]);

      expect(providerCalled).toBe(true);
      expect(decision.verbatimCopy).toBeUndefined();
      expect(decision.reasoningSummary).not.toBe(
        "assistant_reply pass-through",
      );
    } finally {
      providerSendMessage = previousSendMessage;
    }
  });
});

describe("recipient notes injection (ACL from gateway, notes joined locally)", () => {
  function makeLlmSignal(): NotificationSignal {
    return {
      signalId: "sig-llm-notes-1",
      createdAt: Date.now(),
      sourceChannel: "scheduler",
      sourceContextId: "schedule-1",
      sourceEventName: "schedule.notify",
      contextPayload: {},
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    };
  }

  test("injects the guardian's local notes, resolved via the gateway contactId", async () => {
    guardianDeliveryFixture = [{ contactId: "contact-42" }];
    contactInfoFixture = { "contact-42": { notes: "Prefers terse updates." } };

    let capturedSystemPrompt: string | undefined;
    providerSendMessage = async (_messages, opts) => {
      capturedSystemPrompt = opts.systemPrompt;
      return {};
    };

    await evaluateSignal(makeLlmSignal(), ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).toContain("<recipient-context>");
    expect(capturedSystemPrompt).toContain("Prefers terse updates.");
  });

  test("omits recipient context when no guardian is bound", async () => {
    guardianDeliveryFixture = [];
    contactInfoFixture = {};

    let capturedSystemPrompt: string | undefined;
    providerSendMessage = async (_messages, opts) => {
      capturedSystemPrompt = opts.systemPrompt;
      return {};
    };

    await evaluateSignal(makeLlmSignal(), ["vellum"] as NotificationChannel[]);

    expect(capturedSystemPrompt).not.toContain("<recipient-context>");
  });
});
