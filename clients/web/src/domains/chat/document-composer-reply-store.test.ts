/**
 * Tests for `document-composer-reply-store`, the per-conversation list of
 * document composer sends still owed an assistant reply.
 *
 * `useDocumentComposerSubmit` appends to it before a send and
 * `DocumentComposerReplyWatcher` settles the running entries off it, so the
 * two sides only agree if the acknowledged/queued split and nonce matching
 * are exact: this file pins those semantics directly through the store's
 * non-React API.
 */
import { beforeEach, describe, expect, test } from "bun:test";

import type {
  PendingDocumentReply,
  PendingDocumentReplyPayload,
} from "@/domains/chat/document-composer-reply-store";
import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";

/** A draft and its one uploaded attachment, as a send hands them over. */
const SENT_PAYLOAD: PendingDocumentReplyPayload = {
  surfaceId: "surf-1",
  content: "a note on the draft",
  attachments: [
    {
      id: "srv-1",
      filename: "notes.txt",
      mimeType: "text/plain",
      sizeBytes: 12,
      previewUrl: null,
    },
  ],
};

function getState() {
  return useDocumentComposerReplyStore.getState();
}

function pendingFor(conversationId: string): readonly PendingDocumentReply[] {
  return getState().pendingReplies.get(conversationId) ?? [];
}

function noncesFor(conversationId: string): (string | undefined)[] {
  return pendingFor(conversationId).map((p) => p.clientMessageId);
}

function queuedFlags(conversationId: string): boolean[] {
  return pendingFor(conversationId).map((p) => p.queued);
}

function acknowledgedFlags(conversationId: string): boolean[] {
  return pendingFor(conversationId).map((p) => p.acknowledged);
}

beforeEach(() => {
  useDocumentComposerReplyStore.setState({
    pendingReplies: new Map(),
    failedSends: new Map(),
    handedOffConversationIds: new Set(),
  });
});

describe("startAwaitingReply", () => {
  test("lists sends in the order they went out", () => {
    // GIVEN two document composer sends into one conversation
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    // THEN both wait, oldest first, and the daemon has spoken for neither
    expect(noncesFor("conv-1")).toEqual(["cm-1", "cm-2"]);
    expect(acknowledgedFlags("conv-1")).toEqual([false, false]);
    expect(queuedFlags("conv-1")).toEqual([false, false]);
  });

  test("the same nonce sent twice is listed once", () => {
    // GIVEN a send retried under the nonce it already went out with
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-1");

    // THEN it is the same message, awaiting one reply
    expect(noncesFor("conv-1")).toEqual(["cm-1"]);
  });

  test("two sends carrying no nonce are two waits", () => {
    // GIVEN a daemon too old to echo `clientMessageId`, so neither send
    // records one
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-1");

    // THEN each is still owed its own reply
    expect(pendingFor("conv-1")).toHaveLength(2);
  });

  test("tracks conversations independently", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-2", "cm-2");

    expect(noncesFor("conv-1")).toEqual(["cm-1"]);
    expect(noncesFor("conv-2")).toEqual(["cm-2"]);
  });

  test("keeps the message the send carried", () => {
    // GIVEN a send listed with the draft and attachments it went out with
    getState().startAwaitingReply("conv-1", "cm-1", SENT_PAYLOAD);

    // THEN the message is there to hand back when the daemon reports the
    // send failed after the composer was cleared
    expect(pendingFor("conv-1")[0].payload).toEqual(SENT_PAYLOAD);
  });

  test("a send listed without a message carries none", () => {
    getState().startAwaitingReply("conv-1", "cm-1");

    expect(pendingFor("conv-1")[0].payload).toBeUndefined();
  });
});

