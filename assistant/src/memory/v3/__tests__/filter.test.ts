/**
 * Tests for `assistant/src/memory/v3/filter.ts`.
 *
 * Coverage matrix:
 *   - keep-subset → kept = bypass ∪ judged-kept; dropped = judged minus kept;
 *     bypass slugs are never judged.
 *   - model keeping a slug outside the judged set → dropped.
 *   - empty dense → no LLM call, kept = bypass-relevant only.
 *   - dense entirely covered by bypass → no LLM call (nothing to judge).
 *   - provider === null (no provider configured) → fail-open: keep all dense,
 *     failureReason = "no_provider".
 *   - provider throws → fail-open (keep all, failureReason = "api_error").
 *   - missing tool_use block → fail-open (failureReason = "tool_use_missing").
 *   - tool input failing schema → fail-open (failureReason = "schema_mismatch").
 *   - request shape: forced tool_choice on `filter_dense_hits`, judged set in
 *     the user message, abort signal forwarded.
 *
 * The provider is injected via `filterDenseHits({ provider })` — no real LLM,
 * no network, no `mock.module`. `~/.vellum/` is never touched.
 */

import { describe, expect, test } from "bun:test";

import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
  ToolDefinition,
} from "../../../providers/types.js";
import type { RetrievalInput } from "../../v2/harness/retriever.js";
import type { ScoutResult } from "../../v2/harness/trace.js";
import { filterDenseHits } from "../filter.js";
import type { LlmCallRecord } from "../llm-capture.js";
import { FILTER_SYSTEM_PROMPT } from "../prompts/system-prompts.js";

// ---------------------------------------------------------------------------
// Helpers.
// ---------------------------------------------------------------------------

interface ProviderCall {
  messages: Message[];
  tools: ToolDefinition[] | undefined;
  systemPrompt: string | undefined;
  options: SendMessageOptions | undefined;
}

/**
 * A stub provider that records its calls and returns a fixed response.
 * Honors an already-aborted signal by throwing an AbortError so signal
 * forwarding can be asserted.
 */
function makeProvider(
  response: ProviderResponse,
  calls: ProviderCall[],
): Provider {
  return {
    name: "stub",
    sendMessage: async (messages, options) => {
      calls.push({
        messages,
        tools: options?.tools,
        systemPrompt: options?.systemPrompt,
        options,
      });
      if (options?.signal?.aborted) {
        const err = new Error("aborted");
        err.name = "AbortError";
        throw err;
      }
      return response;
    },
  };
}

/** A provider whose sendMessage always throws. */
function makeThrowingProvider(): Provider {
  return {
    name: "throwing-stub",
    sendMessage: async () => {
      throw new Error("boom");
    },
  };
}

/** A provider that must never be called (asserts no LLM round-trip happens). */
function makeNeverCalledProvider(): Provider {
  return {
    name: "never-called-stub",
    sendMessage: async () => {
      throw new Error("provider should not be called");
    },
  };
}

function filterToolResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [
      { type: "tool_use", id: "tu-1", name: "filter_dense_hits", input },
    ],
  };
}

/** A response with no tool_use block (e.g. the model emitted only text). */
function textOnlyResponse(): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "end_turn",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [{ type: "text", text: "no tool here" }],
  };
}

/** Minimal `RetrievalInput` — the filter only reads `nowText` and `signal`. */
function makeInput(overrides?: Partial<RetrievalInput>): RetrievalInput {
  return {
    workspaceDir: "/tmp/does-not-matter",
    recentTurnPairs: [],
    nowText: "2026-05-25 10:00 PT",
    priorEverInjected: [],
    config: {} as unknown as RetrievalInput["config"],
    ...overrides,
  };
}

function denseResult(slugs: string[]): ScoutResult {
  return { lane: "dense", slugs };
}

/**
 * Build a `RetrievalInput["config"]` carrying a `memory.v3.prompts.filter`
 * inline override. The cast mirrors `makeInput`'s — the filter only reads the
 * prompts path on config.
 */
