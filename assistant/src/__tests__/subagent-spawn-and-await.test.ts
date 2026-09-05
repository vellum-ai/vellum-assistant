/**
 * Tests for `SubagentManager.spawnAndAwait` — the synchronous run primitive.
 *
 * Unlike fire-and-forget `spawn` (covered elsewhere), `spawnAndAwait` awaits
 * the child's run, resolves to its final assistant text, supports external
 * abort via `signal`, and MUST NOT trigger the terminal parent-injection that
 * the fire-and-forget path uses.
 *
 * The harness mocks `Conversation` + bootstrap + provider registry + config
 * (same pattern as subagent-call-site-routing.test.ts) so the manager runs
 * its real setUpSubagent → runSubagent path against a controllable fake
 * Conversation without touching SQLite or a real provider.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantEvent } from "../api/index.js";
import type { Message } from "../providers/types.js";

// ── Fake Conversation ───────────────────────────────────────────────────────

interface FakeConversationConfig {
  /** Final in-memory messages exposed after runAgentLoop resolves. */
  messages?: Message[];
  /** When set, runAgentLoop rejects with this error. */
  runError?: Error;
  /**
   * When true, runAgentLoop blocks until `abort()` is called, then rejects.
   * Used to exercise the external-signal abort path.
   */
  waitForAbort?: boolean;
  /**
   * When true, runAgentLoop blocks until `abort()` is called, then RESOLVES
   * normally (does not throw). Simulates the real `runAgentLoop`, which
   * consumes the cancellation internally and resolves — the case where a
   * timed-out run would otherwise reach the success branch.
   */
  resolveOnAbort?: boolean;
  /** Deltas to emit through sendToClient before runAgentLoop resolves. */
  emitDeltas?: AssistantEvent[];
  /**
   * Invoked synchronously at the very start of runAgentLoop (after the loop has
   * begun, so the run is past the early-terminal guard and marked "running").
   * Lets a test trigger an external abort while the loop is genuinely in
   * flight, deterministically exercising the resolve-on-abort branch that
   * captures partial trailing text.
   */
  onLoopStart?: () => void;
  /**
   * Text the run flushes as its trailing assistant message when it is aborted,
   * modelling the real loop's final partial flush. Written when `abort()` is
   * called, which is AFTER a budget stop raises the abort and before
   * `runAgentLoop` finishes unwinding, so a notification sent from the stop
   * itself cannot see it and one sent from the run's teardown can.
   */
  flushOnAbort?: string;
}

/** Ordered record of the flush and the parent injection, for the budget tests. */
let teardownOrder: string[] = [];

let nextConversationConfig: FakeConversationConfig = {};
/** Set true when any FakeConversation's runAgentLoop is invoked. */
let runLoopInvoked = false;
/** The first user message persisted by the most recent FakeConversation. */
let lastPersistedUserMessage: string | undefined;
/** Records `setSubagentDenySideEffects` on the most recent FakeConversation. */
let lastDenySideEffects: boolean | undefined;
/**
 * Records `setSubagentSuppressParentNotifications` on the most recent
 * FakeConversation.
 */
let lastSuppressParentNotifications: boolean | undefined;
/** Records `setTrustContext` on the most recent FakeConversation. */
let lastTrustContext: unknown;
/** Options the most recent `bootstrapConversation` call received. */
let lastBootstrapOptions: Record<string, unknown> | undefined;

class FakeConversation {
  messages: Message[];
  usageStats = { inputTokens: 10, outputTokens: 5, estimatedCost: 0.001 };
  subagentDeniedToolNames = new Set<string>();
  subagentToolStats = {
    calls: 0,
    succeeded: 0,
    filesWritten: new Set<string>(),
  };
  conversationType = "background";
  hasSystemPromptOverride = false;

  private sendToClient: (msg: AssistantEvent) => void;
  private readonly cfg: FakeConversationConfig;
  private aborted = false;
  private resolveAbort?: () => void;

  constructor(
    _id: string,
    _provider: unknown,
    _systemPrompt: string,
    sendToClient: (msg: AssistantEvent) => void,
    _workingDir: string,
    _options?: unknown,
  ) {
    this.sendToClient = sendToClient;
    this.cfg = nextConversationConfig;
    this.messages = this.cfg.messages ?? [];
  }

