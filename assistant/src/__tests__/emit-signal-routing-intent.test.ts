import { beforeEach, describe, expect, mock, test } from "bun:test";

const evaluateSignalMock = mock();
const enforceRoutingIntentMock = mock();
const updateDecisionMock = mock();
const runDeterministicChecksMock = mock();
const createEventMock = mock();
const updateEventDedupeKeyMock = mock();
const dispatchDecisionMock = mock();

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
  updateEventDedupeKey: (...args: unknown[]) =>
    updateEventDedupeKeyMock(...args),
}));

mock.module("../notifications/runtime-dispatch.js", () => ({
  dispatchDecision: (...args: unknown[]) => dispatchDecisionMock(...args),
}));

import { emitNotificationSignal } from "../notifications/emit-signal.js";

describe("emitNotificationSignal routing intent re-persistence", () => {
  beforeEach(() => {
    evaluateSignalMock.mockReset();
    enforceRoutingIntentMock.mockReset();
    updateDecisionMock.mockReset();
    runDeterministicChecksMock.mockReset();
    createEventMock.mockReset();
    updateEventDedupeKeyMock.mockReset();
    dispatchDecisionMock.mockReset();

    createEventMock.mockReturnValue({ id: "evt-1" });
    runDeterministicChecksMock.mockResolvedValue({ passed: true });
    dispatchDecisionMock.mockResolvedValue({
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    });
  });

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
  beforeEach(() => {
    evaluateSignalMock.mockReset();
    runDeterministicChecksMock.mockReset();
    createEventMock.mockReset();
    dispatchDecisionMock.mockReset();

    createEventMock.mockReturnValue({ id: "evt-src-active" });
    runDeterministicChecksMock.mockResolvedValue({ passed: true });
    dispatchDecisionMock.mockResolvedValue({
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    });
  });

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
  beforeEach(() => {
    evaluateSignalMock.mockReset();
    enforceRoutingIntentMock.mockReset();
    updateDecisionMock.mockReset();
    runDeterministicChecksMock.mockReset();
    createEventMock.mockReset();
    updateEventDedupeKeyMock.mockReset();
    dispatchDecisionMock.mockReset();
    createEventMock.mockReturnValue({ id: "evt-1" });
    runDeterministicChecksMock.mockResolvedValue({ passed: true });
    dispatchDecisionMock.mockResolvedValue({
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    });
  });

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
