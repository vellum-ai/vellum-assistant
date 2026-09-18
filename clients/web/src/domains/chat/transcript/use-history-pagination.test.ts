import { describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";
import { createElement, type PropsWithChildren } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import {
  activeModeSessionIdsForRefresh,
  aggregateBackgroundToolCompletions,
  aggregateModeSessionDescriptors,
  aggregateSubagentNotifications,
  conversationHistoryQueryKey,
  reconcileHistoryModeSessions,
  useHistoryPagination,
  type HistoryCache,
  modeSessionIdsForRefresh,
} from "@/domains/chat/transcript/use-history-pagination";
import type { ModeSessionDescriptor } from "@vellumai/assistant-api";
import type { RuntimeSubagentNotification } from "@/domains/chat/api/messages";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import type { PaginatedHistoryResult } from "@/domains/chat/transcript/types";

function notif(
  subagentId: string,
  status: string,
): RuntimeSubagentNotification {
  return {
    subagentId,
    label: subagentId,
    status,
  } as RuntimeSubagentNotification;
}

function completion(id: string): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId: "conv-1",
    command: `echo ${id}`,
    startedAt: 0,
    status: "completed",
  };
}

function page(
  subagentNotifications?: RuntimeSubagentNotification[],
  backgroundToolCompletions?: BackgroundTaskEntry[],
  modeSessions?: ModeSessionDescriptor[],
  messages: PaginatedHistoryResult["messages"] = [],
): PaginatedHistoryResult {
  return {
    messages,
    hasMore: false,
    oldestTimestamp: null,
    oldestMessageId: null,
    ...(subagentNotifications ? { subagentNotifications } : {}),
    ...(backgroundToolCompletions ? { backgroundToolCompletions } : {}),
    ...(modeSessions ? { modeSessions } : {}),
  };
}

function descriptor(
  id: string,
  revision: number,
  status: "active" | "completed" = "active",
): ModeSessionDescriptor {
  const base = {
    id,
    conversationId: "conv-1",
    mode: "computer_use" as const,
    sourceStartedAt: 1,
    firstIncludedAt: 1,
    firstIncludedMessageId: "message-1",
    lastActivityAt: 2,
    lastOwnedMessageId: "message-1",
    revision,
  };
  return status === "active"
    ? { summary: { ...base, status, endedAt: null, endReason: null } }
    : {
        summary: {
          ...base,
          status,
          endedAt: 2,
          endReason: "completed",
        },
      };
}

describe("aggregateSubagentNotifications", () => {
  test("returns undefined for no pages", () => {
    expect(aggregateSubagentNotifications(undefined)).toBeUndefined();
    expect(aggregateSubagentNotifications([])).toBeUndefined();
  });

  test("returns undefined when no page carries notifications", () => {
    expect(aggregateSubagentNotifications([page(), page()])).toBeUndefined();
  });

  test("returns a single page's notifications", () => {
    const result = aggregateSubagentNotifications([
      page([notif("a", "completed")]),
    ]);
    expect(result?.map((n) => n.subagentId)).toEqual(["a"]);
  });

  test("includes notifications from OLDER pages, oldest-first (regression: aborted-early subagent)", () => {
    // pages[0] = latest page, pages[1] = older. The aborted subagent's
    // notification lives only in the older page; it must still be aggregated.
    const pages = [
      page([notif("completed-late", "completed")]),
      page([notif("aborted-early", "aborted")]),
    ];
    const result = aggregateSubagentNotifications(pages);
    expect(result?.map((n) => n.subagentId)).toEqual([
      "aborted-early",
      "completed-late",
    ]);
  });
});

describe("aggregateBackgroundToolCompletions", () => {
  test("returns undefined for no pages", () => {
    expect(aggregateBackgroundToolCompletions(undefined)).toBeUndefined();
    expect(aggregateBackgroundToolCompletions([])).toBeUndefined();
  });

  test("returns undefined when no page carries completions", () => {
    expect(
      aggregateBackgroundToolCompletions([page(), page()]),
    ).toBeUndefined();
  });

  test("returns a single page's completions", () => {
    const result = aggregateBackgroundToolCompletions([
      page(undefined, [completion("bg-a")]),
    ]);
    expect(result?.map((c) => c.id)).toEqual(["bg-a"]);
  });

  test("concatenates completions from multiple pages, oldest-first", () => {
    // pages[0] = latest page, pages[1] = older. Completions from the older
    // page must come first so first-seen order is preserved for seeding.
    const pages = [
      page(undefined, [completion("bg-late"), completion("bg-latest")]),
      page(undefined, [completion("bg-early")]),
    ];
    const result = aggregateBackgroundToolCompletions(pages);
    expect(result?.map((c) => c.id)).toEqual([
      "bg-early",
      "bg-late",
      "bg-latest",
    ]);
  });
});

