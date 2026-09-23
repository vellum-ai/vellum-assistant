/**
 * Enqueue contract for a message typed while an `ask_question` card is open.
 *
 * The message is read as the answer: `answerParkedQuestionWithEnqueuedMessage`
 * resolves the parked prompt with the typed text as free text and consumes the
 * queued message, so the parked turn keeps running and the model reads the
 * answer once, in the tool result.
 *
 * Everything a single free-text answer cannot honestly stand in for falls back
 * to `steerOnEnqueuedMessageIfQuestionParked`, which supersedes the prompt by
 * aborting the parked turn and draining the message instead. Confirmations and
 * secrets are separate interaction kinds and are untouched by both paths.
 */
import { afterEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";
import type { QueuedMessage } from "../daemon/conversation-queue-manager.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  answerParkedQuestionWithEnqueuedMessage,
  steerOnEnqueuedMessageIfQuestionParked,
  supersedePendingInteractionsOnEnqueue,
} from "../daemon/handlers/conversations.js";
import type { QuestionPromptResult } from "../permissions/question-prompter.js";
import * as pendingInteractions from "../runtime/pending-interactions.js";

interface ParkedTurn {
  abortCount: () => number;
  fake: { pendingSteerRepair: boolean };
  /** Queue entries still waiting, by request id. */
  queuedIds: () => string[];
  /** Event types emitted through the queued message's own sink. */
  emittedTypes: () => string[];
  enqueue: (message: Partial<QueuedMessage> & { requestId: string }) => void;
}

/**
 * Register a fake conversation whose in-flight turn is parked. The fake exposes
 * just the surface the enqueue paths touch: a processing flag, a queue that can
 * be looked up, promoted and removed from, an abort controller that records
 * aborts, and the confirmation-deny hook.
 */
