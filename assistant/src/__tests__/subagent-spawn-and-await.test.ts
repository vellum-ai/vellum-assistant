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
import { describe, expect, mock, test } from "bun:test";

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
  /** Deltas to emit through sendToClient before runAgentLoop resolves. */
  emitDeltas?: ServerMessage[];
}

let nextConversationConfig: FakeConversationConfig = {};

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
  setIsSubagent() {}
  setTrustContext() {}
  setAuthContext() {}
  getAuthContext() {
    return undefined;
  }
  setAssistantId() {}
  setSubagentAllowedTools() {}
  setPreactivatedSkillIds() {}
  getCurrentSystemPrompt() {
    return "system";
  }
  injectInheritedContext() {}

  persistUserMessage() {
    return { id: "msg-id", deduplicated: false };
  }

  async runAgentLoop() {
    for (const delta of this.cfg.emitDeltas ?? []) {
      this.sendToClient(delta);
    }
    if (this.cfg.waitForAbort) {
      // Reject promptly if abort already fired (already-aborted signal), else
      // block until abort() resolves the gate.
      if (!this.aborted) {
        await new Promise<void>((resolve) => {
          this.resolveAbort = resolve;
        });
      }
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

mock.module("../memory/conversation-bootstrap.js", () => ({
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

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    llm: {
      default: {
        provider: "anthropic",
        provider_connection: "anthropic-conn",
        model: "claude-opus-4-7",
      },
    },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

mock.module("../config/llm-resolver.js", () => ({
  resolveCallSiteConfig: () => ({
    provider: "anthropic",
    provider_connection: "anthropic-conn",
    maxTokens: 4096,
  }),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import { SubagentManager } from "../subagent/manager.js";

function makeConfig(overrides: Record<string, unknown> = {}) {
  return {
    parentConversationId: `parent-${Math.random()}`,
    label: "test",
    objective: "do the thing",
    ...overrides,
  };
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

  test("a failing run rejects (does not silently resolve)", async () => {
    nextConversationConfig = { runError: new Error("boom") };

    const manager = new SubagentManager();
    await expect(manager.spawnAndAwait(makeConfig(), () => {})).rejects.toThrow(
      "boom",
    );
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
