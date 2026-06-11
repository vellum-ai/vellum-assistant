/**
 * Unit tests for `runOneShotLLM`.
 *
 * Strategy: we mock `provider-send-message.js` so each test can hand the helper
 * a controllable stub provider via `getConfiguredProvider` — or `null` to
 * exercise the unavailable policy. Mocking the whole module avoids evaluating
 * the real one (which would pin a real logger before our logger mock applies);
 * the small pure helpers (`createTimeout` / `extractAllText` / `extractToolUse`
 * / `userMessage`) are reimplemented faithfully so timeout, text, and
 * tool-extraction behavior is still exercised against equivalent logic.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import { z } from "zod";

// ── Module mocks (declared before the import-under-test) ────────────────────

// Silence the helper's warn logging so failure-path tests don't spam output.
// We assert behavior via the discriminated result (each warn branch maps 1:1
// to a `status: "failure"` reason), which is the robust contract to test.
mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../types.js";

// We mock the whole `provider-send-message.js` module so that importing it
// here never evaluates the real module (which would pin a real logger before
// the logger mock applies). `getConfiguredProvider` is the per-test seam; the
// three small pure helpers are reimplemented faithfully so the helper's
// extraction/timeout behavior is still exercised against equivalent logic.
let nextProvider: Provider | null = null;
mock.module("../provider-send-message.js", () => ({
  getConfiguredProvider: async () => nextProvider,
  createTimeout: (ms: number) => {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ms);
    return { signal: controller.signal, cleanup: () => clearTimeout(timer) };
  },
  extractAllText: (response: ProviderResponse): string =>
    response.content
      .filter(
        (b): b is Extract<ContentBlock, { type: "text" }> => b.type === "text",
      )
      .map((b) => b.text)
      .join(" "),
  extractToolUse: (response: ProviderResponse) =>
    response.content.find((b) => b.type === "tool_use"),
  userMessage: (text: string): Message => ({
    role: "user",
    content: [{ type: "text", text }],
  }),
}));

// ── Import under test (after mocks) ─────────────────────────────────────────
import { BackendUnavailableError } from "../../util/errors.js";
import { runOneShotLLM } from "../one-shot-llm.js";
import { userMessage } from "../provider-send-message.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

const MESSAGES: Message[] = [userMessage("hello")];

function textResponse(text: string): ProviderResponse {
  return {
    content: [{ type: "text", text }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "end_turn",
  };
}

function toolResponse(
  name: string,
  input: Record<string, unknown>,
): ProviderResponse {
  return {
    content: [{ type: "tool_use", id: "tu_1", name, input }],
    model: "test-model",
    usage: { inputTokens: 1, outputTokens: 1 },
    stopReason: "tool_use",
  };
}

/** A provider whose `sendMessage` returns (or throws) what the test wires up. */
function makeProvider(
  impl: (
    messages: Message[],
    options?: SendMessageOptions,
  ) => Promise<ProviderResponse>,
): Provider {
  return { name: "stub", sendMessage: impl };
}

const TOOL = {
  name: "store_thing",
  description: "store a thing",
  input_schema: { type: "object" as const, properties: {} },
};

beforeEach(() => {
  nextProvider = null;
});

// ── onUnavailable policy ─────────────────────────────────────────────────────

describe("runOneShotLLM — provider unavailable", () => {
  test('returns { status: "unavailable" } under default "null" policy', async () => {
    nextProvider = null;
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES);
    expect(result.status).toBe("unavailable");
  });

  test('throws BackendUnavailableError under "throw" policy', async () => {
    nextProvider = null;
    await expect(
      runOneShotLLM("styleAnalyzer", MESSAGES, { onUnavailable: "throw" }),
    ).rejects.toBeInstanceOf(BackendUnavailableError);
  });
});

// ── Text mode ────────────────────────────────────────────────────────────────

describe("runOneShotLLM — text mode", () => {
  test("returns extracted text plus raw response on success", async () => {
    nextProvider = makeProvider(async () => textResponse("  hi there  "));
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES);
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data).toBe("hi there");
    expect(result.response.model).toBe("test-model");
    expect(result.response.usage.outputTokens).toBe(1);
  });

  test('returns failure "empty_text" + warns when no text block', async () => {
    nextProvider = makeProvider(async () => textResponse("   "));
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES);
    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.reason).toBe("empty_text");
  });
});

// ── Tool mode ────────────────────────────────────────────────────────────────