function configWithFilterOverride(override: string): RetrievalInput["config"] {
  return {
    memory: { v3: { prompts: { filter: { override, path: null } } } },
  } as unknown as RetrievalInput["config"];
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("filterDenseHits — judged keep/drop", () => {
  test("kept = bypass ∪ judged-kept; bypass slugs are never judged", async () => {
    const calls: ProviderCall[] = [];
    // Dense surfaces a, b, c, plus bypass slug `x`. Model keeps a, c; drops b.
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["c", "a"] }),
      calls,
    );

    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b", "c", "x"]),
      sticky: new Set(["x"]),
      bypass: new Set(["x"]),
      provider,
    });

    // bypass first (x), then judged-kept in model order (c, a).
    expect(result.kept).toEqual(["x", "c", "a"]);
    // Only the non-bypass slugs are judged; b was dropped.
    expect(result.trace.judged).toEqual(["a", "b", "c"]);
    expect(result.trace.dropped).toEqual(["b"]);
    expect(result.failureReason).toBeUndefined();
    expect(calls).toHaveLength(1);
    // The bypass slug `x` was never shown to the model.
    const userText = calls[0].messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(userText).not.toContain("x");
  });

  test("excludes the full sticky set from judgment, not just bypass", async () => {
    const calls: ProviderCall[] = [];
    // Dense surfaces a, b, plus sticky-but-not-bypass slug `s`. `s` must not be
    // judged (the gate force-injects every sticky slug regardless), so the model
    // only sees a, b. Model keeps a.
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b", "s"]),
      // sticky is a strict superset of bypass here: `s` is sticky but not bypass.
      sticky: new Set(["s"]),
      bypass: new Set(),
      provider,
    });

    // `s` is excluded from the judged set even though it is not in bypass.
    expect(result.trace.judged).toEqual(["a", "b"]);
    expect(result.trace.dropped).toEqual(["b"]);
    // The sticky slug `s` was never shown to the model.
    const slugLines = calls[0].messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n")
      .split("\n");
    expect(slugLines).not.toContain("s");
  });

  test("forces tool_choice on filter_dense_hits and surfaces judged candidates", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    await filterDenseHits({
      input: makeInput({ nowText: "NOW-MARKER" }),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    const call = calls[0];
    expect(call.options?.config?.tool_choice).toEqual({
      type: "tool",
      name: "filter_dense_hits",
    });
    expect(call.options?.config?.callSite).toBe("memoryV3Filter");
    expect(call.tools?.[0].name).toBe("filter_dense_hits");
    const userText = call.messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(userText).toContain("NOW-MARKER");
    expect(userText).toContain("a");
    expect(userText).toContain("b");
  });

  test("includes the just-arrived turn so the filter judges query-aware", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    await filterDenseHits({
      input: makeInput({
        recentTurnPairs: [
          {
            assistantMessage: "an earlier reply",
            userMessage: "tell me about the people you know",
          },
        ],
      }),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    const userText = calls[0].messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    // The filter must judge against the user's actual question, not just NOW.
    expect(userText).toContain("<last_turn>");
    expect(userText).toContain("tell me about the people you know");
    expect(userText).toContain("an earlier reply");
  });

  test("drops a model-kept slug outside the judged set", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a", "ghost"] }),
      calls,
    );

    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    expect(result.kept).toEqual(["a"]);
    expect(result.trace.dropped).toEqual(["b"]);
  });

  test("forwards an abort signal to the provider call", async () => {
    const calls: ProviderCall[] = [];
    const controller = new AbortController();
    controller.abort();
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    // Aborted signal makes the stub throw → filter fails open (keep all).
    const result = await filterDenseHits({
      input: makeInput({ signal: controller.signal }),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    expect(calls[0].options?.signal).toBe(controller.signal);
    expect([...result.kept].sort()).toEqual(["a", "b"]);
    expect(result.failureReason).toBe("api_error");
  });
});

describe("filterDenseHits — no LLM call", () => {
  test("empty dense → no call, kept = bypass-relevant only", async () => {
    const provider = makeNeverCalledProvider();

    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult([]),
      sticky: new Set(["x"]),
      bypass: new Set(["x"]),
      provider,
    });

    expect(result.kept).toEqual(["x"]);
    expect(result.trace).toEqual({ judged: [], dropped: [] });
    expect(result.failureReason).toBeUndefined();
  });

  test("dense fully covered by bypass → no call (nothing to judge)", async () => {
    const provider = makeNeverCalledProvider();

    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["x", "y"]),
      sticky: new Set(["x", "y"]),
      bypass: new Set(["x", "y"]),
      provider,
    });

    expect([...result.kept].sort()).toEqual(["x", "y"]);
    expect(result.trace).toEqual({ judged: [], dropped: [] });
  });

  test("dense fully covered by sticky (not bypass) → no call", async () => {
    const provider = makeNeverCalledProvider();

    // Every dense slug is sticky but none is bypass: there is nothing to judge,
    // so no LLM round-trip happens. kept is the (empty) bypass set — the sticky
    // slugs are force-selected downstream by the gate, not via the filter.
    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["x", "y"]),
      sticky: new Set(["x", "y"]),
      bypass: new Set(),
      provider,
    });

    expect(result.kept).toEqual([]);
    expect(result.trace).toEqual({ judged: [], dropped: [] });
  });
});

