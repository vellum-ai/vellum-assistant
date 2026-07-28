import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
import { registerPlugin } from "../plugins/registry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";
import { textResponse } from "./helpers/mock-provider.js";

/**
 * The agent loop invokes history repair as built-in daemon logic (not a
 * plugin): on a provider rejection whose message denotes a tool-use/tool-result
 * pairing or ordering violation, it deep-repairs the working history and
 * re-issues the call once per turn. These tests exercise that loop-integrated
 * recovery; the repair transform itself is covered by `history-repair.test.ts`.
 */

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "Hello" }],
};

// A provider whose message-ordering rejection matches `ORDERING_ERROR_PATTERNS`,
// so the loop treats it as repairable.
const ORDERING_REJECTION =
  "messages: `tool_use` ids must have corresponding `tool_result` blocks";

/**
 * Provider that rejects the first `errorCount` calls with an ordering error,
 * then returns a plain text reply. Records how many times it was called.
 */
function orderingRejectionProvider(errorCount: number): {
  provider: Provider;
  callCount: () => number;
} {
  let calls = 0;
  const provider: Provider = {
    name: "test-ordering",
    async sendMessage(): Promise<ProviderResponse> {
      calls += 1;
      if (calls <= errorCount) {
        throw new Error(ORDERING_REJECTION);
      }
      return textResponse("recovered");
    },
  };
  return { provider, callCount: () => calls };
}

describe("agent loop — built-in history-repair recovery", () => {
  beforeEach(() => {
    resetPluginRegistryAndRegisterDefaults();
  });

  test("deep-repairs and retries once on a provider ordering rejection", async () => {
    const { provider, callCount } = orderingRejectionProvider(1);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Initial call rejected → deep-repair → one retry that succeeded.
    expect(callCount()).toBe(2);
    expect(history[history.length - 1]).toEqual({
      role: "assistant",
      content: [{ type: "text", text: "recovered" }],
    });
    expect(events.some((e) => e.type === "error")).toBe(false);
  });

  test("bounds ordering-repair recovery to one attempt per turn", async () => {
    // Provider keeps rejecting: the loop must not retry forever.
    const { provider, callCount } = orderingRejectionProvider(Infinity);
    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: [userMessage],
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // Initial call + exactly one deep-repair retry, then the rejection surfaces.
    expect(callCount()).toBe(2);
    expect(events.some((e) => e.type === "error")).toBe(true);
  });

  test("dispatches post-model-call but lets native repair drive the ordering retry", async () => {
    // A user hook that observes the rejection and blindly continues without
    // repairing. It must still fire (the hook contract dispatches at every
    // model-call outcome), but native ordering repair takes precedence, so the
    // retry sends a repaired history rather than the hook's unrepaired continue.
    let genericContinueFired = 0;
    registerPlugin({
      manifest: { name: "generic-continue", version: "0.0.1" },
      hooks: {
        "post-model-call": async (ctx) => {
          if (ctx.error) {
            genericContinueFired += 1;
            ctx.decision = "continue";
          }
        },
      },
    });

    // History with an orphan tool_use: deep repair appends a synthetic
    // tool_result so the retry is well-formed.
    const orphanHistory: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      {
        role: "assistant",
        content: [{ type: "tool_use", id: "t1", name: "noop", input: {} }],
      },
    ];

    let calls = 0;
    let retryMessages: Message[] | null = null;
    const provider: Provider = {
      name: "test-ordering",
      async sendMessage(messages): Promise<ProviderResponse> {
        calls += 1;
        if (calls === 1) {
          throw new Error(ORDERING_REJECTION);
        }
        retryMessages = messages;
        return textResponse("recovered");
      },
    };

    const loop = new AgentLoop({
      provider,
      systemPrompt: "system",
      conversationId: "test-conversation",
    });

    const events: AgentEvent[] = [];
    await loop.run({
      requestId: "test-request",
      messages: orphanHistory,
      onEvent: (e) => {
        events.push(e);
      },
      trust: { sourceChannel: "vellum", trustClass: "unknown" },
    });

    // The hook observed the rejection (contract preserved).
    expect(genericContinueFired).toBeGreaterThanOrEqual(1);
    // Recovery happened in exactly one retry, and that retry used the repaired
    // history: the orphan tool_use now has a matching tool_result. If the hook's
    // unrepaired continue had driven the retry, this block would be absent.
    expect(calls).toBe(2);
    const repaired: Message[] = retryMessages ?? [];
    const hasPairedResult = repaired.some((m) =>
      m.content.some((b) => b.type === "tool_result" && b.tool_use_id === "t1"),
    );
    expect(hasPairedResult).toBe(true);
  });
});