function registerParkedTurn(id: string): ParkedTurn {
  let abortCount = 0;
  const emitted: string[] = [];
  const queue = new Map<string, QueuedMessage>();
  const fake = {
    isProcessing: () => true,
    queue: {
      findByRequestId: (requestId: string) => queue.get(requestId),
      promoteToHead: (requestId: string) => queue.get(requestId),
    },
    removeQueuedMessage: (requestId: string) => {
      const item = queue.get(requestId);
      queue.delete(requestId);
      return item;
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
  const enqueue = (
    message: Partial<QueuedMessage> & { requestId: string },
  ): void => {
    queue.set(message.requestId, {
      content: "",
      attachments: [],
      onEvent: (event) => {
        emitted.push(event.type);
      },
      sentAt: 0,
      ...message,
    } as QueuedMessage);
  };
  // Every case needs a queued message to act on; the plain typed reply is the
  // common one, and cases that need other content re-enqueue over it.
  enqueue({ requestId: "msg-1", content: "next tuesday works" });
  return {
    abortCount: () => abortCount,
    fake,
    queuedIds: () => [...queue.keys()],
    emittedTypes: () => [...emitted],
    enqueue,
  };
}

const registeredRequestIds: string[] = [];
function registerInteraction(
  conversationId: string,
  kind: "question" | "confirmation" | "secret",
  options: { requestId?: string; questionIds?: string[] } = {},
): { requestId: string; result: () => QuestionPromptResult | undefined } {
  const requestId =
    options.requestId ?? `pending-${kind}-${conversationId}-${Date.now()}`;
  let result: QuestionPromptResult | undefined;
  const questionIds = options.questionIds ?? ["q1"];
  pendingInteractions.register(requestId, {
    conversationId,
    kind,
    ...(kind === "question"
      ? {
          metadata: {
            orderedIds: questionIds,
            optionsById: Object.fromEntries(
              questionIds.map((id) => [id, ["opt-a"]]),
            ),
          },
          rpcResolve: (value: unknown) => {
            result = value as QuestionPromptResult;
          },
        }
      : {}),
  });
  registeredRequestIds.push(requestId);
  return { requestId, result: () => result };
}

const QUESTION_CONV = "steer-enqueue-question";
const CONFIRMATION_CONV = "steer-enqueue-confirmation";
const NONE_CONV = "steer-enqueue-none";

describe("a typed reply answers a parked question", () => {
  afterEach(() => {
    for (const id of registeredRequestIds) {
      pendingInteractions.resolve(id, "cancelled");
    }
    registeredRequestIds.length = 0;
    deleteConversation(QUESTION_CONV);
    deleteConversation(CONFIRMATION_CONV);
    deleteConversation(NONE_CONV);
  });

  test("resolves a single parked question with the typed text", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const question = registerInteraction(QUESTION_CONV, "question");

    const answered = answerParkedQuestionWithEnqueuedMessage(
      QUESTION_CONV,
      "msg-1",
    );

    expect(answered).toBe(true);
    expect(question.result()).toEqual({
      entries: [
        { questionId: "q1", decision: "free_text", text: "next tuesday works" },
      ],
      overall: "completed",
      answeredInChat: true,
    });
    // The parked turn keeps running: no abort, no tool-result repair.
    expect(conv.abortCount()).toBe(0);
    expect(conv.fake.pendingSteerRepair).toBe(false);
    // The message reaches the model through the tool result, so it is consumed
    // rather than run as a turn of its own, and the client's queued row is
    // retired the way a queue delete retires it.
    expect(conv.queuedIds()).toEqual([]);
    expect(conv.emittedTypes()).toEqual(["message_queued_deleted"]);
  });

  test("answers the first question of a batch and leaves the rest unanswered", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const question = registerInteraction(QUESTION_CONV, "question", {
      questionIds: ["q1", "q2", "q3"],
    });

    const answered = answerParkedQuestionWithEnqueuedMessage(
      QUESTION_CONV,
      "msg-1",
    );

    expect(answered).toBe(true);
    expect(question.result()).toEqual({
      entries: [
        { questionId: "q1", decision: "free_text", text: "next tuesday works" },
        { questionId: "q2", decision: "skipped" },
        { questionId: "q3", decision: "skipped" },
      ],
      overall: "completed",
      answeredInChat: true,
    });
    expect(conv.abortCount()).toBe(0);
  });

  test("supersedes instead when the message carries an attachment", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const question = registerInteraction(QUESTION_CONV, "question");
    conv.enqueue({
      requestId: "msg-1",
      content: "here it is",
      attachments: [
        {
          id: "att-1",
          filename: "notes.txt",
          mimeType: "text/plain",
          data: "",
        },
      ],
    });

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(question.result()).toBeUndefined();
    expect(conv.abortCount()).toBe(1);
    expect(conv.queuedIds()).toEqual(["msg-1"]);
  });

  test("supersedes instead when the message is a slash command", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const question = registerInteraction(QUESTION_CONV, "question");
    conv.enqueue({ requestId: "msg-1", content: "/compact" });

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(question.result()).toBeUndefined();
    expect(conv.abortCount()).toBe(1);
  });

  test("supersedes instead when the message is blank", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const question = registerInteraction(QUESTION_CONV, "question");
    conv.enqueue({ requestId: "msg-1", content: "   " });

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(question.result()).toBeUndefined();
    expect(conv.abortCount()).toBe(1);
  });

  test("supersedes instead when the send is automated rather than typed", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const question = registerInteraction(QUESTION_CONV, "question");
    conv.enqueue({
      requestId: "msg-1",
      content: "scheduled follow-up",
      metadata: { automated: true },
    });

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(question.result()).toBeUndefined();
    expect(conv.abortCount()).toBe(1);
  });

  test("supersedes instead when two questions are parked at once", () => {
    // Which prompt the text answers would be a guess, so the old behavior
    // stands: abort the turn and run the message as its own turn.
    const conv = registerParkedTurn(QUESTION_CONV);
    const first = registerInteraction(QUESTION_CONV, "question", {
      requestId: "question-a",
    });
    const second = registerInteraction(QUESTION_CONV, "question", {
      requestId: "question-b",
    });

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(first.result()).toBeUndefined();
    expect(second.result()).toBeUndefined();
    expect(conv.abortCount()).toBe(1);
  });

  test("leaves a parked secret alone while answering the question", () => {
    const conv = registerParkedTurn(QUESTION_CONV);
    const secret = registerInteraction(QUESTION_CONV, "secret");
    const question = registerInteraction(QUESTION_CONV, "question");

    supersedePendingInteractionsOnEnqueue(QUESTION_CONV, "msg-1");

    expect(question.result()?.overall).toBe("completed");
    expect(conv.abortCount()).toBe(0);
    expect(pendingInteractions.get(secret.requestId)?.kind).toBe("secret");
  });

  test("does not answer from a pending confirmation (not a question)", () => {
    const conv = registerParkedTurn(CONFIRMATION_CONV);
    registerInteraction(CONFIRMATION_CONV, "confirmation");

    const answered = answerParkedQuestionWithEnqueuedMessage(
      CONFIRMATION_CONV,
      "msg-1",
    );
    const steered = steerOnEnqueuedMessageIfQuestionParked(
      CONFIRMATION_CONV,
      "msg-1",
    );

    expect(answered).toBe(false);
    expect(steered).toBe(false);
    expect(conv.abortCount()).toBe(0);
    // The message is left on the queue to run as its own turn.
    expect(conv.queuedIds()).toEqual(["msg-1"]);
  });

  test("does nothing when no prompt is parked", () => {
    const conv = registerParkedTurn(NONE_CONV);

    supersedePendingInteractionsOnEnqueue(NONE_CONV, "msg-1");

    expect(conv.abortCount()).toBe(0);
    expect(conv.queuedIds()).toEqual(["msg-1"]);
    expect(conv.emittedTypes()).toEqual([]);
  });
});

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
});

describe("removeByConversation preserves question interactions", () => {
  // The enqueue path's confirmation auto-deny calls removeByConversation before
  // the question is answered or steered to. Questions must survive it (they
  // are settled instead by the answer or by the steer's turn abort) or, when
  // an ask_question and a confirmation are pending concurrently, the queued
  // message would strand behind a question whose entry was cleared (and whose
  // Promise was never settled) before either path fired.
  const CONV = "remove-by-conv-preserve-question";
  const ids: string[] = [];
  function register(kind: "question" | "confirmation"): void {
    const requestId = `rbc-${kind}`;
    pendingInteractions.register(requestId, { conversationId: CONV, kind });
    ids.push(requestId);
  }

  afterEach(() => {
    for (const id of ids) {
      pendingInteractions.resolve(id, "cancelled");
    }
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
