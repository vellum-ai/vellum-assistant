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

  test("slack approval copy is stripped of request-code instructions instead of enforced", async () => {
    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-slack-1",
        questionText: "Approve tool: bash — ls /tmp (requested by Alice)",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        toolName: "bash",
      },
    });

    const decision = await evaluateSignal(signal, [
      "vellum",
      "slack",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    // Vellum keeps the code-reply directive.
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 approve"');
    // Slack renders Approve/Reject buttons — no code anywhere in its copy.
    expect(decision.renderedCopy.slack?.body).toBe(
      "Approve tool: bash — ls /tmp (requested by Alice)",
    );
    expect(decision.renderedCopy.slack?.body).not.toContain("A1B2C3");
  });

  test("slack copy strips LLM-authored approval-code phrasing for approval requests", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["slack"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          slack: {
            title: "Tool Grant Request",
            body: "Alice is asking to run ls /tmp.",
            deliveryText:
              'Alice is asking to run ls /tmp.\nApproval code: A1B2C3\nReference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
          },
        },
        dedupeKey: "guardian-question-slack-llm-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-slack-2",
        questionText: "Approve tool: bash — ls /tmp (requested by Alice)",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        toolName: "bash",
      },
    });

    const decision = await evaluateSignal(signal, [
      "slack",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.slack?.deliveryText).toBe(
      "Alice is asking to run ls /tmp.",
    );
    expect(decision.renderedCopy.slack?.body).toBe(
      "Alice is asking to run ls /tmp.",
    );
  });

  test("slack answer-mode questions keep code instructions (no buttons render)", async () => {
    const signal = makeSignal({
      contextPayload: {
        requestId: "req-pending-slack-1",
        questionText: "What is the gate code?",
        requestCode: "A1B2C3",
        requestKind: "pending_question",
        callSessionId: "call-1",
        activeGuardianRequestCount: 1,
      },
    });

    const decision = await evaluateSignal(signal, [
      "slack",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    expect(decision.renderedCopy.slack?.body).toContain(
      '"A1B2C3 <your answer>"',
    );
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
    // Directive form, not prose mentions: the guardian must be able to reply
    // with these exact code+verb tokens.
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 trust"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 reject"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 block"');
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
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 trust"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 reject"');
    expect(decision.renderedCopy.vellum?.body).toContain('"A1B2C3 block"');
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
      'Alice wants access.\nReply "A1B2C3 verify" to send them a verification code, "A1B2C3 trust" to trust them without one, "A1B2C3 reject" to leave them unverified, or "A1B2C3 block" to block them.\nReply "open invite flow" to start Trusted Contacts invite flow.';
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
    expect(decision.renderedCopy.vellum?.body).toContain("A1B2C3 verify");
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

/**
 * A question is the one payload whose copy cannot be composed: the guardian is
 * choosing between the words it carries. The engine replaces title / body /
 * deliveryText wholesale with the model's version, which is how a question
 * reached a channel as a summary of itself with its options missing.
 */
describe("ask_question copy is pinned to the question", () => {
  const askQuestionSignal = (): NotificationSignal => ({
    signalId: "sig-ask-question-1",
    createdAt: Date.now(),
    sourceChannel: "slack",
    sourceContextId: "conv-1",
    sourceEventName: "guardian.question",
    contextPayload: {
      requestId: "req-ask-1",
      requestCode: "08B619",
      requestKind: "pending_question",
      questionText: "What should I dig into?",
      options: [
        { id: "opt-thread", label: "This Slack thread" },
        { id: "opt-pr", label: "The pull request" },
      ],
    },
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
  });

  beforeEach(() => {
    configuredProvider = { sendMessage: async () => ({ content: [] }) };
    // The tool-use envelope `classifyWithLLM` reads, not the decision fields
    // alone: it takes `toolBlock.input`, and the field names inside must be
    // the ones `validateDecisionOutput` requires. Either mismatch drops the
    // decision to the fallback path, where this suite's own copy is correct
    // and the pin under test never runs.
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["slack"],
        reasoningSummary: "guardian needs to answer",
        dedupeKey: "ask-question-req-ask-1",
        confidence: 0.9,
        renderedCopy: {
          slack: {
            title: "Guardian question",
            body: "Guardian wants to know where to focus",
            deliveryText: "Guardian wants to know where to focus",
          },
        },
      },
    };
  });

  test("the composed paraphrase does not replace the question", async () => {
    const decision = await evaluateSignal(askQuestionSignal(), [
      "slack",
    ] as NotificationChannel[]);

    // Guards the fixture itself: a shape the validator rejects would fall
    // back, and the assertions below would then be testing the fallback copy
    // rather than the pin that overrides a composed paraphrase.
    expect(decision.fallbackUsed).toBe(false);

    const copy = decision.renderedCopy.slack;
    // `deliveryText` is what the Slack adapter sends, ahead of body and title.
    expect(copy?.deliveryText).toContain("What should I dig into?");
    expect(copy?.deliveryText).not.toContain("wants to know where to focus");
    expect(copy?.body).toContain("What should I dig into?");
  });

  test("the options ride along, numbered as the resolver orders them", async () => {
    const decision = await evaluateSignal(askQuestionSignal(), [
      "slack",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    const delivered = decision.renderedCopy.slack?.deliveryText ?? "";
    expect(delivered).toContain("1. This Slack thread");
    expect(delivered).toContain("2. The pull request");
    expect(delivered).toContain("08B619");
  });

  test("a voice tool approval keeps its composed copy", async () => {
    const signal = askQuestionSignal();
    // A `pending_question` carrying a tool name is an approval, not a
    // question, so composing its copy is correct.
    signal.contextPayload = {
      ...signal.contextPayload,
      toolName: "bash",
      options: undefined,
    };
    const decision = await evaluateSignal(signal, [
      "slack",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.slack?.deliveryText).toBe(
      "Guardian wants to know where to focus",
    );
  });
});