  updateClient(sendToClient: (msg: AssistantEvent) => void) {
    // The manager re-points sendToClient via updateClient; honor it so the
    // wrappedSendToClient tap is the one the deltas flow through.
    this.sendToClient = sendToClient;
  }

  setTrustContext(ctx: unknown) {
    lastTrustContext = ctx;
  }
  setAuthContext() {}
  getAuthContext() {
    return undefined;
  }
  setAssistantId() {}
  setEnabledPlugins() {}
  setSubagentAllowedTools() {}
  setSubagentDenySideEffects(deny: boolean) {
    lastDenySideEffects = deny;
  }
  setSubagentSuppressParentNotifications(suppress: boolean) {
    lastSuppressParentNotifications = suppress;
  }
  setPreactivatedSkillIds() {}
  getCurrentSystemPrompt() {
    return "system";
  }
  injectInheritedContext() {}

  persistUserMessage(args: { content: string }) {
    lastPersistedUserMessage = args.content;
    return { id: "msg-id", deduplicated: false };
  }

  /** A busy child queues a follow-up; `sendMessage` reads `queued` off this. */
  enqueueMessage() {
    return { queued: true, rejected: false, requestId: "req-child" };
  }

  async runAgentLoop() {
    runLoopInvoked = true;
    this.cfg.onLoopStart?.();
    for (const delta of this.cfg.emitDeltas ?? []) {
      this.sendToClient(delta);
    }
    if (this.cfg.waitForAbort || this.cfg.resolveOnAbort) {
      // Block until abort() resolves the gate (unless abort already fired, e.g.
      // an already-aborted signal). resolveOnAbort RESOLVES normally to mimic
      // the real runAgentLoop consuming the cancellation; waitForAbort throws.
      if (!this.aborted) {
        await new Promise<void>((resolve) => {
          this.resolveAbort = resolve;
        });
      }
      if (this.cfg.resolveOnAbort) {
        return;
      }
      throw new Error("aborted");
    }
    if (this.cfg.runError) {
      throw this.cfg.runError;
    }
  }

  abort() {
    this.aborted = true;
    if (this.cfg.flushOnAbort !== undefined) {
      this.messages = [
        {
          role: "assistant",
          content: [{ type: "text", text: this.cfg.flushOnAbort }],
        },
      ];
      teardownOrder.push("flush");
    }
    this.resolveAbort?.();
  }
  dispose() {}
}

mock.module("../daemon/conversation.js", () => ({
  Conversation: FakeConversation,
}));

/**
 * When set, `bootstrapConversation` awaits this before resolving. Lets a test
 * hold spawn setup open and cancel the turn while it is in flight, which is the
 * window `spawn`'s post-setup signal recheck exists to close.
 */
let bootstrapGate: Promise<void> | undefined;

mock.module("../persistence/conversation-bootstrap.js", () => ({
  bootstrapConversation: async (opts: Record<string, unknown>) => {
    lastBootstrapOptions = opts;
    if (bootstrapGate) {
      await bootstrapGate;
    }
    return { id: `conv-${Math.random()}` };
  },
}));

mock.module("../prompts/system-prompt.js", () => ({
  buildSystemPrompt: () => "system prompt",
  buildSubagentSystemPrompt: () => "subagent system",
}));

const anthropicStub = { name: "anthropic" };

mock.module("../providers/registry.js", () => ({
  getProvider: () => anthropicStub,
  resolveProviderFromConnection: async () => anthropicStub,
  clearConnectionProviderCache: () => {},
  listProviders: () => ["anthropic"],
}));

mock.module("../providers/connection-resolution.js", () => ({
  resolveDefaultProvider: async () => anthropicStub,
}));

mock.module("../providers/call-site-routing.js", () => ({
  wrapWithCallSiteRouting: (provider: unknown) => provider,
}));

