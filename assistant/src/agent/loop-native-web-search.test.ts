/**
 * Verifies the agent loop's provider-native web-search gate (used by the
 * tool-less advisor consult): when `enableNativeWebSearch` is set, the loop
 * appends a `web_search`-named SERVER tool to the outbound request and forces
 * `tool_choice: auto` — but ONLY when the provider/model the call ACTUALLY
 * routes to reports native-search support. A non-native target gets nothing,
 * and the consult stays tool-less (no client `web_search` tool surfaced).
 *
 * The gate prefers the routing-aware `supportsNativeWebSearchFor(options)` (the
 * routed (provider, model)'s capability) over the construction-time
 * `supportsNativeWebSearch` snapshot. The advisor's `advisorProfile` can route
 * `subagentSpawn` to a provider/model whose native-search support DIFFERS from
 * the default, so the routed capability — not the default's — must drive the
 * decision in both directions. Drives the REAL loop, mocking only the provider
 * boundary.
 */
import { describe, expect, test } from "bun:test";

import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import type {
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { AgentLoop } from "./loop.js";

const endTurn = (text: string): ProviderResponse => ({
  content: [{ type: "text", text }],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});

const baseRun = {
  requestId: "req-web",
  onEvent: () => {},
  callSite: "subagentSpawn" as const,
  trust: { sourceChannel: "vellum" as const, trustClass: "unknown" as const },
};

const userMessages = [
  {
    role: "user" as const,
    content: [{ type: "text" as const, text: "advise" }],
  },
];

/** Build a tool-less loop (mirrors the advisor consult) with the given flag. */
function buildAdvisorLoop(
  provider: Provider,
  enableNativeWebSearch: boolean,
): AgentLoop {
  return new AgentLoop({
    provider,
    systemPrompt: "advisor system",
    conversationId: "advisor-1",
    // Tool-less for client tools — exactly the advisor role's empty allowlist.
    config: { enableNativeWebSearch },
  });
}

describe("AgentLoop — provider-native web search gate", () => {
  test("attaches the native web_search server tool when the provider supports it", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    (
      provider as { supportsNativeWebSearch?: boolean }
    ).supportsNativeWebSearch = true;

    const loop = buildAdvisorLoop(provider, true);
    await loop.run({ ...baseRun, messages: userMessages });

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    // The native web_search SERVER tool is the only tool surfaced.
    expect(sent.tools?.map((t) => t.name)).toEqual(["web_search"]);
    // tool_choice is forced to auto so the model may invoke the search.
    expect(sent.options?.config?.tool_choice).toEqual({ type: "auto" });
  });

  test("attaches nothing on a non-native provider (consult stays tool-less)", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    // supportsNativeWebSearch is absent (falsy) — a non-native provider.

    const loop = buildAdvisorLoop(provider, true);
    await loop.run({ ...baseRun, messages: userMessages });

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    // No web_search tool surfaced — no client tool the one-shot consult can't run.
    expect(sent.tools).toBeUndefined();
    // No tool_choice forced when nothing is attached.
    expect(sent.options?.config?.tool_choice).toBeUndefined();
  });

  test("attaches nothing when the flag is off, even on a native provider", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    (
      provider as { supportsNativeWebSearch?: boolean }
    ).supportsNativeWebSearch = true;

    const loop = buildAdvisorLoop(provider, false);
    await loop.run({ ...baseRun, messages: userMessages });

    expect(calls).toHaveLength(1);
    const sent = calls[0];
    expect(sent.tools).toBeUndefined();
    expect(sent.options?.config?.tool_choice).toBeUndefined();
  });

  test("does not duplicate web_search when a tool of that name is already present", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    (
      provider as { supportsNativeWebSearch?: boolean }
    ).supportsNativeWebSearch = true;

    // A loop that already exposes a `web_search` client tool (e.g. researcher
    // role). The gate must not append a second `web_search` entry.
    const loop = new AgentLoop({
      provider,
      systemPrompt: "sys",
      conversationId: "advisor-dup",
      config: { enableNativeWebSearch: true },
      tools: [
        {
          name: "web_search",
          description: "",
          input_schema: { type: "object" },
        },
      ],
    });
    await loop.run({ ...baseRun, messages: userMessages });

    const sent = calls[0];
    expect(sent.tools?.filter((t) => t.name === "web_search")).toHaveLength(1);
  });

  // ── Routed capability drives the decision (not the static default) ────────

  test("false positive: static flag is native but the ROUTED target is not — attaches nothing", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    // The construction-time default supports native search…
    (
      provider as { supportsNativeWebSearch?: boolean }
    ).supportsNativeWebSearch = true;
    // …but the advisorProfile routes `subagentSpawn` to a provider/model that
    // does NOT. The routing-aware probe wins, so no unexecutable client tool is
    // surfaced to the otherwise tool-less advisor.
    (
      provider as {
        supportsNativeWebSearchFor?: (o?: SendMessageOptions) => boolean;
      }
    ).supportsNativeWebSearchFor = () => false;

    const loop = buildAdvisorLoop(provider, true);
    await loop.run({ ...baseRun, messages: userMessages });

    const sent = calls[0];
    expect(sent.tools).toBeUndefined();
    expect(sent.options?.config?.tool_choice).toBeUndefined();
  });

  test("false negative: static flag is non-native but the ROUTED target is — attaches the tool", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    // The construction-time default lacks native search (flag absent/falsy)…
    // …but the advisorProfile routes to a provider/model that has it.
    (
      provider as {
        supportsNativeWebSearchFor?: (o?: SendMessageOptions) => boolean;
      }
    ).supportsNativeWebSearchFor = () => true;

    const loop = buildAdvisorLoop(provider, true);
    await loop.run({ ...baseRun, messages: userMessages });

    const sent = calls[0];
    expect(sent.tools?.map((t) => t.name)).toEqual(["web_search"]);
    expect(sent.options?.config?.tool_choice).toEqual({ type: "auto" });
  });

  test("the routing probe receives the loop's callSite", async () => {
    const { provider, calls } = createMockProvider([endTurn("guidance")]);
    const probeOptions: (SendMessageOptions | undefined)[] = [];
    (
      provider as {
        supportsNativeWebSearchFor?: (o?: SendMessageOptions) => boolean;
      }
    ).supportsNativeWebSearchFor = (o) => {
      probeOptions.push(o);
      return true;
    };

    const loop = buildAdvisorLoop(provider, true);
    await loop.run({ ...baseRun, messages: userMessages });

    expect(calls).toHaveLength(1);
    // The probe is resolved against the same callSite the dispatch uses
    // (`subagentSpawn` per `baseRun`), so the routed (provider, model) matches.
    expect(probeOptions[0]?.config?.callSite).toBe("subagentSpawn");
  });
});
