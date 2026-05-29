import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { useRef, type MutableRefObject } from "react";

import type { AssistantEvent } from "@/types/event-types";
import type { ChatEventStream } from "@/domains/chat/api/stream";
import {
  __resetEventBusForTesting,
  useEventBusStore,
} from "@/stores/event-bus-store";

import { useEventStream } from "@/domains/chat/hooks/use-event-stream";

type StreamContext = { assistantId: string; conversationId: string };

function renderEventStream(
  activeConversationId: string,
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void,
) {
  return renderHook(
    ({ key }: { key: string }) => {
      const streamRef = useRef<ChatEventStream | null>(null);
      const streamEpochRef = useRef(0);
      const reconcileAfterNextStreamOpenRef = useRef(false);
      const streamContextRef = useRef<StreamContext | null>(null);
      const syncRouterRef = useRef(null) as MutableRefObject<
        null
      > as never;
      const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
      useEventStream({
        assistantStateKind: "active",
        assistantId: "asst-1",
        activeConversationId: key,
        conversationExistsOnServer: true,
        streamRef,
        streamEpochRef,
        reconcileAfterNextStreamOpenRef,
        streamContextRef,
        handleStreamEvent,
        reconcileActiveConversation: async () =>
          ({
            changed: false,
            messagesAdded: 0,
            assistantProgress: 0,
          }) as never,
        startReconciliationLoop: () => {},
        cancelReconciliation: () => {},
        reachabilityProbe: () => {},
        reachabilityPhase: "ready",
        reachabilityReset: () => {},
        setMessages: () => {},
        setError: () => {},
        syncRouterRef,
        conversationListInvalidatedTimerRef: timerRef,
      });
    },
    { initialProps: { key: activeConversationId } },
  );
}

function publishDelta(conversationId: string): void {
  useEventBusStore.getState().publish("sse.event", {
    type: "assistant_text_delta",
    conversationId,
    delta: "hi",
  } as unknown as AssistantEvent);
}

beforeEach(() => {
  __resetEventBusForTesting();
});

afterEach(() => {
  cleanup();
  __resetEventBusForTesting();
});

describe("useEventStream — conversation-switch filtering", () => {
  test("forwards events whose conversationId matches the active key", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    publishDelta("conv-A");
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("drops events for a non-active conversation", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    publishDelta("conv-B");
    expect(handler).not.toHaveBeenCalled();
  });

  test("rejects in-flight events for the previous conversation as soon as the active key changes", () => {
    const handler = mock(() => {});
    const { rerender } = renderEventStream("conv-A", handler);
    publishDelta("conv-A");
    expect(handler).toHaveBeenCalledTimes(1);

    // Conversation switch: re-render with the new active key. The
    // effect cleanup + re-subscribe has not necessarily run yet on
    // the bus side, but the latest-key ref must already gate further
    // deliveries for the previous conversation.
    rerender({ key: "conv-B" });
    publishDelta("conv-A");
    expect(handler).toHaveBeenCalledTimes(1);

    // Events for the new active key still flow through.
    publishDelta("conv-B");
    expect(handler).toHaveBeenCalledTimes(2);
  });

  test("forwards assistant-broadcast events that omit conversationId", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    useEventBusStore.getState().publish("sse.event", {
      type: "sync_changed",
      tags: ["assistant:self:identity"],
    } as unknown as AssistantEvent);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("rejects conversation-scoped events that omit conversationId (no implicit broadcast)", () => {
    // Regression coverage: before the fix, conversation-scoped events
    // arriving without a conversationId were treated as broadcast and
    // forwarded to whichever conversation was active — causing
    // cross-conversation jumbling. The new filter rejects them: a
    // conversation-scoped event without an explicit key is treated as
    // "unknown conversation", not "broadcast".
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    useEventBusStore.getState().publish("sse.event", {
      type: "assistant_text_delta",
      delta: "should be rejected",
    } as unknown as AssistantEvent);
    expect(handler).not.toHaveBeenCalled();
  });

  test("forwards conversation-scoped events whose conversationId matches the active conversation", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    useEventBusStore.getState().publish("sse.event", {
      type: "message_complete",
      conversationId: "conv-A",
      messageId: "m1",
    } as unknown as AssistantEvent);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("a tool_call event for another conversation is dropped even when the active conversation has no current SSE epoch yet", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    useEventBusStore.getState().publish("sse.event", {
      type: "tool_call",
      conversationId: "conv-B",
      toolName: "bash",
    } as unknown as AssistantEvent);
    expect(handler).not.toHaveBeenCalled();
  });
});
