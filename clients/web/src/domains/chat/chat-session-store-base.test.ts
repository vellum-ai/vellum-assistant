import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { selectTranscriptMessages } from "@/domains/chat/transcript/select-transcript-messages";
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

  test("seedSnapshot drops a stale-anchored fetch the ring can't bridge (send flicker)", () => {
    // The logged incident: the live view seeded at seq 100, then folded the
    // send's user_message_echo (seq 500 — other conversations' events advanced
    // the global counter in between, so the ring can't bridge from 100). The
    // echo handler already retired the optimistic copy, so a pre-send fetch
    // committing now (anchor still 100, no user row) must be dropped — taking
    // it wholesale would erase the just-sent message from the screen.
    const id = registerSseClient(new AbortController().signal);
    store().seedSnapshot(CONV, snapshot([textRow("a1", "earlier")], 100));
    const echo = envelope(500, CONV, {
      type: "user_message_echo",
      text: "hi",
      messageId: "msg-user-1",
      clientMessageId: "nonce-1",
    } as AssistantEvent);
    pushSseEvent(id, echo);
    store().applyEnvelopeToSnapshot(echo);
    expect(store().snapshot?.messages.some((m) => m.id === "msg-user-1")).toBe(true);

    const before = store().snapshot;
    store().seedSnapshot(CONV, snapshot([textRow("a1", "earlier")], 100));

    expect(store().snapshot).toBe(before);
    expect(store().snapshot?.messages.some((m) => m.id === "msg-user-1")).toBe(true);
  });

  test("seedSnapshot accepts a caught-up anchor after dropping a stale one", () => {
    const id = registerSseClient(new AbortController().signal);
    store().seedSnapshot(CONV, snapshot([textRow("a1", "earlier")], 100));
    const echo = envelope(500, CONV, {
      type: "user_message_echo",
      text: "hi",
      messageId: "msg-user-1",
      clientMessageId: "nonce-1",
    } as AssistantEvent);
    pushSseEvent(id, echo);
    store().applyEnvelopeToSnapshot(echo);

    // The authoritative reconcile refetch lands with the persisted user row
    // and an anchor at (or past) the live watermark — reseeds normally.
    const fresh = snapshot(
      [textRow("a1", "earlier"), { ...textRow("msg-user-1", "hi"), role: "user" }],
      500,
    );
    store().seedSnapshot(CONV, fresh);
    expect(store().snapshot?.messages.some((m) => m.id === "msg-user-1")).toBe(true);
    expect(store().snapshot?.seq).toBe(500);
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

  test("optimistic sends add and retire via setOptimisticSends", () => {
    const send: DisplayMessage = { ...textRow("u1", "hi"), role: "user", clientMessageId: "nonce-1" };
    store().addOptimisticSend(send);
    expect(store().optimisticSends.map((m) => m.clientMessageId)).toEqual(["nonce-1"]);
    store().setOptimisticSends((prev) => prev.filter((m) => m.clientMessageId !== "nonce-1"));
    expect(store().optimisticSends).toEqual([]);
  });

  test("seedSnapshot prunes optimistic sends the snapshot already represents", () => {
    // A retained attachment-carrying send (upgraded to the server id by its
    // echo) is retired once the reseeded snapshot carries the persisted row —
    // matched by any shared identity key (server id or nonce).
    store().addOptimisticSend({
      ...textRow("msg-server-1", "pic"),
      role: "user",
      clientMessageId: "nonce-1",
    });
    store().addOptimisticSend({
      ...textRow("u-unconfirmed", "later"),
      role: "user",
      clientMessageId: "nonce-2",
    });

    store().seedSnapshot(
      CONV,
      snapshot([{ ...textRow("msg-server-1", "pic"), role: "user" }], 5),
    );

    expect(store().optimisticSends.map((m) => m.clientMessageId)).toEqual(["nonce-2"]);
  });

  test("switching conversation resets snapshot and optimistic sends", () => {
    store().seedSnapshot(CONV, snapshot([textRow("a1", "x")], 1));
    store().addOptimisticSend({ ...textRow("u1", "hi"), role: "user", clientMessageId: "n" });

    store().switchToConversation({ assistantId: "asst-1", activeConversationId: "conv-B" });

    expect(store().snapshot).toBeNull();
    expect(store().optimisticSends).toEqual([]);
  });

  test("reseed keeps an attachment-carrying send until its snapshot twin is hydrated", () => {
    // A stale in-flight /messages fetch can commit after the echo: the reseed
    // replays the buffered echo into a text-only twin row. Pruning against
    // that unhydrated twin would drop the only blob-preview copy — the send
    // must survive until a snapshot row with attachments lands.
    const send: DisplayMessage = {
      ...textRow("msg-server-1", "pic"),
      role: "user",
      clientMessageId: "nonce-1",
      attachments: [
        {
          id: "att-1",
          filename: "shot.png",
          mimeType: "image/png",
          sizeBytes: 10,
          previewUrl: "blob:preview",
        },
      ],
    };
    store().addOptimisticSend(send);

    // Stale reseed: the twin row shares identity but has no attachments.
    store().seedSnapshot(
      CONV,
      snapshot([{ ...textRow("msg-server-1", "pic"), role: "user" }], 5),
    );
    expect(store().optimisticSends).toEqual([send]);

    // Hydrated reseed: the twin now carries attachment data — send retires.
    store().seedSnapshot(
      CONV,
      snapshot(
        [
          {
            ...textRow("msg-server-1", "pic"),
            role: "user",
            attachments: [
              {
                id: "att-1",
                filename: "shot.png",
                mimeType: "image/png",
                sizeBytes: 10,
                previewUrl: "data:image/png;base64,x",
              },
            ],
          },
        ],
        6,
      ),
    );
    expect(store().optimisticSends).toEqual([]);
  });

  test("attachment previews survive the echo → reseed lifecycle (LUM-2663)", () => {
    // A pasted image's preview lives only on the optimistic send (blob URL).
    // The echo folds a text-only row into the snapshot; the retained
    // (id-upgraded) optimistic copy must keep winning the overlay so the
    // preview never disappears, and the reseed retires it once the server row
    // carries hydrated attachment data.
    const attachment = {
      id: "att-1",
      filename: "shot.png",
      mimeType: "image/png",
      sizeBytes: 10,
      previewUrl: "blob:preview",
    };
    store().seedSnapshot(CONV, snapshot([textRow("a1", "earlier")], 5));
    store().addOptimisticSend({
      ...textRow("client-uuid", "look"),
      role: "user",
      clientMessageId: "nonce-1",
      isOptimistic: true,
      attachments: [attachment],
    });

    // The echo event folds a text-only user row into the snapshot…
    store().applyEnvelopeToSnapshot(
      envelope(6, CONV, {
        type: "user_message_echo",
        text: "look",
        messageId: "msg-server-1",
        clientMessageId: "nonce-1",
      } as AssistantEvent),
    );
    // …while the handler upgrades the retained optimistic copy in place
    // (mirrors handleUserMessageEcho's attachment-carrying branch).
    store().setOptimisticSends((prev) =>
      prev.map((m) =>
        m.clientMessageId === "nonce-1"
          ? { ...m, id: "msg-server-1", isOptimistic: false }
          : m,
      ),
    );

    const midTurn = selectTranscriptMessages(
      store().snapshot!.messages,
      store().optimisticSends,
    );
    const userRow = midTurn.find((m) => m.id === "msg-server-1");
    expect(midTurn.filter((m) => m.role === "user")).toHaveLength(1);
    expect(userRow?.attachments?.[0]?.previewUrl).toBe("blob:preview");

    // Turn-end reseed: the authoritative server row carries hydrated data and
    // retires the overlay copy.
    const serverRow: DisplayMessage = {
      ...textRow("msg-server-1", "look"),
      role: "user",
      clientMessageId: "nonce-1",
      attachments: [{ ...attachment, previewUrl: "data:image/png;base64,x" }],
    };
    store().seedSnapshot(CONV, snapshot([textRow("a1", "earlier"), serverRow], 7));

    expect(store().optimisticSends).toEqual([]);
    const afterReseed = selectTranscriptMessages(
      store().snapshot!.messages,
      store().optimisticSends,
    );
    expect(
      afterReseed.find((m) => m.id === "msg-server-1")?.attachments?.[0]
        ?.previewUrl,
    ).toBe("data:image/png;base64,x");
  });
});