describe("runOneShotLLM — tool mode", () => {
  const schema = z.object({ count: z.number() });

  test("validates tool input against schema (happy path)", async () => {
    nextProvider = makeProvider(async () =>
      toolResponse("store_thing", { count: 42 }),
    );
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES, {
      tools: [TOOL],
      toolChoice: "store_thing",
      schema,
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data).toEqual({ count: 42 });
    expect(result.response.stopReason).toBe("tool_use");
  });

  test("returns raw input when no schema is supplied", async () => {
    nextProvider = makeProvider(async () =>
      toolResponse("store_thing", { anything: "goes" }),
    );
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES, {
      tools: [TOOL],
      toolChoice: "store_thing",
    });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") throw new Error("unreachable");
    expect(result.data).toEqual({ anything: "goes" });
  });

  test('returns failure "schema_mismatch" + warns when input fails zod', async () => {
    nextProvider = makeProvider(async () =>
      toolResponse("store_thing", { count: "not a number" }),
    );
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES, {
      tools: [TOOL],
      toolChoice: "store_thing",
      schema,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.reason).toBe("schema_mismatch");
    expect(result.response).toBeDefined();
  });

  test('returns failure "tool_use_missing" + warns when no tool block', async () => {
    nextProvider = makeProvider(async () => textResponse("just text"));
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES, {
      tools: [TOOL],
      toolChoice: "store_thing",
      schema,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.reason).toBe("tool_use_missing");
  });

  test('returns failure "tool_use_missing" when wrong tool is called', async () => {
    nextProvider = makeProvider(async () =>
      toolResponse("some_other_tool", { count: 1 }),
    );
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES, {
      tools: [TOOL],
      toolChoice: "store_thing",
      schema,
    });
    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.reason).toBe("tool_use_missing");
  });

  test("forces tool_choice for the named tool", async () => {
    let seen: SendMessageOptions | undefined;
    nextProvider = makeProvider(async (_messages, options) => {
      seen = options;
      return toolResponse("store_thing", { count: 1 });
    });
    await runOneShotLLM("styleAnalyzer", MESSAGES, {
      tools: [TOOL],
      toolChoice: "store_thing",
      schema,
    });
    const cfg = seen?.config as Record<string, unknown>;
    expect(cfg.tool_choice).toEqual({ type: "tool", name: "store_thing" });
    expect(cfg.callSite).toBe("styleAnalyzer");
  });
});

// ── Timeout / abort + cleanup ────────────────────────────────────────────────

describe("runOneShotLLM — timeout and external signal", () => {
  test("fires the timeout, aborts the call, and clears the timer", async () => {
    let timerCleared = false;
    const realClearTimeout = globalThis.clearTimeout;
    // Spy on clearTimeout to prove the `finally` cleanup ran.
    globalThis.clearTimeout = ((id?: ReturnType<typeof setTimeout>) => {
      timerCleared = true;
      return realClearTimeout(id);
    }) as typeof clearTimeout;

    nextProvider = makeProvider((_messages, options) => {
      // Reject as soon as the timeout signal aborts.
      return new Promise<ProviderResponse>((_resolve, reject) => {
        options?.signal?.addEventListener("abort", () =>
          reject(new Error("aborted")),
        );
      });
    });

    try {
      const result = await runOneShotLLM("styleAnalyzer", MESSAGES, {
        timeoutMs: 5,
      });
      expect(result.status).toBe("failure");
      if (result.status !== "failure") throw new Error("unreachable");
      expect(result.reason).toBe("timeout");
      expect(timerCleared).toBe(true);
    } finally {
      globalThis.clearTimeout = realClearTimeout;
    }
  });

  test("aborts when the external signal fires before the timeout", async () => {
    const controller = new AbortController();
    nextProvider = makeProvider((_messages, options) => {
      return new Promise<ProviderResponse>((_resolve, reject) => {
        const signal = options?.signal;
        // Honor an already-aborted merged signal (the external signal can fire
        // before `sendMessage` runs) as well as a later abort event.
        if (signal?.aborted) {
          reject(new Error("aborted"));
          return;
        }
        signal?.addEventListener("abort", () => reject(new Error("aborted")));
      });
    });

    const promise = runOneShotLLM("styleAnalyzer", MESSAGES, {
      timeoutMs: 60_000,
      signal: controller.signal,
    });
    controller.abort();

    const result = await promise;
    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.reason).toBe("timeout");
  });

  test('surfaces a non-abort provider throw as "provider_error"', async () => {
    nextProvider = makeProvider(async () => {
      throw new Error("kaboom");
    });
    const result = await runOneShotLLM("styleAnalyzer", MESSAGES);
    expect(result.status).toBe("failure");
    if (result.status !== "failure") throw new Error("unreachable");
    expect(result.reason).toBe("provider_error");
  });
});
