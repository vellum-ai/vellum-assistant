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

import { evaluateSignal } from "../decision-engine.js";
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
});
