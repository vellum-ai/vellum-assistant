/**
 * Tests for restoring (and retiring) the ask_question card on a committed
 * history snapshot.
 *
 * The snapshot the hook is handed here is the one TanStack serves from cache
 * when a conversation is reopened: it still carries the `pendingQuestion`
 * marker the daemon stamped while the prompt was live, because nothing removes
 * that marker from a cached page once the prompt resolves. What decides the
 * card is the pending-interactions read, which reports the registry as it is
 * now.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import type { DisplayMessage } from "@/domains/chat/types/types";
import { useInteractionStore } from "@/domains/chat/interaction-store";
import { useConversationStore } from "@/stores/conversation-store";
import type { QuestionEntry } from "@vellumai/assistant-api";

const realPaginationModule =
  await import("@/domains/chat/transcript/use-history-pagination");
const realInteractionsModule = await import("@/domains/chat/api/interactions");

const ENTRIES: QuestionEntry[] = [
  {
    id: "q1",
    question: "Which draft should I send?",
    options: [
      { id: "a", label: "The short one" },
      { id: "b", label: "The long one" },
    ],
  },
];

/** A committed page still carrying the marker for `req-1`. */
function messagesWithMarker(): DisplayMessage[] {
  return [
    {
      id: "msg-1",
      role: "assistant",
      toolCalls: [
        {
          id: "tool-1",
          name: "ask_question",
          input: {},
          pendingQuestion: { requestId: "req-1", entries: ENTRIES },
        },
      ],
    } satisfies DisplayMessage,
  ];
}

let currentMessages: DisplayMessage[] = [];

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
    dataUpdatedAt: 1,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

/**
 * What the daemon reports for the conversation. The three values are the three
 * cases under test: an outstanding prompt, a positive "nothing outstanding",
 * and an assistant too old to have an opinion.
 */
let reportedInteractions: Record<string, unknown> = {};
/** Held open by the in-flight test so a live event can land mid-read. */
let gate: Promise<void> | null = null;
let openGate: (() => void) | null = null;

mock.module("@/domains/chat/api/interactions", () => ({
  ...realInteractionsModule,
  getPendingInteractions: async () => {
    if (gate) {
      await gate;
    }
    return reportedInteractions;
  },
}));

const { useConversationHistory } =
  await import("@/domains/chat/hooks/use-conversation-history");

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={new QueryClient()}>
      {children}
    </QueryClientProvider>
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

beforeEach(() => {
  currentMessages = messagesWithMarker();
  reportedInteractions = {};
  gate = null;
  openGate = null;
  useInteractionStore.getState().resetAll();
  useConversationStore.setState({ activeConversationId: "conv-A" });
});

afterEach(() => {
  cleanup();
  useInteractionStore.getState().resetAll();
});

describe("ask_question restore on a committed snapshot", () => {
  test("does not raise a card for a prompt the registry has resolved", async () => {
    // GIVEN a cached page that still carries the marker for `req-1`, and a
    // daemon reporting that nothing is outstanding. This is the reported bug:
    // the user answered, switched chats, and came back.
    reportedInteractions = { pendingQuestion: null };

    // WHEN the snapshot commits
    renderHistory();

    // THEN no card is ever raised from the stale marker
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    });
    // Held across a few more ticks so a late raise would still be caught.
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
  });

  test("retires a card that is already on screen", async () => {
    // GIVEN a card raised earlier (a live `question_request` this session)
    // whose prompt has since been answered from another surface
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "req-1", entries: ENTRIES });
    reportedInteractions = { pendingQuestion: null };

    // WHEN the snapshot commits
    renderHistory();

    // THEN the card comes down instead of waiting for the user to answer it
    // into a 404
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    });
  });

  test("raises the card the registry reports as outstanding", async () => {
    // GIVEN a prompt genuinely awaiting an answer, whose `question_request`
    // this client never saw (broadcast while it was disconnected)
    reportedInteractions = {
      pendingQuestion: { requestId: "req-live", entries: ENTRIES },
    };

    // WHEN the snapshot commits
    renderHistory();

    // THEN the card is restored from the registry, not from the marker
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
        "req-live",
      );
    });
  });

  test("falls back to the history marker when the assistant has no opinion", async () => {
    // GIVEN an assistant that predates `pendingQuestion` on the response, so
    // the key is absent rather than null
    reportedInteractions = { pendingConfirmation: null, pendingSecret: null };

    // WHEN the snapshot commits
    renderHistory();

    // THEN the marker still restores the card, so older assistants keep the
    // recovery behavior they have today
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
        "req-1",
      );
    });
  });

  test("leaves a prompt that arrived while the read was in flight", async () => {
    // GIVEN a read that has not come back yet
    gate = new Promise<void>((resolve) => {
      openGate = resolve;
    });
    reportedInteractions = { pendingQuestion: null };
    renderHistory();

    // WHEN a live `question_request` raises a newer card mid-flight
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "req-newer", entries: ENTRIES });
    // AND the now-stale read resolves, reporting nothing outstanding
    openGate?.();

    // THEN the newer card survives: the response describes the registry as it
    // was before that prompt existed
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "req-newer",
    );
  });
});
