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
// Round-3 review follow-up — error fidelity at the job boundary:
//   - `timeout` (stalled provider): throws BackendUnavailableError (transient →
//     defer/retry).
//   - `provider_error`: re-throws the ORIGINAL provider error so `classifyError`
//     can fail fast on a fatal 4xx instead of wrapping every failure in a
//     "transient" BackendUnavailableError. An already-BackendUnavailableError
//     re-throws as-is.
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
  // Cap the fuse at 100ms so the timeout-path test aborts quickly instead of
  // waiting the scan's real 60s `PATTERN_SCAN_TIMEOUT_MS`. Providers in the
  // other tests resolve on the next microtask, well before 100ms, so the cap
  // never trips them.
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(ms, 100));
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  },
}));

import { resetDbForTesting } from "../../__tests__/db-test-helpers.js";
import { DEFAULT_CONFIG } from "../../config/defaults.js";
import { BackendUnavailableError } from "../../util/errors.js";
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

/** Provider stub whose `sendMessage` throws — simulates `provider_error`. */
function makeThrowingProvider(err: unknown): Provider {
  return {
    name: "stub",
    sendMessage: async () => {
      throw err;
    },
  } as Provider;
}

/**
 * Provider stub that rejects with an AbortError once its abort signal fires —
 * simulates the timeout path. `runOneShotLLM` sees `signal.aborted` and reports
 * `reason: "timeout"`. Pair with a small `createTimeout` so the abort is fast.
 */
function makeAbortAwaitingProvider(): Provider {
  return {
    name: "stub",
    sendMessage: (_msgs: Message[], opts?: SendMessageOptions) =>
      new Promise<ProviderResponse>((_resolve, reject) => {
        const signal = opts?.signal;
        if (signal?.aborted) {
          reject(new DOMException("Aborted", "AbortError"));
          return;
        }
        signal?.addEventListener("abort", () => {
          reject(new DOMException("Aborted", "AbortError"));
        });
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

  test("re-throws the ORIGINAL provider error so classifyError can fail fast on a fatal 4xx", async () => {
    seedNodes(12);
    const before = queryNodes({ scopeId: SCOPE }).length;
    // A non-retryable provider error (e.g. a 400 bad-request / 401 auth error
    // from the forced-tool call) surfaces as `reason: "provider_error"` with the
    // original error preserved on `llmResult.error`. The job must re-throw that
    // ORIGINAL error — NOT a BackendUnavailableError wrapper — so `classifyError`
    // inspects its 4xx status and fails the job fast instead of deferring/retrying
    // a doomed request for the full backoff window.
    const fatalError = Object.assign(new Error("bad request"), { status: 400 });
    providerStub = makeThrowingProvider(fatalError);

    await expect(runPatternScan(SCOPE, DEFAULT_CONFIG)).rejects.toBe(
      fatalError,
    );
    // The original error propagates, not a BackendUnavailableError wrapper.
    await expect(
      runPatternScan(SCOPE, DEFAULT_CONFIG),
    ).rejects.not.toBeInstanceOf(BackendUnavailableError);
    // No graph writes on a failed scan.
    expect(queryNodes({ scopeId: SCOPE }).length).toBe(before);
  });

  test("re-throws an already-BackendUnavailableError provider error as-is (transient)", async () => {
    seedNodes(12);
    // When the provider itself throws a BackendUnavailableError (e.g. a backend
    // that classifies its own outage), `reason: "provider_error"` carries it on
    // `llmResult.error` and the job re-throws it unchanged — still transient, so
    // `classifyError` / `handleJobError` defers and retries.
    const backendErr = new BackendUnavailableError("provider backend down");
    providerStub = makeThrowingProvider(backendErr);

    await expect(runPatternScan(SCOPE, DEFAULT_CONFIG)).rejects.toBe(
      backendErr,
    );
  });

  test("re-throws BackendUnavailableError on a timeout (transient) so the worker retries", async () => {
    seedNodes(12);
    // A stalled provider connection that hits the timeout aborts the request;
    // `runOneShotLLM` reports `reason: "timeout"`, which the job must re-throw
    // as BackendUnavailableError (the established transient-backend signal). The
    // mocked `createTimeout` caps the fuse at 100ms, so the abort fires fast.
    providerStub = makeAbortAwaitingProvider();

    await expect(runPatternScan(SCOPE, DEFAULT_CONFIG)).rejects.toBeInstanceOf(
      BackendUnavailableError,
    );
  });

  test("returns an empty result without an LLM call for too-few nodes", async () => {
    seedNodes(5);
    providerStub = makeToolProvider({ patterns: [] });

    const result = await runPatternScan(SCOPE, DEFAULT_CONFIG);

    expect(result.patternsDetected).toBe(0);
  });
});
