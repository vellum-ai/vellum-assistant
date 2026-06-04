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
import { textBody } from "@/domains/chat/utils/message-test-helpers";

// ---------------------------------------------------------------------------
// Mutable per-test stubs
// ---------------------------------------------------------------------------

// `conversationId` now lives in the URL path, so it's surfaced via
// `useParams()` rather than `useSearchParams()`. `messageId` and `callId`
// stay in the query string.
let paramsStub: { conversationId?: string } = {};
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
let sessionInitializingStub = false;

let contextStub: ContextStub = {
  data: undefined,
  isLoading: true,
  isError: false,
  error: null,
  refetch: () => {},
};

interface MessageListEntry {
  id: string;
  role: "user" | "assistant";
  textSegments?: string[];
  contentOrder?: Array<{ type: string; id: string }>;
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
  useParams: () => paramsStub,
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

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => assistantStub.assistantId,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => authUserStub,
    },
  },
  useIsSessionInitializing: () => sessionInitializingStub,
}));

mock.module("@/domains/chat/inspector/inspector-api", () => ({
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

import { InspectPage } from "@/domains/chat/inspector/inspect-page";

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
  // Default to a valid path param so each test renders the gated/loaded
  // page without re-stating the obvious. Tests override when the id
  // matters for an assertion.
  paramsStub = { conversationId: "conv-default" };
  searchParamsMap = new Map();
  assistantStub = { assistantId: "asst-1" };
  authUserStub = { email: "dev@vellum.ai", isStaff: false };
  sessionInitializingStub = false;
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
    paramsStub = { conversationId: "conv-abc" };

    const html = renderInspector();

    expect(html).toContain("Inspector is available to Vellum developers only");
    // header chrome shouldn't render
    expect(html).not.toContain("LLM Context Inspector");
  });

  test("allows staff users even without a vellum.ai email", () => {
    authUserStub = { email: "person@example.com", isStaff: true };
    paramsStub = { conversationId: "conv-abc" };
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

  // (No "missing conversationId" branch — the dynamic segment is required
  // by the route, so the page is unreachable without one.)
});

describe("InspectPage — data-loading branches", () => {
  test("shows loading copy while the inspector context is fetching", () => {
    paramsStub = { conversationId: "conv-1" };
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
    paramsStub = { conversationId: "conv-empty" };
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
    paramsStub = { conversationId: "conv-1" };
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
    // The mobile call-selector trigger is mounted alongside the
    // desktop aside (CSS hides whichever doesn't match the viewport).
    // We rely on its trigger so phone users can pick a call when the
    // aside is collapsed; the label shape is `Call N of M`.
    expect(html).toContain("Call 2 of 2");
    expect(html).toContain('aria-label="Select an LLM call to inspect"');
  });

  test("renders the error state when the context query errors out", () => {
    paramsStub = { conversationId: "conv-err" };
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
    paramsStub = { conversationId: "conv-1" };
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
        role: "user",
        ...textBody("Hello there, how is the inspector going?"),
        timestamp: 1,
      },
      {
        id: "msg-2",
        role: "assistant",
        ...textBody("Great — we're shipping dual-mode chrome right now."),
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
    paramsStub = { conversationId: "conv-1" };
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
    paramsStub = { conversationId: "conv-1" };
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
