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
let lastEnabled: boolean | undefined;

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
    enabled: boolean;
  }) => {
    lastAttachmentContent = params.attachmentContent;
    lastEnabled = params.enabled;
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
  lastEnabled = undefined;
  useAssistantIdentityStore.getState().clearIdentity();
});

afterEach(() => {
  cleanup();
  queryClient.clear();
  useAssistantIdentityStore.getState().clearIdentity();
});

describe("useConversationHistory attachment content compatibility", () => {
  test("keeps pagination disabled while the requested assistant identity is pending", () => {
    renderHook(
      () =>
        useConversationHistory({
          assistantId: "asst-1",
          assistantStateKind: "active",
          activeConversationId: "conv-1",
        }),
      { wrapper: Wrapper },
    );

    expect(lastEnabled).toBe(false);
    expect(lastAttachmentContent).toBe("inline");
  });

  test("enables legacy inline history for a known old assistant", () => {
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
    expect(lastEnabled).toBe(true);
    expect(lastAttachmentContent).toBe("inline");
  });

  test("enables metadata history only for a supported owning assistant", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");

    renderHook(
      () =>
        useConversationHistory({
          assistantId: "asst-1",
          assistantStateKind: "active",
          activeConversationId: "conv-1",
        }),
      { wrapper: Wrapper },
    );
    expect(lastEnabled).toBe(true);
    expect(lastAttachmentContent).toBe("metadata");
  });

  test("returns to pending on assistant mismatch and resolves for the new owner", () => {
    useAssistantIdentityStore
      .getState()
      .setIdentity("assistant", "0.10.12", "asst-1");
    const { rerender } = renderHook(
      ({ assistantId }: { assistantId: string }) =>
        useConversationHistory({
          assistantId,
          assistantStateKind: "active",
          activeConversationId: "conv-1",
        }),
      { wrapper: Wrapper, initialProps: { assistantId: "asst-1" } },
    );
    expect(lastEnabled).toBe(true);
    expect(lastAttachmentContent).toBe("metadata");

    rerender({ assistantId: "asst-2" });
    expect(lastEnabled).toBe(false);
    expect(lastAttachmentContent).toBe("inline");

    act(() => {
      useAssistantIdentityStore
        .getState()
        .setIdentity("assistant", "0.10.11", "asst-2");
    });
    expect(lastEnabled).toBe(true);
    expect(lastAttachmentContent).toBe("inline");
  });
});
