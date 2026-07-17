/**
 * Unit tests for the platform-hosted /reengage route handler.
 *
 * Covers:
 * - Happy path: forced tool_use → structured subject/body
 * - The compose tool is forced via tool_choice
 * - No provider configured → 503
 * - Missing / empty tool output → 502
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { Message } from "@vellumai/plugin-api";

// ---------------------------------------------------------------------------
// Mock — defined before importing the module under test
// ---------------------------------------------------------------------------

type SendMessage = (messages: Message[], options?: unknown) => Promise<unknown>;

let mockResponse: unknown = {
  content: [
    {
      type: "tool_use",
      id: "tu_1",
      name: "compose_reengagement_email",
      input: {
        subject: "Ready when you are",
        body: "Just picking up where we left off.",
      },
    },
  ],
  model: "test-model",
  usage: { inputTokens: 10, outputTokens: 20 },
  stopReason: "tool_use",
};

let mockProvider: { sendMessage: SendMessage } | null = null;
let lastOptions:
  | { config?: { tool_choice?: unknown }; tools?: unknown }
  | undefined;

mock.module("@vellumai/plugin-api", () => ({
  getConfiguredProvider: async () => mockProvider,
}));

const { POST } = await import("../routes/reengage.js");

function postRequest(): Request {
  return new Request(
    "http://plugin.internal/x/plugins/platform-hosted/reengage",
    { method: "POST" },
  );
}

describe("platform-hosted /reengage POST", () => {
  beforeEach(() => {
    lastOptions = undefined;
    mockProvider = {
      sendMessage: async (_messages, options) => {
        lastOptions = options as typeof lastOptions;
        return mockResponse;
      },
    };
    mockResponse = {
      content: [
        {
          type: "tool_use",
          id: "tu_1",
          name: "compose_reengagement_email",
          input: {
            subject: "Ready when you are",
            body: "Just picking up where we left off.",
          },
        },
      ],
      model: "test-model",
      usage: { inputTokens: 10, outputTokens: 20 },
      stopReason: "tool_use",
    };
  });

  test("returns the structured subject and body from the tool call", async () => {
    const response = await POST(postRequest());
    expect(response.status).toBe(200);
    const json = (await response.json()) as { subject: string; body: string };
    expect(json.subject).toBe("Ready when you are");
    expect(json.body).toBe("Just picking up where we left off.");
  });

  test("forces the compose_reengagement_email tool via tool_choice", async () => {
    await POST(postRequest());
    expect(lastOptions?.config?.tool_choice).toEqual({
      type: "tool",
      name: "compose_reengagement_email",
    });
  });

  test("returns 503 when no provider is configured", async () => {
    mockProvider = null;
    const response = await POST(postRequest());
    expect(response.status).toBe(503);
  });

  test("returns 502 when the model returns no usable tool output", async () => {
    mockResponse = {
      content: [{ type: "text", text: "sorry, I can't" }],
      model: "test-model",
      usage: { inputTokens: 5, outputTokens: 5 },
      stopReason: "end_turn",
    };
    const response = await POST(postRequest());
    expect(response.status).toBe(502);
  });
});
