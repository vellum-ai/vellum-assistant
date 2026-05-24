/**
 * Tests for the conversation LLM context inspector route.
 *
 * Strategy: bun:test runs without a DOM, so we render via
 * `renderToStaticMarkup` and mock the few module-level dependencies
 * that the page can't otherwise resolve in a node renderer (router,
 * auth store, the active-assistant context, the data hook). All
 * inspector subcomponents (CallRail, TabBar, OverviewTab, etc.) render
 * for real because `bun:test`'s `mock.module()` registers process-wide
 * and would pollute sibling test files if we replaced them here.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Mutable per-test stubs
// ---------------------------------------------------------------------------

let searchParamsMap = new Map<string, string>();

interface ContextStub {
  data:
    | {
        messageId?: string | null;
        conversationId: string | null;
        conversationKey: string | null;
        conversationKind: string;
        conversationTotalEstimatedCostUsd: number | null;
        logs: Array<{
          id: string;
          createdAt: number;
          requestPayload: null;
          responsePayload: null;
          provider?: string | null;
          summary?: unknown;
        }>;
        memoryRecall: null;
        memoryV2Activation: null;
      }
    | undefined;
  isLoading: boolean;
  isError: boolean;
  error: unknown;
  refetch: () => void;
}

let assistantStub: { assistantId: string | undefined } = {
  assistantId: "asst-1",
};

interface AuthUserStub {
  email: string | null;
  isStaff: boolean;
}

let authUserStub: AuthUserStub | null = {
  email: "dev@vellum.ai",
  isStaff: false,
};
let authLoadingStub = false;

let contextStub: ContextStub = {
  data: undefined,
  isLoading: true,
  isError: false,
  error: null,
  refetch: () => {},
};

interface MessageListEntry {
  id: string;
  daemonMessageId?: string;
  role: "user" | "assistant";
  content: string;
  timestamp: number;
}

let messageListStub: MessageListEntry[] = [];
const navigateCalls: string[] = [];

// ---------------------------------------------------------------------------
// Module mocks — kept to ONLY the modules this test owns. Do NOT mock
// `@/domains/chat/inspector/components/*` here: `bun:test`'s
// `mock.module()` registers globally and would override the real
// components in their own test files.
// ---------------------------------------------------------------------------

mock.module("react-router", () => ({
  useSearchParams: () => [
    {
      get: (key: string) => searchParamsMap.get(key) ?? null,
    } as unknown as URLSearchParams,
    () => {},
  ],
  useNavigate: () => (href: string) => {
    navigateCalls.push(href);
  },
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: ReactNode;
    [key: string]: unknown;
  }) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

mock.module("@/components/layout/active-assistant-gate.js", () => ({
  useActiveAssistantContext: () => assistantStub,
}));

mock.module("@/stores/auth-store.js", () => ({
  useAuthStore: {
    use: {
      user: () => authUserStub,
      isLoading: () => authLoadingStub,
    },
  },
}));

mock.module("@/domains/chat/inspector/inspector-api.js", () => ({
  useLlmContext: () => contextStub,
  useConversationMessageList: () => ({
    data: messageListStub,
    isLoading: false,
    isError: false,
  }),
}));

// ---------------------------------------------------------------------------
// Subject (imported AFTER mocks)
// ---------------------------------------------------------------------------

import { InspectPage } from "@/domains/chat/inspector/inspect-page.js";

function renderInspector(): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <InspectPage />
    </QueryClientProvider>,
  );
}

// ---------------------------------------------------------------------------
// Per-test reset
// ---------------------------------------------------------------------------

beforeEach(() => {
  searchParamsMap = new Map();
  assistantStub = { assistantId: "asst-1" };
  authUserStub = { email: "dev@vellum.ai", isStaff: false };
  authLoadingStub = false;
  contextStub = {
    data: undefined,
    isLoading: true,
    isError: false,
    error: null,
    refetch: () => {},
  };
  messageListStub = [];
  navigateCalls.length = 0;
});

function makeLog(id: string, createdAt: number) {
  return {
    id,
    createdAt,
    requestPayload: null,
    responsePayload: null,
    provider: "anthropic",
    summary: {
      provider: "anthropic",
      model: "claude-3",
      status: "ok",
    },
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("InspectPage — gating", () => {
  test("blocks non-internal users before resolving inspector params", () => {
    authUserStub = { email: "person@example.com", isStaff: false };
    searchParamsMap.set("conversationId", "conv-abc");

    const html = renderInspector();

    expect(html).toContain("Inspector is available to Vellum developers only");
    // header chrome shouldn't render
    expect(html).not.toContain("LLM Context Inspector");
  });

  test("allows staff users even without a vellum.ai email", () => {
    authUserStub = { email: "person@example.com", isStaff: true };
    searchParamsMap.set("conversationId", "conv-abc");
    contextStub = {
      data: {
        conversationId: "conv-int-1",
        conversationKey: "conv-abc",
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [makeLog("log-1", 1)],
        memoryRecall: null,
        memoryV2Activation: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = renderInspector();

    expect(html).not.toContain(
      "Inspector is available to Vellum developers only",
    );
    // Real CallRail emits one row per log — assert the page reached the
    // loaded state, not the empty/loading/error branches.
    expect(html).toContain("LLM Context Inspector");
    expect(html).toContain("1 LLM call");
  });

  test("renders the missing-conversationId state when no params are present", () => {
    const html = renderInspector();
    expect(html).toContain("Missing inspector parameters");
    expect(html).toContain("requires a <code>conversationId</code>");
  });
});

describe("InspectPage — data-loading branches", () => {
  test("shows loading copy while the inspector context is fetching", () => {
    searchParamsMap.set("conversationId", "conv-1");
    contextStub = {
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = renderInspector();
    expect(html).toContain("Loading…");
  });

  test("renders the empty state when the conversation has no LLM calls", () => {
    searchParamsMap.set("conversationId", "conv-empty");
    contextStub = {
      data: {
        conversationId: "conv-int-empty",
        conversationKey: "conv-empty",
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV2Activation: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = renderInspector();
    expect(html).toContain("No LLM calls recorded for this conversation");
  });

  test("renders the call-count chrome when calls are present", () => {
    searchParamsMap.set("conversationId", "conv-1");
    contextStub = {
      data: {
        conversationId: "conv-int-1",
        conversationKey: "conv-1",
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: 0.42,
        logs: [makeLog("log-1", 1), makeLog("log-2", 2)],
        memoryRecall: null,
        memoryV2Activation: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    const html = renderInspector();
    expect(html).toContain("LLM Context Inspector");
    expect(html).toContain("2 LLM calls");
    expect(html).not.toContain("No LLM calls recorded for this conversation");
    // Tab bar from the loaded path
    expect(html).toContain("Overview");
    expect(html).toContain("Prompt");
  });

  test("renders the error state when the context query errors out", () => {
    searchParamsMap.set("conversationId", "conv-err");
    contextStub = {
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      refetch: () => {},
    };
    const html = renderInspector();
    expect(html).toContain("Failed to load");
    expect(html).toContain("boom");
    expect(html).toContain("Retry");
  });
});

describe("InspectPage — dual-mode chrome", () => {
  test("conversation mode renders the conversation-wide subtitle and the filter dropdown", () => {
    searchParamsMap.set("conversationId", "conv-1");
    contextStub = {
      data: {
        conversationId: "conv-int-1",
        conversationKey: "conv-1",
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [makeLog("log-1", 1)],
        memoryRecall: null,
        memoryV2Activation: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };
    messageListStub = [
      {
        id: "msg-raw-1",
        daemonMessageId: "msg-d-1",
        role: "user",
        content: "Hello there, how is the inspector going?",
        timestamp: 1,
      },
      {
        id: "msg-2",
        role: "assistant",
        content: "Great — we're shipping dual-mode chrome right now.",
        timestamp: 2,
      },
    ];

    const html = renderInspector();

    expect(html).toContain(
      "Showing every LLM call recorded for this conversation",
    );
    // Filter dropdown is present with the "All messages" sentinel
    // and one entry per message in the list.
    expect(html).toContain("Filter to message:");
    expect(html).toContain("All messages");
    expect(html).toContain("1. User · Hello there, how is the inspector");
    expect(html).toContain(
      "2. Assistant · Great — we&#x27;re shipping dual-mode chrome right now.",
    );
    // The message-mode "View all calls" button must NOT appear here.
    expect(html).not.toContain("View all conversation calls");
  });

  test("message mode renders the scoped subtitle, short id, and the back-to-conversation button", () => {
    searchParamsMap.set("conversationId", "conv-1");
    searchParamsMap.set("messageId", "msg-abcdef-1234567890");
    contextStub = {
      data: {
        conversationId: "conv-int-1",
        conversationKey: "conv-1",
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [makeLog("log-1", 1)],
        memoryRecall: null,
        memoryV2Activation: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = renderInspector();

    expect(html).toContain("Scoped to one message");
    expect(html).toContain("msg-abcd"); // shortMessageId
    expect(html).toContain("View all conversation calls");
    // Conversation-mode dropdown should NOT be in message mode.
    expect(html).not.toContain("Filter to message:");
  });

  test("message mode empty state copy is message-specific", () => {
    searchParamsMap.set("conversationId", "conv-1");
    searchParamsMap.set("messageId", "msg-x");
    contextStub = {
      data: {
        messageId: "msg-x",
        conversationId: null,
        conversationKey: "conv-1",
        conversationKind: "user",
        conversationTotalEstimatedCostUsd: null,
        logs: [],
        memoryRecall: null,
        memoryV2Activation: null,
      },
      isLoading: false,
      isError: false,
      error: null,
      refetch: () => {},
    };

    const html = renderInspector();

    expect(html).toContain("No LLM calls recorded for this message");
    expect(html).not.toContain("No LLM calls recorded for this conversation");
  });
});
