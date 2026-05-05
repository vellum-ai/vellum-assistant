/**
 * Verifies that the queue-drain paths in `conversation-process.ts` re-add
 * the `app-control` skill to the conversation's preactivated set when the
 * dequeued message's `userMessageInterface` supports the `host_app_control`
 * proxy capability.
 *
 * Both `drainSingleMessage` (single-message path) and `drainBatch`
 * (batched path) reset `preactivatedSkillIds = undefined` at the top of
 * each drain. Without an explicit re-add, queued messages 2+ would lose
 * the `app-control` skill — its tools wouldn't be projected to the LLM —
 * even though the `HostAppControlProxy` is still attached to the
 * conversation. This mirrors the existing parallel re-add for
 * `computer-use` and uses the same `supportsHostProxy(_, "host_app_control")`
 * gate that `prepareConversationForMessage` and the `conversation-routes`
 * instantiation block use at first-message time.
 */

import { describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks for downstream side effects (DB writes, slash resolution,
// notification preference extraction). The drain paths must be allowed to
// reach the preactivation block; they must not be allowed to touch a real DB.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  addMessage: () => ({ id: "msg-mock" }),
}));

mock.module("../memory/canonical-guardian-store.js", () => ({
  listPendingRequestsByConversationScope: () => [],
}));

mock.module("../memory/trace-event-store.js", () => ({
  persistTraceEvent: () => {},
  getMaxSequence: () => 0,
}));

mock.module("../notifications/preference-extractor.js", () => ({
  extractPreferences: async () => ({ detected: false, preferences: [] }),
}));

mock.module("../notifications/preferences-store.js", () => ({
  createPreference: () => {},
}));

mock.module("../agent/attachments.ts", () => ({
  enrichMessageWithSourcePaths: <T>(msg: T) => msg,
}));

