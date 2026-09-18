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
type ProviderSendOptions = { systemPrompt?: string; tools?: unknown[] };

let providerSendMessage: (
  messages: unknown[],
  opts: ProviderSendOptions,
) => Promise<unknown> = () => {
  throw new Error(
    "provider.sendMessage should NOT be invoked for pass-through decisions",
  );
};

// Tool block the engine reads back from a provider response. Null drives the
// deterministic fallback, so LLM-path tests set it before calling in.
let toolUseBlock: { input: Record<string, unknown> } | null = null;

mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => ({
    sendMessage: (messages: unknown[], opts: ProviderSendOptions) =>
      providerSendMessage(messages, opts),
  }),
  createTimeout: () => ({
    signal: new AbortController().signal,
    cleanup: () => {},
  }),
  extractToolUse: () => toolUseBlock,
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
    sourceEventName: "assistant.share",
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

/** A signal with no verbatim copy, so the engine takes the LLM path. */
function makeLlmSignal(): NotificationSignal {
  return {
    signalId: "sig-llm-1",
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

  test("channelAllowlist replaces the default channel set", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "telegram only",
        channelAllowlist: ["telegram"],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["telegram"]);
    expect(decision.shouldNotify).toBe(true);
    expect(decision.renderedCopy.telegram?.body).toBe("telegram only");
  });

  test("channelAllowlist wins over preferredChannels", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "exclusive telegram",
        preferredChannels: ["slack"],
        channelAllowlist: ["telegram"],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
      "slack",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["telegram"]);
    expect(decision.selectedChannels).not.toContain("vellum");
    expect(decision.selectedChannels).not.toContain("slack");
  });

  test("urgent + channelAllowlist stays exclusive", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "urgent telegram only",
        channelAllowlist: ["telegram"],
      },
      attentionHints: {
        requiresAction: true,
        urgency: "critical",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
      "slack",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["telegram"]);
    expect(decision.shouldNotify).toBe(true);
  });

  test("channelAllowlist with no overlap yields an empty selection", async () => {
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: "nowhere to send",
        channelAllowlist: ["disconnected_channel"],
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual([]);
    expect(decision.shouldNotify).toBe(false);
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

describe("decision tool title field specification", () => {
  test("pins the length, form, and no-echo constraints in the tool schema", async () => {
    guardianDeliveryFixture = [];
    contactInfoFixture = {};

    let capturedTools: unknown[] | undefined;
    providerSendMessage = async (_messages, opts) => {
      capturedTools = opts.tools;
      return {};
    };

    await evaluateSignal(makeLlmSignal(), ["vellum"] as NotificationChannel[]);

    const tool = capturedTools?.[0] as {
      input_schema: {
        properties: {
          renderedCopy: {
            properties: Record<
              string,
              { properties: { title: { description: string } } }
            >;
          };
        };
      };
    };
    const description =
      tool.input_schema.properties.renderedCopy.properties.vellum.properties
        .title.description;

    expect(description).toContain("2 to 6 words");
    expect(description).toContain("40 characters");
    // The title carries a bell row on its own, so it states the outcome
    // rather than naming a topic the body then explains.
    expect(description).toContain("WHAT HAPPENED or WHAT IS NEEDED");
    expect(description).toContain("Lead with the outcome");
    expect(description).toContain("Do NOT restate the body word for word");
    expect(description).toContain("no markdown");
    expect(description).toContain("Missing context");
    expect(description.match(/NOT '/g)?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});

describe("title normalization", () => {
  /** Run the LLM path with the given channel copy and return the kept title. */
  async function titleFromModelCopy(
    title: string,
    body: string,
  ): Promise<string | undefined> {
    guardianDeliveryFixture = [];
    contactInfoFixture = {};
    const previousSendMessage = providerSendMessage;
    providerSendMessage = async () => ({});
    toolUseBlock = {
      input: {
        shouldNotify: true,
        selectedChannels: ["vellum"],
        reasoningSummary: "model decision",
        dedupeKey: "title-normalization-test",
        renderedCopy: { vellum: { title, body } },
      },
    };

    try {
      const decision = await evaluateSignal(makeLlmSignal(), [
        "vellum",
      ] as NotificationChannel[]);
      return decision.renderedCopy.vellum?.title;
    } finally {
      toolUseBlock = null;
      providerSendMessage = previousSendMessage;
    }
  }

  test("replaces a model title that restates the body with a derived one", async () => {
    const title = "The staging deploy finished and the build is live.";
    const body = `Deploy complete. ${title}`;

    expect(await titleFromModelCopy(title, body)).toBe("Deploy complete.");
  });

  test("keeps a clean model title verbatim", async () => {
    expect(
      await titleFromModelCopy(
        "Staging Deploy Status",
        "The staging deploy finished.",
      ),
    ).toBe("Staging Deploy Status");
  });

  test("truncates a model title longer than 40 characters", async () => {
    const kept = await titleFromModelCopy(
      "Quarterly Infrastructure Migration Status Report",
      "The migration is on track for the quarter.",
    );

    expect(kept).toBe("Quarterly Infrastructure Migration");
    expect(kept?.length).toBeLessThanOrEqual(40);
  });

  test("strips markdown from a model title", async () => {
    expect(
      await titleFromModelCopy(
        "**Deploy Status**",
        "The staging deploy finished.",
      ),
    ).toBe("Deploy Status");
  });

  test("replaces a pass-through requestedTitle that stutters against the body", async () => {
    const requestedTitle = "The nightly backup finished without any errors.";
    const signal = makeAssistantToolSignal({
      contextPayload: {
        requestedMessage: `Backup finished. ${requestedTitle}`,
        requestedTitle,
      },
    });
    const decision = await evaluateSignal(signal, [
      "vellum",
    ] as NotificationChannel[]);

    expect(decision.renderedCopy.vellum?.title).toBe("Backup finished.");
  });
});

function makeScheduleResultSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-schedule-result-test-1",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceContextId: "conv-schedule-run",
    sourceEventName: "schedule.result",
    contextPayload: {
      requestedMessage: "- **3 new emails**\n- `deploy.sh` failed overnight",
      requestedTitle: "Morning briefing",
      scheduleName: "Morning briefing",
      scheduleId: "sched-1",
    },
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

describe("schedule.result pass-through in notification decision engine", () => {
  beforeEach(() => {
    persistedDecisions = [];
  });

  test("carries the run's own output verbatim rather than rewriting it", async () => {
    // The whole value of this notification is the digest itself. The
    // classifier compresses a signal into a short alert, which would throw
    // away the content the user set the schedule up to receive.
    const decision = await evaluateSignal(makeScheduleResultSignal(), [
      "vellum",
      "platform",
    ] as NotificationChannel[]);

    expect(decision.renderedCopy.vellum?.body).toBe(
      "- **3 new emails**\n- `deploy.sh` failed overnight",
    );
    expect(decision.renderedCopy.vellum?.title).toBe("Morning briefing");
    expect(decision.reasoningSummary).toBe("schedule_result pass-through");
    expect(decision.verbatimCopy).toBe(true);
    expect(decision.fallbackUsed).toBe(false);
  });

  test("delivers to the notification center as well as push", async () => {
    // Unlike an unseen chat reply, a scheduled run's output has no
    // conversation the user is already in. `vellum` is where it persists.
    const decision = await evaluateSignal(makeScheduleResultSignal(), [
      "vellum",
      "telegram",
      "platform",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["vellum", "platform"]);
    expect(decision.shouldNotify).toBe(true);
  });

  test("still reaches the inbox when push is unavailable", async () => {
    const decision = await evaluateSignal(makeScheduleResultSignal(), [
      "vellum",
      "telegram",
    ] as NotificationChannel[]);

    expect(decision.selectedChannels).toEqual(["vellum"]);
    expect(decision.shouldNotify).toBe(true);
  });
});

const SCHEDULER_OWNED_REPORT = [
  "# Daily briefing",
  "",
  "## Overnight",
  "- Calendar is clear until 10:00.",
  "- Two pull requests are waiting on review.",
  "",
  "## Account security",
  "- Urgent: a sign-in from a new device needs confirmation before the weekly sync.",
  "",
  "## This week",
  "- Project kickoff on Wednesday.",
  "- Weekly planning on Friday.",
  "- Follow up on the draft status update.",
].join("\n");

function makeSchedulerShareSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-scheduler-share-test-1",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceContextId: "conv-xyz",
    sourceEventName: "assistant.share",
    contextPayload: {
      requestedMessage: SCHEDULER_OWNED_REPORT,
      requestedBySource: "scheduler",
      requestedTitle: "Your day",
    },
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

describe("scheduler requested-message pass-through in notification decision engine", () => {
  beforeEach(() => {
    persistedDecisions = [];
  });

  test("keeps a scheduler-owned report verbatim on every urgency-selected channel", async () => {
    const available = [
      "vellum",
      "telegram",
      "platform",
    ] as NotificationChannel[];
    const decision = await evaluateSignal(
      makeSchedulerShareSignal(),
      available,
    );

    expect(decision.shouldNotify).toBe(true);
    expect(decision.selectedChannels).toEqual(available);
    expect(decision.reasoningSummary).toBe(
      "scheduler requested-message pass-through",
    );
    expect(decision.verbatimCopy).toBe(true);
    expect(decision.fallbackUsed).toBe(false);
    for (const ch of available) {
      expect(decision.renderedCopy[ch]?.title).toBe("Your day");
      expect(decision.renderedCopy[ch]?.body).toBe(SCHEDULER_OWNED_REPORT);
      expect(decision.renderedCopy[ch]?.conversationSeedMessage).toBe(
        SCHEDULER_OWNED_REPORT,
      );
    }
  });

  test("copies the complete report onto the urgency-narrowed channel set", async () => {
    const available = [
      "vellum",
      "telegram",
      "platform",
    ] as NotificationChannel[];
    const decision = await evaluateSignal(
      makeSchedulerShareSignal({
        attentionHints: {
          requiresAction: false,
          urgency: "medium",
          isAsyncBackground: true,
          visibleInSourceNow: false,
        },
      }),
      available,
    );

    expect(decision.shouldNotify).toBe(true);
    expect(decision.selectedChannels).toEqual(["vellum"]);
    expect(decision.reasoningSummary).toBe(
      "scheduler requested-message pass-through",
    );
    expect(decision.renderedCopy.vellum?.body).toBe(SCHEDULER_OWNED_REPORT);
    expect(decision.renderedCopy.vellum?.conversationSeedMessage).toBe(
      SCHEDULER_OWNED_REPORT,
    );
    expect(decision.renderedCopy.telegram?.body).toBe(SCHEDULER_OWNED_REPORT);
    expect(decision.renderedCopy.platform?.body).toBe(SCHEDULER_OWNED_REPORT);
  });

  test("leaves an unowned scheduler requestedMessage on the model path", async () => {
    const previousSendMessage = providerSendMessage;
    let providerCalled = false;
    providerSendMessage = async () => {
      providerCalled = true;
      return {};
    };

    try {
      const decision = await evaluateSignal(
        makeSchedulerShareSignal({
          contextPayload: {
            requestedMessage: SCHEDULER_OWNED_REPORT,
            requestedTitle: "Your day",
          },
        }),
        ["vellum", "telegram", "platform"] as NotificationChannel[],
      );

      expect(providerCalled).toBe(true);
      expect(decision.verbatimCopy).toBeUndefined();
      expect(decision.reasoningSummary).not.toBe(
        "scheduler requested-message pass-through",
      );
    } finally {
      providerSendMessage = previousSendMessage;
    }
  });

  test("leaves scheduler notify-mode without the ownership marker on the model path", async () => {
    const previousSendMessage = providerSendMessage;
    let providerCalled = false;
    providerSendMessage = async () => {
      providerCalled = true;
      return {};
    };

    try {
      const decision = await evaluateSignal(
        {
          signalId: "sig-schedule-notify-test-1",
          createdAt: Date.now(),
          sourceChannel: "scheduler",
          sourceContextId: "sched-notify-1",
          sourceEventName: "schedule.notify",
          contextPayload: {
            scheduleId: "sched-notify-1",
            label: "Take out the trash",
            message: "Take out the trash",
          },
          attentionHints: {
            requiresAction: true,
            urgency: "high",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
        },
        ["vellum", "telegram", "platform"] as NotificationChannel[],
      );

      expect(providerCalled).toBe(true);
      expect(decision.verbatimCopy).toBeUndefined();
      expect(decision.reasoningSummary).not.toBe(
        "scheduler requested-message pass-through",
      );
      expect(decision.reasoningSummary).not.toBe(
        "schedule_result pass-through",
      );
    } finally {
      providerSendMessage = previousSendMessage;
    }
  });
});