describe("mode session descriptor aggregation", () => {
  test("keeps an empty result while history pages are loading", () => {
    expect(aggregateModeSessionDescriptors(undefined)).toEqual([]);
    expect(aggregateModeSessionDescriptors([])).toEqual([]);
  });

  test("keeps the newest revision while preserving independent page content", () => {
    const result = aggregateModeSessionDescriptors([
      page(undefined, undefined, [descriptor("session-a", 2)]),
      page(undefined, undefined, [
        descriptor("session-a", 1),
        descriptor("session-b", 1, "completed"),
      ]),
    ]);
    expect(result.map(({ summary }) => [summary.id, summary.revision])).toEqual(
      [
        ["session-a", 2],
        ["session-b", 1],
      ],
    );
  });

  test("cache reconciliation retains newer revisions and accepts independent content", () => {
    const accepted = descriptor("session-a", 3, "completed");
    const previous: HistoryCache = {
      pages: [page(undefined, undefined, [accepted])],
      pageParams: [null],
    };
    const message = {
      id: "reply-2",
      role: "assistant" as const,
      content: "New reply",
      modeSession: { id: "session-a", mode: "computer_use" as const },
    };
    const incoming: HistoryCache = {
      pages: [
        page(
          undefined,
          undefined,
          [descriptor("session-a", 1), descriptor("session-b", 1)],
          [message],
        ),
      ],
      pageParams: [null],
    };
    const result = reconcileHistoryModeSessions(previous, incoming);

    expect(result.pages[0]?.modeSessions?.[0]).toBe(accepted);
    expect(result.pages[0]?.modeSessions?.[1]?.summary.id).toBe("session-b");
    expect(result.pages[0]?.messages).toEqual([message]);
    expect(reconcileHistoryModeSessions(result, structuredClone(result))).toBe(
      result,
    );
  });

  test("authoritative omission removes unavailable descriptors without removing message stamps", () => {
    const previous: HistoryCache = {
      pages: [page(undefined, undefined, [descriptor("session-a", 3)])],
      pageParams: [null],
    };
    const message = {
      id: "reply-1",
      role: "assistant" as const,
      modeSession: { id: "session-a", mode: "computer_use" as const },
    };
    const incoming: HistoryCache = {
      pages: [page(undefined, undefined, [], [message])],
      pageParams: [null],
    };
    const result = reconcileHistoryModeSessions(previous, incoming);

    expect(aggregateModeSessionDescriptors(result.pages)).toEqual([]);
    expect(result.pages[0]?.messages[0]?.modeSession).toEqual(
      message.modeSession,
    );
  });

  test("cache ownership survives remount, stale pages, and flag-off rendering", async () => {
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false, gcTime: Infinity } },
    });
    const queryKey = conversationHistoryQueryKey("assistant-1", "conv-1");
    const accepted = descriptor("session-a", 3, "completed");
    queryClient.setQueryData<HistoryCache>(queryKey, {
      pages: [page(undefined, undefined, [accepted])],
      pageParams: [null],
    });
    const wrapper = ({ children }: PropsWithChildren) =>
      createElement(QueryClientProvider, { client: queryClient }, children);
    const mount = (sessionGroupsEnabled: boolean) =>
      renderHook(
        ({ conversationId }) =>
          useHistoryPagination({
            assistantId: "assistant-1",
            conversationId,
            enabled: false,
            sessionGroupsEnabled,
          }),
        { wrapper, initialProps: { conversationId: "conv-1" } },
      );
    const first = mount(true);
    expect(first.result.current.modeSessions?.[0]).toBe(accepted);
    first.unmount();

    const second = mount(true);
    await act(async () => {
      queryClient.setQueryData<HistoryCache>(queryKey, {
        pages: [
          page(undefined, undefined, [descriptor("session-a", 1)]),
          page(undefined, undefined, [descriptor("session-b", 1)]),
        ],
        pageParams: [null, 1],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(second.result.current.modeSessions?.[0]).toBe(accepted);
    expect(second.result.current.modeSessions?.[1]?.summary.id).toBe(
      "session-b",
    );
    expect(
      queryClient.getQueryData<HistoryCache>(queryKey)?.pages[0]
        ?.modeSessions?.[0],
    ).toBe(accepted);
    second.unmount();

    const disabled = mount(false);
    expect(disabled.result.current.modeSessions).toBeUndefined();
    await act(async () => {
      queryClient.setQueryData<HistoryCache>(queryKey, {
        pages: [page(undefined, undefined, [descriptor("session-a", 1)])],
        pageParams: [null],
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(disabled.result.current.modeSessions).toBeUndefined();
    disabled.unmount();
    const third = mount(true);
    expect(third.result.current.modeSessions?.[0]).toBe(accepted);
    third.rerender({ conversationId: "conv-2" });
    expect(third.result.current.modeSessions).toEqual([]);
    third.rerender({ conversationId: "conv-1" });
    expect(third.result.current.modeSessions?.[0]).toBe(accepted);
    third.unmount();
    queryClient.clear();
  });

  test("refreshes only bounded active ids from all loaded pages", () => {
    expect(
      activeModeSessionIdsForRefresh([
        page(undefined, undefined, [descriptor("session-new", 1)]),
        page(undefined, undefined, [
          descriptor("session-old", 1),
          descriptor("session-done", 1, "completed"),
        ]),
      ]),
    ).toEqual(["session-new", "session-old"]);
  });

  test("omits active session refresh ids while the feature is disabled", () => {
    const pages = [
      page(undefined, undefined, [descriptor("session-active", 1)]),
    ];

    expect(modeSessionIdsForRefresh(pages, false)).toEqual([]);
    expect(modeSessionIdsForRefresh(pages, true)).toEqual(["session-active"]);
  });
});
