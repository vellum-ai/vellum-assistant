import { beforeEach, describe, expect, mock, test } from "bun:test";

const evaluateSignalMock = mock();
const enforceRoutingIntentMock = mock();
const updateDecisionMock = mock();
const runDeterministicChecksMock = mock();
const createEventMock = mock();
const setEventDedupeKeyMock = mock();
const dispatchDecisionMock = mock();
const isPlatformClientConfiguredMock = mock();

mock.module("../channels/config.js", () => ({
  getDeliverableChannels: () => ["vellum", "telegram"],
}));

// Guardian connectivity is resolved from the gateway pull. No active guardian
// binding ⇒ binding-based channels (telegram) are not reported connected.
// Guardian connectivity resolves solely from the gateway delivery; an empty
// list ⇒ telegram stays disconnected.
mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: async () => [],
  guardianForChannel: () => undefined,
}));

mock.module("../notifications/adapters/macos.js", () => ({
  VellumAdapter: class {
    constructor(_broadcastFn: unknown) {}
  },
}));

mock.module("../notifications/adapters/telegram.js", () => ({
  TelegramAdapter: class {},
}));

mock.module("../notifications/broadcaster.js", () => ({
  NotificationBroadcaster: class {
    constructor(_adapters: unknown[]) {}
    setOnConversationCreated(_fn: unknown) {}
  },
}));

// Capture the real enforcement before the module mock below replaces it:
// the single_channel interplay tests exercise the genuine cap logic against
// the urgency force-add's channel ordering.
const { enforceRoutingIntent: realEnforceRoutingIntent } =
  await import("../notifications/decision-engine.js");

mock.module("../notifications/decision-engine.js", () => ({
  evaluateSignal: (...args: unknown[]) => evaluateSignalMock(...args),
  enforceRoutingIntent: (...args: unknown[]) =>
    enforceRoutingIntentMock(...args),
}));

mock.module("../notifications/decisions-store.js", () => ({
  updateDecision: (...args: unknown[]) => updateDecisionMock(...args),
}));

mock.module("../notifications/deterministic-checks.js", () => ({
  runDeterministicChecks: (...args: unknown[]) =>
    runDeterministicChecksMock(...args),
  // emit-signal also imports checkSourceActiveSuppression for the pre-decision
  // gate. Mirror its real signal-only contract here so the gate behaves under
  // the mock without depending on bun's export-merge semantics. The real
  // implementation is unit-tested in
  // notifications/__tests__/deterministic-checks.test.ts.
  checkSourceActiveSuppression: (signal: {
    attentionHints: { visibleInSourceNow?: boolean };
  }) =>
    signal.attentionHints.visibleInSourceNow
      ? {
          passed: false,
          reason:
            "Source-active suppression: user is already viewing the source context",
        }
      : { passed: true },
}));

mock.module("../notifications/events-store.js", () => ({
  createEvent: (...args: unknown[]) => createEventMock(...args),
  setEventDedupeKey: (...args: unknown[]) => setEventDedupeKeyMock(...args),
}));

mock.module("../notifications/runtime-dispatch.js", () => ({
  dispatchDecision: (...args: unknown[]) => dispatchDecisionMock(...args),
}));

mock.module("../platform/client.js", () => ({
  // The adapter import graph needs the class symbol; nothing in these tests
  // dispatches through it.
  VellumPlatformClient: class {
    static async create(): Promise<null> {
      return null;
    }
  },
  isPlatformClientConfigured: () => isPlatformClientConfiguredMock(),
}));

import { emitNotificationSignal } from "../notifications/emit-signal.js";

beforeEach(() => {
  evaluateSignalMock.mockReset();
  enforceRoutingIntentMock.mockReset();
  updateDecisionMock.mockReset();
  runDeterministicChecksMock.mockReset();
  createEventMock.mockReset();
  setEventDedupeKeyMock.mockReset();
  dispatchDecisionMock.mockReset();
  isPlatformClientConfiguredMock.mockReset();

  createEventMock.mockReturnValue({ id: "evt-1" });
  runDeterministicChecksMock.mockResolvedValue({ passed: true });
  dispatchDecisionMock.mockResolvedValue({
    dispatched: true,
    reason: "ok",
    deliveryResults: [],
  });
  isPlatformClientConfiguredMock.mockResolvedValue(true);
  enforceRoutingIntentMock.mockImplementation((decision: unknown) => decision);
});