mock.module("../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({
    provider: "anthropic",
    provider_connection: "anthropic-conn",
    maxTokens: 4096,
  }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  SubagentAbortedError,
  SubagentManager,
  SubagentSpawnCancelledError,
} from "../subagent/manager.js";
import { asConversation } from "./helpers/mock-conversation.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    parentConversationId: `parent-${Math.random()}`,
    label: "test",
    objective: "do the thing",
    ...overrides,
  };
}

/** Statuses broadcast to the parent via `subagent_status_changed` events. */
function broadcastStatuses(events: AssistantEvent[]): string[] {
  return events
    .filter((m) => m.type === "subagent_status_changed")
    .map((m) => (m as { status: string }).status);
}

/** A fake parent conversation that records injected (enqueued) messages. */
function registerFakeParent(parentConversationId: string): {
  enqueuedCount: () => number;
  messages: () => string[];
} {
  const enqueued: string[] = [];
  setConversation(
    parentConversationId,
    asConversation({
      // Accessors read by setUpSubagent when copying trust/auth context.
      trustContext: undefined,
      getAuthContext: () => undefined,
      assistantId: undefined,
      enqueueMessage: (options: { content: string }) => {
        enqueued.push(options.content);
        teardownOrder.push("notify");
        return { rejected: false, queued: true, requestId: "req-fake" };
      },
    }),
  );
  return { enqueuedCount: () => enqueued.length, messages: () => enqueued };
}