describe("stopAwaitingReply", () => {
  test("removes only the send carrying the nonce", () => {
    // GIVEN two sends pending in one conversation
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    // WHEN the newer one is dropped
    getState().stopAwaitingReply("conv-1", "cm-2");

    // THEN the older one is still owed a reply
    expect(noncesFor("conv-1")).toEqual(["cm-1"]);
  });

  test("the conversation drops off once its last send goes", () => {
    getState().startAwaitingReply("conv-1", "cm-1");

    getState().stopAwaitingReply("conv-1", "cm-1");

    expect(getState().pendingReplies.has("conv-1")).toBe(false);
  });

  test("is a no-op for a nonce none of the sends carry", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().stopAwaitingReply("conv-1", "cm-someone-else");

    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op for a conversation with nothing pending", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().stopAwaitingReply("conv-never-sent", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });
});

describe("dropUnacknowledgedReply", () => {
  test("drops a send the daemon has not spoken for", () => {
    // GIVEN a send listed but not yet acknowledged
    getState().startAwaitingReply("conv-1", "cm-1");

    // WHEN the attempt behind it is abandoned
    const dropped = getState().dropUnacknowledgedReply("conv-1", "cm-1");

    // THEN it is off the list, and reports as dropped
    expect(dropped).toBe(true);
    expect(getState().pendingReplies.has("conv-1")).toBe(false);
  });

  test("keeps a send the daemon echoed as running", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyRunning("conv-1", "cm-1");

    const dropped = getState().dropUnacknowledgedReply("conv-1", "cm-1");

    expect(dropped).toBe(false);
    expect(noncesFor("conv-1")).toEqual(["cm-1"]);
  });

  test("keeps a send the daemon acked as queued", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");

    const dropped = getState().dropUnacknowledgedReply("conv-1", "cm-1");

    expect(dropped).toBe(false);
    expect(queuedFlags("conv-1")).toEqual([true]);
  });

  test("drops only the send carrying the nonce", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    getState().dropUnacknowledgedReply("conv-1", "cm-1");

    expect(noncesFor("conv-1")).toEqual(["cm-2"]);
  });

  test("is a no-op for a nonce none of the sends carry", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    const dropped = getState().dropUnacknowledgedReply("conv-1", "cm-other");

    expect(dropped).toBe(false);
    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op for a conversation with nothing pending", () => {
    const before = getState().pendingReplies;

    const dropped = getState().dropUnacknowledgedReply("conv-none", "cm-1");

    expect(dropped).toBe(false);
    expect(getState().pendingReplies).toBe(before);
  });
});

describe("settleRunningReplies", () => {
  test("settles nothing in a conversation with nothing pending", () => {
    expect(getState().settleRunningReplies("conv-1")).toBe(0);
  });

  test("answers the running send and drops it", () => {
    // GIVEN one send, running because nothing else held the conversation
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyRunning("conv-1", "cm-1");

    // WHEN the turn it started ends
    const settled = getState().settleRunningReplies("conv-1");

    // THEN it is answered, and the conversation drops off with it
    expect(settled).toBe(1);
    expect(getState().pendingReplies.has("conv-1")).toBe(false);
  });

  test("settles nothing the daemon has not spoken for yet", () => {
    // GIVEN a send listed before its POST reached the daemon
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    // WHEN a turn already running in the conversation ends
    const settled = getState().settleRunningReplies("conv-1");

    // THEN that terminal belongs to a turn this send is not in
    expect(settled).toBe(0);
    expect(getState().pendingReplies).toBe(before);
  });

  test("counts only the sends that are running", () => {
    // GIVEN one send running, one parked in the queue, and one the daemon has
    // not spoken for
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().startAwaitingReply("conv-1", "cm-3");
    getState().markReplyRunning("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-2");

    const settled = getState().settleRunningReplies("conv-1");

    expect(settled).toBe(1);
    expect(noncesFor("conv-1")).toEqual(["cm-2", "cm-3"]);
  });

  test("one terminal answers every send the daemon ran in the same turn", () => {
    // GIVEN two sends the daemon dequeued together, which one turn answers
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().markReplyRunning("conv-1", "cm-1");
    getState().markReplyRunning("conv-1", "cm-2");

    const settled = getState().settleRunningReplies("conv-1");

    expect(settled).toBe(2);
    expect(getState().pendingReplies.has("conv-1")).toBe(false);
  });

  test("leaves a queued send behind the running one it settles", () => {
    // GIVEN a running send and a second one parked behind it
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().markReplyRunning("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-2");

    const settled = getState().settleRunningReplies("conv-1");

    expect(settled).toBe(1);
    expect(noncesFor("conv-1")).toEqual(["cm-2"]);
    expect(queuedFlags("conv-1")).toEqual([true]);
  });

  test("settles nothing while every send is queued", () => {
    // GIVEN a send parked behind a turn this composer sent nothing toward
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");
    const before = getState().pendingReplies;

    // WHEN that other turn ends
    const settled = getState().settleRunningReplies("conv-1");

    // THEN the terminal was not this send's, and the wait stands untouched
    expect(settled).toBe(0);
    expect(getState().pendingReplies).toBe(before);
    expect(queuedFlags("conv-1")).toEqual([true]);

    // Only its own dequeue makes it settleable.
    getState().clearReplyQueued("conv-1", "cm-1");

    expect(getState().settleRunningReplies("conv-1")).toBe(1);
  });
});

