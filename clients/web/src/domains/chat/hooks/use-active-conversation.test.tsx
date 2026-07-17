/**
 * `useActiveConversation` resolves the open conversation's metadata row from
 * either list cache, and fetches the single row on demand when an open
 * background/scheduled thread is in neither — without loading the whole
 * background backlog.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { Conversation } from "@/types/conversation-types";

let foregroundImpl: Conversation[] = [];
let backgroundImpl: Conversation[] = [];
let scheduledImpl: Conversation[] = [];
let archivedImpl: Conversation[] = [];
let isOrgReadyImpl = true;
const refreshConversationRowCalls: Array<{
  assistantId: string | null;
  conversationId: string;
}> = [];

mock.module("@/hooks/conversation-queries", () => ({
  useConversationListQuery: () => ({ conversations: foregroundImpl }),
  useBackgroundConversationListQuery: () => ({ conversations: backgroundImpl }),
  useScheduledConversationListQuery: () => ({ conversations: scheduledImpl }),
  useArchivedConversationListQuery: () => ({ conversations: archivedImpl }),
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => isOrgReadyImpl,
}));

mock.module("@/utils/conversation-cache-mutations", () => ({
  refreshConversationRow: async (
    _queryClient: unknown,
    assistantId: string | null,
    conversationId: string,
  ) => {
    refreshConversationRowCalls.push({ assistantId, conversationId });
  },
  markConversationSeenLocal: () => {},
  prependConversation: () => {},
  removeConversation: () => {},
  resolveDraftKey: () => {},
}));

const { useActiveConversation } = await import(
  "@/domains/chat/hooks/use-active-conversation"
);

function makeConversation(conversationId: string): Conversation {
  return { conversationId } as Conversation;
}

function wrapper({ children }: { children: ReactNode }) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  foregroundImpl = [];
  backgroundImpl = [];
  scheduledImpl = [];
  isOrgReadyImpl = true;
  refreshConversationRowCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("useActiveConversation", () => {
  test("returns the foreground row without fetching", () => {
    // GIVEN the active conversation is already in the foreground list
    foregroundImpl = [makeConversation("fg-1")];

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation("asst-1", "fg-1", true),
      { wrapper },
    );

    // THEN it returns the foreground row and never fetches a single row
    expect(result.current?.conversationId).toBe("fg-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns a background-cache row without fetching", () => {
    // GIVEN the active conversation is only in the background cache
    backgroundImpl = [makeConversation("bg-1")];

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation("asst-1", "bg-1", true),
      { wrapper },
    );

    // THEN it returns the background row and never fetches a single row
    expect(result.current?.conversationId).toBe("bg-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns a scheduled-cache row without fetching", () => {
    // GIVEN the active conversation is only in the scheduled cache
    scheduledImpl = [makeConversation("sch-1")];

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation("asst-1", "sch-1", true),
      { wrapper },
    );

    // THEN it returns the scheduled row and never fetches a single row
    expect(result.current?.conversationId).toBe("sch-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns an archived-cache row without fetching", () => {
    // GIVEN the active conversation is only in the archived cache
    archivedImpl = [makeConversation("arc-1")];

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation("asst-1", "arc-1", true),
      { wrapper },
    );

    // THEN it returns the archived row and never fetches a single row
    expect(result.current?.conversationId).toBe("arc-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("fetches the single row when the active thread is in neither list", async () => {
    // GIVEN neither list holds the open background/scheduled thread
    foregroundImpl = [makeConversation("fg-1")];
    backgroundImpl = [];

    // WHEN the hook resolves an active conversation absent from both lists
    const { result } = renderHook(
      () => useActiveConversation("asst-1", "bg-unloaded", true),
      { wrapper },
    );

    // THEN it has no row yet and fetches exactly that one row
    expect(result.current).toBeUndefined();
    await waitFor(() => {
      expect(refreshConversationRowCalls).toEqual([
        { assistantId: "asst-1", conversationId: "bg-unloaded" },
      ]);
    });
  });

  test("does not fetch when disabled", async () => {
    // GIVEN the active thread is in neither list AND the hook is disabled
    foregroundImpl = [];
    backgroundImpl = [];

    // WHEN the hook runs with `enabled: false`
    renderHook(() => useActiveConversation("asst-1", "bg-unloaded", false), {
      wrapper,
    });

    // THEN no single-row fetch is issued
    await Promise.resolve();
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("does not fetch when org is not ready", async () => {
    // GIVEN the org store has not hydrated yet
    isOrgReadyImpl = false;
    foregroundImpl = [];
    backgroundImpl = [];

    // WHEN the hook runs with org not ready
    renderHook(
      () => useActiveConversation("asst-1", "bg-unloaded", true),
      { wrapper },
    );

    // THEN no fetch is issued (prevents 400 org-header errors)
    await Promise.resolve();
    expect(refreshConversationRowCalls).toHaveLength(0);
  });
});