describe("SubagentManager.spawnAndAwait", () => {
  // Reset outside the test body so TypeScript does not narrow the module var to
  // `undefined` across the opaque spawnAndAwait call.
  beforeEach(() => {
    lastDenySideEffects = undefined;
    lastSuppressParentNotifications = undefined;
    lastTrustContext = undefined;
  });

  test("wires denySideEffectTools onto the subagent conversation (read-only)", async () => {
    nextConversationConfig = {};

    const manager = new SubagentManager();
    await manager.spawnAndAwait(
      makeConfig({ denySideEffectTools: true }),
      () => {},
    );

    expect(lastDenySideEffects).toBe(true);
  });

  test("leaves denySideEffectTools off by default", async () => {
    nextConversationConfig = {};

    const manager = new SubagentManager();
    await manager.spawnAndAwait(makeConfig(), () => {});

    expect(lastDenySideEffects).toBeUndefined();
  });

  test("an explicit config trustContext lands on the subagent conversation", async () => {
    nextConversationConfig = {};

    const manager = new SubagentManager();
    // No parent conversation is registered here, so inheritance would leave
    // trust unset — the explicit config value must be applied regardless (the
    // live-voice continuation path, where the parent's per-turn trust has
    // already been cleared at spawn time).
    await manager.spawnAndAwait(
      makeConfig({
        trustContext: { sourceChannel: "vellum", trustClass: "guardian" },
      }),
      () => {},
    );

    expect(lastTrustContext).toMatchObject({
      sourceChannel: "vellum",
      trustClass: "guardian",
    });
  });

  test("suppresses mid-run parent notifications on the synchronous path", async () => {
    nextConversationConfig = {};

    const manager = new SubagentManager();
    await manager.spawnAndAwait(makeConfig(), () => {});

    // The awaiting caller is the child's only parent channel: notify_parent
    // must not inject a user-role turn into the live parent mid-await.
    expect(lastSuppressParentNotifications).toBe(true);
  });

  test("stamps the parent conversation id on the subagent's conversation", async () => {
    nextConversationConfig = {};

    const manager = new SubagentManager();
    const config = makeConfig();
    await manager.spawnAndAwait(config, () => {});

    expect(lastBootstrapOptions?.parentConversationId).toBe(
      config.parentConversationId,
    );
  });

  test("resolves to the child's final assistant text", async () => {
    nextConversationConfig = {
      messages: [
        { role: "user", content: [{ type: "text", text: "do the thing" }] },
        {
          role: "assistant",
          content: [
            { type: "text", text: "Final " },
            { type: "text", text: "answer." },
          ],
        },
      ],
    };

    const manager = new SubagentManager();
    const text = await manager.spawnAndAwait(makeConfig(), () => {});

    expect(text).toBe("Final answer.");
  });

  test("returns empty string when the final assistant message has no text", async () => {
    nextConversationConfig = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
        },
      ],
    };

    const manager = new SubagentManager();
    const text = await manager.spawnAndAwait(makeConfig(), () => {});

    expect(text).toBe("");
  });

  test("does NOT inject a terminal notification into the parent (synchronous path)", async () => {
    clearConversations();
    const cfg = makeConfig();
    const parent = registerFakeParent(cfg.parentConversationId);

    nextConversationConfig = {
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "result" }],
        },
      ],
    };

    const manager = new SubagentManager();
    await manager.spawnAndAwait(cfg, () => {});

    expect(parent.enqueuedCount()).toBe(0);
    clearConversations();
  });

  test("aborting the provided signal rejects the run", async () => {
    nextConversationConfig = { waitForAbort: true };

    const controller = new AbortController();
    const manager = new SubagentManager();
    const promise = manager.spawnAndAwait(makeConfig(), () => {}, {
      signal: controller.signal,
    });

    // Abort on the next tick so the run is in flight.
    queueMicrotask(() => controller.abort());

    await expect(promise).rejects.toThrow();
  });

  test("an already-aborted signal aborts the run immediately", async () => {
    nextConversationConfig = { waitForAbort: true };

    const controller = new AbortController();
    controller.abort();

    const manager = new SubagentManager();
    await expect(
      manager.spawnAndAwait(makeConfig(), () => {}, {
        signal: controller.signal,
      }),
    ).rejects.toThrow();
  });

  test("a live-signal abort records status 'aborted', never broadcasts 'completed'", async () => {
    // runAgentLoop RESOLVES normally on abort (the real loop consumes the
    // cancellation). Before the fix, runSubagent's success branch then
    // recorded the run as "completed"; the manager-routed abort must mark it
    // terminal first so this is recorded and broadcast as "aborted".
    nextConversationConfig = { resolveOnAbort: true };

    const events: AssistantEvent[] = [];
    const controller = new AbortController();
    const manager = new SubagentManager();
    const promise = manager.spawnAndAwait(
      makeConfig(),
      (msg) => events.push(msg),
      { signal: controller.signal },
    );

    // Abort once the run is in flight (runAgentLoop is awaiting the gate).
    queueMicrotask(() => controller.abort());

    await expect(promise).rejects.toThrow();

    const statuses = broadcastStatuses(events);
    expect(statuses).toContain("aborted");
    expect(statuses).not.toContain("completed");
  });

  test("an abort carries the partial assistant text on the rejection", async () => {
    // The real runAgentLoop consumes the cancellation and resolves, so the
    // success branch captures whatever trailing assistant text was streamed
    // before the abort. A timed-out caller (e.g. the advisor consult) must be
    // able to recover that partial text rather than have it discarded.
    const controller = new AbortController();
    nextConversationConfig = {
      resolveOnAbort: true,
      messages: [
        {
          role: "assistant",
          content: [{ type: "text", text: "partial advice so far" }],
        },
      ],
      // Abort once the loop is in flight (past the early-terminal guard, status
      // "running") so we exercise the partial-capture branch, not the
      // aborted-before-start early return.
      onLoopStart: () => controller.abort(),
    };

    const manager = new SubagentManager();
    const err = await manager
      .spawnAndAwait(makeConfig(), () => {}, { signal: controller.signal })
      .then(
        () => undefined,
        (e) => e,
      );
    expect(err).toBeInstanceOf(SubagentAbortedError);
    expect((err as SubagentAbortedError).partialText).toContain(
      "partial advice so far",
    );
  });

  test("an already-aborted signal does not run the agent loop", async () => {
    nextConversationConfig = { resolveOnAbort: true };
    runLoopInvoked = false;

    const controller = new AbortController();
    controller.abort();

    const events: AssistantEvent[] = [];
    const manager = new SubagentManager();
    await expect(
      manager.spawnAndAwait(makeConfig(), (msg) => events.push(msg), {
        signal: controller.signal,
      }),
    ).rejects.toThrow();

    // The early-return guard fires before setStatus("running") and before the
    // agent loop starts: no loop invocation, no "running"/"completed" broadcast.
    expect(runLoopInvoked).toBe(false);
    const statuses = broadcastStatuses(events);
    expect(statuses).not.toContain("running");
    expect(statuses).not.toContain("completed");
    expect(statuses).toContain("aborted");
  });

  test("a failing run rejects (does not silently resolve)", async () => {
    nextConversationConfig = { runError: new Error("boom") };

    const manager = new SubagentManager();
    await expect(manager.spawnAndAwait(makeConfig(), () => {})).rejects.toThrow(
      "boom",
    );
  });
});

