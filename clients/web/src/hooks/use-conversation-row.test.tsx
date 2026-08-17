/**
 * `useConversationRow` follows one conversation by id across every list
 * cache under the `conversation-list` prefix. Two properties are what it
 * exists for, and both are pinned here at the render level: it sees the row
 * wherever it lives (and keeps seeing it as it moves), and a write to some
 * other row leaves the returned reference alone, so consumers of the active
 * row are not re-rendered by unrelated sidebar traffic.
 */

import { describe, expect, it } from "bun:test";
import { createElement, type ReactNode } from "react";

import { act, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import { useConversationRow } from "@/hooks/conversation-queries";
import type { Conversation } from "@/types/conversation-types";
import { patchConversation } from "@/utils/conversation-cache";
import {
  conversationsQueryKey,
  sectionConversationsQueryKey,
} from "@/utils/conversation-list-fetchers";
import { listPage } from "@/utils/conversation-list.test-helper";

const ASSISTANT_ID = "asst-1";

function row(conversationId: string, title = conversationId): Conversation {
  return { conversationId, title, createdAt: 1, lastMessageAt: 1 };
}

function setup() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return { queryClient, wrapper };
}

describe("useConversationRow", () => {
  it("returns undefined when no cache holds the row, then the row once one does", () => {
    const { queryClient, wrapper } = setup();
    const { result } = renderHook(
      () => useConversationRow(ASSISTANT_ID, "c1"),
      { wrapper },
    );
    expect(result.current).toBeUndefined();

    act(() => {
      queryClient.setQueryData(
        conversationsQueryKey(ASSISTANT_ID),
        listPage([row("c1", "found")]),
      );
    });
    expect(result.current?.title).toBe("found");
  });

  it("follows the row into a section cache, not only the foreground list", () => {
    /* The row's home moves as it is pinned or filed. A subscription pinned
       to the foreground list would lose it the moment it lived only in a
       section window; this one is keyed by prefix, so it does not. */
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(
      sectionConversationsQueryKey(ASSISTANT_ID, { groupId: "system:pinned" }),
      listPage([row("c1", "pinned-row")], true),
    );
    const { result } = renderHook(
      () => useConversationRow(ASSISTANT_ID, "c1"),
      { wrapper },
    );
    expect(result.current?.title).toBe("pinned-row");
  });

  it("re-renders with the patched row when that row changes", () => {
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(
      conversationsQueryKey(ASSISTANT_ID),
      listPage([row("c1", "before")]),
    );
    const { result } = renderHook(
      () => useConversationRow(ASSISTANT_ID, "c1"),
      { wrapper },
    );
    expect(result.current?.title).toBe("before");

    act(() => {
      patchConversation(queryClient, ASSISTANT_ID, "c1", { title: "after" });
    });
    expect(result.current?.title).toBe("after");
  });

  it("keeps the same reference when a different row is written", () => {
    /* The point of subscribing by id rather than to a whole list: a
       placement or seen-state write elsewhere in the sidebar must not
       re-render every consumer of the active row. patchConversation keeps
       untouched rows' identity, and useSyncExternalStore compares by it. */
    const { queryClient, wrapper } = setup();
    queryClient.setQueryData(
      conversationsQueryKey(ASSISTANT_ID),
      listPage([row("c1"), row("c2")]),
    );
    const { result } = renderHook(
      () => useConversationRow(ASSISTANT_ID, "c1"),
      { wrapper },
    );
    const before = result.current;
    expect(before).toBeDefined();

    act(() => {
      patchConversation(queryClient, ASSISTANT_ID, "c2", { title: "moved" });
    });
    expect(result.current).toBe(before);
  });

  it("returns undefined for a null id or assistant without subscribing", () => {
    const { wrapper } = setup();
    const { result: noId } = renderHook(
      () => useConversationRow(ASSISTANT_ID, null),
      { wrapper },
    );
    expect(noId.current).toBeUndefined();
    const { result: noAssistant } = renderHook(
      () => useConversationRow(null, "c1"),
      { wrapper },
    );
    expect(noAssistant.current).toBeUndefined();
  });
});