describe("markReplyRunning", () => {
  test("acknowledges the send carrying the nonce", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    getState().markReplyRunning("conv-1", "cm-2");

    expect(acknowledgedFlags("conv-1")).toEqual([false, true]);
    expect(queuedFlags("conv-1")).toEqual([false, false]);
  });

  test("an echo carrying no nonce speaks for the oldest send still waiting", () => {
    // GIVEN an older daemon, which echoes the send back without the nonce
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    getState().markReplyRunning("conv-1");

    // THEN the send at the front of the list is the one it took in
    expect(acknowledgedFlags("conv-1")).toEqual([true, false]);

    // The next echo speaks for the next one the daemon has said nothing about.
    getState().markReplyRunning("conv-1");

    expect(acknowledgedFlags("conv-1")).toEqual([true, true]);
  });

  test("acknowledges the oldest send when no pending send carries a nonce", () => {
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-1");

    getState().markReplyRunning("conv-1", "cm-1");

    expect(acknowledgedFlags("conv-1")).toEqual([true, false]);
  });

  test("is a no-op for a nonce none of the sends carry", () => {
    // GIVEN sends that do carry nonces, so the echo is another client's
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    const before = getState().pendingReplies;

    getState().markReplyRunning("conv-1", "cm-someone-else");

    expect(getState().pendingReplies).toBe(before);
    expect(acknowledgedFlags("conv-1")).toEqual([false, false]);
  });

  test("is a no-op for a send already running", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyRunning("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().markReplyRunning("conv-1", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });

  test("takes a queued send off the queue", () => {
    // GIVEN a send the daemon parked and then started a turn for
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");

    getState().markReplyRunning("conv-1", "cm-1");

    expect(queuedFlags("conv-1")).toEqual([false]);
    expect(getState().settleRunningReplies("conv-1")).toBe(1);
  });

  test("is a no-op for a conversation with nothing pending", () => {
    const before = getState().pendingReplies;

    getState().markReplyRunning("conv-1", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });
});

describe("markReplyQueued", () => {
  test("flags the send carrying the nonce", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    getState().markReplyQueued("conv-1", "cm-1");

    expect(queuedFlags("conv-1")).toEqual([true, false]);
  });

  test("the ack is the daemon speaking for the send", () => {
    getState().startAwaitingReply("conv-1", "cm-1");

    getState().markReplyQueued("conv-1", "cm-1");

    // Acknowledged but not running, so a terminal for the turn ahead of it
    // still is not its reply.
    expect(acknowledgedFlags("conv-1")).toEqual([true]);
    expect(getState().settleRunningReplies("conv-1")).toBe(0);
  });

  test("an ack carrying no nonce flags the newest send", () => {
    // GIVEN an older daemon, which acks the queue without echoing the nonce
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");

    getState().markReplyQueued("conv-1");

    // THEN the send that just went out is the one that got queued
    expect(queuedFlags("conv-1")).toEqual([false, true]);
  });

  test("flags the newest send when no pending send carries a nonce", () => {
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-1");

    getState().markReplyQueued("conv-1", "cm-1");

    expect(queuedFlags("conv-1")).toEqual([false, true]);
  });

  test("is a no-op for a nonce none of the sends carry", () => {
    // GIVEN sends that do carry nonces, so the ack names another client's
    // message
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    const before = getState().pendingReplies;

    getState().markReplyQueued("conv-1", "cm-someone-else");

    expect(getState().pendingReplies).toBe(before);
    expect(queuedFlags("conv-1")).toEqual([false, false]);
  });

  test("is a no-op for a send already flagged", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().markReplyQueued("conv-1", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op for a conversation with nothing pending", () => {
    const before = getState().pendingReplies;

    getState().markReplyQueued("conv-1", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });
});

describe("clearReplyQueued", () => {
  test("unflags the send carrying the nonce", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().markReplyQueued("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-2");

    getState().clearReplyQueued("conv-1", "cm-2");

    expect(queuedFlags("conv-1")).toEqual([true, false]);
  });

  test("leaves the send acknowledged, so its own turn's terminal answers it", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");

    getState().clearReplyQueued("conv-1", "cm-1");

    expect(acknowledgedFlags("conv-1")).toEqual([true]);
    expect(getState().settleRunningReplies("conv-1")).toBe(1);
  });

  test("a dequeue carrying no nonce unflags the oldest queued send", () => {
    // GIVEN two queued sends and a daemon that does not echo the nonce
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().markReplyQueued("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-2");

    getState().clearReplyQueued("conv-1");

    // THEN the drain started the one at the front of the queue
    expect(queuedFlags("conv-1")).toEqual([false, true]);
  });

  test("unflags the oldest queued send when no pending send carries a nonce", () => {
    getState().startAwaitingReply("conv-1");
    getState().startAwaitingReply("conv-1");
    getState().markReplyQueued("conv-1");

    getState().clearReplyQueued("conv-1", "cm-1");

    expect(queuedFlags("conv-1")).toEqual([false, false]);
  });

  test("is a no-op for a nonce none of the sends carry", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().clearReplyQueued("conv-1", "cm-someone-else");

    expect(getState().pendingReplies).toBe(before);
    expect(queuedFlags("conv-1")).toEqual([true]);
  });

  test("is a no-op for a send that was never flagged", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().clearReplyQueued("conv-1", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op when nothing in the conversation is queued", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().clearReplyQueued("conv-1");

    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op for a conversation with nothing pending", () => {
    const before = getState().pendingReplies;

    getState().clearReplyQueued("conv-1", "cm-1");

    expect(getState().pendingReplies).toBe(before);
  });
});

