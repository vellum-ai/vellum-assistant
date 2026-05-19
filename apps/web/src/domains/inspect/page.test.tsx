/**
 * Tests for the conversation LLM context inspector route.
 *
 * Strategy mirrors `CurrentPlanCard.test.tsx` — `bun test` cannot drive a real
 * DOM, so we mock `useSearchParams` + `useQuery` + the embedded
 * `MessageInspectorView` per test, render with `renderToStaticMarkup`, and
 * assert on the resulting HTML.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import * as realRQ from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

// ---------------------------------------------------------------------------
// Mutable per-test stubs
// ---------------------------------------------------------------------------

let searchParamsMap = new Map<string, string>();

interface QueryStub<T> {
  data: T | undefined;
  isLoading: boolean;
  isError: boolean;
}

let assistantStub: { assistantId: string | undefined; isLoading: boolean } = {
  assistantId: "asst-1",
  isLoading: false,
};

let latestMessageQuery: QueryStub<string | null> = {
  data: undefined,
  isLoading: true,
  isError: false,
};

const inspectorViewCalls: Array<{
  conversationKey: string;
  messageId: string;
}> = [];

// ---------------------------------------------------------------------------
// Module mocks — registered before the subject is imported.
// ---------------------------------------------------------------------------

mock.module("next/navigation", () => ({
  useSearchParams: () => ({
    get: (key: string) => searchParamsMap.get(key) ?? null,
  }),
}));

mock.module("@tanstack/react-query", () => ({
  ...realRQ,
  useQuery: () => latestMessageQuery,
}));

mock.module("@/lib/logs/useResolvedAssistantId.js", () => ({
  useResolvedAssistantId: () => assistantStub,
}));

mock.module("@/components/app/pages/Layout/index.js", () => ({
  Layout: ({ children }: { children: React.ReactNode }) => <>{children}</>,
}));

mock.module(
  "@/components/app/assistant/message-inspector/message-inspector-view.js",
  () => ({
    MessageInspectorView: ({
      conversationKey,
      messageId,
    }: {
      conversationKey: string;
      messageId: string;
    }) => {
      inspectorViewCalls.push({ conversationKey, messageId });
      return (
        <div data-testid="inspector">
          inspector:{conversationKey}:{messageId}
        </div>
      );
    },
  }),
);

// fetchConversationMessages is invoked from a useQuery queryFn — the mocked
// useQuery never fires it, but mock the module anyway so the static import
// chain stays valid.
mock.module("@/domains/chat/lib/api", () => ({
  fetchConversationMessages: async () => [],
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import InspectPage from "@/domains/inspect/page.js";

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  searchParamsMap = new Map();
  assistantStub = { assistantId: "asst-1", isLoading: false };
  latestMessageQuery = { data: undefined, isLoading: true, isError: false };
  inspectorViewCalls.length = 0;
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InspectPage — query string handling", () => {
  test("renders the missing-conversationKey state when no params are present", () => {
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("Missing inspector parameters");
    expect(html).toContain("requires a <code>conversationKey</code>");
    expect(inspectorViewCalls).toHaveLength(0);
  });

  test("renders MessageInspectorView directly when both params are provided", () => {
    searchParamsMap.set("conversationKey", "conv-abc");
    searchParamsMap.set("messageId", "msg-xyz");
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("inspector:conv-abc:msg-xyz");
    expect(inspectorViewCalls).toEqual([
      { conversationKey: "conv-abc", messageId: "msg-xyz" },
    ]);
  });
});

describe("InspectPage — conversationKey-only resolver", () => {
  test("shows loading copy while messages are being fetched", () => {
    searchParamsMap.set("conversationKey", "conv-1");
    latestMessageQuery = { data: undefined, isLoading: true, isError: false };
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("Loading…");
    expect(inspectorViewCalls).toHaveLength(0);
  });

  test("shows loading copy while assistant id is still resolving", () => {
    searchParamsMap.set("conversationKey", "conv-1");
    assistantStub = { assistantId: undefined, isLoading: true };
    latestMessageQuery = { data: undefined, isLoading: false, isError: false };
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("Loading…");
    expect(inspectorViewCalls).toHaveLength(0);
  });

  test("renders MessageInspectorView with the resolved messageId", () => {
    searchParamsMap.set("conversationKey", "conv-1");
    latestMessageQuery = {
      data: "msg-resolved",
      isLoading: false,
      isError: false,
    };
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("inspector:conv-1:msg-resolved");
    expect(inspectorViewCalls).toEqual([
      { conversationKey: "conv-1", messageId: "msg-resolved" },
    ]);
  });

  test("shows the no-assistant-message state when resolution returns null", () => {
    searchParamsMap.set("conversationKey", "conv-empty");
    latestMessageQuery = { data: null, isLoading: false, isError: false };
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("Nothing to inspect yet");
    expect(html).toContain("at least one assistant turn");
    expect(inspectorViewCalls).toHaveLength(0);
  });

  test("shows the failure state when message fetch errors", () => {
    searchParamsMap.set("conversationKey", "conv-err");
    latestMessageQuery = { data: undefined, isLoading: false, isError: true };
    const html = renderToStaticMarkup(<InspectPage />);
    expect(html).toContain("Failed to load conversation messages");
    expect(inspectorViewCalls).toHaveLength(0);
  });
});