describe("emitNotificationSignal routing intent re-persistence", () => {
  test("re-persists selectedChannels/reasoningSummary when enforcement changes the decision", async () => {
    const preDecision = {
      shouldNotify: true,
      selectedChannels: ["vellum"],
      reasoningSummary: "LLM selected vellum only",
      renderedCopy: {
        vellum: { title: "Reminder", body: "Take out trash" },
      },
      dedupeKey: "dedupe-rem-1",
      confidence: 0.9,
      fallbackUsed: false,
      persistedDecisionId: "dec-1",
    };

    const enforcedDecision = {
      ...preDecision,
      selectedChannels: ["vellum", "telegram"],
      reasoningSummary: `${preDecision.reasoningSummary} [routing_intent=all_channels enforced: vellum, telegram]`,
    };

    evaluateSignalMock.mockResolvedValue(preDecision);
    enforceRoutingIntentMock.mockReturnValue(enforcedDecision);

    const result = await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "rem-1",
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: { reminderId: "rem-1" },
      routingIntent: "all_channels",
    });

    expect(result.dispatched).toBe(true);
    expect(updateDecisionMock).toHaveBeenCalledTimes(1);
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-1", {
      selectedChannels: ["vellum", "telegram"],
      reasoningSummary: `${preDecision.reasoningSummary} [routing_intent=all_channels enforced: vellum, telegram]`,
      validationResults: {
        dedupeKey: "dedupe-rem-1",
        channelCount: 2,
        hasCopy: true,
      },
    });
  });

  test("does not re-persist when enforcement leaves the decision unchanged", async () => {
    const decision = {
      shouldNotify: true,
      selectedChannels: ["vellum"],
      reasoningSummary: "No routing override needed",
      renderedCopy: {
        vellum: { title: "Reminder", body: "Drink water" },
      },
      dedupeKey: "dedupe-rem-2",
      confidence: 0.8,
      fallbackUsed: false,
      persistedDecisionId: "dec-2",
    };

    evaluateSignalMock.mockResolvedValue(decision);
    enforceRoutingIntentMock.mockImplementation(
      (inputDecision: unknown) => inputDecision,
    );

    await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "rem-2",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: { reminderId: "rem-2" },
      routingIntent: "single_channel",
    });

    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  test("excludes unverified binding channels from connected channel candidates", async () => {
    const decision = {
      shouldNotify: true,
      selectedChannels: ["vellum"],
      reasoningSummary: "Local only",
      renderedCopy: {
        vellum: { title: "Reminder", body: "Check this" },
      },
      dedupeKey: "dedupe-rem-3",
      confidence: 0.8,
      fallbackUsed: false,
      persistedDecisionId: "dec-3",
    };

    evaluateSignalMock.mockResolvedValue(decision);
    enforceRoutingIntentMock.mockImplementation(
      (inputDecision: unknown) => inputDecision,
    );

    await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "rem-3",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: { reminderId: "rem-3" },
      routingIntent: "single_channel",
    });

    expect(evaluateSignalMock).toHaveBeenCalled();
    const callArgs = evaluateSignalMock.mock.calls[0];
    expect(callArgs).toBeDefined();
    expect(callArgs?.[1]).toEqual(["vellum"]);
  });
});

describe("emitNotificationSignal source-active pre-gate", () => {
  test("suppresses visibleInSourceNow signals before the decision engine runs", async () => {
    const result = await emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.verification_sent",
      sourceChannel: "slack",
      sourceContextId: "conv-1",
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: true,
        visibleInSourceNow: true,
      },
      contextPayload: { verificationSessionId: "vs-1" },
    });

    // The event row is still persisted (audit trail), but the signal
    // short-circuits before the LLM-backed decision stage and never dispatches.
    expect(createEventMock).toHaveBeenCalledTimes(1);
    expect(evaluateSignalMock).not.toHaveBeenCalled();
    expect(runDeterministicChecksMock).not.toHaveBeenCalled();
    expect(dispatchDecisionMock).not.toHaveBeenCalled();
    expect(result.dispatched).toBe(false);
    expect(result.reason).toContain("Source-active suppression");
  });

  test("does not short-circuit when visibleInSourceNow is false", async () => {
    evaluateSignalMock.mockResolvedValue({
      shouldNotify: false,
      selectedChannels: [],
      reasoningSummary: "no notify",
      renderedCopy: {},
      dedupeKey: "dk-not-source-active",
      confidence: 0.5,
      fallbackUsed: false,
    });

    await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "conv-2",
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
      contextPayload: {},
    });

    expect(evaluateSignalMock).toHaveBeenCalledTimes(1);
  });
});