describe("SubagentManager — first user message framing", () => {
  const advisorTrailingText = {
    messages: [
      {
        role: "assistant" as const,
        content: [{ type: "text" as const, text: "advice" }],
      },
    ],
  };

  beforeEach(() => {
    lastPersistedUserMessage = undefined;
  });

  test("advisor consult sends the bare advice request (no FORK TASK wrapper)", async () => {
    nextConversationConfig = advisorTrailingText;

    const manager = new SubagentManager();
    await manager.spawnAndAwait(
      makeConfig({
        objective: "Please advise.",
        role: "advisor",
        spawnMode: "advisor_consult",
        // The advisor always supplies its own framing; setUpSubagent uses it
        // in place of a built subagent preamble.
        systemPromptOverride: "You are a senior advisor.",
      }),
      () => {},
    );

    // The consult's user turn is the brief itself: the fork directive would
    // fight the advisor system prompt. Framing is shared by both entry points,
    // so awaiting here exercises the same path the advisor's own spawn takes.
    expect(lastPersistedUserMessage).toBe("Please advise.");
    expect(lastPersistedUserMessage).not.toContain("FORK TASK");
  });

  test("a non-advisor fork still wraps the objective in FORK TASK framing", async () => {
    nextConversationConfig = advisorTrailingText;

    const manager = new SubagentManager();
    await manager.spawnAndAwait(
      makeConfig({
        objective: "Investigate the bug.",
        fork: true,
        parentSystemPrompt: "Parent prompt.",
        parentMessages: [
          { role: "user", content: [{ type: "text", text: "prior turn" }] },
        ],
      }),
      () => {},
    );

    expect(lastPersistedUserMessage).toContain("FORK TASK");
    expect(lastPersistedUserMessage).toContain("Investigate the bug.");
  });

  test("a non-fork subagent sends the bare objective (no FORK TASK wrapper)", async () => {
    nextConversationConfig = advisorTrailingText;

    const manager = new SubagentManager();
    await manager.spawnAndAwait(
      makeConfig({ objective: "Do the thing." }),
      () => {},
    );

    expect(lastPersistedUserMessage).toBe("Do the thing.");
    expect(lastPersistedUserMessage).not.toContain("FORK TASK");
  });
});

describe("SubagentManager.spawn (fire-and-forget) — unaffected", () => {
  test("spawn returns the subagent id synchronously and does not throw on a normal run", async () => {
    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };

    const manager = new SubagentManager();
    const id = await manager.spawn(makeConfig(), () => {});

    expect(typeof id).toBe("string");
    expect(id.length).toBeGreaterThan(0);
  });

  test("spawn still injects a terminal notification into the parent", async () => {
    clearConversations();
    const cfg = makeConfig();
    const parent = registerFakeParent(cfg.parentConversationId);

    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };

    const manager = new SubagentManager();
    await manager.spawn(cfg, () => {});

    // The run kicks off asynchronously; let the microtask/macrotask queue drain.
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(parent.enqueuedCount()).toBeGreaterThan(0);
    clearConversations();
  });
});

// ── Cancellation during spawn setup ─────────────────────────────────────────

