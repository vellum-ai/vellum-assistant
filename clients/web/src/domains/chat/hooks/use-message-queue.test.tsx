import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";

import type { DisplayMessage } from "@/domains/chat/types/types";

const steerCalls: Array<{
  assistantId: string;
  conversationId: string;
  requestId: string;
}> = [];
let steerResult = true;
const deleteCalls: Array<{
  assistantId: string;
  conversationId: string;
  requestId: string;
}> = [];
let deletePromise = Promise.resolve(true);
let resolveDelete: (deleted: boolean) => void = () => {};

mock.module("@/domains/chat/api/messages", () => ({
  deleteQueuedMessage: (
    assistantId: string,
    conversationId: string,
    requestId: string,
  ) => {
    deleteCalls.push({ assistantId, conversationId, requestId });
    return deletePromise;
  },
  steerToMessage: async (
    assistantId: string,
    conversationId: string,
    requestId: string,
  ) => {
    steerCalls.push({ assistantId, conversationId, requestId });
    return steerResult;
  },
}));

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useMessageQueue } from "@/domains/chat/hooks/use-message-queue";
import { registerHistoryCachePatcher } from "@/domains/chat/transcript/patch-transcript-messages";

function queuedMessage(id: string, clientMessageId: string): DisplayMessage {
  return {
    id,
    clientMessageId,
    role: "user",
    textSegments: ["Steer me"],
    contentOrder: [{ type: "text", id: "0" }],
    contentBlocks: [{ type: "text", text: "Steer me" }],
    timestamp: 1,
    queueStatus: "queued",
    queuePosition: 1,
  };
}

function seedQueuedCopies(): void {
  useChatSessionStore.setState({
    optimisticSends: [queuedMessage("client-1", "client-1")],
    snapshot: {
      messages: [queuedMessage("request-1", "client-1")],
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
      seq: 1,
    },
    requestIdToMessageId: new Map([["request-1", "client-1"]]),
  });
}

beforeEach(() => {
  steerCalls.length = 0;
  steerResult = true;
  deleteCalls.length = 0;
  deletePromise = new Promise<boolean>((resolve) => {
    resolveDelete = resolve;
  });
  registerHistoryCachePatcher(null);
  useChatSessionStore.setState({
    optimisticSends: [],
    snapshot: null,
    pendingQueuedMessageIds: [],
    requestIdToMessageId: new Map(),
    pendingLocalDeletions: new Set(),
  });
});

afterEach(() => {
  cleanup();
  registerHistoryCachePatcher(null);
});

describe("useMessageQueue", () => {
  test("keeps a reconciled queued message visible and cancellable", async () => {
    useChatSessionStore.setState({
      optimisticSends: [queuedMessage("client-1", "client-1")],
      requestIdToMessageId: new Map([["request-1", "client-1"]]),
    });
    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    act(() => {
      useChatSessionStore.getState().seedSnapshot("conversation-1", {
        messages: [queuedMessage("request-1", "client-1")],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      });
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
    expect(result.current.queuedMessages.map((message) => message.id)).toEqual([
      "request-1",
    ]);

    act(() => {
      result.current.handleCancelQueuedMessage("request-1");
    });
    expect(deleteCalls[0]?.requestId).toBe("request-1");

    await act(async () => {
      resolveDelete(true);
      await deletePromise;
    });

    expect(result.current.queuedMessages).toHaveLength(0);
  });

  test("steers a snapshot-backed queued message by its request id", () => {
    useChatSessionStore.setState({
      snapshot: {
        messages: [queuedMessage("request-1", "client-1")],
        hasMore: false,
        oldestTimestamp: null,
        oldestMessageId: null,
        seq: 1,
      },
    });
    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    expect(result.current.queuedMessages).toHaveLength(1);
    act(() => {
      result.current.handleSteerMessage("request-1");
    });

    expect(steerCalls[0]?.requestId).toBe("request-1");
    expect(result.current.queuedMessages).toHaveLength(0);
  });

  test("keeps a queued message visible until deletion is confirmed", async () => {
    seedQueuedCopies();
    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    act(() => {
      result.current.handleCancelQueuedMessage("client-1");
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(1);
    expect(useChatSessionStore.getState().snapshot?.messages).toHaveLength(1);
    expect(deleteCalls).toEqual([
      {
        assistantId: "assistant-1",
        conversationId: "conversation-1",
        requestId: "request-1",
      },
    ]);

    await act(async () => {
      resolveDelete(true);
      await deletePromise;
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(0);
    expect(useChatSessionStore.getState().snapshot?.messages).toHaveLength(0);
    expect(useChatSessionStore.getState().requestIdToMessageId.size).toBe(0);
  });

  test("leaves a queued message visible when deletion fails", async () => {
    seedQueuedCopies();
    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    act(() => {
      result.current.handleCancelQueuedMessage("client-1");
    });
    await act(async () => {
      resolveDelete(false);
      await deletePromise;
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(1);
    expect(useChatSessionStore.getState().snapshot?.messages).toHaveLength(1);
    expect(useChatSessionStore.getState().requestIdToMessageId.size).toBe(1);
  });

  test("keeps an early cancellation visible while its request id is pending", () => {
    seedQueuedCopies();
    useChatSessionStore.setState({
      requestIdToMessageId: new Map(),
      snapshot: null,
    });
    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    act(() => {
      result.current.handleCancelQueuedMessage("client-1");
    });

    expect(useChatSessionStore.getState().optimisticSends).toHaveLength(1);
    expect(
      useChatSessionStore.getState().pendingLocalDeletions.has("client-1"),
    ).toBe(true);
    expect(deleteCalls).toHaveLength(0);
  });

  test("steering promotes both optimistic and snapshot copies into the transcript", () => {
    seedQueuedCopies();

    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    act(() => {
      result.current.handleSteerMessage("client-1");
    });

    expect(
      useChatSessionStore.getState().optimisticSends[0]?.queueStatus,
    ).toBeUndefined();
    expect(
      useChatSessionStore.getState().snapshot?.messages[0]?.queueStatus,
    ).toBeUndefined();
    expect(steerCalls).toEqual([
      {
        assistantId: "assistant-1",
        conversationId: "conversation-1",
        requestId: "request-1",
      },
    ]);
  });

  test("failed steering restores both queued copies", async () => {
    steerResult = false;
    seedQueuedCopies();
    const { result } = renderHook(() =>
      useMessageQueue({
        assistantId: "assistant-1",
        activeConversationId: "conversation-1",
      }),
    );

    await act(async () => {
      result.current.handleSteerMessage("client-1");
      await Promise.resolve();
    });

    expect(
      useChatSessionStore.getState().optimisticSends[0]?.queueStatus,
    ).toBe("queued");
    expect(
      useChatSessionStore.getState().snapshot?.messages[0]?.queueStatus,
    ).toBe("queued");
  });
});