describe("rekeyReplyByNonce", () => {
  test("moves the send under the row the daemon answered on", () => {
    // GIVEN a send listed under the client key its POST went out with
    getState().startAwaitingReply("draft-key", "cm-1");

    // WHEN a stream event names that nonce under the row the daemon minted
    const previous = getState().rekeyReplyByNonce("cm-1", "conv-server");

    // THEN the wait moves onto the row, and the key it left is reported
    expect(previous).toBe("draft-key");
    expect(noncesFor("conv-server")).toEqual(["cm-1"]);
  });

  test("carries the message the send went out with across", () => {
    getState().startAwaitingReply("draft-key", "cm-1", SENT_PAYLOAD);

    getState().rekeyReplyByNonce("cm-1", "conv-server");

    expect(pendingFor("conv-server")[0].payload).toEqual(SENT_PAYLOAD);
  });

  test("carries the document the message was composed for across", () => {
    // The conversation the daemon answers on says nothing about which
    // document's composer the message came from, so the surface rides along.
    getState().startAwaitingReply("draft-key", "cm-1", SENT_PAYLOAD);

    getState().rekeyReplyByNonce("cm-1", "conv-server");

    expect(pendingFor("conv-server")[0].payload?.surfaceId).toBe("surf-1");
  });

  test("carries the acknowledged and queued flags across", () => {
    getState().startAwaitingReply("draft-key", "cm-1");
    getState().markReplyQueued("draft-key", "cm-1");

    getState().rekeyReplyByNonce("cm-1", "conv-server");

    expect(acknowledgedFlags("conv-server")).toEqual([true]);
    expect(queuedFlags("conv-server")).toEqual([true]);
  });

  test("the emptied key drops off", () => {
    getState().startAwaitingReply("draft-key", "cm-1");

    getState().rekeyReplyByNonce("cm-1", "conv-server");

    expect(getState().pendingReplies.has("draft-key")).toBe(false);
  });

  test("joins the tail of the row's own sends", () => {
    getState().startAwaitingReply("conv-server", "cm-1");
    getState().startAwaitingReply("draft-key", "cm-2");

    getState().rekeyReplyByNonce("cm-2", "conv-server");

    expect(noncesFor("conv-server")).toEqual(["cm-1", "cm-2"]);
  });

  test("leaves the key's other sends where they are", () => {
    getState().startAwaitingReply("draft-key", "cm-1");
    getState().startAwaitingReply("draft-key", "cm-2");

    getState().rekeyReplyByNonce("cm-2", "conv-server");

    expect(noncesFor("draft-key")).toEqual(["cm-1"]);
    expect(noncesFor("conv-server")).toEqual(["cm-2"]);
  });

  test("is a no-op for a send already under the row", () => {
    getState().startAwaitingReply("conv-server", "cm-1");
    const before = getState().pendingReplies;

    const previous = getState().rekeyReplyByNonce("cm-1", "conv-server");

    expect(previous).toBeNull();
    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op for a nonce nothing is waiting under", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    const previous = getState().rekeyReplyByNonce("cm-other", "conv-server");

    expect(previous).toBeNull();
    expect(getState().pendingReplies).toBe(before);
  });

  test("drops the stray entry when the row already lists the nonce", () => {
    // GIVEN the same send listed twice: once under the key, once under the
    // row the response already moved it to
    getState().startAwaitingReply("draft-key", "cm-1");
    getState().startAwaitingReply("conv-server", "cm-1");
    getState().markReplyRunning("conv-server", "cm-1");

    const previous = getState().rekeyReplyByNonce("cm-1", "conv-server");

    // THEN the row keeps the one it holds, and the key's copy goes
    expect(previous).toBe("draft-key");
    expect(getState().pendingReplies.has("draft-key")).toBe(false);
    expect(noncesFor("conv-server")).toEqual(["cm-1"]);
    expect(acknowledgedFlags("conv-server")).toEqual([true]);
  });
});

