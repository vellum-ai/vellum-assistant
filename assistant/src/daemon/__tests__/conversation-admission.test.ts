import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import { setConfig } from "../../__tests__/helpers/set-config.js";
import type { AssistantEvent } from "../../api/index.js";
import type { Conversation } from "../conversation.js";
import {
  __resetConversationAdmissionForTests,
  AdmissionCancelledError,
  AdmissionOverflowError,
  cancelAllPendingAdmissions,
  cancelPendingAdmissions,
  MAX_PENDING_ADMISSIONS,
  pendingAdmissionCount,
  runWhenConversationIdle,
} from "../conversation-admission.js";
import { CONVERSATION_BUSY_MESSAGE } from "../conversation-busy-error.js";
import {
  clearConversations,
  removeSubagentConversation,
  setConversation,
  setSubagentConversation,
} from "../conversation-registry.js";
import {
  beginTurnFinalization,
  resetTurnFinalizationsForTesting,
} from "../turn-finalization.js";

/** Drain microtasks + timers so deferred admissions have had a chance to run. */
const tick = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 0));

/**
 * Minimal stand-in for the parts of `Conversation` the admission gate reads:
 * the processing flag and the event-driven `waitForIdle` wait. `release()`
 * mimics `setProcessing(false)` notifying idle waiters.
 */
interface FakeConversation {
  isProcessing: () => boolean;
  waitForIdle: (opts: { timeoutMs: number }) => Promise<boolean>;
  acquire: () => void;
  release: () => void;
}

