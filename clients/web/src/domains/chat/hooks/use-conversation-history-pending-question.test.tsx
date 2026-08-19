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
/**
 * Bumped to commit a second snapshot. Mounting is not enough to test a retire:
 * the hook's first effect runs `switchToConversation`, which calls
 * `resetAll()` on the interaction store, so a card seeded before render is
 * wiped before the reconcile ever sees it. A card only coexists with a
 * committed snapshot the way it does in production: raised while the
 * conversation is already open, then a later snapshot commits.
 */
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

/**
 * What the daemon reports for the conversation. The three values are the three
 * cases under test: an outstanding prompt, a positive "nothing outstanding",
 * and an assistant too old to have an opinion.
 */
let reportedInteractions: Record<string, unknown> = {};
/** Held open by the in-flight test so a live event can land mid-read. */
let gate: Promise<void> | null = null;
let openGate: (() => void) | null = null;

/** When set, the read rejects instead of answering (a 5xx or a dropped network). */
let readFailure: Error | null = null;
/**
 * When set, each call parks and is answered by the test in whatever order it
 * chooses, so two reads can be in flight and land out of order.
 */
let deferredCalls: Array<(value: Record<string, unknown>) => void> | null =
  null;

mock.module("@/domains/chat/api/interactions", () => ({
  ...realInteractionsModule,
  getPendingInteractions: async () => {
    if (deferredCalls) {
      return new Promise((resolve) => {
        deferredCalls?.push(resolve as (v: Record<string, unknown>) => void);
      });
    }
    if (gate) {
      await gate;
    }
    if (readFailure) {
      throw readFailure;
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
  readFailure = null;
  deferredCalls = null;
  dataUpdatedAt = 1;
  useInteractionStore.getState().resetAll();
  useConversationStore.setState({
    activeConversationId: "conv-A",
    attentionConversationIds: new Set<string>(),
  });
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
    // GIVEN an open conversation whose first snapshot has already settled
    reportedInteractions = { pendingQuestion: null };
    const { rerender } = renderHistory();
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    });

    // AND a card raised live afterwards (a `question_request` this session),
    // whose prompt is then answered from another surface
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "req-live", entries: ENTRIES });
    expect(useInteractionStore.getState().pendingQuestion).not.toBeNull();

    // WHEN a later snapshot commits and the registry reports nothing
    dataUpdatedAt = 2;
    rerender();

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

  test("still restores from the marker when the read fails", async () => {
    // GIVEN a snapshot carrying a live prompt's marker and a registry read that
    // rejects (a transient 5xx, or the network dropping). `getPendingInteractions`
    // throws on both.
    readFailure = new Error("getPendingInteractions failed: 503");

    // WHEN the snapshot commits
    renderHistory();

    // THEN the card is still restored. A failed read carries no opinion, and on
    // an assistant that predates the field the marker is the only recovery path
    // there is, so swallowing it would hide a prompt the turn is blocked on.
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
        "req-1",
      );
    });
  });

  test("does not retire a card when the read fails", async () => {
    // GIVEN an open conversation carrying no marker, settled, with a card
    // raised live afterwards
    currentMessages = [];
    reportedInteractions = { pendingQuestion: null };
    const { rerender } = renderHistory();
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion).toBeNull();
    });
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "req-live", entries: ENTRIES });

    // WHEN a later snapshot commits but the registry read rejects
    readFailure = new Error("network down");
    dataUpdatedAt = 2;
    rerender();

    // THEN the card stays: only a read that actually answered may retire one
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(useInteractionStore.getState().pendingQuestion?.requestId).toBe(
      "req-live",
    );
  });

  test("keeps the conversation marked while a question is outstanding", async () => {
    // GIVEN a conversation carrying an attention key and a question the
    // registry still reports as awaiting an answer
    useConversationStore.getState().addAttentionConversationId("conv-A");
    reportedInteractions = {
      pendingSecret: null,
      pendingConfirmation: null,
      pendingQuestion: { requestId: "req-live", entries: ENTRIES },
    };

    // WHEN the snapshot commits
    renderHistory();

    // THEN the key survives. A question parks the turn on the user the same way
    // a secret or confirmation does, and the sweep that sets the key counts
    // questions, so clearing it here just made the badge flap.
    await waitFor(() => {
      expect(useInteractionStore.getState().pendingQuestion).not.toBeNull();
    });
    expect(
      useConversationStore.getState().attentionConversationIds.has("conv-A"),
    ).toBe(true);
  });

  test("releases the conversation once nothing is outstanding", async () => {
    // GIVEN an attention key and a registry reporting all three kinds clear
    useConversationStore.getState().addAttentionConversationId("conv-A");
    reportedInteractions = {
      pendingSecret: null,
      pendingConfirmation: null,
      pendingQuestion: null,
    };

    // WHEN the snapshot commits
    renderHistory();

    // THEN the key is released, so adding the question term did not strand it
    await waitFor(() => {
      expect(
        useConversationStore.getState().attentionConversationIds.has("conv-A"),
      ).toBe(false);
    });
  });

  test("ignores a read whose prompt arrived and settled while it was in flight", async () => {
    // GIVEN a reconcile whose read is still in flight, started while no card
    // was on screen
    currentMessages = [];
    deferredCalls = [];
    renderHistory();
    await waitFor(() => {
      expect(deferredCalls?.length).toBe(1);
    });

    // WHEN a prompt arrives and is then resolved inside that same window (the
    // live `question_request` followed by its `interaction_resolved`, or a fast
    // answer), returning the slot to the null it started from
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "req-fleeting", entries: ENTRIES });
    useInteractionStore.getState().dismissQuestionIfMatches("req-fleeting");
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();

    // AND the read lands, still carrying the prompt it saw mid-flight
    deferredCalls?.[0]?.({
      pendingQuestion: { requestId: "req-fleeting", entries: ENTRIES },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // THEN the settled prompt is not put back on screen. Comparing the card
    // rather than a revision cannot catch this: the slot ends on the same
    // `null` it began on, so the response looks like it landed on an untouched
    // store.
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
  });

  test("does not re-raise from the marker when the slot moved mid-read", async () => {
    // GIVEN a legacy assistant (no `pendingQuestion` key, so the marker is the
    // only source) and a snapshot still carrying the marker for `req-1`
    deferredCalls = [];
    renderHistory();
    await waitFor(() => {
      expect(deferredCalls?.length).toBe(1);
    });

    // WHEN that prompt arrives and settles while the read is in flight
    useInteractionStore
      .getState()
      .showQuestion({ requestId: "req-1", entries: ENTRIES });
    useInteractionStore.getState().dismissQuestionIfMatches("req-1");

    // AND the read lands with no opinion, sending the marker fallback down its
    // own branch
    deferredCalls?.[0]?.({ pendingConfirmation: null, pendingSecret: null });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // THEN the settled prompt is not restored from the marker either. The
    // ordering rule holds for every branch, not only the registry's answer.
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
  });

  test("ignores a read that a newer one has already overtaken", async () => {
    // GIVEN two reconciles whose reads are both in flight, which happens when
    // two snapshots commit close together (a turn-end reseed landing on top of
    // the processing revalidate).
    currentMessages = [];
    deferredCalls = [];
    const { rerender } = renderHistory();
    await waitFor(() => {
      expect(deferredCalls?.length).toBe(1);
    });
    dataUpdatedAt = 2;
    rerender();
    await waitFor(() => {
      expect(deferredCalls?.length).toBe(2);
    });

    // WHEN the newer read answers first, reporting the prompt as resolved
    deferredCalls?.[1]?.({ pendingQuestion: null });
    await new Promise((resolve) => setTimeout(resolve, 5));

    // AND the older read lands afterwards, still carrying the prompt it saw
    // before the answer
    deferredCalls?.[0]?.({
      pendingQuestion: { requestId: "req-answered", entries: ENTRIES },
    });
    await new Promise((resolve) => setTimeout(resolve, 10));

    // THEN the stale response raises nothing. Both reads captured the same
    // empty card state, so the identity guard alone would have let this one
    // through and put the answered prompt back on screen.
    expect(useInteractionStore.getState().pendingQuestion).toBeNull();
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
