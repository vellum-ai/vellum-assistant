import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { BackgroundTaskEntry } from "@/domains/chat/background-task-store";
import { useBackgroundTaskStore } from "@/domains/chat/background-task-store";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";

// ---------------------------------------------------------------------------
// Module mocks.
//
// `use-history-pagination` is stubbed so the test drives the post-load
// (data-apply) effect directly: `isSuccess: true` + a non-zero `dataUpdatedAt`
// runs it once, and `backgroundToolCompletions` carries the persisted-history
// payload under test. The interactions API is stubbed to `{}` so the effect's
// async pending-interaction restore makes no network call and stays a no-op —
// the synchronous background-task seed is all this test asserts on.
// ---------------------------------------------------------------------------
const realPaginationModule = await import(
  "@/domains/chat/transcript/use-history-pagination"
);

let currentCompletions: BackgroundTaskEntry[] | undefined;

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: undefined,
    subagentNotifications: undefined,
    backgroundToolCompletions: currentCompletions,
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
    dataUpdatedAt: 1,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
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

function terminalEntry(id: string): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId: "conv-A",
    command: "echo hi",
    startedAt: 1,
    status: "completed",
    exitCode: 0,
    output: "hi",
    completedAt: 2,
  };
}

function runningEntry(id: string): BackgroundTaskEntry {
  return {
    id,
    toolName: "bash",
    conversationId: "conv-A",
    command: "sleep 99",
    startedAt: 1,
    status: "running",
  };
}

beforeEach(() => {
  currentCompletions = undefined;
  useBackgroundTaskStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useBackgroundTaskStore.getState().reset();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
});

describe("useConversationHistory — seed background tasks from history", () => {
  test("seeds a terminal card from persisted history", () => {
    /**
     * The daemon's in-memory completed ring is gone after a restart, so a
     * completed bash card must be reconstructed from the durable history
     * aggregate on conversation load.
     */
    // GIVEN history carries one terminal background-task completion
    currentCompletions = [terminalEntry("bg-done")];

    // WHEN the conversation loads
    renderHistory();

    // THEN the store holds a terminal entry keyed by that bg id
    const entry = useBackgroundTaskStore.getState().byId["bg-done"];
    expect(entry?.status).toBe("completed");
    expect(useBackgroundTaskStore.getState().orderedIds).toContain("bg-done");
  });

  test("upgrades a live running entry to terminal without duplicating it", () => {
    /**
     * A live `running` entry and its persisted terminal share the same bg id;
     * the idempotent terminal-wins merge must fold the history metadata in
     * rather than appending a second row.
     */
    // GIVEN a live running task is already in the store for the same id
    useBackgroundTaskStore.setState({
      byId: { "bg-done": runningEntry("bg-done") },
      orderedIds: ["bg-done"],
    });
    // AND history carries the terminal completion for that id
    currentCompletions = [terminalEntry("bg-done")];

    // WHEN the conversation loads
    renderHistory();

    // THEN the entry is upgraded in place (terminal status + filled metadata)
    const entry = useBackgroundTaskStore.getState().byId["bg-done"];
    expect(entry?.status).toBe("completed");
    expect(entry?.exitCode).toBe(0);
    expect(entry?.completedAt).toBe(2);
    // AND it is not duplicated in the order list
    expect(useBackgroundTaskStore.getState().orderedIds).toEqual(["bg-done"]);
  });

  test("leaves a live running entry absent from history untouched", () => {
    /**
     * Seeding must not retire or regress a still-running task that history
     * doesn't mention — `retireMissing` stays owned by the live rehydration
     * hook, which skips terminal entries.
     */
    // GIVEN a live running task with no matching history completion
    useBackgroundTaskStore.setState({
      byId: { "bg-live": runningEntry("bg-live") },
      orderedIds: ["bg-live"],
    });
    // AND history carries a terminal completion for a different id
    currentCompletions = [terminalEntry("bg-done")];

    // WHEN the conversation loads
    renderHistory();

    // THEN the unrelated running task is left running
    expect(useBackgroundTaskStore.getState().byId["bg-live"]?.status).toBe(
      "running",
    );
    // AND the history completion is still seeded alongside it
    expect(useBackgroundTaskStore.getState().byId["bg-done"]?.status).toBe(
      "completed",
    );
  });
});
