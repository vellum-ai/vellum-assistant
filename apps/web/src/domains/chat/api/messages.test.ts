/**
 * Tests for `postChatMessage` wire format, specifically the
 * googleConnected and googleScopes fields added for the
 * Google Connect Scan feature.
 *
 * Uses direct method spying on the imported client instead of
 * mock.module to avoid polluting the module registry for other test
 * files in the same Bun process.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { client } from "@/domains/chat/api/client.js";
import { getChatHistory, normalizeContentOrder, normalizeTextSegments, postChatMessage } from "@/domains/chat/api/messages.js";

// ---------------------------------------------------------------------------
// Spy setup — replace client.post per-test, restore after
// ---------------------------------------------------------------------------

let capturedBody: Record<string, unknown> | null = null;
let nextPostResult: { data: unknown; error: unknown; response: Response };
const originalPost = client.post;
const originalGet = client.get;

beforeEach(() => {
  capturedBody = null;
  nextPostResult = {
    data: { accepted: true, messageId: "msg-1" },
    error: null,
    response: new Response(null, { status: 200 }),
  };
  client.post = mock(
    async (options: { body?: Record<string, unknown> }) => {
      capturedBody = options.body ?? null;
      return nextPostResult;
    },
  ) as typeof client.post;
});

afterEach(() => {
  client.post = originalPost;
  client.get = originalGet;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("postChatMessage — onboarding wire format", () => {
  test("includes googleConnected and googleScopes when provided", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      {
        tools: [],
        tasks: [],
        tone: "warm",
        googleConnected: true,
        googleScopes: ["https://mail.google.com/"],
      },
    );

    expect(capturedBody).not.toBeNull();
    const onboarding = (capturedBody as Record<string, unknown>)
      .onboarding as Record<string, unknown>;
    expect(onboarding).not.toBeNull();
    expect(onboarding.googleConnected).toBe(true);
    expect(onboarding.googleScopes).toEqual(["https://mail.google.com/"]);
  });

  test("omits googleConnected and googleScopes when not provided", async () => {
    await postChatMessage(
      "assistant-1",
      "conv-key",
      "Hello",
      [],
      {
        tools: [],
        tasks: [],
        tone: "grounded",
      },
    );

    const onboarding = (capturedBody as Record<string, unknown>)
      .onboarding as Record<string, unknown>;
    expect(onboarding.googleConnected).toBeUndefined();
    expect(onboarding.googleScopes).toBeUndefined();
  });

  test("omits the entire onboarding key when onboarding param is absent", async () => {
    await postChatMessage("assistant-1", "conv-key", "Hello");

    expect(capturedBody).not.toBeNull();
    expect((capturedBody as Record<string, unknown>).onboarding).toBeUndefined();
  });
});

describe("normalizeContentOrder", () => {
  test("converts string-format entries to objects", () => {
    const result = normalizeContentOrder(["text:0", "tool:1", "surface:2"]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "1" },
      { type: "surface", id: "2" },
    ]);
  });

  test("passes through already-object entries unchanged", () => {
    const input = [
      { type: "text", id: "0" },
      { type: "toolCall", id: "abc-123" },
    ];
    const result = normalizeContentOrder(input);
    expect(result).toEqual(input);
  });

  test("handles mixed string and object entries", () => {
    const result = normalizeContentOrder([
      "text:0",
      { type: "toolCall", id: "tc-1" },
      "tool:1",
    ]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "toolCall", id: "tc-1" },
      { type: "tool", id: "1" },
    ]);
  });

  test("handles thinking entries", () => {
    const result = normalizeContentOrder(["thinking:0", "text:0"]);
    expect(result).toEqual([
      { type: "thinking", id: "0" },
      { type: "text", id: "0" },
    ]);
  });

  test("returns undefined for empty or missing input", () => {
    expect(normalizeContentOrder(undefined)).toBeUndefined();
    expect(normalizeContentOrder([])).toBeUndefined();
  });

  test("skips malformed entries", () => {
    const result = normalizeContentOrder([
      "text:0",
      "nocolon",
      42 as unknown as string,
      null as unknown as string,
      { type: 123, id: "bad" } as unknown as { type: string; id: string },
      "tool:1",
    ]);
    expect(result).toEqual([
      { type: "text", id: "0" },
      { type: "tool", id: "1" },
    ]);
  });
});

describe("normalizeTextSegments", () => {
  test("converts plain strings to text segment objects", () => {
    const result = normalizeTextSegments(["Hello world", "Second segment"]);
    expect(result).toEqual([
      { type: "text", content: "Hello world" },
      { type: "text", content: "Second segment" },
    ]);
  });

  test("passes through already-object segments unchanged", () => {
    const input = [
      { type: "text", content: "Hello" },
      { type: "markdown", content: "# Header" },
    ];
    const result = normalizeTextSegments(input);
    expect(result).toEqual(input);
  });

  test("defaults type to text when object has content but no type", () => {
    const result = normalizeTextSegments([
      { content: "no type field" } as unknown as string,
    ]);
    expect(result).toEqual([{ type: "text", content: "no type field" }]);
  });

  test("handles mixed string and object entries", () => {
    const result = normalizeTextSegments([
      "plain string",
      { type: "text", content: "object form" },
    ]);
    expect(result).toEqual([
      { type: "text", content: "plain string" },
      { type: "text", content: "object form" },
    ]);
  });

  test("returns undefined for empty or missing input", () => {
    expect(normalizeTextSegments(undefined)).toBeUndefined();
    expect(normalizeTextSegments([])).toBeUndefined();
  });

  test("skips entries without content", () => {
    const result = normalizeTextSegments([
      "valid",
      { type: "text" } as unknown as string,
      42 as unknown as string,
      null as unknown as string,
    ]);
    expect(result).toEqual([{ type: "text", content: "valid" }]);
  });
});

describe("getChatHistory", () => {
  test("uses shared runtime mapping for Slack metadata and timestamps", async () => {
    const slackMessage = {
      channelId: "C123ABCDEF",
      channelName: "triage",
      channelTs: "1710000000.000200",
      threadTs: "1710000000.000100",
      sender: {
        id: "U123",
        displayName: "Ada Lovelace",
        username: "ada",
        avatarUrl: "https://example.com/avatar.png",
        isBot: false,
      },
      messageLink: {
        appUrl:
          "slack://channel?team=T123&id=C123ABCDEF&message=1710000000.000200",
        webUrl:
          "https://example.slack.com/archives/C123ABCDEF/p1710000000000200",
      },
    };

    client.get = mock(async () => ({
      data: {
        messages: [
          {
            id: "msg-slack",
            daemonMessageId: "daemon-msg-slack",
            role: "user",
            content:
              "Slack reply\n[File attachment] file.pdf, type=application/pdf",
            metadata: { source: "slack" },
            slackMessage,
            timestamp: "2026-05-15T12:34:56.000Z",
          },
        ],
      },
      error: null,
      response: new Response(null, { status: 200 }),
    })) as typeof client.get;

    const result = await getChatHistory("assistant-1", "conv-key");

    expect(result.ok).toBe(true);
    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.messages[0]).toMatchObject({
      id: "msg-slack",
      daemonMessageId: "daemon-msg-slack",
      role: "user",
      content: "Slack reply",
      metadata: { source: "slack" },
      slackMessage,
      timestamp: Date.parse("2026-05-15T12:34:56.000Z"),
    });
    expect(result.messages[0]?.stableId.startsWith("server-")).toBe(true);
  });
});
