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

import type { PendingDocumentReply } from "@/domains/chat/document-composer-reply-store";
import { useDocumentComposerReplyStore } from "@/domains/chat/document-composer-reply-store";

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
  useDocumentComposerReplyStore.setState({ pendingReplies: new Map() });
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

describe("clearAwaitingReplies", () => {
  test("drops every conversation's sends at once", () => {
    getState().startAwaitingReply("conv-1", "cm-1");
    getState().startAwaitingReply("conv-1", "cm-2");
    getState().startAwaitingReply("conv-2", "cm-3");

    getState().clearAwaitingReplies();

    expect(getState().pendingReplies.size).toBe(0);
  });

  test("is a no-op when nothing is awaiting a reply", () => {
    const before = getState().pendingReplies;

    getState().clearAwaitingReplies();

    expect(getState().pendingReplies).toBe(before);
  });
});
