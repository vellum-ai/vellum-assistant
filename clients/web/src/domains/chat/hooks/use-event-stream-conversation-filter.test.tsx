import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import type { AssistantEvent } from "@/types/event-types";
import {
  __resetForTesting,
  publish,
} from "@/lib/event-bus";

import { useEventStream } from "@/domains/chat/hooks/use-event-stream";

function renderEventStream(
  activeConversationId: string,
  handleStreamEvent: (event: AssistantEvent, epoch: number) => void,
) {
  return renderHook(
    ({ key }: { key: string }) => {

      useEventStream({
        assistantStateKind: "active",
        assistantId: "asst-1",
        activeConversationId: key,
        conversationExistsOnServer: true,
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
      });
    },
    { initialProps: { key: activeConversationId } },
  );
}

function publishDelta(conversationId: string): void {
  publish("sse.event", {
    id: "evt-1",
    conversationId,
    emittedAt: new Date().toISOString(),
    message: {
      type: "assistant_text_delta",
      conversationId,
      text: "hi",
    },
  } as AssistantEventEnvelope);
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
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
    // bus subscription is stable (never torn down / re-registered),
    // but the `activeConversationIdLatestRef` is updated during the
    // commit phase and gates further deliveries for the old key.
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
    publish("sse.event", {
      id: "evt-sync",
      emittedAt: new Date().toISOString(),
      message: {
        type: "sync_changed",
        tags: ["assistant:self:identity"],
      },
    } as AssistantEventEnvelope);
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
    publish("sse.event", {
      id: "evt-no-conv",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        text: "should be rejected",
      },
    } as AssistantEventEnvelope);
    expect(handler).not.toHaveBeenCalled();
  });

  test("forwards conversation-scoped events whose conversationId matches the active conversation", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    publish("sse.event", {
      id: "evt-msg",
      conversationId: "conv-A",
      emittedAt: new Date().toISOString(),
      message: {
        type: "message_complete",
        conversationId: "conv-A",
        messageId: "m1",
      },
    } as AssistantEventEnvelope);
    expect(handler).toHaveBeenCalledTimes(1);
  });

  test("a conversation-scoped event for another conversation is dropped even when the active conversation has no current SSE epoch yet", () => {
    const handler = mock(() => {});
    renderEventStream("conv-A", handler);
    publish("sse.event", {
      id: "evt-tool",
      conversationId: "conv-B",
      emittedAt: new Date().toISOString(),
      message: {
        type: "assistant_text_delta",
        conversationId: "conv-B",
        text: "should be dropped",
      },
    } as AssistantEventEnvelope);
    expect(handler).not.toHaveBeenCalled();
  });
});