describe("SubagentManager.spawn cancellation", () => {
  beforeEach(() => {
    runLoopInvoked = false;
    bootstrapGate = undefined;
  });

  test("an already-cancelled turn spawns nothing at all", async () => {
    nextConversationConfig = {};
    const controller = new AbortController();
    controller.abort();

    const manager = new SubagentManager();
    await expect(
      manager.spawn(makeConfig(), () => {}, { signal: controller.signal }),
    ).rejects.toBeInstanceOf(SubagentSpawnCancelledError);

    // Not merely "did not run": no conversation was bootstrapped either, so the
    // stopped turn costs nothing.
    expect(runLoopInvoked).toBe(false);
  });

  test("cancelling during setup leaves the child terminal and never runs it", async () => {
    // The race this closes: setup is async, so `abortAllForParent` can sweep the
    // parent while this child is not yet in the manager to be swept. Without the
    // post-setup recheck the abandoned promise would launch a run afterwards.
    clearConversations();
    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };
    const controller = new AbortController();
    let openGate: () => void = () => {};
    bootstrapGate = new Promise<void>((resolve) => {
      openGate = resolve;
    });

    const manager = new SubagentManager();
    const spawning = manager.spawn(makeConfig(), () => {}, {
      signal: controller.signal,
    });

    // Stop the turn while the child conversation is still being built, then let
    // setup finish.
    controller.abort();
    openGate();
    const subagentId = await spawning;

    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runLoopInvoked).toBe(false);
    expect(manager.getState(subagentId)?.status).toBe("aborted");
    clearConversations();
  });

  test("a live turn spawns normally", async () => {
    // The guard must cost an uncancelled spawn nothing.
    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "ok" }] },
      ],
    };
    const controller = new AbortController();

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(makeConfig(), () => {}, {
      signal: controller.signal,
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(runLoopInvoked).toBe(true);
    expect(manager.getState(subagentId)?.status).toBe("completed");
  });
});

// ── Advisor follow-ups ──────────────────────────────────────────────────────

describe("SubagentManager.sendMessage on an advisor", () => {
  beforeEach(() => {
    clearConversations();
    bootstrapGate = undefined;
  });

  test("an advisor refuses a follow-up rather than running an unbudgeted turn", async () => {
    // A queued follow-up drains after `runSubagent` has already settled the run
    // and cleared the runtime timer, so it would run on the premium profile
    // under neither the time nor the tool-call ceiling. The advisor is
    // documented as one-shot, so the refusal is the consistent answer.
    const cfg = makeConfig({ role: "advisor", maxToolCalls: 8 });
    registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = { waitForAbort: true };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});
    // Mid-run, which is exactly when a follow-up would be queued.
    expect(manager.getState(subagentId)?.status).toBe("running");

    await expect(
      manager.sendMessage(subagentId, "one more thing"),
    ).resolves.toBe("one_shot");

    // Nothing was queued, so no drained turn can escape the budget later.
    expect(manager.getState(subagentId)?.status).toBe("running");
    manager.abort(subagentId, () => {}, undefined, {
      suppressNotification: true,
    });
    clearConversations();
  });

  test("other roles still take follow-ups", async () => {
    // The refusal is the advisor's alone: delegated work is steerable mid-run,
    // which is what subagent_message is for.
    const cfg = makeConfig({ role: "researcher" });
    registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = { waitForAbort: true };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});

    await expect(
      manager.sendMessage(subagentId, "also check the queue"),
    ).resolves.not.toBe("one_shot");

    manager.abort(subagentId, () => {}, undefined, {
      suppressNotification: true,
    });
    clearConversations();
  });
});

// ── Run budgets ─────────────────────────────────────────────────────────────

