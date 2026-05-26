/**
 * Tests for `assistant/src/memory/v3/gate.ts`.
 *
 * Coverage matrix:
 *   - ready + selection → selection maps from candidates, in model order, and
 *     includes sticky slugs even when the model omits them.
 *   - more + questions → `decision.questions` surfaced; selection still returned.
 *   - more with no/blank questions → decision is `{ decision: "more" }` (no
 *     empty `questions` array).
 *   - provider === null (no provider configured) → fail-safe: ready, all
 *     candidates selected, sticky present.
 *   - provider throws → fail-safe (ready, all candidates).
 *   - missing tool_use block → fail-safe (ready, all candidates).
 *   - tool input failing schema → fail-safe (ready, all candidates).
 *   - model selecting a slug outside the candidate set → dropped.
 *   - request shape: forced tool_choice on `decide_selection`, candidate set in
 *     the user message, abort signal forwarded.
 *
 * The provider is injected via `runGate({ provider })` — no real LLM, no
 * network, no `mock.module`. `~/.vellum/` is never touched.
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
import { runGate } from "../gate.js";
import type { LlmCallRecord } from "../llm-capture.js";
import { GATE_SYSTEM_PROMPT } from "../prompts/system-prompts.js";

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
    sendMessage: async (messages, tools, systemPrompt, options) => {
      calls.push({ messages, tools, systemPrompt, options });
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

function gateToolResponse(input: Record<string, unknown>): ProviderResponse {
  return {
    model: "stub-model",
    stopReason: "tool_use",
    usage: { inputTokens: 0, outputTokens: 0 },
    content: [
      { type: "tool_use", id: "tu-1", name: "decide_selection", input },
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

/** Minimal `RetrievalInput` — the gate only reads `nowText` and `signal`. */
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

/**
 * Build a `RetrievalInput["config"]` carrying a `memory.v3.prompts.gate`
 * inline override. The cast mirrors `makeInput`'s — the gate only reads the
 * prompts path on config.
 */
function configWithGateOverride(override: string): RetrievalInput["config"] {
  return {
    memory: { v3: { prompts: { gate: { override, path: null } } } },
  } as unknown as RetrievalInput["config"];
}

// ---------------------------------------------------------------------------
// Tests.
// ---------------------------------------------------------------------------

describe("runGate — ready decision", () => {
  test("maps model selection to slugs in order and includes sticky", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      // Model selects b, a (its own order). Sticky `c` is omitted by the
      // model but must survive in the final selection.
      gateToolResponse({ decision: "ready", selected_slugs: ["b", "a"] }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b", "c"]),
      sticky: new Set(["c"]),
      passNumber: 1,
      provider,
    });

    expect(result.decision).toEqual({ decision: "ready" });
    // Model order preserved (b, a), then omitted sticky appended (c).
    expect(result.selectedSlugs).toEqual(["b", "a", "c"]);
    expect(calls).toHaveLength(1);
  });

  test("forces tool_choice on decide_selection and surfaces candidates", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    await runGate({
      input: makeInput({ nowText: "NOW-MARKER" }),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 3,
      provider,
    });

    const call = calls[0];
    expect(call.options?.config?.tool_choice).toEqual({
      type: "tool",
      name: "decide_selection",
    });
    expect(call.options?.config?.callSite).toBe("memoryV3Gate");
    expect(call.tools?.[0].name).toBe("decide_selection");
    const userText = call.messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(userText).toContain("NOW-MARKER");
    expect(userText).toContain("a");
    expect(userText).toContain("b");
  });

  test("includes the just-arrived turn so the selection is query-aware", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    await runGate({
      input: makeInput({
        recentTurnPairs: [
          {
            assistantMessage: "an earlier reply",
            userMessage: "tell me about the people you know",
          },
        ],
      }),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    const userText = calls[0].messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    // The gate must see the user's actual question, not just NOW + slugs.
    expect(userText).toContain("<last_turn>");
    expect(userText).toContain("tell me about the people you know");
    expect(userText).toContain("an earlier reply");
  });

  test("drops a model-selected slug outside the candidate set", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a", "ghost"] }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    expect(result.selectedSlugs).toEqual(["a"]);
  });

  test("forwards an abort signal to the provider call", async () => {
    const calls: ProviderCall[] = [];
    const controller = new AbortController();
    controller.abort();
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    // Aborted signal makes the stub throw → gate fails open (ready, all).
    const result = await runGate({
      input: makeInput({ signal: controller.signal }),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    expect(calls[0].options?.signal).toBe(controller.signal);
    expect(result.decision).toEqual({ decision: "ready" });
    expect(result.selectedSlugs).toEqual(["a", "b"]);
  });
});

describe("runGate — candidate summaries", () => {
  test("renders candidates as `slug — summary` when summaryBySlug is provided", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a/one"] }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a/one", "b/two"]),
      sticky: new Set(),
      passNumber: 1,
      summaryBySlug: new Map([
        ["a/one", "first summary"],
        ["b/two", "second summary"],
      ]),
      provider,
    });

    // The model still answers in bare slugs (the enum is slug-only).
    expect(result.selectedSlugs).toEqual(["a/one"]);
    const userText = calls[0].messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(userText).toContain("a/one — first summary");
    expect(userText).toContain("b/two — second summary");
  });

  test("falls back to the bare slug when no summary is available", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: [] }),
      calls,
    );

    await runGate({
      input: makeInput(),
      candidates: new Set(["a/one"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    const userText = calls[0].messages[0].content
      .map((b) => (b.type === "text" ? b.text : ""))
      .join("\n");
    expect(userText).toContain("a/one");
    expect(userText).not.toContain("a/one —");
  });
});