describe("filterDenseHits — system prompt", () => {
  test("uses the bundled default when no override is configured", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    expect(calls[0].systemPrompt).toBe(FILTER_SYSTEM_PROMPT);
  });

  test("uses the configured inline override as the system prompt", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    const override = "CUSTOM FILTER PROMPT — keep only the obvious matches.";
    await filterDenseHits({
      input: makeInput({ config: configWithFilterOverride(override) }),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    expect(calls[0].systemPrompt).toBe(override);
    expect(calls[0].systemPrompt).not.toBe(FILTER_SYSTEM_PROMPT);
  });
});

describe("filterDenseHits — fail-open", () => {
  test("provider === null keeps all dense with failureReason no_provider", async () => {
    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b", "c"]),
      sticky: new Set(),
      bypass: new Set(),
      provider: null,
    });

    expect([...result.kept].sort()).toEqual(["a", "b", "c"]);
    expect(result.trace.judged).toEqual(["a", "b", "c"]);
    expect(result.trace.dropped).toEqual([]);
    expect(result.failureReason).toBe("no_provider");
  });

  test("fail-open still unions bypass slugs into kept", async () => {
    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b", "x"]),
      sticky: new Set(["x"]),
      bypass: new Set(["x"]),
      provider: null,
    });

    // bypass `x` first, then the judged-but-kept-by-fail-open slugs a, b.
    expect(result.kept).toEqual(["x", "a", "b"]);
    expect(result.trace.judged).toEqual(["a", "b"]);
  });

  test("provider throw keeps all dense (failureReason api_error)", async () => {
    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider: makeThrowingProvider(),
    });

    expect([...result.kept].sort()).toEqual(["a", "b"]);
    expect(result.failureReason).toBe("api_error");
  });

  test("missing tool_use block keeps all dense (failureReason tool_use_missing)", async () => {
    const calls: ProviderCall[] = [];
    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider: makeProvider(textOnlyResponse(), calls),
    });

    expect([...result.kept].sort()).toEqual(["a", "b"]);
    expect(result.failureReason).toBe("tool_use_missing");
  });

  test("schema-mismatched tool input keeps all dense (failureReason schema_mismatch)", async () => {
    const calls: ProviderCall[] = [];
    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      // `keep_slugs` is required; missing it fails the Zod schema.
      provider: makeProvider(filterToolResponse({ wrong_key: ["a"] }), calls),
    });

    expect([...result.kept].sort()).toEqual(["a", "b"]);
    expect(result.failureReason).toBe("schema_mismatch");
  });
});

describe("filterDenseHits — capture", () => {
  test("emits one record with the filter's input + raw response", async () => {
    const calls: ProviderCall[] = [];
    const captured: Omit<LlmCallRecord, "pass">[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
      capture: (record) => captured.push(record),
    });

    expect(captured).toHaveLength(1);
    const rec = captured[0]!;
    expect(rec.lane).toBe("filter");
    expect(rec.callSite).toBe("memoryV3Filter");
    expect(rec.request.tools[0]!.name).toBe("filter_dense_hits");
    expect(rec.response.stopReason).toBe("tool_use");
  });

  test("emits nothing when there is nothing to judge (no LLM call)", async () => {
    const captured: Omit<LlmCallRecord, "pass">[] = [];
    await filterDenseHits({
      input: makeInput(),
      dense: denseResult([]),
      sticky: new Set(),
      bypass: new Set(),
      capture: (record) => captured.push(record),
    });
    expect(captured).toHaveLength(0);
  });
});

describe("filterDenseHits — reasoning field", () => {
  test("exposes an optional reasoning property in the forced tool schema", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({ keep_slugs: ["a"] }),
      calls,
    );

    await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    const schema = calls[0].tools![0].input_schema as {
      properties: Record<string, { type?: string }>;
      required?: string[];
    };
    expect(schema.properties.reasoning?.type).toBe("string");
    // Reasoning is purely additive — the model may omit it.
    expect(schema.required ?? []).not.toContain("reasoning");
  });

  test("accepts model-supplied reasoning without altering the kept set", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      filterToolResponse({
        keep_slugs: ["c", "a"],
        reasoning:
          "kept the cross-domain associations, dropped the near-duplicate",
      }),
      calls,
    );

    const result = await filterDenseHits({
      input: makeInput(),
      dense: denseResult(["a", "b", "c"]),
      sticky: new Set(),
      bypass: new Set(),
      provider,
    });

    // Reasoning is ignored by control flow: kept/dropped unchanged.
    expect(result.kept).toEqual(["c", "a"]);
    expect(result.trace.dropped).toEqual(["b"]);
    expect(result.failureReason).toBeUndefined();
  });
});
