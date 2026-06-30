import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import {
  pushSseEvent,
  registerSseClient,
  resetSseDebugStateForTests,
} from "@/lib/streaming/stream-debug";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";
import type { DisplayMessage } from "@/domains/chat/types/types";
import type { AssistantEvent } from "@/types/event-types";
import type { AssistantEventEnvelope } from "@vellumai/assistant-api";

const CONV = "conv-A";

function snapshot(
  messages: DisplayMessage[],
  seq: number | null,
): PaginatedHistoryResult {
  return { messages, hasMore: false, oldestTimestamp: null, oldestMessageId: null, seq };
}
function textRow(id: string, text: string): DisplayMessage {
  return {
    id,
    role: "assistant",
    textSegments: [text],
    contentOrder: [{ type: "text", id: "0" }],
    contentBlocks: [{ type: "text", text }],
  };
}
function envelope(seq: number, conversationId: string, message: AssistantEvent): AssistantEventEnvelope {
  return {
    id: `e${seq}`,
    conversationId,
    seq,
    emittedAt: new Date(1000 + seq).toISOString(),
    message,
  } as AssistantEventEnvelope;
}
const textDelta = (seq: number, conv: string, id: string, text: string) =>
  envelope(seq, conv, { type: "assistant_text_delta", messageId: id, text } as AssistantEvent);

const store = () => useChatSessionStore.getState();

beforeEach(() => {
  resetSseDebugStateForTests();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});
afterEach(() => {
  resetSseDebugStateForTests();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

describe("chat-session-store — snapshot + optimistic", () => {
  test("seedSnapshot with no buffered tail uses the snapshot as-is", () => {
    const snap = snapshot([textRow("a1", "persisted")], 5);
    store().seedSnapshot(CONV, snap);
    expect(store().snapshot).toBe(snap); // resolveSnapshot returns the snapshot ref
  });

  test("seedSnapshot replays the buffered tail (events that raced the fetch)", () => {
    const id = registerSseClient(new AbortController().signal);
    // The ring reaches back to the cursor (oldest retained seq 6 <= snapshot.seq+1).
    pushSseEvent(id, textDelta(6, CONV, "a1", " + live"));

    store().seedSnapshot(CONV, snapshot([textRow("a1", "persisted")], 5));

    expect(store().snapshot?.messages.find((m) => m.id === "a1")?.textSegments).toEqual([
      "persisted + live",
    ]);
    expect(store().snapshot?.seq).toBe(6);
  });

  test("seedSnapshot takes the snapshot wholesale when the tail is an eviction gap", () => {
    const id = registerSseClient(new AbortController().signal);
    // Oldest retained seq (50) is past snapshot.seq+1 → getSseEnvelopesSince → null.
    pushSseEvent(id, textDelta(50, CONV, "a1", " evicted-gap"));

    const snap = snapshot([textRow("a1", "persisted")], 5);
    store().seedSnapshot(CONV, snap);
    expect(store().snapshot).toBe(snap); // wholesale, no partial replay
  });

  test("applyEnvelopeToSnapshot folds a live event once seeded; idempotent by seq", () => {
    store().seedSnapshot(CONV, snapshot([textRow("a1", "persisted")], 5));
    store().applyEnvelopeToSnapshot(textDelta(6, CONV, "a1", " live"));
    expect(store().snapshot?.messages.find((m) => m.id === "a1")?.textSegments).toEqual([
      "persisted live",
    ]);
    // Re-applying seq 6 is a no-op.
    const before = store().snapshot;
    store().applyEnvelopeToSnapshot(textDelta(6, CONV, "a1", " live"));
    expect(store().snapshot).toBe(before);
  });

  test("applyEnvelopeToSnapshot is a no-op before the snapshot is seeded", () => {
    store().applyEnvelopeToSnapshot(textDelta(6, CONV, "a1", "x"));
    expect(store().snapshot).toBeNull();
  });

  test("optimistic sends add and clear by clientMessageId", () => {
    const send: DisplayMessage = { ...textRow("u1", "hi"), role: "user", clientMessageId: "nonce-1" };
    store().addOptimisticSend(send);
    expect(store().optimisticSends.map((m) => m.clientMessageId)).toEqual(["nonce-1"]);
    store().clearOptimisticSend("nonce-1");
    expect(store().optimisticSends).toEqual([]);
  });

  test("switching conversation resets snapshot and optimistic sends", () => {
    store().seedSnapshot(CONV, snapshot([textRow("a1", "x")], 1));
    store().addOptimisticSend({ ...textRow("u1", "hi"), role: "user", clientMessageId: "n" });

    store().switchToConversation({ assistantId: "asst-1", activeConversationId: "conv-B" });

    expect(store().snapshot).toBeNull();
    expect(store().optimisticSends).toEqual([]);
  });
});
