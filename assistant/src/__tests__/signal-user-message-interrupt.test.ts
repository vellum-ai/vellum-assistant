/**
 * Where the CLI signal path sends a message once the interrupt has answered.
 *
 * Only `released` means the conversation is idle AND its history is whole. The
 * two `busy` answers that arrive after the interrupted turn has already ended
 * (the repair could not be persisted, another waiter took the lock) leave a
 * conversation that reads idle and a durable `tool_use` with no result behind
 * it, so running the message there would persist a user row after it. Every
 * outcome but `released` takes the queue.
 */
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import type { Conversation } from "../daemon/conversation.js";

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

type Outcome = "released" | "declined" | "busy";
let interruptOutcome: Outcome = "released";
let conversationProcessing = false;
/** What the conversation reads as once the interrupt has answered. */
let processingAfterInterrupt: boolean | null = null;

mock.module("../daemon/conversation-interrupt.js", () => ({
  interruptRunningTurn: async () => {
    if (processingAfterInterrupt !== null) {
      conversationProcessing = processingAfterInterrupt;
    }
    return interruptOutcome;
  },
}));

const enqueued: string[] = [];
const drainKicks: string[] = [];

const fakeConversation = {
  isProcessing: () => conversationProcessing,
  enqueueMessage: ({ content }: { content: string }) => {
    enqueued.push(content);
    return { queued: true, requestId: "req-1" };
  },
  kickDrainQueue: async (_reason?: string, origin?: string) => {
    drainKicks.push(origin ?? "");
  },
} as unknown as Conversation;

mock.module("../daemon/conversation-store.js", () => ({
  getOrCreateConversation: async () => fakeConversation,
}));

const backgroundDispatches: string[] = [];
/** Set to make the direct dispatch refuse, as it does when it loses the lock. */
let backgroundDispatchError: Error | null = null;
mock.module("../daemon/process-message.js", () => ({
  processMessageInBackground: async (_id: string, content: string) => {
    if (backgroundDispatchError) {
      throw backgroundDispatchError;
    }
    backgroundDispatches.push(content);
  },
  resolveTurnChannel: (c: string) => c,
  resolveTurnInterface: (i: string) => i,
}));

mock.module("../daemon/handlers/conversations.js", () => ({
  supersedePendingInteractionsOnEnqueue: () => {},
}));

mock.module("../persistence/conversation-key-store.js", () => ({
  getOrCreateConversation: () => ({ conversationId: "conv-1" }),
}));

mock.module("../security/secret-ingress.js", () => ({
  checkIngressForSecrets: () => ({ blocked: false }),
}));

// Only the signals-dir accessor is redirected; the rest of the platform module
// stays real so nothing else that reads it loses a path.
const signalsDir = mkdtempSync(join(tmpdir(), "vellum-signal-interrupt-"));
const realPlatform = await import("../util/platform.js");
mock.module("../util/platform.js", () => ({
  ...realPlatform,
  getSignalsDir: () => signalsDir,
}));

const { handleUserMessageSignal } = await import("../signals/user-message.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

let signalSeq = 0;

/** Drop a signal file the way the CLI does, and let the handler consume it. */
async function sendSignal(content: string): Promise<void> {
  const filename = `user-message.sig-${++signalSeq}`;
  writeFileSync(
    join(signalsDir, filename),
    JSON.stringify({
      requestId: `req-${signalSeq}`,
      conversationKey: "conv-key",
      content,
      sourceChannel: "cli",
      interface: "cli",
      bypassSecretCheck: true,
    }),
  );
  await handleUserMessageSignal(filename);
}

beforeEach(() => {
  interruptOutcome = "released";
  conversationProcessing = false;
  processingAfterInterrupt = null;
  enqueued.length = 0;
  drainKicks.length = 0;
  backgroundDispatches.length = 0;
  backgroundDispatchError = null;
});

afterEach(() => {
  // `mock.module` is process-wide, so leave the stub on the answer an idle
  // conversation gives, which is what every other file expects.
  interruptOutcome = "released";
});

describe("CLI signal send after an interrupt", () => {
  test("runs the message when the interrupt hands the conversation over", async () => {
    interruptOutcome = "released";

    await sendSignal("run it");

    expect(backgroundDispatches).toEqual(["run it"]);
    expect(enqueued).toEqual([]);
  });

  test("queues on `busy` even though the conversation now reads idle", async () => {
    // The shape the repair failure and the lost-lock race both produce: the
    // conversation was busy at the check, the interrupted turn then ended, so
    // `isProcessing()` reads false while the history still carries a
    // `tool_use` nothing answered.
    interruptOutcome = "busy";
    conversationProcessing = true;
    processingAfterInterrupt = false;

    await sendSignal("what time is it");

    expect(enqueued).toEqual(["what time is it"]);
    expect(backgroundDispatches).toEqual([]);
    // Nothing is running to drain it, so the enqueue kicks one itself.
    expect(drainKicks).toEqual(["signal_send_idle"]);
  });

  test("queues a released send that loses the conversation before it dispatches", async () => {
    // `released` proves the interrupted turn let go, not that this send got the
    // conversation: an idle waiter registered earlier can take it on the same
    // transition. The direct dispatch then refuses, and the CLI's message must
    // land on the queue rather than be lost to an internal error.
    const { CONVERSATION_BUSY_MESSAGE } =
      await import("../daemon/conversation-messaging.js");
    interruptOutcome = "released";
    conversationProcessing = true;
    processingAfterInterrupt = false;
    backgroundDispatchError = new Error(CONVERSATION_BUSY_MESSAGE);

    await sendSignal("answer me");

    expect(backgroundDispatches).toEqual([]);
    expect(enqueued).toEqual(["answer me"]);
    expect(drainKicks).toEqual(["signal_send_idle"]);
  });

  test("still surfaces a dispatch failure that is not the busy race", async () => {
    interruptOutcome = "released";
    backgroundDispatchError = new Error("disk on fire");

    // The signal handler catches and reports; what matters is that a genuine
    // failure is not silently turned into a queued message.
    await sendSignal("hello");

    expect(enqueued).toEqual([]);
  });

  test("queues on `declined`, which is what the flag-off path answers", async () => {
    interruptOutcome = "declined";
    conversationProcessing = true;

    await sendSignal("hello");

    expect(enqueued).toEqual(["hello"]);
    expect(backgroundDispatches).toEqual([]);
    // The running turn's own `finally` drains it, so no kick here.
    expect(drainKicks).toEqual([]);
  });
});
