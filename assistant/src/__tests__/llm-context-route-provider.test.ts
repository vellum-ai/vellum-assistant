import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { llmRequestLogs } from "../memory/schema.js";
import { ROUTES } from "../runtime/routes/conversation-query-routes.js";
import { NotFoundError } from "../runtime/routes/errors.js";

initializeDb();

const llmContextRoute = ROUTES.find(
  (r) => r.method === "GET" && r.endpoint === "messages/:id/llm-context",
)!;

const logPayloadRoute = ROUTES.find(
  (r) => r.method === "GET" && r.endpoint === "llm-request-logs/:id/payload",
)!;

function dispatchLlmContext(messageId: string) {
  return llmContextRoute.handler({ pathParams: { id: messageId } });
}

function dispatchLogPayload(logId: string) {
  return logPayloadRoute.handler({ pathParams: { id: logId } });
}

function clearRequestLogs(): void {
  getDb().delete(llmRequestLogs).run();
}

function seedRequestLog(overrides: {
  id: string;
  messageId: string;
  provider: string | null;
  requestPayload: string;
  responsePayload: string;
  createdAt?: number;
}): void {
  getDb()
    .insert(llmRequestLogs)
    .values({
      id: overrides.id,
      conversationId: "conv-1",
      messageId: overrides.messageId,
      provider: overrides.provider,
      requestPayload: overrides.requestPayload,
      responsePayload: overrides.responsePayload,
      createdAt: overrides.createdAt ?? 1_700_000_000_000,
    })
    .run();
}

beforeEach(() => {
  clearRequestLogs();
});

