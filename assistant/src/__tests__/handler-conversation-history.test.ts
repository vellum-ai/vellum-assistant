import { beforeEach, describe, expect, mock, test } from "bun:test";

import { noopLogger } from "./handlers/handler-test-helpers.js";

// ── Mocks (before any handler imports) ──────────────────────────────────────

mock.module("../util/logger.js", () => ({
  getLogger: () => noopLogger,
}));

const mockGetMessageById = mock();
mock.module("../memory/conversation-crud.js", () => ({
  getMessageById: mockGetMessageById,
}));

const mockListConversations = mock();
const mockSearchConversations = mock();
mock.module("../memory/conversation-queries.js", () => ({
  listConversations: mockListConversations,
  searchConversations: mockSearchConversations,
}));

// ── Imports (after mocks) ───────────────────────────────────────────────────

import {
  getMessageContent,
  performConversationSearch,
} from "../daemon/handlers/conversation-history.js";

// ── Tests ───────────────────────────────────────────────────────────────────

describe("performConversationSearch", () => {
  beforeEach(() => {
    mockListConversations.mockReset();
    mockSearchConversations.mockReset();
  });

  test("delegates to searchConversations for normal queries", () => {
    const expected = [
      {
        conversationId: "c1",
        conversationTitle: "Chat 1",
        conversationUpdatedAt: 1000,
        matchingMessages: [
          {
            messageId: "m1",
            role: "user",
            excerpt: "hello",
            createdAt: 900,
          },
        ],
      },
    ];
    mockSearchConversations.mockReturnValue(expected);

    const result = performConversationSearch({ query: "hello" });

    expect(mockSearchConversations).toHaveBeenCalledTimes(1);
    expect(mockSearchConversations).toHaveBeenCalledWith("hello", {
      limit: undefined,
      maxMessagesPerConversation: undefined,
    });
    expect(result).toEqual(expected);
    expect(mockListConversations).not.toHaveBeenCalled();
  });

  test("'*' wildcard delegates to listConversations", () => {
    mockListConversations.mockReturnValue([
      { id: "c1", title: "Chat 1", updatedAt: 1000 },
      { id: "c2", title: "Chat 2", updatedAt: 2000 },
    ]);

    const result = performConversationSearch({ query: "*" });

    expect(mockListConversations).toHaveBeenCalledTimes(1);
    expect(mockSearchConversations).not.toHaveBeenCalled();
    expect(result).toEqual([
      {
        conversationId: "c1",
        conversationTitle: "Chat 1",
        conversationUpdatedAt: 1000,
        matchingMessages: [],
      },
      {
        conversationId: "c2",
        conversationTitle: "Chat 2",
        conversationUpdatedAt: 2000,
        matchingMessages: [],
      },
    ]);
  });

  test("'*' with whitespace still treated as wildcard", () => {
    mockListConversations.mockReturnValue([]);

    performConversationSearch({ query: "  *  " });

    expect(mockListConversations).toHaveBeenCalledTimes(1);
    expect(mockSearchConversations).not.toHaveBeenCalled();
  });

  test("passes limit to listConversations for wildcard", () => {
    mockListConversations.mockReturnValue([]);

    performConversationSearch({ query: "*", limit: 5 });

    expect(mockListConversations).toHaveBeenCalledWith(5);
  });

  test("passes limit and maxMessagesPerConversation to searchConversations", () => {
    mockSearchConversations.mockReturnValue([]);

    performConversationSearch({
      query: "test",
      limit: 10,
      maxMessagesPerConversation: 3,
    });

    expect(mockSearchConversations).toHaveBeenCalledWith("test", {
      limit: 10,
      maxMessagesPerConversation: 3,
    });
  });

  test("returns empty array when no results", () => {
    mockSearchConversations.mockReturnValue([]);

    const result = performConversationSearch({ query: "nonexistent" });

    expect(result).toEqual([]);
  });
});

