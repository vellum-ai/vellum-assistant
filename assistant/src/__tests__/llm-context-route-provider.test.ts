import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

const testDir = mkdtempSync(join(tmpdir(), "llm-context-route-provider-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { llmRequestLogs } from "../memory/schema.js";
import { conversationQueryRouteDefinitions } from "../runtime/routes/conversation-query-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

const routes = conversationQueryRouteDefinitions();

function dispatchLlmContext(messageId: string): Promise<Response> | Response {
  const url = new URL(`http://localhost/v1/messages/${messageId}/llm-context`);
  const route = routes.find(
    (r) => r.method === "GET" && r.endpoint === "messages/:id/llm-context",
  );
  if (!route) {
    throw new Error("No llm-context route found");
  }

  return route.handler({
    req: new Request(url.toString(), { method: "GET" }),
    url,
    server: null as never,
    authContext: {} as never,
    params: { id: messageId },
  });
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

    const response = await dispatchLlmContext("msg-openrouter");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      logs: Array<{
        summary?: { provider: string };
      }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({
        provider: "openrouter",
      }),
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

    const response = await dispatchLlmContext("msg-fireworks");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      logs: Array<{
        summary?: { provider: string };
      }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({
        provider: "fireworks",
      }),
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

    const response = await dispatchLlmContext("msg-legacy");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      logs: Array<{
        summary?: { provider: string };
      }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual(
      expect.objectContaining({
        provider: "openai",
      }),
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

    const response = await dispatchLlmContext("msg-raw-only");
    expect(response.status).toBe(200);

    const body = (await response.json()) as {
      logs: Array<{
        summary?: { provider: string };
      }>;
    };

    expect(body.logs).toHaveLength(1);
    expect(body.logs[0]?.summary).toEqual({ provider: "ollama" });
  });
});
