/**
 * Tests for `useGhostTextSuggestion`.
 *
 * The hook's job is narrow: derive a query enable/disable predicate and
 * a stable query key from `(assistantId, conversationId,
 * lastCompleteAssistantMsgId)`, then surface the cached suggestion
 * string. There is no input gating in the hook — that's
 * `ChatComposer.computeGhostSuffix`'s job (so the "typing the beginning
 * of the suggestion shows only the suffix" behavior stays correct).
 *
 * We mock `useQuery` and capture the options the hook passes in (same
 * convention as `use-conversation-starters.test.tsx`).
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { SuggestionGetResponse } from "@/generated/daemon/types.gen";

interface CapturedQueryOptions {
  queryKey: readonly unknown[];
  queryFn: (ctx: { signal: AbortSignal }) => Promise<SuggestionGetResponse>;
  enabled: boolean;
  staleTime: number;
}

let lastCapturedOptions: CapturedQueryOptions | null = null;
let useQueryStub: { data: SuggestionGetResponse | undefined } = {
  data: undefined,
};

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

const { useGhostTextSuggestion } =
  await import("@/domains/chat/hooks/use-ghost-text-suggestion");

let lastReturn: string | null = null;

function Probe(props: {
  assistantId: string | null;
  conversationId: string | null;
  lastCompleteAssistantMsgId: string | null;
}) {
  // eslint-disable-next-line react-hooks/globals -- synchronous renderToStaticMarkup test harness
  lastReturn = useGhostTextSuggestion(props);
  return null;
}

function drive(props: {
  assistantId: string | null;
  conversationId: string | null;
  lastCompleteAssistantMsgId: string | null;
}): { capturedOptions: CapturedQueryOptions | null; value: string | null } {
  lastCapturedOptions = null;
  lastReturn = null;
  renderToStaticMarkup(<Probe {...props} />);
  return { capturedOptions: lastCapturedOptions, value: lastReturn };
}

beforeEach(() => {
  useQueryStub = { data: undefined };
});

describe("useGhostTextSuggestion — query enable / disable", () => {
  test("disabled when assistantId is null", () => {
    const { capturedOptions } = drive({
      assistantId: null,
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a1",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("disabled when conversationId is null", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: null,
      lastCompleteAssistantMsgId: "a1",
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("disabled when lastCompleteAssistantMsgId is null (e.g. just-sent user message, or in-flight stream)", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: null,
    });
    expect(capturedOptions?.enabled).toBe(false);
  });

  test("enabled with all three scalars in the query key", () => {
    const { capturedOptions } = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a2",
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

  test("query key changes when lastCompleteAssistantMsgId changes (drives cache lookup)", () => {
    const first = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a1",
    });
    const second = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a2",
    });
    expect(first.capturedOptions?.queryKey).not.toEqual(
      second.capturedOptions?.queryKey,
    );
  });
});

describe("useGhostTextSuggestion — return value", () => {
  test("returns null when no data is cached", () => {
    useQueryStub = { data: undefined };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a1",
    });
    expect(value).toBeNull();
  });

  test("returns the cached suggestion string", () => {
    useQueryStub = {
      data: { suggestion: "Try this!", messageId: "a1", source: "llm" },
    };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a1",
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
      lastCompleteAssistantMsgId: "a1",
    });
    expect(value).toBeNull();
  });

  test("does NOT suppress the suggestion based on composer input (consumer's job)", () => {
    // This is the regression-prevention test: the hook is pure w.r.t.
    // composer input. `ChatComposer.computeGhostSuffix` is where the
    // input-vs-suggestion comparison happens, so the hook returning the
    // full cached value preserves the "type the prefix, see the tail"
    // suffix-completion behavior.
    useQueryStub = {
      data: { suggestion: "Hello world", messageId: "a1", source: "llm" },
    };
    const { value } = drive({
      assistantId: "asst",
      conversationId: "c1",
      lastCompleteAssistantMsgId: "a1",
    });
    expect(value).toBe("Hello world");
  });
});
