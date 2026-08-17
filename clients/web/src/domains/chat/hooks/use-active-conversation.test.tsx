/**
 * `useActiveConversation` resolves the open conversation's metadata row from
 * whichever list cache holds it, and fetches the single row on demand when
 * no cache does, without loading any list onto the render path.
 *
 * The list caches are real here (a seeded QueryClient), not stubbed: the
 * property under test is that the row is found wherever it lives, which a
 * stub of the lookup could only assert about itself.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

import type { Conversation } from "@/types/conversation-types";
import {
  archivedConversationsQueryKey,
  backgroundConversationsQueryKey,
  conversationsQueryKey,
  scheduledConversationsQueryKey,
  sectionConversationsQueryKey,
} from "@/utils/conversation-list-fetchers";
import { listPage } from "@/utils/conversation-list.test-helper";

let isOrgReadyImpl = true;
const refreshConversationRowCalls: Array<{
  assistantId: string | null;
  conversationId: string;
}> = [];

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

const { useActiveConversation } =
  await import("@/domains/chat/hooks/use-active-conversation");

function makeConversation(conversationId: string): Conversation {
  return { conversationId } as Conversation;
}

const ASSISTANT_ID = "asst-1";
let client: QueryClient;

function seed(queryKey: readonly unknown[], rows: Conversation[]): void {
  client.setQueryData(queryKey, listPage(rows));
}

function wrapper({ children }: { children: ReactNode }) {
  return createElement(QueryClientProvider, { client }, children);
}

beforeEach(() => {
  client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  isOrgReadyImpl = true;
  refreshConversationRowCalls.length = 0;
});

afterEach(() => {
  cleanup();
});

describe("useActiveConversation", () => {
  test("returns the foreground row without fetching", () => {
    // GIVEN the active conversation is already in the foreground list
    seed(conversationsQueryKey(ASSISTANT_ID), [makeConversation("fg-1")]);

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation(ASSISTANT_ID, "fg-1", true),
      { wrapper },
    );

    // THEN it returns the foreground row and never fetches a single row
    expect(result.current?.conversationId).toBe("fg-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns a background-cache row without fetching", () => {
    // GIVEN the active conversation is only in the background cache
    seed(backgroundConversationsQueryKey(ASSISTANT_ID), [
      makeConversation("bg-1"),
    ]);

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation(ASSISTANT_ID, "bg-1", true),
      { wrapper },
    );

    // THEN it returns the background row and never fetches a single row
    expect(result.current?.conversationId).toBe("bg-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns a scheduled-cache row without fetching", () => {
    // GIVEN the active conversation is only in the scheduled cache
    seed(scheduledConversationsQueryKey(ASSISTANT_ID), [
      makeConversation("sch-1"),
    ]);

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation(ASSISTANT_ID, "sch-1", true),
      { wrapper },
    );

    // THEN it returns the scheduled row and never fetches a single row
    expect(result.current?.conversationId).toBe("sch-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns an archived-cache row without fetching", () => {
    // GIVEN the active conversation is only in the archived cache
    seed(archivedConversationsQueryKey(ASSISTANT_ID), [
      makeConversation("arc-1"),
    ]);

    // WHEN the hook resolves the active conversation
    const { result } = renderHook(
      () => useActiveConversation(ASSISTANT_ID, "arc-1", true),
      { wrapper },
    );

    // THEN it returns the archived row and never fetches a single row
    expect(result.current?.conversationId).toBe("arc-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("returns a row that lives only in a section cache without fetching", () => {
    // GIVEN the row is in a pinned-section window and no drained list. The
    // four-list scan this hook replaced could not see it and would have
    // fetched a row it already had.
    seed(
      sectionConversationsQueryKey(ASSISTANT_ID, { groupId: "system:pinned" }),
      [makeConversation("pin-1")],
    );

    const { result } = renderHook(
      () => useActiveConversation(ASSISTANT_ID, "pin-1", true),
      { wrapper },
    );

    expect(result.current?.conversationId).toBe("pin-1");
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("fetches the single row when the active thread is in no list", async () => {
    // GIVEN no list holds the open background/scheduled thread
    seed(conversationsQueryKey(ASSISTANT_ID), [makeConversation("fg-1")]);

    // WHEN the hook resolves an active conversation absent from both lists
    const { result } = renderHook(
      () => useActiveConversation(ASSISTANT_ID, "bg-unloaded", true),
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
    // GIVEN the active thread is in no list AND the hook is disabled

    // WHEN the hook runs with `enabled: false`
    renderHook(
      () => useActiveConversation(ASSISTANT_ID, "bg-unloaded", false),
      {
        wrapper,
      },
    );

    // THEN no single-row fetch is issued
    await Promise.resolve();
    expect(refreshConversationRowCalls).toHaveLength(0);
  });

  test("does not fetch when org is not ready", async () => {
    // GIVEN the org store has not hydrated yet
    isOrgReadyImpl = false;

    // WHEN the hook runs with org not ready
    renderHook(() => useActiveConversation(ASSISTANT_ID, "bg-unloaded", true), {
      wrapper,
    });

    // THEN no fetch is issued (prevents 400 org-header errors)
    await Promise.resolve();
    expect(refreshConversationRowCalls).toHaveLength(0);
  });
});