// Stub the batched-drain helper so the test doesn't fall through to real
// SQLite paths after the preactivation block has already run. The drain
// chain doesn't recurse here because our stubbed `runAgentLoop` is a no-op.
mock.module("../daemon/conversation-messaging.js", () => ({
  persistQueuedMessageBody: async () => "user-msg-id",
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import type { TurnInterfaceContext } from "../channels/types.js";
import type { ProcessConversationContext } from "../daemon/conversation-process.js";
import { drainQueue } from "../daemon/conversation-process.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";
import { TraceEmitter } from "../daemon/trace-emitter.js";

// ---------------------------------------------------------------------------
// Fake context — captures preactivation calls, satisfies the bare minimum
// of `ProcessConversationContext`. `runAgentLoop` resolves immediately so
// the drain-chain does not recurse forever.
// ---------------------------------------------------------------------------

interface FakeRecord {
  preactivatedSkillIdCalls: string[];
}

function makeFakeContext(opts: {
  queue: MessageQueue;
  turnInterfaceContext?: TurnInterfaceContext;
}): ProcessConversationContext & FakeRecord {
  const calls: string[] = [];
  let preactivatedSkillIds: string[] | undefined = undefined;
  const ctx = {
    conversationId: "conv-app-control-preactivation",
    messages: [],
    processing: false,
    abortController: null,
    queue: opts.queue,
    traceEmitter: new TraceEmitter("conv-app-control-preactivation", () => {}),
    surfaceActionRequestIds: new Set<string>(),
    usageStats: { inputTokens: 0, outputTokens: 0, estimatedCost: 0 },
    get preactivatedSkillIds(): string[] | undefined {
      return preactivatedSkillIds;
    },
    set preactivatedSkillIds(value: string[] | undefined) {
      preactivatedSkillIds = value;
    },
    preactivatedSkillIdCalls: calls,
    addPreactivatedSkillId(id: string) {
      calls.push(id);
      if (!preactivatedSkillIds) {
        preactivatedSkillIds = [id];
      } else if (!preactivatedSkillIds.includes(id)) {
        preactivatedSkillIds.push(id);
      }
    },
    async ensureActorScopedHistory() {},
    async persistUserMessage() {
      return "user-msg-id";
    },
    async runAgentLoop() {
      // No-op: the drain path's finally block would normally call drainQueue
      // recursively. We intentionally do not chain another drain here so the
      // test asserts on what the FIRST dequeue produced.
    },
    getTurnChannelContext: () => null,
    setTurnChannelContext() {},
    getTurnInterfaceContext: () => opts.turnInterfaceContext ?? null,
    setTurnInterfaceContext() {},
    emitActivityState() {},
    async forceCompact() {
      return {
        compacted: false,
        reason: "no-op",
        estimatedInputTokens: 0,
        previousEstimatedInputTokens: 0,
        maxInputTokens: 100000,
        compactedMessages: 0,
      } as never;
    },
    setTransportHints() {},
    applyHostEnvFromTransport() {},
  } as unknown as ProcessConversationContext & FakeRecord;
  return ctx;
}

function makeQueuedMessage(opts: {
  requestId: string;
  content?: string;
  turnInterfaceContext?: TurnInterfaceContext;
}): QueuedMessage {
  return {
    content: opts.content ?? "follow up",
    attachments: [],
    requestId: opts.requestId,
    onEvent: () => {},
    metadata: {},
    sentAt: Date.now(),
    turnInterfaceContext: opts.turnInterfaceContext,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drainQueue preactivation re-add for host-proxy interfaces", () => {
  test("drainSingleMessage re-adds 'app-control' for macOS-sourced queued message", async () => {
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    };
    queue.push(
      makeQueuedMessage({ requestId: "req-2", turnInterfaceContext: ifCtx }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    // Both CU and app-control must be re-preactivated for queued macOS turns.
    expect(ctx.preactivatedSkillIdCalls).toContain("computer-use");
    expect(ctx.preactivatedSkillIdCalls).toContain("app-control");
    expect(ctx.preactivatedSkillIds).toContain("app-control");
  });

  test("drainSingleMessage does not re-add 'app-control' for chrome-extension (host_app_control unsupported)", async () => {
    const queue = new MessageQueue();
    // chrome-extension supports host_browser but NOT host_app_control. The
    // CU re-add (no-arg form) also returns false for chrome-extension, so
    // neither skill should be re-preactivated.
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "chrome-extension",
      assistantMessageInterface: "chrome-extension",
    };
    queue.push(
      makeQueuedMessage({ requestId: "req-2", turnInterfaceContext: ifCtx }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    expect(ctx.preactivatedSkillIdCalls).not.toContain("computer-use");
    expect(ctx.preactivatedSkillIdCalls).not.toContain("app-control");
  });

  test("drainSingleMessage does not re-add 'app-control' for non-host-proxy interface (slack)", async () => {
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "slack",
      assistantMessageInterface: "slack",
    };
    queue.push(
      makeQueuedMessage({ requestId: "req-2", turnInterfaceContext: ifCtx }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    expect(ctx.preactivatedSkillIdCalls).not.toContain("computer-use");
    expect(ctx.preactivatedSkillIdCalls).not.toContain("app-control");
  });

  test("drainBatch re-adds 'app-control' for macOS-sourced batched queue", async () => {
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    };
    // Two passthrough siblings with matching interface — buildPassthroughBatch
    // groups them into a batch, exercising drainBatch.
    queue.push(
      makeQueuedMessage({
        requestId: "req-2",
        content: "msg-2",
        turnInterfaceContext: ifCtx,
      }),
    );
    queue.push(
      makeQueuedMessage({
        requestId: "req-3",
        content: "msg-3",
        turnInterfaceContext: ifCtx,
      }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    // Batched path mirrors the single-message preactivation block.
    expect(ctx.preactivatedSkillIdCalls).toContain("computer-use");
    expect(ctx.preactivatedSkillIdCalls).toContain("app-control");
    expect(ctx.preactivatedSkillIds).toContain("app-control");
  });

  test("drainSingleMessage skips 'app-control' re-add when isInteractive=false", async () => {
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "macos",
      assistantMessageInterface: "macos",
    };
    const qm = makeQueuedMessage({
      requestId: "req-2",
      turnInterfaceContext: ifCtx,
    });
    qm.isInteractive = false;
    queue.push(qm);
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    // Both branches share the outer `isInteractive !== false` gate, so
    // app-control follows CU's behavior and is skipped for non-interactive
    // turns even on macOS.
    expect(ctx.preactivatedSkillIdCalls).not.toContain("computer-use");
    expect(ctx.preactivatedSkillIdCalls).not.toContain("app-control");
  });
});
