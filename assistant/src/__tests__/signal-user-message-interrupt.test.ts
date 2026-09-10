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
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
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

/**
 * What the synchronous gate answers. `eligible` is the only value that reaches
 * `interruptRunningTurn`; everything else queues without a handover, which is
 * what the flag-off and wrong-actor paths do.
 */
let interruptEligibility: "eligible" | "flag_off" = "eligible";

/** Held open by the acknowledgement-timing test to stall the handover. */
let interruptGate: Promise<void> = Promise.resolve();

mock.module("../daemon/conversation-interrupt.js", () => ({
  classifyInterruptEligibility: () => interruptEligibility,
  interruptRunningTurn: async () => {
    await interruptGate;
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

/**
 * Let the detached handover run. An eligible interrupt is acknowledged before
 * the abort, the wait, the repair and the dispatch, so anything they do lands
 * after `sendSignal` has already returned.
 */
async function settleHandover(): Promise<void> {
  for (let i = 0; i < 10; i++) {
    await Promise.resolve();
  }
  await new Promise((resolve) => setTimeout(resolve, 5));
}

beforeEach(() => {
  interruptOutcome = "released";
  interruptEligibility = "eligible";
  interruptGate = Promise.resolve();
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
    await settleHandover();

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
    await settleHandover();

    expect(backgroundDispatches).toEqual([]);
    expect(enqueued).toEqual(["answer me"]);
    expect(drainKicks).toEqual(["signal_send_idle"]);
  });

  test("surfaces a dispatch failure on the idle path, where nothing was promised", async () => {
    // No interrupt, so the acknowledgement is still the dispatch's own answer
    // and a failure can be reported honestly rather than queued.
    conversationProcessing = false;
    backgroundDispatchError = new Error("disk on fire");

    await sendSignal("hello");
    await settleHandover();

    expect(enqueued).toEqual([]);
  });

  test("queues any failure that lands after the send was acknowledged", async () => {
    // Once accepted, the message is this handler's responsibility. The queue is
    // the one place that survives, so even an unrecognised failure lands there
    // rather than being dropped.
    interruptOutcome = "released";
    conversationProcessing = true;
    processingAfterInterrupt = false;
    backgroundDispatchError = new Error("disk on fire");

    await sendSignal("still deliver me");
    await settleHandover();

    expect(enqueued).toEqual(["still deliver me"]);
  });

  test("writes the result before the handover, not after it", async () => {
    // The CLI stops waiting for the result file after 10 s, and the handover
    // alone can spend the abort budget plus the turn-boundary commit wait.
    // Awaiting it here made the CLI report a failure for a send that went on to
    // land, so the acknowledgement has to be written first.
    conversationProcessing = true;
    processingAfterInterrupt = false;
    let releaseHandover = () => {};
    interruptGate = new Promise<void>((resolve) => {
      releaseHandover = resolve;
    });

    const filename = `user-message.sig-${++signalSeq}`;
    writeFileSync(
      join(signalsDir, filename),
      JSON.stringify({
        requestId: "req-ack-first",
        conversationKey: "conv-key",
        content: "answer me",
        sourceChannel: "cli",
        interface: "cli",
        bypassSecretCheck: true,
      }),
    );

    await handleUserMessageSignal(filename);

    // Back with the handover still stalled: the result file is already written
    // and the dispatch has not run.
    const written = JSON.parse(
      readFileSync(join(signalsDir, `${filename}.result`), "utf-8"),
    ) as { ok: boolean; accepted: boolean; requestId: string };
    expect(written).toMatchObject({
      ok: true,
      accepted: true,
      requestId: "req-ack-first",
    });
    expect(backgroundDispatches).toEqual([]);

    releaseHandover();
    await settleHandover();
    expect(backgroundDispatches).toEqual(["answer me"]);
  });

  test("queues on `declined`, which is what the flag-off path answers", async () => {
    interruptEligibility = "flag_off";
    conversationProcessing = true;

    await sendSignal("hello");

    expect(enqueued).toEqual(["hello"]);
    expect(backgroundDispatches).toEqual([]);
    // The running turn's own `finally` drains it, so no kick here.
    expect(drainKicks).toEqual([]);
  });
});
