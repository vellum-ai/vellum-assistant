/**
 * Unit tests for the platform-hosted /reengage route handler.
 *
 * Covers:
 * - Happy path: background turn returns bare JSON → parsed subject/body
 * - Fenced JSON: model wraps the object in a ```json fence → still parsed
 * - additionalGuidance is appended to the base prompt
 * - Queued turn (busy conversation) → ServiceUnavailableError
 * - Unparseable output → InternalError
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { RunConversationTurnOptions } from "../../../../plugin-api/conversation-turn.js";
import type { ContentBlock } from "../../../../providers/types.js";

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

mock.module("../../../../plugin-api/conversation-turn.js", () => ({
  runConversationTurn: async (options: RunConversationTurnOptions) => {
    lastOptions = options;
    return mockTurnResult;
  },
}));

const { ROUTES } = await import("../routes/reengage-routes.js");

const handler = ROUTES[0].handler;

describe("platform-hosted /reengage", () => {
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

  test("exposes a single POST platform-hosted/reengage route", () => {
    expect(ROUTES).toHaveLength(1);
    expect(ROUTES[0].endpoint).toBe("platform-hosted/reengage");
    expect(ROUTES[0].method).toBe("POST");
  });

  test("parses a bare JSON object into subject and body", async () => {
    const result = (await handler({ body: {} })) as {
      subject: string;
      body: string;
      conversationId: string;
    };
    expect(result.subject).toBe("Ready when you are");
    expect(result.body).toBe("Just picking up where we left off.");
    expect(result.conversationId).toBe("conv-1");
  });

  test("runs the turn in a background conversation", async () => {
    await handler({ body: {} });
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
    const result = (await handler({ body: {} })) as {
      subject: string;
      body: string;
    };
    expect(result.subject).toBe("A quick nudge");
    expect(result.body).toBe("Let me know if you want to continue.");
  });

  test("appends additionalGuidance to the prompt and honors conversationId", async () => {
    await handler({
      body: {
        conversationId: "conv-existing",
        additionalGuidance: "Mention the launch.",
      },
    });
    expect(lastOptions?.conversationId).toBe("conv-existing");
    const promptText = (lastOptions?.content[0] as { text: string }).text;
    expect(promptText).toContain("Mention the launch.");
  });

  test("throws when the turn was queued because the conversation is busy", async () => {
    mockTurnResult = {
      content: [],
      userMessageId: "msg-3",
      conversationId: "conv-3",
      queued: true,
    };
    await expect(
      handler({ body: { conversationId: "conv-3" } }),
    ).rejects.toThrow(/busy/i);
  });

  test("throws when the response has no usable subject/body", async () => {
    mockTurnResult = {
      content: [{ type: "text", text: "" }],
      userMessageId: "msg-4",
      conversationId: "conv-4",
    };
    await expect(handler({ body: {} })).rejects.toThrow(/usable subject/i);
  });
});
