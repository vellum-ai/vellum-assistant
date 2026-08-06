/**
 * Abort contract when there is no live controller to signal.
 *
 * `abortConversation` signals `ctx.abortController?.abort()` and otherwise
 * defers clearing the `processing` flag to the in-flight turn's `finally`.
 * That deferral is only safe while a turn is actually live to reach its
 * `finally`. The agent-loop `finally` nulls `abortController` *before* it
 * clears the flag, and some paths set `processing` without ever installing a
 * controller — so a conversation can be `isProcessing() === true` with a null
 * `abortController`. In that state the old `?.abort()` was a silent no-op and
 * nothing ever cleared the flag: every later submit was rejected with
 * "already processing" and Stop did nothing.
 *
 * This pins the fix: when asked to abort while processing with no live
 * controller, `abortConversation` force-clears the flag itself; when a
 * controller IS live, it signals it and leaves the flag to the turn.
 */
import { describe, expect, mock, test } from "bun:test";

// `conversation-lifecycle` transitively imports the messaging markdown
// renderers, which pull in `hast`/`mdast`/`remark`/`unified`. Those packages
// are declared in `assistant/package.json` but absent from this sandbox's
// partial node_modules install (CI has the full set). `abortConversation`
// never touches message rendering, so stub these leaf modules — the only ones
// importing the missing packages — with no-op named exports so the import
// graph resolves. Bun validates named imports statically, hence the explicit
// keys rather than a Proxy.
mock.module("../../messaging/content/parse.js", () => ({
  parseMarkdown: () => ({}),
}));
mock.module("../../messaging/providers/slack/render.js", () => ({
  renderSlackBlocks: () => undefined,
  renderSlack: () => [],
}));
mock.module("../../messaging/providers/telegram-bot/render.js", () => ({
  renderTelegramHtml: () => undefined,
}));

const { abortConversation } = await import("../conversation-lifecycle.js");
import { createAbortReason } from "../../util/abort-reasons.js";
import type { AbortContext } from "../conversation-lifecycle.js";

interface QueuedEvent {
  type: string;
  requestId?: string;
}

interface Harness {
  ctx: AbortContext;
  setProcessingCalls: boolean[];
  prompterDisposed: () => boolean;
  secretPrompterDisposed: () => boolean;
  queueClearedCount: () => number;
  queuedEvents: QueuedEvent[];
  drainKicks: string[];
}

function makeContext(opts: {
  processing: boolean;
  controller: AbortController | null;
  /** requestIds of messages sitting in the queue behind the aborted turn. */
  queued?: string[];
}): Harness {
  let processing = opts.processing;
  const setProcessingCalls: boolean[] = [];
  let prompterDisposed = false;
  let secretPrompterDisposed = false;
  let queueCleared = 0;
  const queuedEvents: QueuedEvent[] = [];
  const drainKicks: string[] = [];
  let queuedItems = (opts.queued ?? []).map((requestId) => ({
    requestId,
    onEvent: (event: QueuedEvent) => queuedEvents.push(event),
  }));

  const ctx = {
    conversationId: "abort-null-controller-test",
    isProcessing: () => processing,
    setProcessing: (value: boolean) => {
      setProcessingCalls.push(value);
      processing = value;
    },
    abortController: opts.controller,
    prompter: {
      dispose: () => {
        prompterDisposed = true;
      },
    },
    secretPrompter: {
      dispose: () => {
        secretPrompterDisposed = true;
      },
    },
    pendingSurfaceActions: new Map(),
    surfaceActionRequestIds: new Set(),
    surfaceState: new Map(),
    accumulatedSurfaceState: new Map(),
    queue: {
      clear: () => {
        queueCleared += 1;
        queuedItems = [];
      },
      get isEmpty() {
        return queuedItems.length === 0;
      },
      get length() {
        return queuedItems.length;
      },
      [Symbol.iterator]: () => queuedItems[Symbol.iterator](),
    },
    pendingInterruptRepair: false,
    kickDrainQueue: async (_reason?: string, origin?: string) => {
      drainKicks.push(origin ?? "");
    },
  } as unknown as AbortContext;

  return {
    ctx,
    setProcessingCalls,
    prompterDisposed: () => prompterDisposed,
    secretPrompterDisposed: () => secretPrompterDisposed,
    queueClearedCount: () => queueCleared,
    queuedEvents,
    drainKicks,
  };
}

