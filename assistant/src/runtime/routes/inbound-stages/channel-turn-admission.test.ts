import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { Conversation } from "../../../daemon/conversation.js";
import {
  clearConversations,
  setConversation,
} from "../../../daemon/conversation-registry.js";
import {
  __resetChannelTurnAdmissionForTests,
  withChannelTurnAdmission,
} from "./channel-turn-admission.js";

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

beforeEach(() => {
  __resetChannelTurnAdmissionForTests();
  clearConversations();
});

afterEach(() => {
  __resetChannelTurnAdmissionForTests();
  clearConversations();
});

describe("withChannelTurnAdmission", () => {
  test("runs immediately when the conversation is not resident", async () => {
    let ran = false;
    await withChannelTurnAdmission("conv-absent", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("runs immediately when the conversation is idle", async () => {
    register("conv-idle", makeFakeConversation(false));
    let ran = false;
    await withChannelTurnAdmission("conv-idle", async () => {
      ran = true;
    });
    expect(ran).toBe(true);
  });

  test("defers until the in-flight turn releases the processing lock", async () => {
    const fake = makeFakeConversation(true);
    register("conv-busy", fake);

    let ran = false;
    const admitted = withChannelTurnAdmission("conv-busy", async () => {
      ran = true;
    });

    await tick();
    expect(ran).toBe(false); // deferred — the conversation is mid-turn

    fake.release();
    await admitted;
    expect(ran).toBe(true); // admitted the instant the lock frees
  });

  test("serializes same-conversation turns in arrival order (FIFO)", async () => {
    const fake = makeFakeConversation(true);
    register("conv-fifo", fake);

    const order: string[] = [];
    const first = withChannelTurnAdmission("conv-fifo", async () => {
      order.push("first");
    });
    const second = withChannelTurnAdmission("conv-fifo", async () => {
      order.push("second");
    });

    await tick();
    expect(order).toEqual([]); // both deferred behind the in-flight turn

    fake.release();
    await Promise.all([first, second]);
    expect(order).toEqual(["first", "second"]);
  });

  test("does not block turns for other conversations", async () => {
    register("conv-a", makeFakeConversation(true)); // A stays busy
    register("conv-b", makeFakeConversation(false)); // B is idle

    let ranB = false;
    const a = withChannelTurnAdmission("conv-a", async () => {});
    void a;
    await withChannelTurnAdmission("conv-b", async () => {
      ranB = true;
    });
    expect(ranB).toBe(true); // B ran despite A being blocked
  });
});
