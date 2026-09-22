/**
 * `submitUserTurn`: what a user's send does to the conversation it is
 * addressed to.
 *
 * Idle runs it now, busy-and-eligible stops the running turn and runs it in
 * that turn's place, and everything else waits for the conversation to free
 * up. The one thing that never happens is the send being dropped.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../../api/index.js";
import type { Conversation } from "../conversation.js";

// The interrupt reaches the real abort watchdog, the turn-finalization
// barrier, the confirmation sweep and the history repair. None of that is this
// module's subject: what it decides on each outcome is. Scripting the outcome
// keeps the test about the decision.
let interruptOutcome: "released" | "declined" | "busy" = "released";
let eligibility = "eligible";
const interruptCalls: string[] = [];
mock.module("../conversation-interrupt.js", () => ({
  classifyInterruptEligibility: () => eligibility,
  interruptRunningTurn: async (conversation: { conversationId: string }) => {
    interruptCalls.push(conversation.conversationId);
    return interruptOutcome;
  },
}));

let repairCalls = 0;
let repairShouldThrow = false;
mock.module("../conversation-interrupt-repair.js", () => ({
  repairInterruptedToolUseBlocks: async () => {
    repairCalls += 1;
    if (repairShouldThrow) {
      throw new Error("repair is not durable");
    }
  },
}));

const {
  __resetConversationAdmissionForTests,
  cancelPendingAdmissions,
  MAX_PENDING_ADMISSIONS,
  runWhenConversationIdle,
} = await import("../conversation-admission.js");
const { AdmissionOverflowError } = await import("../conversation-admission.js");
const { CONVERSATION_BUSY_MESSAGE } =
  await import("../conversation-busy-error.js");
const { clearConversations, setConversation } =
  await import("../conversation-registry.js");
const { resetTurnFinalizationsForTesting } =
  await import("../turn-finalization.js");
const { submitUserTurn } = await import("../conversation-submit.js");

const CONV = "submit-user-turn-conv";

/** Drain microtasks and timers so detached work has had a chance to run. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

interface FakeConversation {
  conversation: Conversation;
  release: () => void;
}

function makeConversation(processing: boolean): FakeConversation {
  let isProcessing = processing;
  const idleWaiters = new Set<() => void>();
  const conversation = {
    conversationId: CONV,
    isProcessing: () => isProcessing,
    abortController: processing ? new AbortController() : null,
    waitForIdle: ({ timeoutMs }: { timeoutMs: number }) =>
      new Promise<boolean>((resolve) => {
        if (!isProcessing) {
          resolve(true);
          return;
        }
        const notify = (): void => {
          clearTimeout(timer);
          idleWaiters.delete(notify);
          resolve(true);
        };
        const timer = setTimeout(() => {
          idleWaiters.delete(notify);
          resolve(false);
        }, timeoutMs);
        (timer as { unref?: () => void }).unref?.();
        idleWaiters.add(notify);
      }),
  } as unknown as Conversation;
  setConversation(CONV, conversation);
  return {
    conversation,
    release: () => {
      isProcessing = false;
      for (const notify of [...idleWaiters]) {
        notify();
      }
    },
  };
}

function options(
  overrides: Partial<Parameters<typeof submitUserTurn>[1]> = {},
): Parameters<typeof submitUserTurn>[1] {
  return {
    origin: "test",
    onEvent: (msg: AssistantEvent) => events.push(msg),
    requestId: "req-1",
    run: async () => {
      runs.push("run");
    },
    ...overrides,
  };
}

let events: AssistantEvent[] = [];
let runs: string[] = [];

beforeEach(() => {
  __resetConversationAdmissionForTests();
  resetTurnFinalizationsForTesting();
  clearConversations();
  events = [];
  runs = [];
  interruptOutcome = "released";
  eligibility = "eligible";
  interruptCalls.length = 0;
  repairCalls = 0;
  repairShouldThrow = false;
});

afterEach(() => {
  __resetConversationAdmissionForTests();
  resetTurnFinalizationsForTesting();
  clearConversations();
});

describe("submitUserTurn", () => {
  test("runs the send inline on an idle conversation", async () => {
    const { conversation } = makeConversation(false);

    const outcome = await submitUserTurn(conversation, options());

    expect(outcome).toBe("started");
    expect(runs).toEqual(["run"]);
    expect(interruptCalls).toEqual([]);
    // Nothing was interrupted, so there is nothing to repair.
    expect(repairCalls).toBe(0);
  });

  test("interrupts a busy conversation and runs the send in the stopped turn's place", async () => {
    const fake = makeConversation(true);

    const outcome = await submitUserTurn(fake.conversation, options());

    // Answered with the decision; the handover runs off the caller's response.
    expect(outcome).toBe("interrupting");
    await tick();
    expect(interruptCalls).toEqual([CONV]);
    expect(runs).toEqual(["run"]);
  });

  test.each(["hidden", "other_actor", "no_abortable_turn"])(
    "defers a busy send that may not interrupt (%s)",
    async (reason) => {
      eligibility = reason;
      const fake = makeConversation(true);

      const outcome = await submitUserTurn(fake.conversation, options());

      expect(outcome).toBe("deferred");
      expect(interruptCalls).toEqual([]);
      expect(runs).toEqual([]);

      fake.release();
      await tick();
      expect(runs).toEqual(["run"]);
    },
  );

  test.each(["declined", "busy"] as const)(
    "defers when the interrupt answers %s",
    async (outcome) => {
      interruptOutcome = outcome;
      const fake = makeConversation(true);

      expect(await submitUserTurn(fake.conversation, options())).toBe(
        "interrupting",
      );
      await tick();
      expect(runs).toEqual([]);

      fake.release();
      await tick();
      expect(runs).toEqual(["run"]);
    },
  );

  test("a deferred send runs the durable repair before its own turn", async () => {
    eligibility = "hidden";
    const fake = makeConversation(true);

    await submitUserTurn(fake.conversation, options());
    fake.release();
    await tick();

    expect(repairCalls).toBe(1);
    expect(runs).toEqual(["run"]);
  });

  test("a deferred send whose repair cannot be persisted tells the sender", async () => {
    eligibility = "hidden";
    repairShouldThrow = true;
    const fake = makeConversation(true);

    await submitUserTurn(fake.conversation, options());
    fake.release();
    await tick();

    expect(runs).toEqual([]);
    expect(events).toEqual([
      {
        type: "error",
        conversationId: CONV,
        requestId: "req-1",
        code: "SEND_FAILED",
        message: "Your message could not be delivered. Please send it again.",
        errorCategory: "internal",
      },
    ]);
  });

  test("an idle send that loses the processing lock defers instead of failing", async () => {
    const fake = makeConversation(false);
    let attempts = 0;

    const outcome = await submitUserTurn(
      fake.conversation,
      options({
        run: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error(CONVERSATION_BUSY_MESSAGE);
          }
          runs.push("run");
        },
      }),
    );

    expect(outcome).toBe("deferred");
    await tick();
    expect(runs).toEqual(["run"]);
    expect(events).toEqual([]);
  });

  test("an interrupting send that loses the lock defers instead of failing", async () => {
    const fake = makeConversation(true);
    let attempts = 0;

    const outcome = await submitUserTurn(
      fake.conversation,
      options({
        run: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw new Error(CONVERSATION_BUSY_MESSAGE);
          }
          runs.push("run");
        },
      }),
    );

    expect(outcome).toBe("interrupting");
    await tick();
    fake.release();
    await tick();
    expect(runs).toEqual(["run"]);
  });

  test("refuses a deferral the conversation has no room for", async () => {
    eligibility = "hidden";
    const fake = makeConversation(true);
    for (let i = 0; i < MAX_PENDING_ADMISSIONS; i++) {
      void runWhenConversationIdle(CONV, async () => {}, { origin: "filler" });
    }

    await expect(
      submitUserTurn(fake.conversation, options()),
    ).rejects.toBeInstanceOf(AdmissionOverflowError);
    expect(runs).toEqual([]);
  });

  test("a deleted conversation drops the deferred send without telling the sender to retry", async () => {
    eligibility = "hidden";
    const fake = makeConversation(true);

    const outcome = await submitUserTurn(fake.conversation, options());
    expect(outcome).toBe("deferred");

    // What the delete route's teardown does to a conversation going away.
    expect(cancelPendingAdmissions(CONV, "conversation_deleted")).toBe(1);
    await tick();

    expect(runs).toEqual([]);
    expect(events).toEqual([]);

    // The turn the send was waiting on ending afterwards must not admit it.
    fake.release();
    await tick();
    expect(runs).toEqual([]);
  });

  test("a deleted conversation drops a send the interrupt had already accepted", async () => {
    interruptOutcome = "busy";
    const fake = makeConversation(true);

    const outcome = await submitUserTurn(fake.conversation, options());
    expect(outcome).toBe("interrupting");
    await tick();
    expect(runs).toEqual([]);

    expect(cancelPendingAdmissions(CONV, "conversation_deleted")).toBe(1);
    await tick();

    expect(runs).toEqual([]);
    expect(events).toEqual([]);
  });

  test("releases the caller's per-send reservation once the work settles", async () => {
    const fake = makeConversation(true);
    let settled = 0;

    await submitUserTurn(
      fake.conversation,
      options({
        onSettled: () => {
          settled += 1;
        },
      }),
    );
    expect(settled).toBe(0);

    await tick();
    expect(settled).toBe(1);
  });
});