describe("access-request vellum floor", () => {
  test("rescues a suppressed access-request decision onto the vellum channel", async () => {
    evaluateSignalMock.mockResolvedValue({
      shouldNotify: false,
      selectedChannels: [],
      reasoningSummary: "LLM suppressed",
      renderedCopy: {},
      dedupeKey: "dedupe-ar-1",
      confidence: 0.9,
      fallbackUsed: false,
      persistedDecisionId: "dec-ar-1",
    });
    enforceRoutingIntentMock.mockImplementation(
      (decision: unknown) => decision,
    );

    const result = await emitNotificationSignal({
      sourceEventName: "ingress.access_request",
      sourceChannel: "telegram",
      sourceContextId: "access-req-telegram-user-1",
      requiresConversation: true,
      attentionHints: {
        requiresAction: true,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestId: "req-1",
        requestCode: "AB12CD",
        sourceChannel: "telegram",
        conversationExternalId: "chat-123",
        actorExternalId: "user-1",
        actorDisplayName: "User One",
        actorUsername: null,
        senderIdentifier: "User One",
        guardianBindingChannel: null,
        guardianResolutionSource: "none",
        previousMemberStatus: null,
        messagePreview: null,
        trigger: "admitted",
      },
    });

    expect(result.dispatched).toBe(true);
    expect(dispatchDecisionMock).toHaveBeenCalledTimes(1);
    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      shouldNotify: boolean;
      selectedChannels: string[];
      reasoningSummary: string;
    };
    expect(dispatched.shouldNotify).toBe(true);
    expect(dispatched.selectedChannels).toContain("vellum");
    expect(dispatched.reasoningSummary).toContain(
      "vellum forced: decisionable access request",
    );
  });

  test("re-adds vellum when single_channel routing enforcement strips it", async () => {
    evaluateSignalMock.mockResolvedValue({
      shouldNotify: true,
      selectedChannels: ["vellum", "telegram"],
      reasoningSummary: "LLM selected vellum + telegram",
      renderedCopy: {},
      dedupeKey: "dedupe-ar-2",
      confidence: 0.9,
      fallbackUsed: false,
      persistedDecisionId: "dec-ar-2",
    });
    // single_channel enforcement caps the selection to the source channel.
    enforceRoutingIntentMock.mockImplementation(
      (decision: { selectedChannels: string[] }) => ({
        ...decision,
        selectedChannels: ["telegram"],
      }),
    );

    await emitNotificationSignal({
      sourceEventName: "ingress.access_request",
      sourceChannel: "telegram",
      sourceContextId: "access-req-telegram-user-2",
      requiresConversation: true,
      routingIntent: "single_channel",
      attentionHints: {
        requiresAction: true,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        requestId: "req-2",
        requestCode: "CD34EF",
        sourceChannel: "telegram",
        conversationExternalId: "chat-123",
        actorExternalId: "user-2",
        actorDisplayName: "User Two",
        actorUsername: null,
        senderIdentifier: "User Two",
        guardianBindingChannel: "telegram",
        guardianResolutionSource: "source-channel-contact",
        previousMemberStatus: null,
        messagePreview: null,
      },
    });

    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      selectedChannels: string[];
    };
    expect(dispatched.selectedChannels).toContain("vellum");
    expect(dispatched.selectedChannels).toContain("telegram");
    // The floor's change is re-persisted alongside enforcement's.
    expect(updateDecisionMock).toHaveBeenCalledWith(
      "dec-ar-2",
      expect.objectContaining({
        selectedChannels: expect.arrayContaining(["vellum", "telegram"]),
      }),
    );
  });

  test("does not rescue suppressed non-access-request signals", async () => {
    evaluateSignalMock.mockResolvedValue({
      shouldNotify: false,
      selectedChannels: [],
      reasoningSummary: "LLM suppressed",
      renderedCopy: {},
      dedupeKey: "dedupe-bg-1",
      confidence: 0.9,
      fallbackUsed: false,
      persistedDecisionId: "dec-bg-1",
    });
    enforceRoutingIntentMock.mockImplementation(
      (decision: unknown) => decision,
    );

    await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "rem-2",
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: true,
        visibleInSourceNow: false,
      },
      contextPayload: {},
    });

    // Suppression handling stays inside dispatchDecision — the floor must
    // not have rewritten the decision for a non-access-request signal.
    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      shouldNotify: boolean;
      reasoningSummary: string;
    };
    expect(dispatched.shouldNotify).toBe(false);
    expect(dispatched.reasoningSummary).not.toContain("vellum forced");
  });
});

