import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { AssistantConfig } from "../config/schema.js";
import type { Provider, ProviderResponse } from "../providers/types.js";

let configuredProvider: Provider | null = null;
const getConfiguredProviderCallSites: string[] = [];

mock.module("../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async (callSite: string) => {
    getConfiguredProviderCallSites.push(callSite);
    return configuredProvider;
  },
}));

import { runAgenticRecall } from "../memory/context-search/agent-runner.js";
import type {
  RecallEvidence,
  RecallSearchContext,
  RecallSource,
  RecallSourceAdapter,
} from "../memory/context-search/types.js";

interface SearchCall {
  source: RecallSource;
  query: string;
  limit: number;
  signal?: AbortSignal;
}

function makeContext(signal?: AbortSignal): RecallSearchContext {
  return {
    workingDir: "/workspace",
    memoryScopeId: "scope-123",
    conversationId: "conv-xyz",
    config: {} as AssistantConfig,
    ...(signal ? { signal } : {}),
  };
}

function makeEvidence(
  id: string,
  overrides: Partial<RecallEvidence> = {},
): RecallEvidence {
  return {
    id,
    source: "workspace",
    title: `${id} title`,
    locator: `${id}.md`,
    excerpt: `${id} excerpt`,
    score: 0.9,
    ...overrides,
  };
}

function makeAdapter(
  evidenceByQuery: Record<string, RecallEvidence[]>,
  calls: SearchCall[] = [],
  source: RecallSource = "workspace",
): RecallSourceAdapter {
  return {
    source,
    async search(query, context, limit) {
      calls.push({ source, query, limit, signal: context.signal });
      return { evidence: evidenceByQuery[query] ?? [] };
    },
  };
}

function makeProvider(
  responses: Array<ProviderResponse | Error>,
  calls: unknown[][] = [],
): Provider {
  return {
    name: "mock-provider",
    async sendMessage(...args) {
      calls.push(args);
      const next = responses.shift();
      if (!next) {
        throw new Error("unexpected provider call");
      }
      if (next instanceof Error) {
        throw next;
      }
      return next;
    },
  };
}

function toolResponse(
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id: `${name}-1`, name, input }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "mock-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

describe("runAgenticRecall", () => {
  beforeEach(() => {
    configuredProvider = null;
    getConfiguredProviderCallSites.length = 0;
  });

  test("falls back to deterministic recall when no provider is configured", async () => {
    const searchCalls: SearchCall[] = [];
    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"], max_results: 3 },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              { "launch notes": [makeEvidence("workspace:launch")] },
              searchCalls,
            ),
          ],
        },
      },
    );

    expect(getConfiguredProviderCallSites).toEqual(["recall"]);
    expect(searchCalls.map((call) => call.query)).toEqual(["launch notes"]);
    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "no_provider",
      roundsUsed: 0,
    });
    expect(result.content).toContain("Found evidence:");
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:launch",
    ]);
  });

  test("returns a valid finish_recall answer with cited evidence", async () => {
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer: "Alice chose Friday.",
        confidence: "high",
        citation_ids: ["workspace:launch"],
      }),
    ]);

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:launch")],
            }),
          ],
        },
      },
    );

    expect(result.content).toBe("Alice chose Friday.");
    expect(result.debug.mode).toBe("agentic");
    expect(result.debug.roundsUsed).toBe(1);
    expect(result.debug.finish).toEqual({
      confidence: "high",
      citationIds: ["workspace:launch"],
    });
    expect(result.evidence.map((item) => item.id)).toEqual([
      "workspace:launch",
    ]);
  });

  test("executes follow-up search_sources through narrowed local searches", async () => {
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        toolResponse("search_sources", {
          query: "decision notes",
          sources: ["workspace", "memory"],
          limit: 2,
          reason: "Need the explicit decision.",
        }),
        toolResponse("finish_recall", {
          answer: "The decision note says Friday.",
          confidence: "medium",
          citation_ids: ["workspace:decision"],
        }),
      ],
      providerCalls,
    );
    const controller = new AbortController();
    const searchCalls: SearchCall[] = [];

    const result = await runAgenticRecall(
      {
        query: "launch notes",
        sources: ["workspace"],
        max_results: 3,
        depth: "standard",
      },
      makeContext(controller.signal),
      {
        searchOptions: {
          adapters: [
            makeAdapter(
              {
                "launch notes": [makeEvidence("workspace:seed")],
                "decision notes": [makeEvidence("workspace:decision")],
              },
              searchCalls,
            ),
          ],
        },
      },
    );

    expect(providerCalls).toHaveLength(2);
    expect(searchCalls).toEqual([
      {
        source: "workspace",
        query: "launch notes",
        limit: 6,
        signal: controller.signal,
      },
      {
        source: "workspace",
        query: "decision notes",
        limit: 2,
        signal: controller.signal,
      },
    ]);
    expect(result.content).toBe("The decision note says Friday.");
    expect(result.debug.searchCalls).toEqual([
      {
        round: 1,
        query: "decision notes",
        sources: ["workspace"],
        limit: 2,
        reason: "Need the explicit decision.",
        evidenceCount: 1,
      },
    ]);
  });

  test("falls back when the provider exhausts the round budget", async () => {
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [
        toolResponse("search_sources", {
          query: "more notes",
          sources: ["workspace"],
          reason: "Need more.",
        }),
      ],
      providerCalls,
    );

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"], depth: "fast" },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
              "more notes": [makeEvidence("workspace:more")],
            }),
          ],
        },
      },
    );

    expect(providerCalls).toHaveLength(1);
    expect(result.debug.roundLimit).toBe(1);
    expect(result.debug.roundsUsed).toBe(1);
    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "round_limit",
    });
    expect(result.evidence.map((item) => item.id)).toEqual(["workspace:seed"]);
  });

  test("falls back when finish_recall cites unknown evidence", async () => {
    configuredProvider = makeProvider([
      toolResponse("finish_recall", {
        answer: "Unsupported answer.",
        confidence: "high",
        citation_ids: ["workspace:missing"],
      }),
    ]);

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "citation_validation_failed",
      fallbackDetail: "unknown_citation_ids",
    });
    expect(result.content).toContain("Found evidence:");
  });

  test("falls back on provider errors", async () => {
    configuredProvider = makeProvider([new Error("provider unavailable")]);

    const result = await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(result.debug).toMatchObject({
      mode: "deterministic_fallback",
      fallbackReason: "provider_error",
      fallbackDetail: "provider unavailable",
    });
  });

  test("routes provider calls through the recall call site with temperature zero", async () => {
    const providerCalls: unknown[][] = [];
    configuredProvider = makeProvider(
      [textResponse("not a tool call")],
      providerCalls,
    );

    await runAgenticRecall(
      { query: "launch notes", sources: ["workspace"] },
      makeContext(),
      {
        searchOptions: {
          adapters: [
            makeAdapter({
              "launch notes": [makeEvidence("workspace:seed")],
            }),
          ],
        },
      },
    );

    expect(getConfiguredProviderCallSites).toEqual(["recall"]);
    expect(providerCalls).toHaveLength(1);
    const options = providerCalls[0]?.[3] as {
      config?: Record<string, unknown>;
    };
    expect(options.config).toEqual({
      callSite: "recall",
      temperature: 0,
    });
    expect(options.config).not.toHaveProperty("thinking");
  });
});
