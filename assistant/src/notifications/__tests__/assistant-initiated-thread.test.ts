import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ConversationCreateType } from "../../persistence/conversation-types.js";
import type { NotificationSignal } from "../signal.js";

let enabled = true;
let producing: {
  conversationType?: ConversationCreateType | "private";
  source?: string;
  archivedAt?: number | null;
} | null = null;
let placement: { isPinned: boolean; groupId: string | null } | undefined;
let seedPersisted = true;
const getMessageByIdMock = mock(
  (_messageId: string, _conversationId: string) =>
    seedPersisted ? { id: "msg-seed" } : null,
);
const getConversationMock = mock((_id: string) => producing);

mock.module("../../config/assistant-initiated-threads-gate.js", () => ({
  isAssistantInitiatedThreadsEnabled: () => enabled,
}));
mock.module("../../persistence/conversation-crud.js", () => ({
  getConversation: getConversationMock,
  getDisplayMetaForConversations: () => new Map([["conv-created", placement]]),
  getMessageById: getMessageByIdMock,
}));

const { resolveAssistantInitiatedThread, isPersistedAssistantInitiatedThread } =
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
  getMessageByIdMock.mockClear();
  placement = { isPinned: false, groupId: null };
  seedPersisted = true;
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

  test("a source read failure preserves unrelated delivery eligibility", () => {
    const signal = share();
    getConversationMock.mockImplementationOnce(() => {
      throw new Error("read unavailable");
    });
    expect(resolveAssistantInitiatedThread(signal)).toEqual({
      isCandidate: false,
      vellumSignal: signal,
    });
  });

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

describe("isPersistedAssistantInitiatedThread", () => {
  beforeEach(() => {
    producing = {
      conversationType: "standard",
      source: "assistant_initiated",
      archivedAt: null,
    };
  });

  test.each([null, "system:all"])(
    "accepts persisted ungrouped placement %s",
    (groupId) => {
      placement = { isPinned: false, groupId };
      expect(
        isPersistedAssistantInitiatedThread("conv-created", "msg-seed"),
      ).toBe(true);
      expect(getMessageByIdMock).toHaveBeenCalledWith(
        "msg-seed",
        "conv-created",
      );
    },
  );

  test.each([
    { isPinned: true, groupId: null },
    { isPinned: false, groupId: "system:pinned" },
    { isPinned: false, groupId: "group-123" },
    { isPinned: false, groupId: "system:background" },
    { isPinned: false, groupId: "system:scheduled" },
    undefined,
  ])("rejects placement outside From me: %j", (value) => {
    placement = value;
    expect(
      isPersistedAssistantInitiatedThread("conv-created", "msg-seed"),
    ).toBe(false);
    expect(getMessageByIdMock).not.toHaveBeenCalled();
  });

  test.each([
    null,
    { source: "user", conversationType: "standard", archivedAt: null },
    {
      source: "assistant_initiated",
      conversationType: "private",
      archivedAt: null,
    },
    {
      source: "assistant_initiated",
      conversationType: "background",
      archivedAt: null,
    },
    {
      source: "assistant_initiated",
      conversationType: "scheduled",
      archivedAt: null,
    },
    {
      source: "assistant_initiated",
      conversationType: "standard",
      archivedAt: 1,
    },
  ] as const)("rejects missing or hidden conversations: %j", (conversation) => {
    producing = conversation;
    expect(
      isPersistedAssistantInitiatedThread("conv-created", "msg-seed"),
    ).toBe(false);
  });

  test("requires both IDs and a seed in the paired conversation", () => {
    expect(isPersistedAssistantInitiatedThread(null, "msg-seed")).toBe(false);
    expect(isPersistedAssistantInitiatedThread("conv-created", null)).toBe(
      false,
    );
    seedPersisted = false;
    expect(
      isPersistedAssistantInitiatedThread("conv-created", "msg-seed"),
    ).toBe(false);
  });

  test("a lookup failure conservatively disables the extra alert", () => {
    getConversationMock.mockImplementationOnce(() => {
      throw new Error("read unavailable");
    });
    expect(
      isPersistedAssistantInitiatedThread("conv-created", "msg-seed"),
    ).toBe(false);
  });
});
