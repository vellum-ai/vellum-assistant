import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import type { AttachmentHistoryContent } from "@/domains/chat/api/history";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let lastAttachmentContent: AttachmentHistoryContent | undefined;

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: undefined,
    subagentNotifications: undefined,
    backgroundToolCompletions: undefined,
    isLoading: true,
    isSuccess: false,
    isError: false,
    error: null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: true,
    fetchOlderPage: () => {},
    invalidate: async () => {},
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt: 0,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: (params: {
    attachmentContent?: AttachmentHistoryContent;
  }) => {
    lastAttachmentContent = params.attachmentContent;
    return paginationStub();
  },
}));

mock.module("@/domains/chat/api/interactions", () => ({
  getPendingInteractions: async () => ({}),
}));

const { useConversationHistory } = await import(
  "@/domains/chat/hooks/use-conversation-history"
);

const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  lastAttachmentContent = undefined;
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useConversationHistory attachment content compatibility", () => {
  test("switches from inline to metadata only when the transcript owner's version supports it", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.11", "asst-1");

    renderHook(
      () =>
        useConversationHistory({
          assistantId: "asst-1",
          assistantStateKind: "active",
          activeConversationId: "conv-1",
        }),
      { wrapper: Wrapper },
    );
    expect(lastAttachmentContent).toBe("inline");

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.12", "asst-1");
    });
    expect(lastAttachmentContent).toBe("metadata");

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.12", "asst-other");
    });
    expect(lastAttachmentContent).toBe("inline");
  });
});
