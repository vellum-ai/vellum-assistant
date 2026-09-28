import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationCreateType } from "../../persistence/conversation-types.js";
import type { NotificationSignal } from "../signal.js";

let enabled = true;
let producing: { conversationType?: ConversationCreateType } | null = null;
const getConversationMock = mock((_id: string) => producing);

mock.module("../../config/assistant-initiated-threads-gate.js", () => ({
  isAssistantInitiatedThreadsEnabled: () => enabled,
}));
mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: getConversationMock,
}));

const { resolveAssistantInitiatedThread } =
  await import("../assistant-initiated-thread.js");

function share(overrides?: Partial<NotificationSignal>): NotificationSignal {
  return {
    signalId: "sig-share",
    createdAt: 1,
    sourceChannel: "assistant_tool",
    sourceContextId: "conv-producer",
    sourceEventName: "assistant.share",
    contextPayload: { body: "Something worth sharing." },
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

beforeEach(() => {
  enabled = true;
  producing = null;
  getConversationMock.mockClear();
});

describe("resolveAssistantInitiatedThread", () => {
  test.each(["background", "scheduled"] as const)(
    "promotes a share from a %s conversation without mutating the input",
    (conversationType) => {
      producing = { conversationType };
      const signal = share();
      const original = structuredClone(signal);

      const resolution = resolveAssistantInitiatedThread(signal);

      expect(resolution.isCandidate).toBe(true);
      expect(resolution.vellumSignal).toEqual({
        ...signal,
        requiresConversation: true,
        conversationMetadata: { source: "assistant_initiated" },
      });
      expect(signal).toEqual(original);
      expect(getConversationMock).toHaveBeenCalledWith("conv-producer");
    },
  );

  test("promotes an unresolved source context", () => {
    const resolution = resolveAssistantInitiatedThread(share());

    expect(resolution.isCandidate).toBe(true);
    expect(resolution.vellumSignal.requiresConversation).toBe(true);
  });

  test.each([{ conversationType: "standard" }, {}] as const)(
    "leaves a resolved user-facing or untyped source unchanged: %j",
    (conversation) => {
      producing = conversation;
      const signal = share();

      const resolution = resolveAssistantInitiatedThread(signal);

      expect(resolution.isCandidate).toBe(false);
      expect(resolution.vellumSignal).toBe(signal);
    },
  );

  test("flag off leaves a background share unchanged without a source lookup", () => {
    enabled = false;
    producing = { conversationType: "background" };
    const signal = share();

    const resolution = resolveAssistantInitiatedThread(signal);

    expect(resolution.isCandidate).toBe(false);
    expect(resolution.vellumSignal).toBe(signal);
    expect(getConversationMock).not.toHaveBeenCalled();
  });

  test.each([
    { sourceEventName: "schedule.notify" },
    { requiresConversation: true },
    { conversationMetadata: { source: "schedule" } },
    { conversationMetadata: { source: "" } },
    {
      requiresConversation: true,
      conversationMetadata: { source: "assistant_initiated" },
    },
  ] satisfies Partial<NotificationSignal>[])(
    "preserves explicit filing and non-share events: %j",
    (overrides) => {
      const signal = share(overrides);

      const resolution = resolveAssistantInitiatedThread(signal);

      expect(resolution.isCandidate).toBe(false);
      expect(resolution.vellumSignal).toBe(signal);
      expect(getConversationMock).not.toHaveBeenCalled();
    },
  );

  test("preserves group and conversation metadata when promoting a passive share", () => {
    const signal = share({
      requiresConversation: false,
      conversationMetadata: {
        conversationType: "scheduled",
        groupId: "group-123",
        scheduleJobId: "job-123",
      },
    });
    const original = structuredClone(signal);

    const resolution = resolveAssistantInitiatedThread(signal);

    expect(resolution.isCandidate).toBe(true);
    expect(resolution.vellumSignal.conversationMetadata).toEqual({
      ...signal.conversationMetadata,
      source: "assistant_initiated",
    });
    expect(signal).toEqual(original);
  });
});
