/**
 * Tests for `useGhostTextSuggestion`.
 *
 * The hook's load-bearing logic is two pure derivations:
 *   1. Which `messages[n]` becomes `lastCompleteAssistantMsgId` (= drives
 *      query enable + key)
 *   2. The render-time gate that suppresses the value when `input` is
 *      non-empty
 *
 * Both are exercised here by mocking `useQuery` and capturing the options
 * object the hook passes in (same convention as `use-conversation-starters.test.tsx`).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { DisplayMessage } from "@/domains/chat/utils/reconcile";
import type { SuggestionResult } from "@/domains/chat/api/suggestion-api";

// ---------------------------------------------------------------------------
// Captured query options + currently-served stub data
// ---------------------------------------------------------------------------

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  queryFn: (ctx: { signal: AbortSignal }) => Promise<SuggestionResult>;
  enabled: boolean;
  staleTime: number;
}

let lastCapturedOptions: CapturedQueryOptions | null = null;
let useQueryStub: { data: SuggestionResult | undefined } = { data: undefined };

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: (options: CapturedQueryOptions) => {
    lastCapturedOptions = options;
    return useQueryStub;
  },
}));

mock.module("@/domains/chat/api/suggestion-api", () => ({
  fetchSuggestion: async () => ({
    suggestion: null,
    messageId: null,
    source: "none" as const,
  }),
}));

// Import after mocks so the hook resolves them.
const { useGhostTextSuggestion } = await import(
  "@/domains/chat/hooks/use-ghost-text-suggestion"
);

// ---------------------------------------------------------------------------
// Test driver
// ---------------------------------------------------------------------------

let lastReturn: string | null = null;

function Probe(props: {
  assistantId: string | null;
  conversationId: string | null;
  messages: DisplayMessage[];
  input: string;
}) {
  lastReturn = useGhostTextSuggestion(props);
  return null;
}

function drive(props: {
  assistantId: string | null;
  conversationId: string | null;
  messages: DisplayMessage[];
  input: string;
}): { capturedOptions: CapturedQueryOptions | null; value: string | null } {
  lastCapturedOptions = null;
  lastReturn = null;
  renderToStaticMarkup(<Probe {...props} />);
  return { capturedOptions: lastCapturedOptions, value: lastReturn };
}

function assistantMsg(id: string, isStreaming = false): DisplayMessage {
  return { id, role: "assistant", content: "hi", isStreaming } as DisplayMessage;
}

function userMsg(id: string): DisplayMessage {
  return { id, role: "user", content: "hello" } as DisplayMessage;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeEach(() => {
  useQueryStub = { data: undefined };
});

describe("useGhostTextSuggestion — query enable / disable", () => {
  test("disabled when assistantId is null", () => {
    const { capturedOptions } = drive({
      assistantId: null,
      conversationId: "c1",
      messages: [assistantMsg("a1")],
      input: "",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("disabled when conversationId is null", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: null,
      messages: [assistantMsg("a1")],
      input: "",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("disabled when there are no messages", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [],
      input: "",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("disabled when last message is a user message (i.e. just sent)", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1"), userMsg("u1")],
      input: "",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("disabled while the last assistant message is still streaming", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1", /*isStreaming*/ true)],
      input: "",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("enabled with the latest assistant message id in the query key", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1"), assistantMsg("a2")],
      input: "",
    });
    expect(capturedOptions?.enabled).toBe(true);
    expect(capturedOptions?.queryKey).toEqual([
      "chat",
      "suggestion",
      "asst",
      "c1",
      "a2",
    ]);
  });
});

describe("useGhostTextSuggestion — return value", () => {
  test("returns null when input is non-empty even if a suggestion is cached", () => {
    useQueryStub = {
      data: { suggestion: "Try this!", messageId: "a1", source: "llm" },
    };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1")],
      input: "user typed",
    });
    expect(value).toBeNull();
  });

  test("returns null when no data is cached", () => {
    useQueryStub = { data: undefined };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1")],
      input: "",
    });
    expect(value).toBeNull();
  });

  test("returns the cached suggestion string when input is empty", () => {
    useQueryStub = {
      data: { suggestion: "Try this!", messageId: "a1", source: "llm" },
    };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1")],
      input: "",
    });
    expect(value).toBe("Try this!");
  });

  test("returns null when the cached suggestion itself is null (daemon returned EMPTY)", () => {
    useQueryStub = {
      data: { suggestion: null, messageId: null, source: "none" },
    };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      messages: [assistantMsg("a1")],
      input: "",
    });
    expect(value).toBeNull();
  });
});
