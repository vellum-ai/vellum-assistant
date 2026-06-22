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

import { afterEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Module mocks for downstream side effects (DB writes, slash resolution,
// notification preference extraction). The drain paths must be allowed to
// reach the preactivation block; they must not be allowed to touch a real DB.
// ---------------------------------------------------------------------------

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

/**
 * Per-test capability client roster. Set in individual tests to simulate
 * a connected macOS client for cross-client drain-path coverage. Reset in
 * afterEach so tests don't bleed state.
 */
let mockCapabilityClients: Array<{
  clientId: string;
  actorPrincipalId?: string;
}> = [];

mock.module("../runtime/assistant-event-hub.js", () => ({
  assistantEventHub: {
    listClientsByCapability: () => mockCapabilityClients,
  },
  broadcastMessage: () => {},
}));

mock.module("../memory/conversation-crud.js", () => ({
  setConversationOriginChannelIfUnset: () => {},
  setConversationOriginInterfaceIfUnset: () => {},
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  addMessage: () => ({ id: "msg-mock" }),
  reserveMessage: mock(async () => ({ id: "msg-reserve" })),
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
  persistQueuedMessageBody: async () => ({
    id: "user-msg-id",
    deduplicated: false,
  }),
}));

// ---------------------------------------------------------------------------
// Imports under test (after mocks)
// ---------------------------------------------------------------------------

import type { TurnInterfaceContext } from "../channels/types.js";
import type { Conversation } from "../daemon/conversation.js";
import { drainQueue } from "../daemon/conversation-process.js";
import {
  MessageQueue,
  type QueuedMessage,
} from "../daemon/conversation-queue-manager.js";
import { TraceEmitter } from "../daemon/trace-emitter.js";

// ---------------------------------------------------------------------------
// Fake context — captures preactivation calls, satisfies the bare minimum
// of `Conversation`. `runAgentLoop` resolves immediately so
// the drain-chain does not recurse forever.
// ---------------------------------------------------------------------------

interface FakeRecord {
  preactivatedSkillIdCalls: string[];
}

function makeFakeContext(opts: {
  queue: MessageQueue;
  turnInterfaceContext?: TurnInterfaceContext;
}): Conversation & FakeRecord {
  const calls: string[] = [];
  let preactivatedSkillIds: string[] | undefined = undefined;
  const ctx = {
    conversationId: "conv-app-control-preactivation",
    messages: [],
    processing: false,
    isProcessing(this: { processing: boolean }) {
      return this.processing;
    },
    setProcessing(this: { processing: boolean }, value: boolean) {
      this.processing = value;
    },
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
      return { id: "user-msg-id", deduplicated: false };
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
    trustContext: {
      trustClass: "guardian" as const,
      guardianPrincipalId: "user-1",
    },
    setTransportHints() {},
    applyHostEnvFromTransport() {},
    ensureHostProxiesForTurn() {},
  } as unknown as Conversation & FakeRecord;
  return ctx;
}

function makeQueuedMessage(opts: {
  requestId: string;
  content?: string;
  turnInterfaceContext?: TurnInterfaceContext;
  sourceActorPrincipalId?: string;
}): QueuedMessage {
  return {
    content: opts.content ?? "follow up",
    attachments: [],
    requestId: opts.requestId,
    onEvent: () => {},
    metadata: {},
    sentAt: Date.now(),
    turnInterfaceContext: opts.turnInterfaceContext,
    sourceActorPrincipalId: opts.sourceActorPrincipalId,
    authContext: opts.sourceActorPrincipalId
      ? ({ actorPrincipalId: opts.sourceActorPrincipalId } as never)
      : undefined,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("drainQueue preactivation re-add for host-proxy interfaces", () => {
  afterEach(() => {
    mockCapabilityClients = [];
  });

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

  // ── Cross-client drain-path: web source + macOS client connected ──────

  test("drainSingleMessage re-adds 'app-control' for web-sourced message when macOS client is connected", async () => {
    mockCapabilityClients = [
      { clientId: "macos-client-1", actorPrincipalId: "user-1" },
    ];
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    };
    queue.push(
      makeQueuedMessage({
        requestId: "req-web-1",
        turnInterfaceContext: ifCtx,
        sourceActorPrincipalId: "user-1",
      }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    // web natively supports neither host_cu nor host_app_control, but the
    // connected macOS client provides both via cross-client routing — so
    // both skills must be re-preactivated.
    expect(ctx.preactivatedSkillIdCalls).toContain("app-control");
    expect(ctx.preactivatedSkillIds).toContain("app-control");
    expect(ctx.preactivatedSkillIdCalls).toContain("computer-use");
  });

  test("drainSingleMessage filters cross-client preactivation by the queued requester, not guardian owner", async () => {
    mockCapabilityClients = [
      { clientId: "owner-macos-client", actorPrincipalId: "owner-user" },
    ];
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    };
    queue.push(
      makeQueuedMessage({
        requestId: "req-web-attacker",
        turnInterfaceContext: ifCtx,
        sourceActorPrincipalId: "trusted-contact-user",
      }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });
    ctx.trustContext = {
      trustClass: "trusted_contact",
      guardianPrincipalId: "owner-user",
      sourceChannel: "vellum",
    };

    await drainQueue(ctx);

    expect(ctx.preactivatedSkillIdCalls).not.toContain("computer-use");
    expect(ctx.preactivatedSkillIdCalls).not.toContain("app-control");
    expect(ctx.currentTurnAuthContext?.actorPrincipalId).toBe(
      "trusted-contact-user",
    );
    expect(ctx.currentTurnSourceActorPrincipalId).toBe("trusted-contact-user");
  });

  test("drainSingleMessage does NOT re-add 'app-control' for web-sourced message when no capable client is connected", async () => {
    // mockCapabilityClients remains [] (reset by afterEach from prior test)
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    };
    queue.push(
      makeQueuedMessage({
        requestId: "req-web-2",
        turnInterfaceContext: ifCtx,
      }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    expect(ctx.preactivatedSkillIdCalls).not.toContain("app-control");
    expect(ctx.preactivatedSkillIdCalls).not.toContain("computer-use");
  });

  test("drainSingleMessage re-adds 'computer-use' for web-sourced message when macOS client is connected", async () => {
    mockCapabilityClients = [
      { clientId: "macos-client-1", actorPrincipalId: "user-1" },
    ];
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    };
    queue.push(
      makeQueuedMessage({
        requestId: "req-web-3",
        turnInterfaceContext: ifCtx,
        sourceActorPrincipalId: "user-1",
      }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    expect(ctx.preactivatedSkillIdCalls).toContain("computer-use");
    expect(ctx.preactivatedSkillIds).toContain("computer-use");
  });

  test("drainSingleMessage does NOT re-add 'computer-use' for web-sourced message when no capable client is connected", async () => {
    const queue = new MessageQueue();
    const ifCtx: TurnInterfaceContext = {
      userMessageInterface: "web",
      assistantMessageInterface: "web",
    };
    queue.push(
      makeQueuedMessage({
        requestId: "req-web-4",
        turnInterfaceContext: ifCtx,
      }),
    );
    const ctx = makeFakeContext({ queue, turnInterfaceContext: ifCtx });

    await drainQueue(ctx);

    expect(ctx.preactivatedSkillIdCalls).not.toContain("computer-use");
  });
});
