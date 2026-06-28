import { afterEach, describe, expect, mock, test } from "bun:test";

import type { TurnCommitContext } from "@vellumai/plugin-api";

import type { MemoryProviderContext } from "../../../../../memory/provider/types.js";

/**
 * The default `turn-commit` hook drives the active memory provider's
 * post-turn consolidation enqueue. These tests assert the two gates the hook
 * inherits from the conversation-disposal safety-net it replaces (trust +
 * auto-analysis recursion) and trigger parity: that a committed turn for a
 * trusted, non-auto-analysis conversation still enqueues a retrospective on the
 * `lifecycle` trigger, now routed through `resolveMemoryProvider().onTurnCommit`.
 */

const NOOP_LOGGER = {
  info: () => {},
  warn: () => {},
  error: () => {},
  debug: () => {},
};

function turnCommitCtx(
  overrides: Partial<TurnCommitContext> = {},
): TurnCommitContext {
  return {
    conversationId: "conv-1",
    userMessageId: "msg-1",
    messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }],
    turnCount: 3,
    isNonInteractive: false,
    logger: NOOP_LOGGER,
    ...overrides,
  };
}

afterEach(() => {
  mock.restore();
});

/**
 * Mock the hook's collaborators and import the hook fresh. `provider` is the
 * spy `onTurnCommit` the resolved provider exposes; `enqueue` is the underlying
 * retrospective-enqueue the real providers call (mocked here so the
 * trigger-parity test can run the real graph provider through the route).
 */
async function loadHookWithMocks(opts: {
  trustClass?: string;
  canAccessMemory?: boolean;
  isAutoAnalysis?: boolean;
  resolvedOnTurnCommit?: (ctx: MemoryProviderContext) => Promise<void>;
}) {
  const {
    trustClass = "guardian",
    canAccessMemory = true,
    isAutoAnalysis = false,
    resolvedOnTurnCommit,
  } = opts;

  const loaderActual = await import("../../../../../config/loader.js");
  mock.module("../../../../../config/loader.js", () => ({
    ...loaderActual,
    getConfig: () => ({ memory: { providerSlice: true } }) as never,
  }));
  mock.module("../../../../../daemon/conversation-registry.js", () => ({
    findConversationOrSubagent: () => ({
      currentTurnTrustContext: { sourceChannel: "vellum", trustClass },
    }),
  }));
  mock.module("../../../../../runtime/capabilities.js", () => ({
    resolveCapabilities: () => ({ canAccessMemory }),
  }));
  mock.module("../../../../../memory/auto-analysis-guard.js", () => ({
    isAutoAnalysisConversation: () => isAutoAnalysis,
  }));

  const onTurnCommit =
    resolvedOnTurnCommit ?? mock(async (_ctx: MemoryProviderContext) => {});
  mock.module("../../../../../memory/provider/resolve.js", () => ({
    resolveMemoryProvider: () => ({ id: "graph", onTurnCommit }),
  }));

  const hook = (await import("../turn-commit.js")).default;
  return { hook, onTurnCommit };
}

describe("memory-retrieval turn-commit hook", () => {
  test("delegates to the resolved provider's onTurnCommit with a context built from the turn", async () => {
    let received: MemoryProviderContext | null = null;
    const { hook } = await loadHookWithMocks({
      resolvedOnTurnCommit: async (ctx) => {
        received = ctx;
      },
    });

    await hook(turnCommitCtx());

    expect(received).not.toBeNull();
    const ctx = received as unknown as MemoryProviderContext;
    expect(ctx.conversationId).toBe("conv-1");
    expect(ctx.requestId).toBe("msg-1");
    expect(ctx.turnIndex).toBe(3);
    expect(ctx.trust.trustClass).toBe("guardian");
  });

  test("skips delegation when the actor cannot access memory", async () => {
    const { hook, onTurnCommit } = await loadHookWithMocks({
      trustClass: "unknown",
      canAccessMemory: false,
    });

    await hook(turnCommitCtx());

    expect(onTurnCommit).not.toHaveBeenCalled();
  });

  test("skips delegation for auto-analysis conversations (recursion guard)", async () => {
    const { hook, onTurnCommit } = await loadHookWithMocks({
      isAutoAnalysis: true,
    });

    await hook(turnCommitCtx());

    expect(onTurnCommit).not.toHaveBeenCalled();
  });

  test("trigger parity: a committed turn enqueues a retrospective on the lifecycle trigger via the real graph provider", async () => {
    const enqueue = mock(
      (_args: { conversationId: string; trigger: string }) => {},
    );

    const loaderActual = await import("../../../../../config/loader.js");
    mock.module("../../../../../config/loader.js", () => ({
      ...loaderActual,
      getConfig: () => ({ memory: { provider: "graph" } }) as never,
    }));
    mock.module("../../../../../daemon/conversation-registry.js", () => ({
      findConversationOrSubagent: () => ({
        currentTurnTrustContext: {
          sourceChannel: "vellum",
          trustClass: "guardian",
        },
      }),
    }));
    mock.module("../../../../../runtime/capabilities.js", () => ({
      resolveCapabilities: () => ({ canAccessMemory: true }),
    }));
    mock.module("../../../../../memory/auto-analysis-guard.js", () => ({
      isAutoAnalysisConversation: () => false,
    }));

    // Intercept the underlying enqueue the real providers call, then resolve
    // the real graph provider so the hook exercises the full route
    // (hook → resolveMemoryProvider → GraphMemoryProvider.onTurnCommit →
    // enqueue) rather than a stub.
    mock.module(
      "../../../../../memory/memory-retrospective-enqueue.js",
      () => ({
        enqueueMemoryRetrospectiveIfEnabled: enqueue,
      }),
    );
    const { GraphMemoryProvider } =
      await import("../../../../../memory/provider/graph-provider.js");
    mock.module("../../../../../memory/provider/resolve.js", () => ({
      resolveMemoryProvider: () => GraphMemoryProvider,
    }));

    const hook = (await import("../turn-commit.js")).default;
    await hook(turnCommitCtx({ conversationId: "conv-parity" }));

    expect(enqueue).toHaveBeenCalledTimes(1);
    expect(enqueue.mock.calls[0][0]).toEqual({
      conversationId: "conv-parity",
      trigger: "lifecycle",
    });
  });
});