describe("runGate — more decision", () => {
  test("surfaces generated follow-up questions", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({
        decision: "more",
        selected_slugs: ["a"],
        questions: ["What is the user's deadline?", "Who else is involved?"],
      }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    expect(result.decision).toEqual({
      decision: "more",
      questions: ["What is the user's deadline?", "Who else is involved?"],
    });
    // Selection is still returned alongside the "more" verdict.
    expect(result.selectedSlugs).toEqual(["a"]);
  });

  test("omits questions array when the model gave none (or only blanks)", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({
        decision: "more",
        selected_slugs: ["a"],
        questions: ["   ", ""],
      }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    expect(result.decision).toEqual({ decision: "more" });
  });

  test("preserves sticky even on a more decision", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({
        decision: "more",
        selected_slugs: ["a"],
        questions: ["follow-up?"],
      }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "sticky-page"]),
      sticky: new Set(["sticky-page"]),
      passNumber: 1,
      provider,
    });

    expect(result.selectedSlugs).toContain("sticky-page");
  });
});

describe("runGate — system prompt", () => {
  test("uses the bundled default when no override is configured", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    expect(calls[0].systemPrompt).toBe(GATE_SYSTEM_PROMPT);
  });

  test("uses the configured inline override as the system prompt", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    const override = "CUSTOM GATE PROMPT — finalize aggressively.";
    await runGate({
      input: makeInput({ config: configWithGateOverride(override) }),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
    });

    expect(calls[0].systemPrompt).toBe(override);
    expect(calls[0].systemPrompt).not.toBe(GATE_SYSTEM_PROMPT);
  });
});

describe("runGate — fail-safe", () => {
  test("provider === null selects all candidates with sticky and ready", async () => {
    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b", "c"]),
      sticky: new Set(["c"]),
      passNumber: 1,
      provider: null,
    });

    expect(result.decision).toEqual({ decision: "ready" });
    expect([...result.selectedSlugs].sort()).toEqual(["a", "b", "c"]);
    expect(result.selectedSlugs).toContain("c");
  });

  test("provider throw falls back to ready + all candidates", async () => {
    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider: makeThrowingProvider(),
    });

    expect(result.decision).toEqual({ decision: "ready" });
    expect([...result.selectedSlugs].sort()).toEqual(["a", "b"]);
  });

  test("missing tool_use block falls back to ready + all candidates", async () => {
    const calls: ProviderCall[] = [];
    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider: makeProvider(textOnlyResponse(), calls),
    });

    expect(result.decision).toEqual({ decision: "ready" });
    expect([...result.selectedSlugs].sort()).toEqual(["a", "b"]);
  });

  test("schema-mismatched tool input falls back to ready + all candidates", async () => {
    const calls: ProviderCall[] = [];
    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      // `decision` is required; missing it fails the Zod schema.
      provider: makeProvider(
        gateToolResponse({ selected_slugs: ["a"] }),
        calls,
      ),
    });

    expect(result.decision).toEqual({ decision: "ready" });
    expect([...result.selectedSlugs].sort()).toEqual(["a", "b"]);
  });
});

describe("runGate — capture", () => {
  test("emits one record with the gate's input + raw response", async () => {
    const calls: ProviderCall[] = [];
    const captured: Omit<LlmCallRecord, "pass">[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
      provider,
      capture: (record) => captured.push(record),
    });

    expect(captured).toHaveLength(1);
    const rec = captured[0]!;
    expect(rec.lane).toBe("gate");
    expect(rec.callSite).toBe("memoryV3Gate");
    expect(rec.request.tools[0]!.name).toBe("decide_selection");
    expect(rec.request.systemPrompt.length).toBeGreaterThan(0);
    expect(rec.request.messages).toHaveLength(1);
    expect(rec.response.stopReason).toBe("tool_use");
    expect(rec.ms).toBeGreaterThanOrEqual(0);
  });

  test("emits nothing when the provider is unavailable (fail-safe path)", async () => {
    const captured: Omit<LlmCallRecord, "pass">[] = [];
    await runGate({
      input: makeInput(),
      candidates: new Set(["a"]),
      sticky: new Set(),
      passNumber: 1,
      provider: null,
      capture: (record) => captured.push(record),
    });
    expect(captured).toHaveLength(0);
  });
});

describe("runGate — reasoning field", () => {
  test("exposes an optional reasoning property in the forced tool schema", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({ decision: "ready", selected_slugs: ["a"] }),
      calls,
    );

    await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b"]),
      sticky: new Set(),
      passNumber: 1,
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

  test("surfaces model-supplied reasoning on the decision without altering the verdict", async () => {
    const calls: ProviderCall[] = [];
    const provider = makeProvider(
      gateToolResponse({
        decision: "ready",
        selected_slugs: ["b", "a"],
        reasoning: "kept the two query-relevant pages, dropped the rest",
      }),
      calls,
    );

    const result = await runGate({
      input: makeInput(),
      candidates: new Set(["a", "b", "c"]),
      sticky: new Set(["c"]),
      passNumber: 1,
      provider,
    });

    // Reasoning does not alter control flow — the verdict and ordered selection
    // (model order, omitted sticky appended) are unchanged — but it IS carried
    // on the decision so a run can be analyzed (trace + shadow telemetry).
    expect(result.decision).toEqual({
      decision: "ready",
      reasoning: "kept the two query-relevant pages, dropped the rest",
    });
    expect(result.selectedSlugs).toEqual(["b", "a", "c"]);
  });
});
