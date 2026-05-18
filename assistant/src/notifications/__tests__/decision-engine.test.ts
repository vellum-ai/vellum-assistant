/**
 * Tests for the assistant_tool pass-through path in the notification
 * decision engine. When a producer hands us a verbatim message via
 * contextPayload.requestedMessage, the engine must skip the LLM call
 * entirely and use the producer-supplied copy as-is.
 */

import { describe, expect, mock, test } from "bun:test";

// ── Mocks (must precede imports from mocked modules) ──────────────────

mock.module("../../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum", "telegram"],
}));

mock.module("../decisions-store.js", () => ({
  createDecision: () => {},
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

mock.module("../../contacts/contact-store.js", () => ({
  listGuardianChannels: () => null,
}));

// Provider mock — if `getConfiguredProvider` is ever called by the
// assistant_tool pass-through path, this throw makes the test fail
// loudly instead of silently exercising the LLM path.
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => {
    throw new Error(
      "getConfiguredProvider should NOT be invoked for assistant_tool pass-through",
    );
  },
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => null,
  userMessage: (text: string) => ({ role: "user", content: text }),
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
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
    expect(decision.fallbackUsed).toBe(false);
    expect(decision.confidence).toBe(1.0);
    expect(decision.dedupeKey).toBe(signal.signalId);
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