describe("getMessageContent", () => {
  beforeEach(() => {
    mockGetMessageById.mockReset();
  });

  test("returns null when message not found", () => {
    mockGetMessageById.mockReturnValue(undefined);

    const result = getMessageContent("msg-404");

    expect(result).toBeNull();
    expect(mockGetMessageById).toHaveBeenCalledWith("msg-404", undefined);
  });

  test("passes conversationId to getMessageById", () => {
    mockGetMessageById.mockReturnValue(undefined);

    getMessageContent("msg-1", "conv-1");

    expect(mockGetMessageById).toHaveBeenCalledWith("msg-1", "conv-1");
  });

  test("parses text content blocks", () => {
    mockGetMessageById.mockReturnValue({
      content: JSON.stringify([{ type: "text", text: "Hello world" }]),
    });

    const result = getMessageContent("msg-1", "conv-1");

    expect(result).toEqual({
      conversationId: "conv-1",
      messageId: "msg-1",
      text: "Hello world",
    });
  });

  test("parses tool_use + tool_result blocks", () => {
    mockGetMessageById.mockReturnValue({
      content: JSON.stringify([
        {
          type: "tool_use",
          id: "tu-1",
          name: "bash",
          input: { command: "ls" },
        },
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "file1.txt\nfile2.txt",
        },
      ]),
    });

    const result = getMessageContent("msg-1");

    expect(result).not.toBeNull();
    expect(result!.toolCalls).toBeDefined();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0].name).toBe("bash");
    expect(result!.toolCalls![0].input).toEqual({ command: "ls" });
    expect(result!.toolCalls![0].result).toBe("file1.txt\nfile2.txt");
  });

  test("handles mixed text + tool calls", () => {
    mockGetMessageById.mockReturnValue({
      content: JSON.stringify([
        { type: "text", text: "Running command..." },
        {
          type: "tool_use",
          id: "tu-1",
          name: "file_read",
          input: { path: "/tmp/x" },
        },
        {
          type: "tool_result",
          tool_use_id: "tu-1",
          content: "contents",
        },
      ]),
    });

    const result = getMessageContent("msg-1");

    expect(result).not.toBeNull();
    expect(result!.text).toBe("Running command...");
    expect(result!.toolCalls).toHaveLength(1);
  });

  test("handles raw text content (not JSON)", () => {
    mockGetMessageById.mockReturnValue({
      content: "This is plain text, not JSON",
    });

    const result = getMessageContent("msg-1");

    expect(result).toEqual({
      conversationId: undefined,
      messageId: "msg-1",
      text: "This is plain text, not JSON",
    });
  });

  test("handles empty string content", () => {
    mockGetMessageById.mockReturnValue({
      content: "",
    });

    const result = getMessageContent("msg-1");

    // Empty string is falsy → text is undefined → omitted from result
    expect(result).toEqual({
      conversationId: undefined,
      messageId: "msg-1",
    });
  });

  test("handles null content in JSON array", () => {
    // renderHistoryContent handles null content → returns empty text
    mockGetMessageById.mockReturnValue({
      content: JSON.stringify(null),
    });

    const result = getMessageContent("msg-1");

    // null content → renderHistoryContent returns text: "" → falsy → omitted
    expect(result).toEqual({
      conversationId: undefined,
      messageId: "msg-1",
    });
  });

  test("tool_result without matching tool_use still captured", () => {
    mockGetMessageById.mockReturnValue({
      content: JSON.stringify([
        {
          type: "tool_result",
          tool_use_id: "orphan",
          content: "orphan result",
        },
      ]),
    });

    const result = getMessageContent("msg-1");

    expect(result).not.toBeNull();
    expect(result!.toolCalls).toHaveLength(1);
    expect(result!.toolCalls![0].name).toBe("unknown");
    expect(result!.toolCalls![0].result).toBe("orphan result");
  });
});
