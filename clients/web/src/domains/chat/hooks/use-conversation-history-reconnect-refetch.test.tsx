import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { act, cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";

import { organizationsBillingSummaryRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import { __resetForTesting, publish } from "@/lib/event-bus";
import type { HistoryPaginationResult } from "@/domains/chat/transcript/use-history-pagination";
import { useChatSessionStore } from "@/domains/chat/chat-session-store";
import { useTurnStore } from "@/domains/chat/turn-store";
import { useConversationStore } from "@/stores/conversation-store";

// ---------------------------------------------------------------------------
// Module mock — `@/domains/chat/transcript/use-history-pagination`.
//
// Stub the TanStack Query layer so the test exercises only the reconnect →
// refetch wiring. `invalidate` is the spy under test; `isSuccess: false`
// keeps the data-apply effect (and its downstream interaction/surface
// fetches) dormant.
// ---------------------------------------------------------------------------
const realPaginationModule =
  await import("@/domains/chat/transcript/use-history-pagination");

let invalidateSpy = mock(async () => {});

function paginationStub(): HistoryPaginationResult {
  return {
    messages: [],
    latestPage: undefined,
    subagentNotifications: undefined,
    backgroundToolCompletions: undefined,
    isLoading: false,
    isSuccess: false,
    isError: false,
    error: null,
    hasMore: false,
    isFetchingOlderPages: false,
    isFetching: false,
    fetchOlderPage: () => {},
    invalidate: invalidateSpy,
    removeCache: () => {},
    latestPageOldestTimestamp: null,
    oldestLoadedTimestamp: null,
    dataUpdatedAt: 0,
  };
}

mock.module("@/domains/chat/transcript/use-history-pagination", () => ({
  ...realPaginationModule,
  useHistoryPagination: () => paginationStub(),
}));

// Drives the platform gate on the turn-end billing-summary invalidation; the
// real gate reads auth/lifecycle/org stores that are out of scope here.
let billingSummaryEnabled = true;

mock.module("@/hooks/use-billing-balance-status", () => ({
  useBillingBalanceQueryEnabled: () => billingSummaryEnabled,
}));

const { useConversationHistory } =
  await import("@/domains/chat/hooks/use-conversation-history");

// The hook reads `useQueryClient()` (for surface cache writes and the
// turn-end history reseed), so it must render inside a provider.
const queryClient = new QueryClient();

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

function renderHistory(activeConversationId: string | null = "conv-A") {
  return renderHook(
    () =>
      useConversationHistory({
        assistantId: "asst-1",
        assistantStateKind: "active",
        activeConversationId,
      }),
    { wrapper: Wrapper },
  );
}

// Call-through spy on the shared client, recording billing-summary
// invalidations issued by the turn-end effect.
const invalidateQueriesSpy = spyOn(queryClient, "invalidateQueries");

/** Calls to the QueryClient's `invalidateQueries` for the billing summary. */
function billingInvalidations(): number {
  const billingKey = organizationsBillingSummaryRetrieveQueryKey();
  return invalidateQueriesSpy.mock.calls.filter(
    ([filters]) =>
      JSON.stringify(filters?.queryKey) === JSON.stringify(billingKey),
  ).length;
}

beforeEach(() => {
  __resetForTesting();
  invalidateSpy = mock(async () => {});
  billingSummaryEnabled = true;
  invalidateQueriesSpy.mockClear();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
  useChatSessionStore.setState({ snapshot: null, optimisticSends: [] });
  useConversationStore.getState().removeProcessingConversationId("conv-A");
  useConversationStore.getState().removeProcessingConversationId("conv-B");
  useTurnStore.setState({ phase: "idle" });
});

describe("useConversationHistory — refetch on SSE reopen", () => {
  test("refetches history when the connection reopens after a resume", () => {
    /**
     * A resume reopen (return-from-background) past the daemon's 30s replay
     * ring must refetch `/messages` so an idle conversation's persisted tail
     * appears without a manual refresh.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reopens its SSE connection with a resume cause
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });

    // THEN the history query is invalidated to pull the latest snapshot
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test.each([["error"], ["watchdog"], ["debug"]] as const)(
    "refetches history on a '%s' reconnect",
    (cause) => {
      /**
       * Every non-initial reopen is a catch-up opportunity: the connection
       * was previously established, so the snapshot may have advanced while
       * it was down.
       */
      // GIVEN an active conversation with a mounted history hook
      renderHistory("conv-A");

      // WHEN the bus reopens with a transport-recovery / debug cause
      publish("sse.opened", { assistantId: "asst-1", cause });

      // THEN the history query is invalidated
      expect(invalidateSpy).toHaveBeenCalledTimes(1);
    },
  );

  test("does not refetch on the first 'fresh' open", () => {
    /**
     * The initial connect's `refetchOnMount` already loaded the snapshot, so
     * a fresh open must not trigger a redundant second fetch.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reports the first fresh open
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });

    // THEN no extra history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not refetch on a cold-start 'anchor' reopen", () => {
    /**
     * The anchor bounce fires immediately after the fresh load with the ring
     * still warm, so the ring replay — not a refetch — is the catch-up.
     */
    // GIVEN an active conversation with a mounted history hook
    renderHistory("conv-A");

    // WHEN the bus reopens for the cold-start anchor replay
    publish("sse.opened", { assistantId: "asst-1", cause: "anchor" });

    // THEN no history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("ignores reopens for a different assistant", () => {
    /**
     * The bus is assistant-global; a reopen for another assistant must not
     * refetch the active assistant's conversation.
     */
    // GIVEN an active conversation for asst-1
    renderHistory("conv-A");

    // WHEN a reopen arrives for a different assistant
    publish("sse.opened", { assistantId: "asst-other", cause: "resume" });

    // THEN the active assistant's history is not refetched
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not refetch when there is no active conversation", () => {
    /**
     * With no conversation selected there is nothing to reconcile, so a
     * reopen must be a no-op.
     */
    // GIVEN no active conversation
    renderHistory(null);

    // WHEN the bus reopens after a resume
    publish("sse.opened", { assistantId: "asst-1", cause: "resume" });

    // THEN no history refetch is issued
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("reseeds history from the server on a passively-observed processing→idle edge", () => {
    /**
     * Channel turns (phone, Slack, Telegram) and other-client sends stream in
     * without a local `useSendMessage`, so `turnPhase` never enters a sending
     * state. They still toggle the conversation's processing flag, so on the
     * processing→idle edge the materialized snapshot must be reseeded from the
     * authoritative server copy — pulled by invalidating the history query. The
     * monotonic seq baseline makes the reseed a no-op when nothing new landed.
     */
    // GIVEN an active conversation marked processing (a server-driven turn
    // streaming in)
    renderHistory("conv-A");
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-A");
    });
    // No reseed while the turn is still in progress.
    expect(invalidateSpy).not.toHaveBeenCalled();

    // WHEN the turn finishes and the processing flag clears
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });

    // THEN the history query is invalidated so the snapshot reseeds, and the
    // billing summary is invalidated once so balance surfaces reflect the
    // turn's spend.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(billingInvalidations()).toBe(1);
  });

  test("invalidates the billing summary once per falling edge, not per turn tick", () => {
    /**
     * The billing refresh rides a falling edge over in-progress turns: one
     * invalidation per finished turn, none while the turn is streaming, and
     * no repeats until another turn completes.
     */
    // GIVEN two back-to-back turns on the active conversation
    renderHistory("conv-A");
    for (let turn = 0; turn < 2; turn++) {
      act(() => {
        useConversationStore.getState().markConversationProcessing("conv-A");
      });
      // No refresh while the turn is still in progress.
      expect(billingInvalidations()).toBe(turn);
      act(() => {
        useConversationStore
          .getState()
          .removeProcessingConversationId("conv-A");
      });
    }

    // THEN exactly one billing invalidation per completed turn
    expect(billingInvalidations()).toBe(2);
  });

  test("invalidates the billing summary when a background conversation's turn ends", () => {
    /**
     * A turn in another conversation (external channel, other client) spends
     * the same org-wide balance, so its end must refresh the billing summary
     * even though the active conversation's history is untouched.
     */
    // GIVEN conversation A open while a background turn streams in B
    renderHistory("conv-A");
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-B");
    });
    expect(billingInvalidations()).toBe(0);

    // WHEN the background turn finishes
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-B");
    });

    // THEN the billing summary refreshes but A's history is not reseeded
    expect(billingInvalidations()).toBe(1);
    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("invalidates per turn when overlapping turns end at different times", () => {
    /**
     * Each conversation leaving the processing set fires its own
     * invalidation. A background turn that exhausts the balance must refresh
     * it immediately even while another turn is still running; a turn parked
     * at a user prompt would otherwise defer the refresh indefinitely.
     */
    // GIVEN overlapping turns in A (active) and B (background)
    renderHistory("conv-A");
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-A");
      useConversationStore.getState().markConversationProcessing("conv-B");
    });

    // WHEN only the background turn ends
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-B");
    });
    // THEN its spend refreshes the balance while A still streams
    expect(billingInvalidations()).toBe(1);

    // WHEN the active turn ends too
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });
    // THEN the second turn fires its own invalidation
    expect(billingInvalidations()).toBe(2);
  });

  test("a local send tracked in the processing set invalidates exactly once", () => {
    /**
     * A `useSendMessage` turn raises both signals: `turnPhase` goes sending
     * and the server flags the conversation processing. The set departure
     * owns the invalidation; the send falling edge stays quiet so the turn
     * does not double-fire.
     */
    // GIVEN a local send whose conversation is also flagged processing
    renderHistory("conv-A");
    act(() => {
      useTurnStore.setState({ phase: "streaming" });
    });
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-A");
    });

    // WHEN the turn ends and both signals clear
    act(() => {
      useTurnStore.setState({ phase: "idle" });
    });
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });

    // THEN exactly one billing invalidation
    expect(billingInvalidations()).toBe(1);
  });

  test("a local send that is never flagged processing still invalidates on its falling edge", () => {
    /**
     * The send falling edge is the fallback for a turn whose processing flag
     * never arrives; without it that turn's spend would go unrefreshed.
     */
    // GIVEN a local send with no processing flag
    renderHistory("conv-A");
    act(() => {
      useTurnStore.setState({ phase: "streaming" });
    });

    // WHEN the send ends
    act(() => {
      useTurnStore.setState({ phase: "idle" });
    });

    // THEN the billing summary refreshes once
    expect(billingInvalidations()).toBe(1);
  });

  test("skips the billing invalidation when the billing query is gated off", () => {
    /**
     * Self-hosted / org-not-ready contexts never run the billing summary
     * query, so the turn-end edge must not invalidate (and thereby fetch) it.
     */
    // GIVEN a context where the billing summary query is disabled
    billingSummaryEnabled = false;
    renderHistory("conv-A");

    // WHEN a turn completes
    act(() => {
      useConversationStore.getState().markConversationProcessing("conv-A");
    });
    act(() => {
      useConversationStore.getState().removeProcessingConversationId("conv-A");
    });

    // THEN history still reseeds but the billing summary is left alone
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
    expect(billingInvalidations()).toBe(0);
  });
});
