/**
 * The runtime proxy bills delegated work off `X-Vellum-Subagent-Role` and
 * `X-Vellum-Subagent-Spawn-Mode`. `RetryProvider` resolves both from
 * `config.conversationId`, so the headers only ever materialize in production
 * if `AgentLoop` stamps its own conversation id onto the provider config it
 * sends. These tests drive a real `AgentLoop` through a real `RetryProvider`
 * so a config field dropped at the loop can never pass silently.
 *
 * Subagents run their turns through `ConversationRunner.runAgentLoop` with
 * `callSite: "subagentSpawn"`, which is the shape reproduced here.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import { AgentLoop } from "../agent/loop.js";
import { initializeDb } from "../persistence/db-init.js";
import { rawRun } from "../persistence/raw-query.js";
import { RetryProvider } from "../providers/retry.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { resetSubagentAttributionCacheForTests } from "../usage/subagent-attribution.js";
import { setConfig } from "./helpers/set-config.js";

const userMessage: Message = {
  role: "user",
  content: [{ type: "text", text: "hi" }],
};

/**
 * Stands in for the transport underneath `RetryProvider`, recording the config
 * it is handed. That config is what would go on the wire, so it is also where
 * the resolved billing headers land.
 */
function makeRecordingProvider(name: string): {
  provider: Provider;
  configs: () => Array<Record<string, unknown>>;
} {
  const configs: Array<Record<string, unknown>> = [];
  const provider: Provider = {
    name,
    async sendMessage(
      _messages: Message[],
      options?: SendMessageOptions,
    ): Promise<ProviderResponse> {
      configs.push((options?.config ?? {}) as Record<string, unknown>);
      return {
        content: [{ type: "text", text: "ok" }],
        model: "gpt-sub",
        usage: { inputTokens: 1, outputTokens: 1 },
        stopReason: "end_turn",
      };
    },
  };
  return { provider, configs: () => configs };
}

async function seedConversation(
  id: string,
  subagentRole: string | null,
  subagentSpawnMode: string | null,
): Promise<void> {
  await initializeDb();
  resetSubagentAttributionCacheForTests();
  rawRun(
    "test:seedSubagentConversation",
    `INSERT OR REPLACE INTO conversations (id, conversation_type, created_at, updated_at, subagent_role, subagent_spawn_mode)
     VALUES (?, 'background', 1000, 1000, ?, ?)`,
    id,
    subagentRole,
    subagentSpawnMode,
  );
}

/** Runs one loop turn the way a subagent's conversation runner does. */
async function runSubagentTurn(
  provider: Provider,
  conversationId: string,
): Promise<void> {
  const loop = new AgentLoop({
    provider,
    systemPrompt: "system",
    conversationId,
    config: { maxTokens: 1024 },
  });
  await loop.run({
    requestId: "test-request",
    messages: [userMessage],
    onEvent: () => {},
    trust: { sourceChannel: "vellum", trustClass: "unknown" },
    callSite: "subagentSpawn",
  });
}

describe("AgentLoop subagent billing-header attribution", () => {
  beforeEach(() => {
    setConfig("llm", {
      callSites: { subagentSpawn: { provider: "openai", model: "gpt-sub" } },
    });
  });

  test("forwards the spawning role and mode on a subagent conversation's turn", async () => {
    // GIVEN a conversation stamped as an advisor-consult subagent
    await seedConversation("conv-loop-advisor", "advisor", "advisor_consult");

    // AND a managed-proxy-shaped provider stack (headers forwarded)
    const { provider, configs } = makeRecordingProvider("openai");
    const wrapped = new RetryProvider(provider, {
      forwardUsageAttributionHeaders: true,
    });

    // WHEN that subagent's loop runs a turn
    await runSubagentTurn(wrapped, "conv-loop-advisor");

    // THEN the transport sees the delegated-work attribution
    expect(configs()).toHaveLength(1);
    const headers = configs()[0]?.usageAttributionHeaders as Record<
      string,
      string
    >;
    expect(headers["X-Vellum-Subagent-Role"]).toBe("advisor");
    expect(headers["X-Vellum-Subagent-Spawn-Mode"]).toBe("advisor_consult");
    expect(headers["X-Vellum-LLM-Call-Site"]).toBe("subagentSpawn");

    // AND the routing-time id itself never reaches the wire config
    expect(configs()[0]?.conversationId).toBeUndefined();
  });

  test("omits the subagent headers on a turn for a plain conversation", async () => {
    // GIVEN a conversation that was not spawned as a subagent
    await seedConversation("conv-loop-plain", null, null);

    const { provider, configs } = makeRecordingProvider("openai");
    const wrapped = new RetryProvider(provider, {
      forwardUsageAttributionHeaders: true,
    });

    // WHEN its loop runs a turn
    await runSubagentTurn(wrapped, "conv-loop-plain");

    // THEN the base attribution is present without the delegated-work fields
    const headers = configs()[0]?.usageAttributionHeaders as Record<
      string,
      string
    >;
    expect(headers["X-Vellum-LLM-Call-Site"]).toBe("subagentSpawn");
    expect(headers["X-Vellum-Subagent-Role"]).toBeUndefined();
    expect(headers["X-Vellum-Subagent-Spawn-Mode"]).toBeUndefined();
  });

  test("stamps the conversation id on the provider config it sends", async () => {
    // GIVEN a bare recording provider (no `RetryProvider` to consume the field)
    const { provider, configs } = makeRecordingProvider("openai");

    // WHEN a loop with a conversation id runs a call-site turn
    await runSubagentTurn(provider, "conv-loop-raw");

    // THEN the id the header lookup depends on is on the config, alongside the
    // mix-expansion seed
    expect(configs()[0]?.conversationId).toBe("conv-loop-raw");
    expect(configs()[0]?.selectionSeed).toBe("conv-loop-raw");
  });
});