describe("abortConversation", () => {
  test("force-clears the flag when processing with no live controller", () => {
    // GIVEN a conversation flagged processing but with no controller to signal
    const h = makeContext({ processing: true, controller: null });

    // WHEN an abort is requested
    abortConversation(h.ctx);

    // THEN the flag is force-cleared so the conversation is no longer wedged
    expect(h.setProcessingCalls).toContain(false);
    expect(h.ctx.isProcessing()).toBe(false);
    // AND the rest of the teardown still ran
    expect(h.prompterDisposed()).toBe(true);
    expect(h.secretPrompterDisposed()).toBe(true);
    expect(h.queueClearedCount()).toBe(1);
  });

  test("signals a live controller and defers the flag to the turn's finally", () => {
    // GIVEN a conversation with a live, un-aborted controller
    const controller = new AbortController();
    const h = makeContext({ processing: true, controller });

    // WHEN an abort is requested
    abortConversation(h.ctx);

    // THEN the controller is signalled
    expect(controller.signal.aborted).toBe(true);
    // AND the flag is NOT force-cleared here — the turn's `finally` owns that
    expect(h.setProcessingCalls).not.toContain(false);
    expect(h.ctx.isProcessing()).toBe(true);
    // AND the shared teardown still ran
    expect(h.prompterDisposed()).toBe(true);
    expect(h.queueClearedCount()).toBe(1);
  });

  test("propagates the abort reason to the live controller", () => {
    // GIVEN a live controller and an explicit abort reason
    const controller = new AbortController();
    const h = makeContext({ processing: true, controller });
    let observedReason: unknown;
    controller.signal.addEventListener("abort", () => {
      observedReason = controller.signal.reason;
    });

    // WHEN aborting with no explicit reason (a default reason is synthesized)
    abortConversation(h.ctx);

    // THEN the controller's reason carries the tagged AbortReason
    expect(observedReason).toBeDefined();
    expect((observedReason as { kind?: string }).kind).toBe(
      "preempted_by_new_message",
    );
  });

  test("a user interrupt leaves queued messages for the stopped turn's drain", () => {
    // GIVEN a live turn with two messages queued behind it
    const controller = new AbortController();
    const h = makeContext({
      processing: true,
      controller,
      queued: ["req-a", "req-b"],
    });

    // WHEN the user stops the turn
    abortConversation(
      h.ctx,
      createAbortReason("user_cancel", "test", "abort-null-controller-test"),
    );

    // THEN the queue is untouched, so the agent loop's `finally` drains it and
    // the queued messages are sent rather than silently dropped
    expect(h.queueClearedCount()).toBe(0);
    expect(h.ctx.queue.length).toBe(2);
    expect(h.queuedEvents).toEqual([]);
    // AND the drain is left to that `finally`, not kicked from here
    expect(h.drainKicks).toEqual([]);
    // AND the drain is told to repair tool_use blocks the killed turn abandoned
    expect(h.ctx.pendingInterruptRepair).toBe(true);
  });

  test("a user interrupt with no live turn kicks the drain itself", () => {
    // GIVEN a conversation flagged processing with no controller left to
    // signal, so no agent-loop `finally` is coming to drain the preserved queue
    const h = makeContext({
      processing: true,
      controller: null,
      queued: ["req-a"],
    });

    // WHEN the user stops it
    abortConversation(
      h.ctx,
      createAbortReason("user_cancel", "test", "abort-null-controller-test"),
    );

    // THEN the queued message is still sent, because the abort kicks the drain
    expect(h.ctx.queue.length).toBe(1);
    expect(h.drainKicks).toEqual(["abortConversation:no_live_turn"]);
  });

  test("a non-interrupt abort discards the queue and closes out each row", () => {
    // GIVEN a live turn with a queued message, torn down by a dispose
    const controller = new AbortController();
    const h = makeContext({
      processing: true,
      controller,
      queued: ["req-a"],
    });

    // WHEN the conversation is disposed rather than interrupted
    abortConversation(
      h.ctx,
      createAbortReason(
        "conversation_disposed",
        "test",
        "abort-null-controller-test",
      ),
    );

    // THEN the queue is dropped, since no turn is left for it to run on, and
    // the sender gets the terminal event that closes the queued row, so no
    // client is left holding a pending indicator nothing will ever settle
    expect(h.queueClearedCount()).toBe(1);
    expect(h.queuedEvents.map((e) => e.type)).toEqual([
      "generation_cancelled",
      "message_queued_deleted",
    ]);
    expect(h.queuedEvents[1].requestId).toBe("req-a");
    expect(h.ctx.pendingInterruptRepair).toBe(false);
  });

  test("a teardown abort discards the queue even when the flag reads idle", () => {
    // GIVEN a conversation whose turn already cleared the processing flag but
    // is still unwinding: the agent-loop `finally` clears the flag, then awaits
    // the turn-boundary commit before its `kickDrainQueue`. A dispose landing
    // in that window sees an idle conversation with a populated queue.
    const h = makeContext({
      processing: false,
      controller: null,
      queued: ["req-a"],
    });

    // WHEN the conversation is disposed
    abortConversation(
      h.ctx,
      createAbortReason(
        "conversation_disposed",
        "test",
        "abort-null-controller-test",
      ),
    );

    // THEN the queue goes with it, so the pending `kickDrainQueue` finds
    // nothing to run against the disposed conversation, and the queued row
    // still gets its terminal event
    expect(h.ctx.queue.length).toBe(0);
    expect(h.queuedEvents.map((e) => e.type)).toEqual([
      "generation_cancelled",
      "message_queued_deleted",
    ]);
  });

  test("clears the persisted flag when in-memory reads idle (cancel with no live abort)", () => {
    // GIVEN a conversation whose in-memory flag reads idle — e.g. reloaded
    // after its owning turn was interrupted out-of-process, so a persisted
    // `processing_started_at` can survive with no live turn or controller to
    // signal and no agent-loop `finally` left to clear it.
    const h = makeContext({ processing: false, controller: null });

    // WHEN a cancel arrives
    abortConversation(h.ctx);

    // THEN `setProcessing(false)` is called unconditionally to null the
    // persisted column, so the row is unwedged for cold readers and the next
    // reload — cancel is not a silent no-op.
    expect(h.setProcessingCalls).toEqual([false]);
    // AND the live-turn teardown (prompters, surfaces) is left alone: there was
    // no live turn holding them. The queue is the exception, discarded on any
    // non-interrupt abort regardless of the flag.
    expect(h.prompterDisposed()).toBe(false);
    expect(h.ctx.queue.length).toBe(0);
  });
});
