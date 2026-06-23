/**
 * Enqueue-steer contract: when a chat message is enqueued while an
 * `ask_question` prompt is open for the same conversation, the user has chosen
 * to move on rather than answer it. `steerOnEnqueuedMessageIfQuestionParked`
 * steers to that message — aborting the parked turn (which settles the open
 * question via its turn-abort signal) and draining the message — instead of
 * stranding it behind a prompt no one will answer.
 *
 * Only `kind: "question"` interactions trigger the steer; pending confirmations
 * are handled separately by the enqueue path's auto-deny.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  steerOnEnqueuedMessageIfQuestionParked,
  supersedePendingInteractionsOnEnqueue,
} from "../daemon/handlers/conversations.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

interface ParkedTurn {
  abortCount: () => number;
  fake: { pendingSteerRepair: boolean };
}

/**
 * Register a fake conversation whose in-flight turn is parked. The fake exposes
 * just the surface `steerToMessage` touches: a processing flag, a queue whose
 * head can be promoted, an abort controller that records aborts, and the
 * confirmation-deny hook.
 */
function registerParkedTurn(id: string): ParkedTurn {
  let abortCount = 0;
  const fake = {
    isProcessing: () => true,
    queue: {
      promoteToHead: (requestId: string) => ({ requestId }),
    },
    pendingSteerRepair: false,
    abortController: {
      abort: () => {
        abortCount += 1;
      },
    },
    hasAnyPendingConfirmation: () => false,
    denyAllPendingConfirmations: () => {},
  };
  setConversation(id, fake as unknown as Conversation);
  return { abortCount: () => abortCount, fake };
}

const registeredRequestIds: string[] = [];
function registerInteraction(
  conversationId: string,
  kind: "question" | "confirmation",
): void {
  const requestId = `pending-${kind}-${conversationId}`;
  pendingInteractions.register(requestId, { conversationId, kind });
  registeredRequestIds.push(requestId);
}

const QUESTION_CONV = "steer-enqueue-question";
const CONFIRMATION_CONV = "steer-enqueue-confirmation";
const NONE_CONV = "steer-enqueue-none";

describe("steerOnEnqueuedMessageIfQuestionParked", () => {
  afterEach(() => {
    for (const id of registeredRequestIds) {
      pendingInteractions.resolve(id, "cancelled");
    }
    registeredRequestIds.length = 0;
    deleteConversation(QUESTION_CONV);
    deleteConversation(CONFIRMATION_CONV);
    deleteConversation(NONE_CONV);
  });

  test("steers to the enqueued message when an ask_question is parked", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    registerInteraction(QUESTION_CONV, "question");

    const steered = steerOnEnqueuedMessageIfQuestionParked(
      QUESTION_CONV,
      "msg-1",
    );

    // The parked turn is aborted (which settles the open question) and marked
    // for tool-result repair so the drain path can pick up the new message.
    expect(steered).toBe(true);
    expect(conv.abortCount()).toBe(1);
    expect(conv.fake.pendingSteerRepair).toBe(true);
  });

  test("steers for a parked question even when a confirmation is also pending", () => {
    // A single model response can open an ask_question and a confirmation
    // concurrently (tools run via Promise.all), so both interactions can be
    // registered at once. The steer must still fire for the question — the
    // enqueue path runs it before the confirmation auto-deny clears entries.
    const conv = registerParkedTurn(QUESTION_CONV);
    registerInteraction(QUESTION_CONV, "confirmation");
    registerInteraction(QUESTION_CONV, "question");

    const steered = steerOnEnqueuedMessageIfQuestionParked(
      QUESTION_CONV,
      "msg-1",
    );

    expect(steered).toBe(true);
    expect(conv.abortCount()).toBe(1);
  });

  test("does not steer for a pending confirmation (not a question)", () => {
    const conv = registerParkedTurn(CONFIRMATION_CONV);
    registerInteraction(CONFIRMATION_CONV, "confirmation");

    const steered = steerOnEnqueuedMessageIfQuestionParked(
      CONFIRMATION_CONV,
      "msg-1",
    );

    expect(steered).toBe(false);
    expect(conv.abortCount()).toBe(0);
  });

  test("does not steer when no prompt is parked", () => {
    const conv = registerParkedTurn(NONE_CONV);

    const steered = steerOnEnqueuedMessageIfQuestionParked(NONE_CONV, "msg-1");

    expect(steered).toBe(false);
    expect(conv.abortCount()).toBe(0);
  });

  test("supersedePendingInteractionsOnEnqueue steers a parked question", () => {
    // The centralized routine is invoked by both the HTTP send handler and the
    // CLI signal path. With no pending confirmation it steers a parked question
    // — the behavior the CLI signal path previously lacked.
    const conv = registerParkedTurn(QUESTION_CONV);
    registerInteraction(QUESTION_CONV, "question");

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(conv.abortCount()).toBe(1);
    expect(conv.fake.pendingSteerRepair).toBe(true);
  });
});

describe("removeByConversation preserves question interactions", () => {
  // The enqueue path's confirmation auto-deny calls removeByConversation before
  // the steer runs. Questions must survive it — they are settled instead by the
  // steer's turn abort — or, when an ask_question and a confirmation are pending
  // concurrently, the queued message would strand behind a question whose entry
  // was cleared (and whose Promise was never settled) before the steer fired.
  const CONV = "remove-by-conv-preserve-question";
  const ids: string[] = [];
  function register(kind: "question" | "confirmation"): void {
    const requestId = `rbc-${kind}`;
    pendingInteractions.register(requestId, { conversationId: CONV, kind });
    ids.push(requestId);
  }

  afterEach(() => {
    for (const id of ids) pendingInteractions.resolve(id, "cancelled");
    ids.length = 0;
  });

  test("removes confirmations but leaves questions registered", () => {
    register("confirmation");
    register("question");

    pendingInteractions.removeByConversation(CONV);

    const remaining = pendingInteractions
      .getByConversation(CONV)
      .map((interaction) => interaction.kind);
    expect(remaining).toEqual(["question"]);
  });
});
