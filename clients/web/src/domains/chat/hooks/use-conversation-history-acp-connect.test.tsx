/**
 * Hook-level restore of the inline Connect Claude Code card from a committed
 * history snapshot.
 *
 * Ordinary missing-token markers wait for a connected-status check before the
 * interaction store is touched. `auth_required` raises without that check. A
 * superseded snapshot or a newer live prompt cannot be overwritten by an
 * older in-flight check.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useConversationStore } from "@/stores/conversation-store";
import {
  ACP_CLAUDE_AUTH_REQUIRED_CODE,
  ACP_CLAUDE_OAUTH_MISSING_CODE,
} from "@/domains/chat/utils/acp-connect";
import { clearUserScopedOverrides } from "@/utils/typed-storage";

const realPaginationModule =
  await import("@/domains/chat/transcript/use-history-pagination");
const realInteractionsModule = await import("@/domains/chat/api/interactions");

function messagesWithAcpMarker(
  errorCode: string,
  toolUseId = "toolu-acp-1",
): DisplayMessage[] {
  return [
    {
      id: "msg-1",
      role: "assistant",
      toolCalls: [
        {
          id: toolUseId,
          name: "acp_spawn",
          input: { agent: "claude" },
          isError: true,
          errorCode,
        },
      ],
    },
  ];
}

let currentMessages: DisplayMessage[] = [];
let dataUpdatedAt = 1;

function paginationStub(): HistoryPaginationResult {
  return {
    messages: currentMessages,
    latestPage: undefined,
    subagentNotifications: undefined,
    backgroundToolCompletions: undefined,
    isLoading: false,
    isSuccess: true,
    isError: false,
    error: null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: false,
    fetchOlderPage: () => {},
    invalidate: async () => {},
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

mock.module("@/domains/chat/api/interactions", () => ({
  ...realInteractionsModule,
  getPendingInteractions: async () => ({
    pendingSecret: null,
    pendingConfirmation: null,
    pendingQuestion: null,
  }),
}));

let connectedResult: boolean | "throw" = false;
let deferredConnect: Array<(value: boolean) => void> | null = null;
let connectCalls = 0;

mock.module("@/hooks/connect-claude-api", () => ({
  isClaudeConnected: async () => {
    connectCalls += 1;
    if (deferredConnect) {
      return new Promise<boolean>((resolve) => {
        deferredConnect?.push(resolve);
      });
    }
    if (connectedResult === "throw") {
      throw new Error("route unavailable");
    }
    return connectedResult;
  },
  startConnectClaude: async () => ({
    mode: "manual",
    authorize_url: "https://example.com/oauth",
    state: "state-1",
  }),
  pollConnectClaudeStatus: async () => ({ status: "pending" }),
  exchangeConnectClaude: async () => {},
}));

const { useConversationHistory } =
  await import("@/domains/chat/hooks/use-conversation-history");

let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderHistory() {
  return renderHook(
    () =>
      useConversationHistory({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId: "conv-A",
      }),
    { wrapper: Wrapper },
  );
}

function resetAcpStore() {
  useInteractionStore.getState().resetAll();
  useInteractionStore.setState({
    pendingAcpConnect: null,
    dismissedAcpConnectToolUseIds: new Set<string>(),
  });
}

beforeEach(() => {
  queryClient = new QueryClient();
  currentMessages = messagesWithAcpMarker(ACP_CLAUDE_OAUTH_MISSING_CODE);
  dataUpdatedAt = 1;
  connectedResult = false;
  deferredConnect = null;
  connectCalls = 0;
  useChatSessionStore.setState({
    previousAssistantId: null,
    previousConversationId: null,
    draftConversationIdResolution: false,
    confirmationToolCallMap: new Map(),
  });
  resetAcpStore();
  useConversationStore.setState({
    activeConversationId: "conv-A",
    attentionConversationIds: new Set<string>(),
  });
});

afterEach(() => {
  cleanup();
  resetAcpStore();
  localStorage.clear();
  clearUserScopedOverrides();
});

describe("ACP Connect restore on a committed snapshot", () => {
  test("does not raise a connected missing-token marker", async () => {
    connectedResult = true;

    renderHistory();

    await waitFor(() => {
      expect(connectCalls).toBeGreaterThan(0);
    });
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
    expect(
      useInteractionStore.getState().dismissedAcpConnectToolUseIds.size,
    ).toBe(0);
  });

  test("raises a disconnected missing-token marker", async () => {
    connectedResult = false;

    renderHistory();

    await waitFor(() => {
      expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
        toolUseId: "toolu-acp-1",
        conversationId: "conv-A",
      });
    });
  });

  test("raises auth_required without checking connected status", async () => {
    currentMessages = messagesWithAcpMarker(ACP_CLAUDE_AUTH_REQUIRED_CODE);

    renderHistory();

    await waitFor(() => {
      expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
        toolUseId: "toolu-acp-1",
        reason: "auth_required",
        conversationId: "conv-A",
      });
    });
    expect(connectCalls).toBe(0);
  });

  test("a superseded snapshot cannot raise after its check resolves", async () => {
    deferredConnect = [];
    const { rerender } = renderHistory();
    await waitFor(() => {
      expect(deferredConnect?.length).toBe(1);
    });

    currentMessages = [];
    dataUpdatedAt = 2;
    rerender();

    const queued = [...(deferredConnect ?? [])];
    for (const resolve of queued) {
      resolve(false);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useInteractionStore.getState().pendingAcpConnect).toBeNull();
  });

  test("an in-flight missing check does not overwrite a live prompt", async () => {
    deferredConnect = [];
    renderHistory();
    await waitFor(() => {
      expect(deferredConnect?.length).toBe(1);
    });

    useInteractionStore.getState().showAcpConnect({
      toolUseId: "toolu-live",
      reason: "auth_required",
      conversationId: "conv-A",
    });

    deferredConnect[0]?.(false);
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useInteractionStore.getState().pendingAcpConnect).toEqual({
      toolUseId: "toolu-live",
      reason: "auth_required",
      conversationId: "conv-A",
    });
  });
});