describe("acknowledgeReply", () => {
  test("a response saying the send is running makes it settleable", () => {
    getState().startAwaitingReply("conv-1", "cm-1");

    getState().acknowledgeReply("conv-1", "cm-1", false);

    expect(acknowledgedFlags("conv-1")).toEqual([true]);
    expect(getState().settleRunningReplies("conv-1")).toBe(1);
  });

  test("a response saying the send is queued parks it", () => {
    getState().startAwaitingReply("conv-1", "cm-1");

    getState().acknowledgeReply("conv-1", "cm-1", true);

    expect(queuedFlags("conv-1")).toEqual([true]);
    expect(getState().settleRunningReplies("conv-1")).toBe(0);
  });

  test("names the send by nonce alone", () => {
    // GIVEN a send carrying no nonce, which no response can name
    getState().startAwaitingReply("conv-1");
    const before = getState().pendingReplies;

    getState().acknowledgeReply("conv-1", "cm-1", false);

    expect(getState().pendingReplies).toBe(before);
    expect(acknowledgedFlags("conv-1")).toEqual([false]);
  });

  test("is a no-op for a nonce none of the sends carry", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().acknowledgeReply("conv-1", "cm-someone-else", false);

    expect(getState().pendingReplies).toBe(before);
  });

  test("leaves a send the stream already started alone", () => {
    // GIVEN the echo reaching the client ahead of the send's POST response
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyRunning("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().acknowledgeReply("conv-1", "cm-1", true);

    // THEN the late response does not park a send that is already running
    expect(getState().pendingReplies).toBe(before);
    expect(queuedFlags("conv-1")).toEqual([false]);
  });

  test("leaves a send the stream already queued alone", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().markReplyQueued("conv-1", "cm-1");
    const before = getState().pendingReplies;

    getState().acknowledgeReply("conv-1", "cm-1", false);

    expect(getState().pendingReplies).toBe(before);
    expect(queuedFlags("conv-1")).toEqual([true]);
  });

  test("is a no-op for a conversation with nothing pending", () => {
    const before = getState().pendingReplies;

    getState().acknowledgeReply("conv-1", "cm-1", false);

    expect(getState().pendingReplies).toBe(before);
  });
});

describe("markHandedOff", () => {
  test("names the conversation, and clearHandedOff takes the name back", () => {
    getState().markHandedOff("conv-1");

    expect(getState().handedOffConversationIds.has("conv-1")).toBe(true);
    expect(getState().clearHandedOff("conv-1")).toBe(true);
    expect(getState().handedOffConversationIds.has("conv-1")).toBe(false);
  });

  test("naming one conversation twice names it once", () => {
    getState().markHandedOff("conv-1");
    const before = getState().handedOffConversationIds;

    getState().markHandedOff("conv-1");

    expect(getState().handedOffConversationIds).toBe(before);
  });

  test("names each conversation on its own", () => {
    getState().markHandedOff("conv-1");
    getState().markHandedOff("conv-2");

    expect(getState().clearHandedOff("conv-1")).toBe(true);
    expect(getState().handedOffConversationIds.has("conv-2")).toBe(true);
  });
});

describe("clearHandedOff", () => {
  test("reports false for a conversation no handoff named", () => {
    const before = getState().handedOffConversationIds;

    expect(getState().clearHandedOff("conv-1")).toBe(false);
    expect(getState().handedOffConversationIds).toBe(before);
  });
});

