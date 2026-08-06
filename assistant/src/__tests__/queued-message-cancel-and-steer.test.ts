/**
 * Queue-cancellation and steer-recovery contracts on the shared handlers.
 *
 * `deleteQueuedMessage` broadcasts the cancellation so every client watching
 * the conversation retires the queued row, not just the tab that issued the
 * DELETE, and pairs that event with the same visibility predicate the enqueue
 * ack used.
 *
 * `steerToMessage` promotes a queued message and then aborts the in-flight
 * turn. When the flag is latched with no live controller there is nothing to
 * abort and no agent-loop release coming, so the handler force-clears and
 * drains itself instead of leaving the promoted message at the head of a queue
 * that never runs.
 */
import { afterEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";

const broadcasts: AssistantEvent[] = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: AssistantEvent) => {
    broadcasts.push(msg);
  },
}));

import type { Conversation } from "../daemon/conversation.js";
import type { QueuedMessage } from "../daemon/conversation-queue-manager.js";
import {
  deleteConversation,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  deleteQueuedMessage,
  steerToMessage,
} from "../daemon/handlers/conversations.js";

const CONV = "queued-cancel-conv";

function registerWithQueuedMessage(
  removed: Partial<QueuedMessage> | undefined,
): void {
  const fake = {
    conversationId: CONV,
    isProcessing: () => false,
    removeQueuedMessage: () => removed,
  };
  setConversation(CONV, fake as unknown as Conversation);
}

interface LatchedTurn {
  cleared: () => boolean;
  drainReasons: string[];
  pendingSteerRepair: () => boolean;
}

/**
 * Register a conversation whose processing flag is latched with no live
 * controller: the shape a turn leaves behind when it tore its controller down
 * (or died) without any release running.
 */
function registerLatchedTurn(): LatchedTurn {
  let processing = true;
  const drainReasons: string[] = [];
  const fake = {
    conversationId: CONV,
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      processing = value;
    },
    abortController: null,
    queue: {
      promoteToHead: (requestId: string) => ({ requestId }),
    },
    pendingSteerRepair: false,
    kickDrainQueue: (reason: string) => {
      drainReasons.push(reason);
      return Promise.resolve();
    },
    denyAllPendingConfirmations: () => {},
  };
  setConversation(CONV, fake as unknown as Conversation);
  return {
    cleared: () => !processing,
    drainReasons,
    pendingSteerRepair: () => fake.pendingSteerRepair,
  };
}

describe("deleteQueuedMessage", () => {
  afterEach(() => {
    broadcasts.length = 0;
    deleteConversation(CONV);
  });

  test("broadcasts the cancellation so other clients drop the queued row", () => {
    registerWithQueuedMessage({
      requestId: "req-1",
      clientMessageId: "client-1",
      metadata: {},
    });

    expect(deleteQueuedMessage(CONV, "req-1")).toEqual({ removed: true });
    expect(broadcasts).toEqual([
      {
        type: "message_queued_deleted",
        conversationId: CONV,
        requestId: "req-1",
        clientMessageId: "client-1",
      },
    ]);
  });

  test("omits clientMessageId when the sender minted none", () => {
    registerWithQueuedMessage({ requestId: "req-2", metadata: {} });

    expect(deleteQueuedMessage(CONV, "req-2")).toEqual({ removed: true });
    expect(broadcasts).toEqual([
      {
        type: "message_queued_deleted",
        conversationId: CONV,
        requestId: "req-2",
      },
    ]);
  });

  test("stays silent for an echo-suppressed entry", () => {
    // A daemon-injected notification never produced a `message_queued` ack, so
    // a delete event would be an unpaired retire for a row no client renders.
    registerWithQueuedMessage({
      requestId: "req-3",
      metadata: { subagentNotification: { childId: "child-1" } },
    });

    expect(deleteQueuedMessage(CONV, "req-3")).toEqual({ removed: true });
    expect(broadcasts).toEqual([]);
  });

  test("stays silent when nothing matched the request id", () => {
    registerWithQueuedMessage(undefined);

    expect(deleteQueuedMessage(CONV, "req-missing")).toEqual({
      removed: false,
      reason: "message_not_found",
    });
    expect(broadcasts).toEqual([]);
  });
});

describe("steerToMessage with a latched processing flag", () => {
  afterEach(() => {
    broadcasts.length = 0;
    deleteConversation(CONV);
  });

  test("force-clears and drains when no live controller can be aborted", () => {
    const turn = registerLatchedTurn();

    expect(steerToMessage(CONV, "req-steer")).toEqual({ steered: true });

    // Without the force-clear the promoted message would sit behind a flag
    // nothing is going to release.
    expect(turn.cleared()).toBe(true);
    expect(turn.drainReasons).toEqual(["loop_complete"]);
    // The drain consumes the repair flag, so it must survive the force-clear.
    expect(turn.pendingSteerRepair()).toBe(true);
    expect(broadcasts).toEqual([
      { type: "message_steered", conversationId: CONV, requestId: "req-steer" },
    ]);
  });
});
