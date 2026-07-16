/**
 * Unit tests for the platform-hosted /reengage route handler (userland
 * `export const POST` form).
 *
 * Covers:
 * - Happy path: background turn returns bare JSON → parsed subject/body
 * - Fenced JSON: model wraps the object in a ```json fence → still parsed
 * - The turn always runs in a fresh background conversation (no caller id)
 * - additionalGuidance is appended to the base prompt
 * - Invalid JSON body → 400
 * - Unparseable model output → 502
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type {
  ContentBlock,
  RunConversationTurnOptions,
} from "@vellumai/plugin-api";

// ---------------------------------------------------------------------------
// Mock — defined before importing the module under test
// ---------------------------------------------------------------------------

let mockTurnResult: {
  content: ContentBlock[];
  userMessageId: string;
  conversationId: string;
  queued?: boolean;
} = {
  content: [
    {
      type: "text",
      text: '{"subject": "Ready when you are", "body": "Just picking up where we left off."}',
    },
  ],
  userMessageId: "msg-1",
  conversationId: "conv-1",
};

let lastOptions: RunConversationTurnOptions | undefined;

mock.module("@vellumai/plugin-api", () => ({
  runConversationTurn: async (options: RunConversationTurnOptions) => {
    lastOptions = options;
    return mockTurnResult;
  },
}));

const { POST } = await import("../routes/reengage.js");

function postRequest(body?: unknown): Request {
  return new Request(
    "http://plugin.internal/x/plugins/platform-hosted/reengage",
    {
      method: "POST",
      headers: { "content-type": "application/json" },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    },
  );
}

describe("platform-hosted /reengage POST", () => {
  beforeEach(() => {
    lastOptions = undefined;
    mockTurnResult = {
      content: [
        {
          type: "text",
          text: '{"subject": "Ready when you are", "body": "Just picking up where we left off."}',
        },
      ],
      userMessageId: "msg-1",
      conversationId: "conv-1",
    };
  });

  test("parses a bare JSON object into subject and body", async () => {
    const response = await POST(postRequest({}));
    expect(response.status).toBe(200);
    const json = (await response.json()) as {
      subject: string;
      body: string;
      conversationId: string;
    };
    expect(json.subject).toBe("Ready when you are");
    expect(json.body).toBe("Just picking up where we left off.");
    expect(json.conversationId).toBe("conv-1");
  });

  test("always runs the turn in a fresh background conversation", async () => {
    await POST(postRequest({}));
    expect(lastOptions?.conversationType).toBe("background");
    expect(lastOptions?.conversationId).toBeUndefined();
  });

  test("parses JSON wrapped in a code fence", async () => {
    mockTurnResult = {
      content: [
        {
          type: "text",
          text: 'Here you go:\n```json\n{"subject": "A quick nudge", "body": "Let me know if you want to continue."}\n```',
        },
      ],
      userMessageId: "msg-2",
      conversationId: "conv-2",
    };
    const response = await POST(postRequest({}));
    const json = (await response.json()) as { subject: string; body: string };
    expect(json.subject).toBe("A quick nudge");
    expect(json.body).toBe("Let me know if you want to continue.");
  });

  test("appends additionalGuidance to the prompt", async () => {
    await POST(postRequest({ additionalGuidance: "Mention the launch." }));
    const promptText = (lastOptions?.content[0] as { text: string }).text;
    expect(promptText).toContain("Mention the launch.");
  });

  test("returns 400 for a malformed JSON body", async () => {
    const request = new Request(
      "http://plugin.internal/x/plugins/platform-hosted/reengage",
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{not json",
      },
    );
    const response = await POST(request);
    expect(response.status).toBe(400);
  });

  test("returns 502 when the response has no usable subject/body", async () => {
    mockTurnResult = {
      content: [{ type: "text", text: "" }],
      userMessageId: "msg-3",
      conversationId: "conv-3",
    };
    const response = await POST(postRequest({}));
    expect(response.status).toBe(502);
  });
});
