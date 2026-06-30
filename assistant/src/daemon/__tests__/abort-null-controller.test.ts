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
import type { AbortContext } from "../conversation-lifecycle.js";

interface Harness {
  ctx: AbortContext;
  setProcessingCalls: boolean[];
  prompterDisposed: () => boolean;
  secretPrompterDisposed: () => boolean;
  queueClearedCount: () => number;
}

function makeContext(opts: {
  processing: boolean;
  controller: AbortController | null;
}): Harness {
  let processing = opts.processing;
  const setProcessingCalls: boolean[] = [];
  let prompterDisposed = false;
  let secretPrompterDisposed = false;
  let queueCleared = 0;

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
      },
      [Symbol.iterator]: function* () {
        // no queued messages
      },
    },
  } as unknown as AbortContext;

  return {
    ctx,
    setProcessingCalls,
    prompterDisposed: () => prompterDisposed,
    secretPrompterDisposed: () => secretPrompterDisposed,
    queueClearedCount: () => queueCleared,
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

  test("is a no-op when the conversation is not processing", () => {
    // GIVEN a conversation that is not processing
    const h = makeContext({ processing: false, controller: null });

    // WHEN an abort is requested
    abortConversation(h.ctx);

    // THEN nothing is torn down and the flag is never touched
    expect(h.setProcessingCalls).toEqual([]);
    expect(h.prompterDisposed()).toBe(false);
    expect(h.queueClearedCount()).toBe(0);
  });
});
