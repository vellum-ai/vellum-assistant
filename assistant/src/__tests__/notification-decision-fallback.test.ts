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

  test("a question's copy carries no reply mechanics on any channel", async () => {
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
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    // The typed-reply instruction rides in the card's plainTextFallback and
    // joins the text only where a transport sends it without buttons.
    for (const channel of ["vellum", "telegram"] as const) {
      expect(decision.renderedCopy[channel]?.body).toBe(
        "What is the gate code?",
      );
      expect(decision.renderedCopy[channel]?.conversationSeedMessage).toBe(
        "What is the gate code?",
      );
    }
  });

  test("a question is pinned to its own words, whatever the model wrote about codes", async () => {
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
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.telegram?.body).toBe("What is the gate code?");
  });

  test("model-authored approval mechanics are stripped from a tool-grant request", async () => {
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
            title: "Guardian Question",
            body: 'Allow running host_bash?\n\nReference code: A1B2C3. Reply "A1B2C3 approve" or "A1B2C3 reject".',
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
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.telegram?.body).toBe(
      "Allow running host_bash?",
    );
  });

  test("a paraphrased directive and a 'use reference code' sentence are stripped too", async () => {
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
            body: 'Allow running host_bash? Reply "A1B2C3 approve" to allow it. Use reference code A1B2C3 for this request.',
          },
        },
        dedupeKey: "guardian-question-paraphrase-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-3",
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
    expect(decision.renderedCopy.vellum?.body).toBe("Allow running host_bash?");
  });

  test("a model title that is only mechanics becomes the kind's headline", async () => {
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
            title: "Reply A1B2C3 approve",
            body: "Allow running host_bash?",
          },
        },
        dedupeKey: "guardian-question-title-mechanics-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-title",
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
    // The banner shows the title, so the code cannot survive there either.
    expect(decision.renderedCopy.vellum?.title).toBe("Guardian Question");
    expect(decision.renderedCopy.vellum?.body).toBe("Allow running host_bash?");
  });

  test("copy that was nothing but mechanics becomes the request's own question", async () => {
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
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.telegram?.body).toBe(
      "Allow running host_bash?",
    );
  });

  test("every channel gets the same code-free copy for an approval request", async () => {
    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-slack-1",
        questionText: "Approve tool: bash (requested by Alice)",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        toolName: "bash",
      },
    });

    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
      "slack",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    for (const channel of ["vellum", "telegram", "slack"] as const) {
      expect(decision.renderedCopy[channel]?.body).toBe(
        "Approve tool: bash (requested by Alice)",
      );
    }
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

  test("a slack answer-mode question carries no code either; the instruction rides in the card fallback", async () => {
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
    expect(decision.renderedCopy.slack?.body).toBe("What is the gate code?");
  });
});

// ── Reply mechanics never ride in copy ───────────────────────────────────

/**
 * The bell detail, the OS banner, the push, and every card with buttons show
 * the ask alone. The typed-reply instruction is the card's plainTextFallback,
 * appended by a transport only when it sends text without buttons, so no
 * channel's composed copy carries it.
 */
