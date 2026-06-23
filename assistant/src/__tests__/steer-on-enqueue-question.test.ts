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
import { steerOnEnqueuedMessageIfQuestionParked } from "../daemon/handlers/conversations.js";
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
});