function makeFakeConversation(initiallyProcessing: boolean): FakeConversation {
  let processing = initiallyProcessing;
  const idleWaiters = new Set<() => void>();
  return {
    isProcessing: () => processing,
    waitForIdle: ({ timeoutMs }) =>
      new Promise<boolean>((resolve) => {
        if (!processing) {
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
    acquire: () => {
      processing = true;
    },
    release: () => {
      processing = false;
      for (const notify of [...idleWaiters]) {
        notify();
      }
    },
  };
}

function register(conversationId: string, fake: FakeConversation): void {
  setConversation(conversationId, fake as unknown as Conversation);
}

const channel = { origin: "channel" } as const;

/**
 * Capture a registration's outcome as a value, with the handler attached at
 * registration: a cancellation rejects every waiter in one synchronous sweep,
 * and a handler attached after that sweep is already too late for Bun's
 * unhandled-rejection watch.
 */
const settle = (p: Promise<unknown>): Promise<unknown> =>
  p.then(
    (value) => value,
    (err: unknown) => err,
  );

beforeEach(() => {
  __resetConversationAdmissionForTests();
  resetTurnFinalizationsForTesting();
  clearConversations();
});

afterEach(() => {
  __resetConversationAdmissionForTests();
  resetTurnFinalizationsForTesting();
  clearConversations();
});

describe("runWhenConversationIdle", () => {
  test("runs immediately when the conversation is not resident", async () => {
    let ran = false;
    await runWhenConversationIdle(
      "conv-absent",
      async () => {
        ran = true;
      },
      channel,
    );
    expect(ran).toBe(true);
  });

  test("runs immediately when the conversation is idle", async () => {
    register("conv-idle", makeFakeConversation(false));
    let ran = false;
    await runWhenConversationIdle(
      "conv-idle",
      async () => {
        ran = true;
      },
      channel,
    );
    expect(ran).toBe(true);
  });

  test("defers until the in-flight turn releases the processing lock", async () => {
    const fake = makeFakeConversation(true);
    register("conv-busy", fake);

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-busy",
      async () => {
        ran = true;
      },
      channel,
    );

    await tick();
    expect(ran).toBe(false); // deferred: the conversation is mid-turn

    fake.release();
    await admitted;
    expect(ran).toBe(true); // admitted the instant the lock frees
  });

  test("serializes same-conversation sends in arrival order (FIFO)", async () => {
    const fake = makeFakeConversation(true);
    register("conv-fifo", fake);

    const order: string[] = [];
    const first = runWhenConversationIdle(
      "conv-fifo",
      async () => {
        order.push("first");
      },
      channel,
    );
    const second = runWhenConversationIdle(
      "conv-fifo",
      async () => {
        order.push("second");
      },
      channel,
    );

    await tick();
    expect(order).toEqual([]); // both deferred behind the in-flight turn

    fake.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  test("does not block sends for other conversations", async () => {
    register("conv-a", makeFakeConversation(true)); // A stays busy
    register("conv-b", makeFakeConversation(false)); // B is idle

    let ranB = false;
    const a = runWhenConversationIdle("conv-a", async () => {}, channel);
    void a;
    await runWhenConversationIdle(
      "conv-b",
      async () => {
        ranB = true;
      },
      channel,
    );
    expect(ranB).toBe(true); // B ran despite A being blocked
  });

  test("defers for a busy subagent conversation, which lives in its own map", async () => {
    const fake = makeFakeConversation(true);
    const child = "conv-child";
    setSubagentConversation(child, fake as unknown as Conversation);

    try {
      let ran = false;
      const admitted = runWhenConversationIdle(
        child,
        async () => {
          ran = true;
        },
        { origin: "subagent_guidance" },
      );

      await tick();
      // Looking only in the top-level map would miss the child's lock here and
      // run the send straight into a busy rejection.
      expect(ran).toBe(false);

      fake.release();
      await admitted;
      expect(ran).toBe(true);
    } finally {
      removeSubagentConversation(child, fake as unknown as Conversation);
    }
  });

  test("waits for the finished turn's boundary commit before running", async () => {
    register("conv-barrier", makeFakeConversation(false));
    const closeBarrier = beginTurnFinalization("conv-barrier");

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-barrier",
      async () => {
        ran = true;
      },
      channel,
    );

    await tick();
    expect(ran).toBe(false); // idle, but the turn-boundary commit is still staging

    closeBarrier();
    await admitted;
    expect(ran).toBe(true);
  });

  test("keeps waiting on a boundary commit that outlasts its budget", async () => {
    setConfig("workspaceGit", { turnCommitMaxWaitMs: 1 });
    register("conv-slow-barrier", makeFakeConversation(false));
    const closeBarrier = beginTurnFinalization("conv-slow-barrier");

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-slow-barrier",
      async () => {
        ran = true;
      },
      channel,
    );

    // Well past the budget. Admitting on an elapsed budget is the exact
    // cross-attribution the barrier exists to prevent, and giving up would lose
    // the send, so it waits the barrier out however long that takes.
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(ran).toBe(false);

    closeBarrier();
    await admitted;
    expect(ran).toBe(true);
  });

  test("goes back to waiting when a claimant retakes the lock during the commit barrier", async () => {
    const fake = makeFakeConversation(false);
    register("conv-retake", fake);
    const closeBarrier = beginTurnFinalization("conv-retake");

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-retake",
      async () => {
        ran = true;
      },
      channel,
    );

    await tick();
    fake.acquire();
    closeBarrier();
    await tick();
    expect(ran).toBe(false); // the barrier closed onto a locked conversation

    fake.release();
    await admitted;
    expect(ran).toBe(true);
  });

  test("retries a run that loses the processing lock, up to three attempts", async () => {
    register("conv-race", makeFakeConversation(false));

    let attempts = 0;
    const ran = await runWhenConversationIdle(
      "conv-race",
      async () => {
        attempts += 1;
        if (attempts < 3) {
          throw new Error(CONVERSATION_BUSY_MESSAGE);
        }
        return "delivered";
      },
      channel,
    );

    expect(attempts).toBe(3);
    expect(ran).toBe("delivered");
  });

  test("gives up after three lost races and tells the sender the send failed", async () => {
    register("conv-lost", makeFakeConversation(false));
    const events: AssistantEvent[] = [];

    let attempts = 0;
    const admitted = runWhenConversationIdle(
      "conv-lost",
      async () => {
        attempts += 1;
        throw new Error(CONVERSATION_BUSY_MESSAGE);
      },
      {
        origin: "test",
        onEvent: (msg) => events.push(msg),
        requestId: "req-1",
      },
    );

    await expect(admitted).rejects.toThrow(CONVERSATION_BUSY_MESSAGE);
    expect(attempts).toBe(3);
    expect(events).toEqual([
      {
        type: "error",
        conversationId: "conv-lost",
        requestId: "req-1",
        code: "SEND_FAILED",
        message: "Your message could not be delivered. Please send it again.",
        errorCategory: "internal",
      },
    ]);
  });

  test("does not retry a run that fails for any other reason", async () => {
    register("conv-throw", makeFakeConversation(false));

    let attempts = 0;
    const admitted = runWhenConversationIdle(
      "conv-throw",
      async () => {
        attempts += 1;
        throw new Error("boom");
      },
      channel,
    );

    await expect(admitted).rejects.toThrow("boom");
    expect(attempts).toBe(1);
  });

  test("counts registrations while they wait and clears the count when they finish", async () => {
    const fake = makeFakeConversation(true);
    register("conv-count", fake);

    expect(pendingAdmissionCount("conv-count")).toBe(0);
    const first = runWhenConversationIdle(
      "conv-count",
      async () => {},
      channel,
    );
    const second = runWhenConversationIdle(
      "conv-count",
      async () => {},
      channel,
    );
    expect(pendingAdmissionCount("conv-count")).toBe(2);

    fake.release();
    await Promise.all([first, second]);
    expect(pendingAdmissionCount("conv-count")).toBe(0);
  });

  test("refuses a registration past the pending cap without running it", async () => {
    const fake = makeFakeConversation(true);
    register("conv-full", fake);

    const admitted: Array<Promise<void>> = [];
    for (let i = 0; i < MAX_PENDING_ADMISSIONS; i++) {
      admitted.push(
        runWhenConversationIdle("conv-full", async () => {}, channel),
      );
    }
    expect(pendingAdmissionCount("conv-full")).toBe(MAX_PENDING_ADMISSIONS);

    let overflowRan = false;
    const overflow = runWhenConversationIdle(
      "conv-full",
      async () => {
        overflowRan = true;
      },
      channel,
    );
    await expect(overflow).rejects.toBeInstanceOf(AdmissionOverflowError);
    expect(overflowRan).toBe(false);
    expect(pendingAdmissionCount("conv-full")).toBe(MAX_PENDING_ADMISSIONS);

    fake.release();
    await Promise.all(admitted);
    expect(pendingAdmissionCount("conv-full")).toBe(0);
  });
});

describe("cancelPendingAdmissions", () => {
  test("drops a waiting send without running it and answers its caller", async () => {
    const fake = makeFakeConversation(true);
    register("conv-deleted", fake);

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-deleted",
      async () => {
        ran = true;
      },
      channel,
    );
    await tick();
    expect(ran).toBe(false);

    expect(
      cancelPendingAdmissions("conv-deleted", "conversation_deleted"),
    ).toBe(1);

    await expect(admitted).rejects.toBeInstanceOf(AdmissionCancelledError);
    expect(pendingAdmissionCount("conv-deleted")).toBe(0);

    // The conversation going idle afterwards must not resurrect the send.
    fake.release();
    await tick();
    expect(ran).toBe(false);
  });

  test("drops every waiting send for the conversation, in one call", async () => {
    const fake = makeFakeConversation(true);
    register("conv-many", fake);

    let ran = 0;
    const admitted = [0, 1, 2].map(() =>
      settle(
        runWhenConversationIdle(
          "conv-many",
          async () => {
            ran += 1;
          },
          channel,
        ),
      ),
    );
    await tick();

    expect(cancelPendingAdmissions("conv-many", "conversation_deleted")).toBe(
      3,
    );
    for (const outcome of await Promise.all(admitted)) {
      expect(outcome).toBeInstanceOf(AdmissionCancelledError);
    }

    fake.release();
    await tick();
    expect(ran).toBe(0);
    expect(pendingAdmissionCount("conv-many")).toBe(0);
  });

  test("leaves a send that is already running to finish", async () => {
    register("conv-running", makeFakeConversation(false));

    let release!: () => void;
    const started = new Promise<void>((resolve) => {
      release = resolve;
    });
    let finished = false;
    const admitted = runWhenConversationIdle(
      "conv-running",
      async () => {
        await started;
        finished = true;
      },
      channel,
    );
    await tick();

    expect(
      cancelPendingAdmissions("conv-running", "conversation_deleted"),
    ).toBe(0);
    release();
    await admitted;
    expect(finished).toBe(true);
  });

  test("a send survives the conversation leaving the registry: only a delete cancels", async () => {
    const fake = makeFakeConversation(true);
    register("conv-evicted", fake);

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-evicted",
      async () => {
        ran = true;
      },
      channel,
    );
    await tick();
    expect(ran).toBe(false);

    // Eviction takes the instance out of the registry and cancels nothing, so
    // the send is still owed and `run` hydrates the conversation for it.
    clearConversations();
    expect(pendingAdmissionCount("conv-evicted")).toBe(1);

    fake.release();
    await admitted;
    expect(ran).toBe(true);
  });

  test("is a no-op for a conversation with nothing waiting", () => {
    expect(cancelPendingAdmissions("conv-none", "conversation_deleted")).toBe(
      0,
    );
  });

  test("cancelAllPendingAdmissions drops waiters across conversations", async () => {
    const one = makeFakeConversation(true);
    const two = makeFakeConversation(true);
    register("conv-one", one);
    register("conv-two", two);

    let ran = 0;
    const admitted = [
      settle(
        runWhenConversationIdle(
          "conv-one",
          async () => {
            ran += 1;
          },
          channel,
        ),
      ),
      settle(
        runWhenConversationIdle(
          "conv-two",
          async () => {
            ran += 1;
          },
          channel,
        ),
      ),
    ];
    await tick();

    expect(cancelAllPendingAdmissions("conversations_cleared")).toBe(2);
    for (const outcome of await Promise.all(admitted)) {
      expect(outcome).toBeInstanceOf(AdmissionCancelledError);
    }

    one.release();
    two.release();
    await tick();
    expect(ran).toBe(0);
  });

  test("a cancelled waiter frees its slot for a later registration", async () => {
    const fake = makeFakeConversation(true);
    register("conv-reuse", fake);

    const cancelled = runWhenConversationIdle(
      "conv-reuse",
      async () => {},
      channel,
    );
    await tick();
    cancelPendingAdmissions("conv-reuse", "conversation_deleted");
    await expect(cancelled).rejects.toBeInstanceOf(AdmissionCancelledError);

    let ran = false;
    const admitted = runWhenConversationIdle(
      "conv-reuse",
      async () => {
        ran = true;
      },
      channel,
    );
    fake.release();
    await admitted;
    expect(ran).toBe(true);
  });
});
