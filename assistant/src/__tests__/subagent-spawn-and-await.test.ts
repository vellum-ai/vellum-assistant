/**
 * Tests for `SubagentManager.spawnAndAwait` — the synchronous run primitive.
 *
 * Unlike fire-and-forget `spawn` (covered elsewhere), `spawnAndAwait` awaits
 * the child's run, resolves to its final assistant text, forwards streaming
 * deltas via `onText`, supports external abort via `signal`, and MUST NOT
 * trigger the terminal parent-injection that the fire-and-forget path uses.
 *
 * The harness mocks `Conversation` + bootstrap + provider registry + config
 * (same pattern as subagent-call-site-routing.test.ts) so the manager runs
 * its real setUpSubagent → runSubagent path against a controllable fake
 * Conversation without touching SQLite or a real provider.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { ServerMessage } from "../daemon/message-protocol.js";
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
  emitDeltas?: ServerMessage[];
  /**
   * Invoked synchronously at the very start of runAgentLoop (after the loop has
   * begun, so the run is past the early-terminal guard and marked "running").
   * Lets a test trigger an external abort while the loop is genuinely in
   * flight, deterministically exercising the resolve-on-abort branch that
   * captures partial trailing text.
   */
  onLoopStart?: () => void;
}

let nextConversationConfig: FakeConversationConfig = {};
/** Set true when any FakeConversation's runAgentLoop is invoked. */
let runLoopInvoked = false;
/** The first user message persisted by the most recent FakeConversation. */
let lastPersistedUserMessage: string | undefined;

class FakeConversation {
  messages: Message[];
  usageStats = { inputTokens: 10, outputTokens: 5, estimatedCost: 0.001 };
  conversationType = "background";
  hasSystemPromptOverride = false;

  private sendToClient: (msg: ServerMessage) => void;
  private readonly cfg: FakeConversationConfig;
  private aborted = false;
  private resolveAbort?: () => void;

  constructor(
    _id: string,
    _provider: unknown,
    _systemPrompt: string,
    sendToClient: (msg: ServerMessage) => void,
    _workingDir: string,
    _options?: unknown,
  ) {
    this.sendToClient = sendToClient;
    this.cfg = nextConversationConfig;
    this.messages = this.cfg.messages ?? [];
  }

  updateClient(sendToClient: (msg: ServerMessage) => void) {
    // The manager re-points sendToClient via updateClient; honor it so the
    // wrappedSendToClient tap is the one the deltas flow through.
    this.sendToClient = sendToClient;
  }

  setTrustContext() {}
  setAuthContext() {}
  getAuthContext() {
    return undefined;
  }
  setAssistantId() {}
  setEnabledPlugins() {}
  setSubagentAllowedTools() {}
  setPreactivatedSkillIds() {}
  getCurrentSystemPrompt() {
    return "system";
  }
  injectInheritedContext() {}

  persistUserMessage(args: { content: string }) {
    lastPersistedUserMessage = args.content;
    return { id: "msg-id", deduplicated: false };
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
      if (this.cfg.resolveOnAbort) return;
      throw new Error("aborted");
    }
    if (this.cfg.runError) {
      throw this.cfg.runError;
    }
  }

  abort() {
    this.aborted = true;
    this.resolveAbort?.();
  }
  dispose() {}
}

mock.module("../daemon/conversation.js", () => ({
  Conversation: FakeConversation,
}));

mock.module("../persistence/conversation-bootstrap.js", () => ({
  bootstrapConversation: () => ({ id: `conv-${Math.random()}` }),
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
import { SubagentAbortedError, SubagentManager } from "../subagent/manager.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    parentConversationId: `parent-${Math.random()}`,
    label: "test",
    objective: "do the thing",
    ...overrides,
  };
}

/** Statuses broadcast to the parent via `subagent_status_changed` events. */
function broadcastStatuses(events: ServerMessage[]): string[] {
  return events
    .filter((m) => m.type === "subagent_status_changed")
    .map((m) => (m as { status: string }).status);
}

/** A fake parent conversation that records injected (enqueued) messages. */
function registerFakeParent(parentConversationId: string): {
  enqueuedCount: () => number;
} {
  let enqueued = 0;
  setConversation(parentConversationId, {
    // Accessors read by setUpSubagent when copying trust/auth context.
    trustContext: undefined,
    getAuthContext: () => undefined,
    assistantId: undefined,
    enqueueMessage: () => {
      enqueued += 1;
      return { rejected: false, queued: true };
    },
  } as never);
  return { enqueuedCount: () => enqueued };
}

describe("SubagentManager.spawnAndAwait", () => {
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

  test("forwards streaming text/thinking deltas via onText", async () => {
    nextConversationConfig = {
      messages: [
        { role: "assistant", content: [{ type: "text", text: "done" }] },
      ],
      emitDeltas: [
        { type: "assistant_text_delta", text: "Hello " } as ServerMessage,
        {
          type: "assistant_thinking_delta",
          thinking: "(pondering) ",
        } as ServerMessage,
        { type: "assistant_text_delta", text: "world" } as ServerMessage,
        // Non-delta events must not be forwarded to onText.
        { type: "subagent_status_changed" } as ServerMessage,
      ],
    };

    const chunks: string[] = [];
    const manager = new SubagentManager();
    await manager.spawnAndAwait(makeConfig(), () => {}, {
      onText: (chunk) => chunks.push(chunk),
    });

    expect(chunks).toEqual(["Hello ", "(pondering) ", "world"]);
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

    const events: ServerMessage[] = [];
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

    const events: ServerMessage[] = [];
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
        fork: true,
        role: "advisor",
        // The advisor always supplies its own framing; setUpSubagent uses it
        // verbatim and never falls back to parentSystemPrompt.
        systemPromptOverride: "You are a senior advisor.",
        parentMessages: [
          { role: "user", content: [{ type: "text", text: "prior turn" }] },
        ],
      }),
      () => {},
    );

    // The advisor's user turn is the bare advice request — the generic fork
    // directive would fight the advisor system prompt.
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
