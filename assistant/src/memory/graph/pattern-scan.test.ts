// ---------------------------------------------------------------------------
// pattern-scan.test.ts — schema-validation + degradation coverage for
// `runPatternScan`.
//
// Focus (M3): the pattern-scan tool input is now validated with a zod schema
// via `runOneShotLLM`. A malformed tool input must degrade to "no patterns
// detected" (empty result, no throw, no graph writes) instead of being
// partially iterated. The no-provider path still throws
// BackendUnavailableError.
//
// Only the provider boundary is mocked; SQLite/store run unmocked against the
// in-process test DB so the assertions reflect real graph state.
// ---------------------------------------------------------------------------

import { beforeAll, beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolUseContent,
} from "../../providers/types.js";

// Provider stub — each test sets `providerStub` to control the tool response;
// `null` simulates "no configured provider".
let providerStub: Provider | null = null;

// `runPatternScan` routes through `runOneShotLLM`, which imports
// `getConfiguredProvider`, `userMessage`, `extractToolUse`, `createTimeout`,
// and `extractAllText` from this module — the mock must export all five.
mock.module("../../providers/provider-send-message.js", () => ({
  getConfiguredProvider: async () => providerStub,
  userMessage: (text: string) => ({
    role: "user" as const,
    content: [{ type: "text" as const, text }],
  }),
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b): b is ToolUseContent => b.type === "tool_use"),
  extractAllText: () => "",
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  },
}));

import { resetDbForTesting } from "../../__tests__/db-test-helpers.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { initializeDb } from "../db-init.js";
import { runPatternScan } from "./pattern-scan.js";
import { createNode, queryNodes } from "./store.js";
import type { NewNode } from "./types.js";

const SCOPE = "pattern-scan-test";

/** Build a plain narrative node so `runPatternScan`'s ≥10-node gate clears. */
function makeNode(content: string): NewNode {
  const now = Date.now();
  return {
    content,
    type: "narrative",
    created: now,
    lastAccessed: now,
    lastConsolidated: now,
    eventDate: null,
    emotionalCharge: {
      valence: 0,
      intensity: 0.3,
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.3,
    },
    fidelity: "clear",
    confidence: 0.7,
    significance: 0.5,
    stability: 14,
    reinforcementCount: 0,
    lastReinforced: now,
    sourceConversations: [],
    sourceType: "observed",
    narrativeRole: null,
    partOfStory: null,
    imageRefs: null,
    scopeId: SCOPE,
  };
}

/** Provider stub returning a single `detect_patterns` tool_use with `input`. */
function makeToolProvider(input: unknown): Provider {
  return {
    name: "stub",
    sendMessage: async (_msgs: Message[], _opts?: SendMessageOptions) => ({
      model: "stub-model",
      stopReason: "tool_use",
      usage: { inputTokens: 0, outputTokens: 0 },
      content: [
        {
          type: "tool_use",
          id: "tu-1",
          name: "detect_patterns",
          input: input as Record<string, unknown>,
        },
      ],
    }),
  } as Provider;
}

function seedNodes(count: number): string[] {
  const ids: string[] = [];
  for (let i = 0; i < count; i++) {
    ids.push(createNode(makeNode(`Memory number ${i} about being tired.`)).id);
  }
  return ids;
}

describe("runPatternScan — schema validation + degradation", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    resetDbForTesting();
    initializeDb();
    providerStub = null;
  });

  test("creates pattern nodes + edges on a well-formed tool response", async () => {
    const ids = seedNodes(12);
    providerStub = makeToolProvider({
      patterns: [
        {
          content: "I notice the user keeps mentioning being tired.",
          type: "narrative",
          significance: 0.6,
          source_node_ids: ids.slice(0, 4),
        },
      ],
    });

    const result = await runPatternScan(SCOPE, DEFAULT_CONFIG);

    expect(result.patternsDetected).toBe(1);
    expect(result.edgesCreated).toBe(4);
  });

  test("degrades to an empty result (no throw, no writes) on a schema mismatch", async () => {
    seedNodes(12);
    const before = queryNodes({ scopeId: SCOPE }).length;

    // `patterns[].significance` is a string, not a number — the zod schema
    // rejects the whole input, so the scan must degrade rather than partially
    // iterate a malformed shape.
    providerStub = makeToolProvider({
      patterns: [
        {
          content: "malformed",
          type: "narrative",
          significance: "high",
          source_node_ids: ["x", "y", "z"],
        },
      ],
    });

    const result = await runPatternScan(SCOPE, DEFAULT_CONFIG);

    expect(result.patternsDetected).toBe(0);
    expect(result.edgesCreated).toBe(0);
    // No new nodes were written despite the malformed response.
    expect(queryNodes({ scopeId: SCOPE }).length).toBe(before);
  });

  test("throws BackendUnavailableError when no provider is configured", async () => {
    seedNodes(12);
    providerStub = null;

    await expect(runPatternScan(SCOPE, DEFAULT_CONFIG)).rejects.toThrow();
  });

  test("returns an empty result without an LLM call for too-few nodes", async () => {
    seedNodes(5);
    providerStub = makeToolProvider({ patterns: [] });

    const result = await runPatternScan(SCOPE, DEFAULT_CONFIG);

    expect(result.patternsDetected).toBe(0);
  });
});