describe("SubagentManager run budgets", () => {
  /** One child tool call, as the agent loop emits it. */
  function toolCallEvent(toolUseId: string): AssistantEvent {
    return {
      type: "tool_use_start",
      toolName: "file_read",
      toolUseId,
    } as unknown as AssistantEvent;
  }

  beforeEach(() => {
    clearConversations();
    bootstrapGate = undefined;
    teardownOrder = [];
  });

  test("a child that outlives maxRuntimeMs is stopped and the parent told", async () => {
    const cfg = makeConfig({ maxRuntimeMs: 20 });
    const parent = registerFakeParent(cfg.parentConversationId);
    // Runs until something aborts it, which here is the budget timer.
    nextConversationConfig = { waitForAbort: true };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(manager.getState(subagentId)?.status).toBe("aborted");
    const injected = parent.messages().join("\n");
    expect(injected).toContain("stopped at its budget");
    expect(injected).toContain("time limit");
    // Not the plain abort text: nobody cancelled this, and the output it did
    // produce is worth reading.
    expect(injected).not.toContain("cancelled on purpose");
    expect(injected).toContain("subagent_read");
    clearConversations();
  });

  test("a child that runs past maxToolCalls is stopped and the parent told", async () => {
    const cfg = makeConfig({ maxToolCalls: 2 });
    const parent = registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = {
      waitForAbort: true,
      // The budget is spent in full first: the third call is the one past the
      // ceiling of two, so both results inside the budget are kept.
      emitDeltas: [
        toolCallEvent("tool-1"),
        toolCallEvent("tool-2"),
        toolCallEvent("tool-3"),
      ],
    };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(manager.getState(subagentId)?.status).toBe("aborted");
    const injected = parent.messages().join("\n");
    expect(injected).toContain("stopped at its budget");
    expect(injected).toContain("full budget of 2 tool calls");
    expect(injected).not.toContain("cancelled on purpose");
    clearConversations();
  });

  test("the budget notification waits for the run's final flush", async () => {
    // The stop is raised from a timer while `runAgentLoop` is still awaited, so
    // sending the notification there would point the parent at a transcript
    // that does not yet contain the guidance. The flush lands during teardown;
    // the notification must come after it, and must carry what it wrote.
    const cfg = makeConfig({ maxRuntimeMs: 20 });
    const parent = registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = {
      waitForAbort: true,
      flushOnAbort: "Lead with the data model.",
    };

    const manager = new SubagentManager();
    await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 80));

    expect(teardownOrder).toEqual(["flush", "notify"]);
    // The inlined guidance is the proof the notification read the settled run:
    // sent from the stop itself, this text does not exist yet.
    const injected = parent.messages().join("\n");
    expect(injected).toContain("Lead with the data model.");
    expect(injected).toContain("stopped at its budget");
    clearConversations();
  });

  test("a tool-cap stop reports the guidance the child had written", async () => {
    // Same ordering on the other ceiling, which fires from the event tap rather
    // than a timer.
    const cfg = makeConfig({ maxToolCalls: 1 });
    const parent = registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = {
      waitForAbort: true,
      flushOnAbort: "Check the migration ordering first.",
      emitDeltas: [toolCallEvent("tool-1"), toolCallEvent("tool-2")],
    };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(teardownOrder).toEqual(["flush", "notify"]);
    const injected = parent.messages().join("\n");
    expect(injected).toContain("Check the migration ordering first.");
    expect(injected).toContain("full budget of 1 tool calls");
    // What a read after the notification would find is the same text, because
    // the run had settled before the parent was told anything.
    expect(manager.getState(subagentId)?.status).toBe("aborted");
    clearConversations();
  });

  test("a stop with nothing written points at the read instead", async () => {
    const cfg = makeConfig({ maxRuntimeMs: 20 });
    const parent = registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = { waitForAbort: true };

    const manager = new SubagentManager();
    await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 80));

    const injected = parent.messages().join("\n");
    expect(injected).toContain("before writing anything");
    expect(injected).toContain("subagent_read");
    clearConversations();
  });

  test("tool calls inside the ceiling leave the child running", async () => {
    const cfg = makeConfig({ maxToolCalls: 3 });
    registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      emitDeltas: [
        toolCallEvent("tool-1"),
        toolCallEvent("tool-2"),
        toolCallEvent("tool-3"),
        // Non-tool traffic must not count against the ceiling.
        { type: "assistant_text_delta", text: "thinking" } as AssistantEvent,
      ],
    };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(manager.getState(subagentId)?.status).toBe("completed");
    clearConversations();
  });

  test("a child with no declared budget is bounded by neither", async () => {
    // Delegated work whose length is the point must not inherit the advisor's
    // ceilings, so an unbudgeted spawn runs to its own completion.
    const cfg = makeConfig();
    registerFakeParent(cfg.parentConversationId);
    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      emitDeltas: Array.from({ length: 30 }, (_, i) =>
        toolCallEvent(`tool-${i}`),
      ),
    };

    const manager = new SubagentManager();
    const subagentId = await manager.spawn(cfg, () => {});
    await new Promise((resolve) => setTimeout(resolve, 40));

    expect(manager.getState(subagentId)?.status).toBe("completed");
    clearConversations();
  });
});