describe("guardian copy carries no reply mechanics", () => {
  beforeEach(() => {
    configuredProvider = null;
    extractedToolUse = null;
  });

  test("a question with options reaches the bell as the question and its options, nothing else", async () => {
    const signal = makeSignal({
      sourceChannel: "telegram",
      contextPayload: {
        requestId: "req-ask-bell-1",
        requestCode: "E96831",
        requestKind: "pending_question",
        questionText:
          "When you say it feels too harsh, what is the feeling exactly?",
        options: [
          { id: "heavy", label: "Lines too heavy" },
          { id: "showy", label: "Feels showy" },
          { id: "both", label: "Both, honestly" },
        ],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    const expectedQuestion =
      "When you say it feels too harsh, what is the feeling exactly?\n\n1. Lines too heavy\n2. Feels showy\n3. Both, honestly";
    // The bell reads the seed; the banner reads the body. Line structure is
    // preserved so the options render as lines rather than one run-on blob.
    expect(decision.renderedCopy.vellum?.conversationSeedMessage).toBe(
      expectedQuestion,
    );
    expect(decision.renderedCopy.vellum?.body).toBe(expectedQuestion);
    expect(decision.renderedCopy.vellum?.deliveryText).toBe(expectedQuestion);
    // The chat channel is the same text: its buttons come from the card
    // context, and a transport without buttons appends the instruction.
    expect(decision.renderedCopy.telegram?.deliveryText).toBe(expectedQuestion);
  });

  test("model-authored code phrasing is stripped from vellum and platform copy", async () => {
    configuredProvider = {
      sendMessage: async () => ({ content: [] }),
    };
    extractedToolUse = {
      name: "record_notification_decision",
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum", "platform"],
        reasoningSummary: "LLM decision",
        renderedCopy: {
          vellum: {
            title: "Tool Grant Request",
            body: 'Alice is asking to run ls /tmp.\nApproval code: A1B2C3\nReply "A1B2C3 approve" or "A1B2C3 reject".',
            conversationSeedMessage:
              "**Alice** is asking to run `ls /tmp`.\n\nReference code: A1B2C3.",
          },
          platform: {
            title: "Tool Grant Request",
            body: 'Alice is asking to run ls /tmp. Reply "A1B2C3 approve" or "A1B2C3 reject".',
          },
        },
        dedupeKey: "guardian-question-vellum-llm-test",
        confidence: 0.9,
      },
    };

    const signal = makeSignal({
      contextPayload: {
        requestId: "req-grant-vellum-1",
        questionText: "Approve tool: bash (requested by Alice)",
        requestCode: "A1B2C3",
        requestKind: "tool_grant_request",
        toolName: "bash",
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "platform",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    expect(decision.renderedCopy.vellum?.body).toBe(
      "Alice is asking to run ls /tmp.",
    );
    expect(decision.renderedCopy.vellum?.conversationSeedMessage).toBe(
      "**Alice** is asking to run `ls /tmp`.",
    );
    expect(decision.renderedCopy.platform?.body).toBe(
      "Alice is asking to run ls /tmp.",
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

  test("fallback copy carries the requester context and no reply mechanics", async () => {
    const signal = makeAccessRequestSignal();
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(true);
    for (const channel of ["vellum", "telegram"] as const) {
      const body = decision.renderedCopy[channel]?.body ?? "";
      expect(body).toContain("Alice");
      expect(body).not.toContain("A1B2C3");
      // Context, not mechanics: no surface offers an invite button.
      expect(body).toContain('Reply "open invite flow"');
    }
  });

  test("model copy with no mechanics keeps its text and gains the invite sentence", async () => {
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
    expect(decision.renderedCopy.vellum?.body).toBe(
      'Someone wants access to your assistant.\nReply "open invite flow" to start Trusted Contacts invite flow.',
    );
  });

  test("model-authored code directives are stripped, leaving the ask", async () => {
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
    expect(decision.renderedCopy.vellum?.body).toBe(
      'Alice wants access.\nReply "open invite flow" to start Trusted Contacts invite flow.',
    );
  });

  test("the code directive is stripped from model copy and the invite directive stays", async () => {
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
    expect(decision.renderedCopy.vellum?.body).toBe(
      'Alice wants access.\nReply "open invite flow" to start Trusted Contacts invite flow.',
    );
  });

  test("the strip covers deliveryText and conversationSeedMessage too", async () => {
    const withMechanics =
      'Someone wants access.\nReply "A1B2C3 trust" to trust them, "A1B2C3 reject" to leave them unverified, or "A1B2C3 block" to block them.';
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
            body: withMechanics,
            deliveryText: withMechanics,
            conversationSeedMessage: withMechanics,
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

    const expected =
      'Someone wants access.\nReply "open invite flow" to start Trusted Contacts invite flow.';
    expect(decision.renderedCopy.telegram?.body).toBe(expected);
    expect(decision.renderedCopy.telegram?.deliveryText).toBe(expected);
    expect(decision.renderedCopy.telegram?.conversationSeedMessage).toBe(
      expected,
    );
  });

  test("model copy that leaves the invite sentence out gets it appended", async () => {
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
            body: "Alice wants access.",
            deliveryText: "Alice wants access.",
          },
        },
        dedupeKey: "access-req-invite-ensured",
        confidence: 0.9,
      },
    };

    const decision = await evaluateSignal(makeAccessRequestSignal(), [
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.fallbackUsed).toBe(false);
    const expected =
      'Alice wants access.\nReply "open invite flow" to start Trusted Contacts invite flow.';
    expect(decision.renderedCopy.telegram?.body).toBe(expected);
    expect(decision.renderedCopy.telegram?.deliveryText).toBe(expected);
    expect(decision.renderedCopy.telegram?.title).toBe("Access Request");
  });

  test("the invite directive stays even when the request has no code", async () => {
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
            body: 'Someone wants access to your assistant.\nReply "open invite flow" to start Trusted Contacts invite flow.',
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
    expect(decision.renderedCopy.vellum?.body).toBe(
      'Someone wants access to your assistant.\nReply "open invite flow" to start Trusted Contacts invite flow.',
    );
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
    // The typed-reply instruction is the card's plainTextFallback, not copy.
    expect(delivered).not.toContain("08B619");
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