describe("GET /v1/messages/:id/llm-context provider preference", () => {
  const openAiRequestPayload = JSON.stringify({
    model: "gpt-4.1",
    tool_choice: "auto",
    messages: [
      { role: "system", content: "Stay brief." },
      { role: "user", content: "Hello there." },
    ],
  });

  const openAiResponsePayload = JSON.stringify({
    model: "gpt-4.1-2026-03-01",
    choices: [
      {
        finish_reason: "stop",
        message: {
          role: "assistant",
          content: "Hello back.",
        },
      },
    ],
    usage: {
      prompt_tokens: 11,
      completion_tokens: 4,
    },
  });

  test("prefers a stored OpenRouter provider over OpenAI-shaped payload inference", async () => {
    seedRequestLog({
      id: "log-openrouter",
      messageId: "msg-openrouter",
      provider: "openrouter",
      requestPayload: openAiRequestPayload,
      responsePayload: openAiResponsePayload,
    });

    const body = (await dispatchLlmContext("msg-openrouter")) as {
      logs: Array<{ summary?: { provider: string } }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({ provider: "openrouter" }),
    );
  });

  test("prefers a stored Fireworks provider over OpenAI-shaped payload inference", async () => {
    seedRequestLog({
      id: "log-fireworks",
      messageId: "msg-fireworks",
      provider: "fireworks",
      requestPayload: openAiRequestPayload,
      responsePayload: openAiResponsePayload,
    });

    const body = (await dispatchLlmContext("msg-fireworks")) as {
      logs: Array<{ summary?: { provider: string } }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({ provider: "fireworks" }),
    );
  });

  test("keeps the legacy shape-inferred provider when no stored provider exists", async () => {
    seedRequestLog({
      id: "log-legacy",
      messageId: "msg-legacy",
      provider: null,
      requestPayload: openAiRequestPayload,
      responsePayload: openAiResponsePayload,
    });

    const body = (await dispatchLlmContext("msg-legacy")) as {
      logs: Array<{ summary?: { provider: string } }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({ provider: "openai" }),
    );
  });

  test("keeps a stored provider label even when payload normalization fails", async () => {
    seedRequestLog({
      id: "log-raw-only",
      messageId: "msg-raw-only",
      provider: "ollama",
      requestPayload: "not-json",
      responsePayload: "still-not-json",
    });

    const body = (await dispatchLlmContext("msg-raw-only")) as {
      logs: Array<{ summary?: { provider: string } }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual({ provider: "ollama" });
  });

  test("returns null payloads to keep the initial response lightweight", async () => {
    seedRequestLog({
      id: "log-null-payload",
      messageId: "msg-null-payload",
      provider: "openrouter",
      requestPayload: openAiRequestPayload,
      responsePayload: openAiResponsePayload,
    });

    const body = (await dispatchLlmContext("msg-null-payload")) as {
      logs: Array<{ requestPayload: unknown; responsePayload: unknown }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.requestPayload).toBeNull();
    expect(body.logs[0]?.responsePayload).toBeNull();
  });

  // ── OpenAI Responses API payload tests ──────────────────────────────

  const responsesApiRequestPayload = JSON.stringify({
    model: "gpt-5.4",
    instructions: "Be concise.",
    input: [
      {
        role: "user",
        content: [{ type: "input_text", text: "Hello there." }],
        type: "message",
      },
    ],
  });

  const responsesApiResponsePayload = JSON.stringify({
    id: "resp_test",
    model: "gpt-5.4",
    output: [
      {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Hello back." }],
      },
    ],
    usage: {
      input_tokens: 11,
      output_tokens: 4,
    },
    status: "completed",
  });

  test("normalizes Responses API payloads and infers OpenAI provider when no stored provider exists", async () => {
    seedRequestLog({
      id: "log-responses-legacy",
      messageId: "msg-responses-legacy",
      provider: null,
      requestPayload: responsesApiRequestPayload,
      responsePayload: responsesApiResponsePayload,
    });

    const body = (await dispatchLlmContext("msg-responses-legacy")) as {
      logs: Array<{ summary?: { provider: string; inputTokens?: number } }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({ provider: "openai", inputTokens: 11 }),
    );
  });

  test("prefers a stored provider over Responses API payload inference", async () => {
    seedRequestLog({
      id: "log-responses-openai",
      messageId: "msg-responses-openai",
      provider: "openai",
      requestPayload: responsesApiRequestPayload,
      responsePayload: responsesApiResponsePayload,
    });

    const body = (await dispatchLlmContext("msg-responses-openai")) as {
      logs: Array<{ summary?: { provider: string } }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({ provider: "openai" }),
    );
  });
});

describe("GET /v1/llm-request-logs/:id/payload", () => {
  test("returns parsed payloads for a valid log", async () => {
    const reqPayload = JSON.stringify({ model: "gpt-4.1", messages: [] });
    const resPayload = JSON.stringify({
      choices: [{ message: { content: "hi" } }],
    });
    seedRequestLog({
      id: "log-payload-ok",
      messageId: "msg-payload-ok",
      provider: "openai",
      requestPayload: reqPayload,
      responsePayload: resPayload,
    });

    const body = (await dispatchLogPayload("log-payload-ok")) as {
      id: string;
      requestPayload: unknown;
      responsePayload: unknown;
    };

    expect(body.id).toBe("log-payload-ok");
    expect(body.requestPayload).toEqual(JSON.parse(reqPayload));
    expect(body.responsePayload).toEqual(JSON.parse(resPayload));
  });

  test("returns NotFoundError for a nonexistent log", () => {
    expect(() => dispatchLogPayload("does-not-exist")).toThrow(NotFoundError);
  });

  test("falls back to string values for non-JSON payloads", async () => {
    seedRequestLog({
      id: "log-raw-strings",
      messageId: "msg-raw-strings",
      provider: null,
      requestPayload: "raw-request-text",
      responsePayload: "raw-response-text",
    });

    const body = (await dispatchLogPayload("log-raw-strings")) as {
      id: string;
      requestPayload: unknown;
      responsePayload: unknown;
    };

    expect(body.requestPayload).toBe("raw-request-text");
    expect(body.responsePayload).toBe("raw-response-text");
  });
});
