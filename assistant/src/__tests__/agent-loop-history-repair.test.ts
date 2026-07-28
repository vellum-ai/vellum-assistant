import { beforeEach, describe, expect, test } from "bun:test";

import type { AgentEvent } from "../agent/loop.js";
import { AgentLoop } from "../agent/loop.js";
import { resetPluginRegistryAndRegisterDefaults } from "../plugins/defaults/index.js";
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
});