describe("clearAwaitingReplies", () => {
  test("drops every conversation's sends at once", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().startAwaitingReply("conv-2", "cm-3");

    getState().clearAwaitingReplies();

    expect(getState().pendingReplies.size).toBe(0);
  });

  test("drops every held message too", () => {
    // An assistant switch, a logout, or the lifecycle reset must not carry
    // one user's message into the next context.
    getState().stashFailedSend(SENT_PAYLOAD);
    getState().stashFailedSend({ ...SENT_PAYLOAD, surfaceId: "surf-2" });

    getState().clearAwaitingReplies();

    expect(getState().failedSends.size).toBe(0);
  });

  test("drops every handed-off conversation too", () => {
    // The outgoing assistant's stream sends no terminal for its
    // conversations, so a name left here would answer a later turn of some
    // other assistant's.
    getState().markHandedOff("conv-1");
    getState().markHandedOff("conv-2");

    getState().clearAwaitingReplies();

    expect(getState().handedOffConversationIds.size).toBe(0);
  });

  test("is a no-op when nothing is awaiting a reply", () => {
    const before = getState().pendingReplies;

    getState().clearAwaitingReplies();

    expect(getState().pendingReplies).toBe(before);
  });

  test("is a no-op when nothing is held either", () => {
    const before = getState().failedSends;

    getState().clearAwaitingReplies();

    expect(getState().failedSends).toBe(before);
  });

  test("is a no-op when no conversation has handed off either", () => {
    const before = getState().handedOffConversationIds;

    getState().clearAwaitingReplies();

    expect(getState().handedOffConversationIds).toBe(before);
  });
});

describe("stashFailedSend", () => {
  test("holds the message under the document it was composed for", () => {
    getState().stashFailedSend(SENT_PAYLOAD);

    expect(getState().failedSends.get("surf-1")).toEqual(SENT_PAYLOAD);
  });

  test("a second failure for the same document keeps both messages", () => {
    // Two sends from one document can fail before its composer is on screen
    // to take either back, and neither message is the one to lose.
    getState().stashFailedSend(SENT_PAYLOAD);
    getState().stashFailedSend({
      surfaceId: "surf-1",
      content: "a second note",
      attachments: [
        {
          id: "srv-2",
          filename: "more.txt",
          mimeType: "text/plain",
          sizeBytes: 5,
          previewUrl: null,
        },
      ],
    });

    // THEN they read oldest first, a blank line apart, and both files are
    // there in the order they were sent
    const held = getState().failedSends.get("surf-1");
    expect(held?.content).toBe("a note on the draft\n\na second note");
    expect(held?.attachments.map((a) => a.id)).toEqual(["srv-1", "srv-2"]);
  });

  test("a message with no text joins by the text there is", () => {
    // An attachment-only send carries no draft, so there is nothing to put a
    // blank line around.
    getState().stashFailedSend({ ...SENT_PAYLOAD, content: "" });
    getState().stashFailedSend({ ...SENT_PAYLOAD, content: "the only text" });

    expect(getState().failedSends.get("surf-1")?.content).toBe("the only text");
  });

  test("holds each document's message separately", () => {
    getState().stashFailedSend(SENT_PAYLOAD);
    getState().stashFailedSend({
      ...SENT_PAYLOAD,
      surfaceId: "surf-2",
      content: "another document's note",
    });

    expect(getState().failedSends.get("surf-1")?.content).toBe(
      "a note on the draft",
    );
    expect(getState().failedSends.get("surf-2")?.content).toBe(
      "another document's note",
    );
  });
});

describe("takeFailedSend", () => {
  test("returns the document's message and stops holding it", () => {
    getState().stashFailedSend(SENT_PAYLOAD);

    expect(getState().takeFailedSend("surf-1")).toEqual(SENT_PAYLOAD);

    expect(getState().failedSends.has("surf-1")).toBe(false);
  });

  test("reports nothing for a document holding no message", () => {
    expect(getState().takeFailedSend("surf-1")).toBeNull();
  });

  test("leaves another document's message alone", () => {
    getState().stashFailedSend(SENT_PAYLOAD);
    getState().stashFailedSend({
      ...SENT_PAYLOAD,
      surfaceId: "surf-2",
      content: "another document's note",
    });

    getState().takeFailedSend("surf-1");

    expect(getState().failedSends.get("surf-2")?.content).toBe(
      "another document's note",
    );
  });
});