describe("high/critical urgency channel force", () => {
  function makeDecision(overrides: Record<string, unknown>) {
    return {
      shouldNotify: true,
      selectedChannels: ["telegram"],
      reasoningSummary: "LLM selected telegram only",
      renderedCopy: {},
      dedupeKey: "dedupe-urg-1",
      confidence: 0.9,
      fallbackUsed: false,
      persistedDecisionId: "dec-urg-1",
      ...overrides,
    };
  }

  function emitWithUrgency(urgency: "low" | "medium" | "high" | "critical") {
    return emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "rem-urg-1",
      attentionHints: {
        requiresAction: true,
        urgency,
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: { reminderId: "rem-urg-1" },
    });
  }

  test("forces vellum and platform onto a high-urgency decision missing both", async () => {
    evaluateSignalMock.mockResolvedValue(makeDecision({}));

    const result = await emitWithUrgency("high");

    expect(result.dispatched).toBe(true);
    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      selectedChannels: string[];
      reasoningSummary: string;
    };
    expect(dispatched.selectedChannels).toContain("vellum");
    expect(dispatched.selectedChannels).toContain("platform");
    expect(dispatched.selectedChannels).toContain("telegram");
    expect(dispatched.reasoningSummary).toContain(
      "(vellum, platform forced: high urgency)",
    );
  });

  test("re-persists the stored decision with the force-added channels when routing enforcement is a no-op", async () => {
    evaluateSignalMock.mockResolvedValue(makeDecision({}));

    await emitWithUrgency("high");

    // The identity enforcement mock leaves the decision unchanged, so only
    // the urgency force-add differs from the evaluated decision. The stored
    // row must still be synced to the dispatched channels.
    expect(updateDecisionMock).toHaveBeenCalledTimes(1);
    expect(updateDecisionMock).toHaveBeenCalledWith("dec-urg-1", {
      selectedChannels: ["vellum", "telegram", "platform"],
      reasoningSummary:
        "LLM selected telegram only (vellum, platform forced: high urgency)",
      validationResults: {
        dedupeKey: "dedupe-urg-1",
        channelCount: 3,
        hasCopy: false,
      },
    });
  });

  test("forces only the missing channel when the other is already selected", async () => {
    evaluateSignalMock.mockResolvedValue(
      makeDecision({ selectedChannels: ["vellum"] }),
    );

    await emitWithUrgency("critical");

    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      selectedChannels: string[];
      reasoningSummary: string;
    };
    expect(dispatched.selectedChannels).toEqual(["vellum", "platform"]);
    expect(dispatched.reasoningSummary).toContain(
      "(platform forced: critical urgency)",
    );
  });

  test("leaves a high-urgency decision untouched when both channels are already selected", async () => {
    evaluateSignalMock.mockResolvedValue(
      makeDecision({ selectedChannels: ["vellum", "platform"] }),
    );

    await emitWithUrgency("high");

    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      selectedChannels: string[];
      reasoningSummary: string;
    };
    expect(dispatched.selectedChannels).toEqual(["vellum", "platform"]);
    expect(dispatched.reasoningSummary).not.toContain("forced");
    expect(updateDecisionMock).not.toHaveBeenCalled();
  });

  test("leaves medium and low urgency selections untouched", async () => {
    for (const urgency of ["medium", "low"] as const) {
      dispatchDecisionMock.mockClear();
      evaluateSignalMock.mockResolvedValue(makeDecision({}));

      await emitWithUrgency(urgency);

      const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
        selectedChannels: string[];
        reasoningSummary: string;
      };
      expect(dispatched.selectedChannels).toEqual(["telegram"]);
      expect(dispatched.reasoningSummary).not.toContain("forced");
    }
  });

  test("does not force channels when the decision suppresses the notification", async () => {
    evaluateSignalMock.mockResolvedValue(
      makeDecision({ shouldNotify: false, selectedChannels: [] }),
    );

    await emitWithUrgency("high");

    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      shouldNotify: boolean;
      selectedChannels: string[];
      reasoningSummary: string;
    };
    expect(dispatched.shouldNotify).toBe(false);
    expect(dispatched.selectedChannels).toEqual([]);
    expect(dispatched.reasoningSummary).not.toContain("forced");
  });

  test("routing-intent enforcement runs after the force-add and can cap channels", async () => {
    evaluateSignalMock.mockResolvedValue(makeDecision({}));
    // single_channel enforcement caps the selection to the source channel.
    enforceRoutingIntentMock.mockImplementation(
      (decision: { selectedChannels: string[] }) => ({
        ...decision,
        selectedChannels: ["telegram"],
      }),
    );

    await emitNotificationSignal({
      sourceEventName: "schedule.notify",
      sourceChannel: "scheduler",
      sourceContextId: "rem-urg-2",
      routingIntent: "single_channel",
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: { reminderId: "rem-urg-2" },
    });

    // Enforcement sees the force-added channels...
    const enforcedInput = enforceRoutingIntentMock.mock.calls[0][0] as {
      selectedChannels: string[];
    };
    expect(enforcedInput.selectedChannels).toEqual([
      "vellum",
      "telegram",
      "platform",
    ]);
    // ...and its cap wins over the force-add.
    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      selectedChannels: string[];
    };
    expect(dispatched.selectedChannels).toEqual(["telegram"]);
  });

  test("forces only vellum when the platform client is not configured", async () => {
    isPlatformClientConfiguredMock.mockResolvedValue(false);
    evaluateSignalMock.mockResolvedValue(makeDecision({}));

    await emitWithUrgency("high");

    const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
      selectedChannels: string[];
      reasoningSummary: string;
    };
    expect(dispatched.selectedChannels).toEqual(["vellum", "telegram"]);
    expect(dispatched.reasoningSummary).toContain(
      "(vellum forced: high urgency)",
    );
  });

  // Real single_channel enforcement caps to the source channel when it is
  // connected, else to the FIRST selected channel. The force-add prepends
  // vellum precisely so that fallback keeps the in-app banner; these tests
  // run the genuine enforcement to pin the interplay.
  describe("interplay with real single_channel enforcement", () => {
    beforeEach(() => {
      enforceRoutingIntentMock.mockImplementation(
        realEnforceRoutingIntent as (...args: unknown[]) => unknown,
      );
    });

    function emitHighUrgencySingleChannel(
      sourceChannel: "watcher" | "assistant_tool",
    ) {
      return emitNotificationSignal({
        sourceEventName: "watcher.escalation",
        sourceChannel,
        sourceContextId: "watch-1",
        routingIntent: "single_channel",
        attentionHints: {
          requiresAction: true,
          urgency: "high",
          isAsyncBackground: false,
          visibleInSourceNow: false,
        },
        contextPayload: {},
      });
    }

    test("vellum survives the cap when the decision selected only vellum", async () => {
      evaluateSignalMock.mockResolvedValue(
        makeDecision({ selectedChannels: ["vellum"] }),
      );

      await emitHighUrgencySingleChannel("watcher");

      // Force-add appends platform: ["vellum", "platform"]. The source
      // channel is not connected, so the cap falls back to index 0.
      const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
        selectedChannels: string[];
      };
      expect(dispatched.selectedChannels).toEqual(["vellum"]);
    });

    test("the cap picks the prepended vellum when the decision selected another channel", async () => {
      evaluateSignalMock.mockResolvedValue(
        makeDecision({ selectedChannels: ["telegram"] }),
      );

      await emitHighUrgencySingleChannel("assistant_tool");

      // Force-add yields ["vellum", "telegram", "platform"]; the
      // non-connected source channel makes the cap take index 0.
      const dispatched = dispatchDecisionMock.mock.calls[0][1] as {
        selectedChannels: string[];
      };
      expect(dispatched.selectedChannels).toEqual(["vellum"]);
    });
  });
});
