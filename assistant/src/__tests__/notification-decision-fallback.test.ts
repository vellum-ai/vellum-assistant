/**
 * Regression tests for notification decision fallback copy.
 *
 * Ensures fallback decisions still produce human-friendly copy when the
 * decision-model call is unavailable.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum", "telegram", "slack"],
}));

mock.module("../notifications/decisions-store.js", () => ({
  createDecision: () => {},
}));

mock.module("../notifications/preference-summary.js", () => ({
  getPreferenceSummary: () => undefined,
}));

mock.module("../notifications/conversation-candidates.js", () => ({
  buildConversationCandidates: () => undefined,
  serializeCandidatesForPrompt: () => undefined,
}));

mock.module("../prompts/persona-resolver.js", () => ({
  resolveGuardianPersona: () => null,
}));

let configuredProvider: { sendMessage: () => Promise<unknown> } | null = null;
let extractedToolUse: unknown = null;

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => configuredProvider,
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => extractedToolUse,
  userMessage: (text: string) => ({ role: "user", content: text }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { evaluateSignal } from "../notifications/decision-engine.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type { NotificationChannel } from "../notifications/types.js";

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-fallback-guardian-1",
    createdAt: Date.now(),
    sourceChannel: "phone",
    sourceContextId: "call-session-1",
    sourceEventName: "guardian.question",
    contextPayload: {
      questionText: "What is the gate code?",
    },
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

describe("notification decision fallback copy", () => {
  beforeEach(() => {
    configuredProvider = null;
    extractedToolUse = null;
  });

  test("uses human-friendly template copy for guardian.question", async () => {
    const signal = makeSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.title).toBe("Guardian Question");
    expect(decision.renderedCopy.vellum?.body).toBe("What is the gate code?");
    expect(decision.renderedCopy.vellum?.title).not.toBe("guardian.question");
    expect(decision.renderedCopy.vellum?.body).not.toContain(
      "Action required: guardian.question",
    );
  });

  test("enforces free-text answer instructions for guardian.question when requestCode exists", async () => {
    const signal = makeSignal({
      contextPayload: {
        requestId: "req-pending-1",
        questionText: "What is the gate code?",
        requestCode: "A1B2C3",
        requestKind: "pending_question",
        callSessionId: "call-1",
        activeGuardianRequestCount: 1,
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.body).toContain("A1B2C3");
    expect(decision.renderedCopy.vellum?.body).toContain("<your answer>");
    expect(decision.renderedCopy.vellum?.body).not.toContain("approve");
    expect(decision.renderedCopy.vellum?.body).not.toContain("reject");
  });

  test("enforcement appends free-text answer instructions when LLM copy only mentions request code", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Guardian Question",
            body: "Use reference code A1B2C3 for this request.",
          },
        },
        dedupeKey: "guardian-question-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-pending-1",
        questionText: "What is the gate code?",
        requestCode: "A1B2C3",
        requestKind: "pending_question",
        callSessionId: "call-1",
        activeGuardianRequestCount: 1,
      },
    });

    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain(
      '"A1B2C3 <your answer>"',
    );
    expect(decision.renderedCopy.vellum?.body).not.toContain(
      '"A1B2C3 approve"',
    );
    expect(decision.renderedCopy.vellum?.body).not.toContain('"A1B2C3 reject"');
  });

  test("enforcement appends answer instructions when LLM copy incorrectly uses approve/reject wording", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Guardian Question",
            body: 'Reference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
          },
        },
        dedupeKey: "guardian-question-wrong-instructions-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-pending-approve-phrasing",
        questionText: "What is the gate code?",
        requestCode: "A1B2C3",
        requestKind: "pending_question",
        callSessionId: "call-1",
        activeGuardianRequestCount: 1,
      },
    });

    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain(
      '"A1B2C3 <your answer>"',
    );
  });

  test("enforcement appends explicit approve/reject instructions for tool-approval guardian questions", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Guardian Question",
            body: "Use reference code A1B2C3 for this request.",
          },
        },
        dedupeKey: "guardian-question-tool-approval-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-1",
        questionText: "Allow running host_bash?",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        toolName: "host_bash",
      },
    });

    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 approve"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 reject"');
  });

  test("approval-mode enforcement removes conflicting answer-mode phrasing", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Guardian Question",
            body: 'Reference code: A1B2C3. Reply "A1B2C3 <your answer>".',
          },
        },
        dedupeKey: "guardian-question-approval-removes-answer-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-2",
        questionText: "Allow running host_bash?",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        toolName: "host_bash",
      },
    });

    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 approve"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 reject"');
    expect(decision.renderedCopy.vellum?.body).not.toContain("<your answer>");
  });
});

// ── Access-request instruction enforcement ──────────────────────────────

describe("access-request instruction enforcement", () => {
  beforeEach(() => {
    configuredProvider = null;
    extractedToolUse = null;
  });

  function makeAccessRequestSignal(
    overrides?: Partial<NotificationSignal>,
  ): NotificationSignal {
    return {
      signalId: "sig-access-req-1",
      createdAt: Date.now(),
      sourceChannel: "telegram",
      sourceContextId: "tg-session-1",
      sourceEventName: "ingress.access_request",
      contextPayload: {
        senderIdentifier: "Alice",
        requestCode: "A1B2C3",
        sourceChannel: "telegram",
      },
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      ...overrides,
    };
  }

  test("fallback copy includes access-request contract elements", async () => {
    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.vellum?.body).toContain("A1B2C3");
    expect(decision.renderedCopy.vellum?.body).toContain("approve");
    expect(decision.renderedCopy.vellum?.body).toContain("reject");
    expect(decision.renderedCopy.vellum?.body).toContain("open invite flow");
  });

  test("enforcement appends contract when LLM copy is missing request code", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Access Request",
            body: "Someone wants access to your assistant.",
          },
        },
        dedupeKey: "access-req-missing-code",
        confidence: 0.9,
      },
    };

    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain("A1B2C3");
    expect(decision.renderedCopy.vellum?.body).toContain("approve");
    expect(decision.renderedCopy.vellum?.body).toContain("reject");
    expect(decision.renderedCopy.vellum?.body).toContain("open invite flow");
  });

  test("enforcement appends contract when LLM copy has code but missing invite flow", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Access Request",
            body: 'Alice wants access. Reply "A1B2C3 approve" or "A1B2C3 reject".',
          },
        },
        dedupeKey: "access-req-missing-invite",
        confidence: 0.9,
      },
    };

    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toContain("open invite flow");
  });

  test("enforcement does not duplicate when LLM copy already has all required elements", async () => {
    const fullBody =
      'Alice wants access.\nReply "A1B2C3 approve" to grant access or "A1B2C3 reject" to deny.\nReply "open invite flow" to start Trusted Contacts invite flow.';
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Access Request",
            body: fullBody,
          },
        },
        dedupeKey: "access-req-already-valid",
        confidence: 0.9,
      },
    };

    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    // Body should remain unchanged when all required elements are present
    expect(decision.renderedCopy.vellum?.body).toBe(fullBody);
  });

  test("enforcement also applies to deliveryText and conversationSeedMessage", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["telegram"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          telegram: {
            title: "Access Request",
            body: "Someone wants access.",
            deliveryText: "Someone wants access.",
            conversationSeedMessage: "Someone wants access.",
          },
        },
        dedupeKey: "access-req-multi-field",
        confidence: 0.9,
      },
    };

    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.renderedCopy.telegram?.deliveryText).toContain("A1B2C3");
    expect(decision.renderedCopy.telegram?.deliveryText).toContain(
      "open invite flow",
    );
    expect(decision.renderedCopy.telegram?.conversationSeedMessage).toContain(
      "A1B2C3",
    );
    expect(decision.renderedCopy.telegram?.conversationSeedMessage).toContain(
      "open invite flow",
    );
  });

  test("enforcement appends contract when LLM copy contains conflicting instructions", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Access Request",
            body: 'Alice wants access. Just reply "yes" or "no" to decide.',
          },
        },
        dedupeKey: "access-req-conflicting",
        confidence: 0.9,
      },
    };

    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    // Must contain the proper contract instructions despite conflicting LLM copy
    expect(decision.renderedCopy.vellum?.body).toContain("A1B2C3 approve");
    expect(decision.renderedCopy.vellum?.body).toContain("A1B2C3 reject");
    expect(decision.renderedCopy.vellum?.body).toContain("open invite flow");
  });

  test("enforcement appends invite directive when requestCode is absent", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Access Request",
            body: "Someone wants access to your assistant.",
          },
        },
        dedupeKey: "access-req-no-code-invite",
        confidence: 0.9,
      },
    };

    const signal = makeAccessRequestSignal({
      contextPayload: {
        senderIdentifier: "Alice",
        sourceChannel: "telegram",
        // No requestCode
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    // Invite directive should still be enforced even without requestCode
    expect(decision.renderedCopy.vellum?.body).toContain("open invite flow");
    // Approve/reject should NOT be present since there is no requestCode
    expect(decision.renderedCopy.vellum?.body).not.toContain("approve");
    expect(decision.renderedCopy.vellum?.body).not.toContain("reject");
  });
});
