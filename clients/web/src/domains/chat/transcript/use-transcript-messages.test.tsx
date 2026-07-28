import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useTranscriptMessages } from "@/domains/chat/transcript/use-transcript-messages";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { AssistantEvent } from "@/types/event-types";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

function textRow(id: string, text: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    textSegments: [text],
    contentOrder: [{ type: "text", id: "0" }],
    contentBlocks: [{ type: "text", text }],
  };
}

function snapshot(messages: DisplayMessage[], seq: number): PaginatedHistoryResult {
  return { messages, hasMore: false, oldestTimestamp: null, oldestMessageId: null, seq };
}

function envelope(seq: number, message: AssistantEvent): AssistantEventEnvelope {
  return {
    id: `e${seq}`,
    seq,
    emittedAt: new Date(1000 + seq).toISOString(),
    message,
  } as AssistantEventEnvelope;
}

beforeEach(() => {
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});
afterEach(() => {
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

describe("useTranscriptMessages reference stability", () => {
  test("a no-op stream event does not re-derive the transcript", () => {
    useChatSessionStore.setState({
      snapshot: snapshot([textRow("a1", "hello")], 1),
    });

    const { result } = renderHook(() => useTranscriptMessages());
    const first = result.current;
    expect(first.map((m) => m.id)).toEqual(["a1"]);
    const snapshotBefore = useChatSessionStore.getState().snapshot;

    // A turn-lifecycle event mints a new snapshot object but leaves `messages`
    // (transcript content) untouched. The reducer reuses the same `messages`
    // array reference for these events, so the derived transcript must stay
    // referentially stable — this is what keeps the SSE burst that accompanies
    // an app surface arriving mid-stream from thrashing every downstream memo.
    act(() => {
      useChatSessionStore
        .getState()
        .applyEnvelopeToSnapshot(envelope(2, { type: "sync_changed" } as AssistantEvent));
    });

    // The snapshot object identity changed…
    expect(useChatSessionStore.getState().snapshot).not.toBe(snapshotBefore);
    // …but the derived transcript reference did not.
    expect(result.current).toBe(first);
  });

  test("a content-changing event does re-derive the transcript", () => {
    useChatSessionStore.setState({
      snapshot: snapshot([textRow("a1", "hello")], 1),
    });

    const { result } = renderHook(() => useTranscriptMessages());
    const first = result.current;

    act(() => {
      useChatSessionStore.getState().applyEnvelopeToSnapshot(
        envelope(2, {
          type: "assistant_text_delta",
          messageId: "a1",
          text: " world",
        } as AssistantEvent),
      );
    });

    expect(result.current).not.toBe(first);
  });
});
