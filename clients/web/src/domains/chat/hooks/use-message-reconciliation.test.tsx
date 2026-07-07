/**
 * `useMessageReconciliation` — the reconcile path adopts the daemon's
 * authoritative `processing` flag.
 *
 * The load-bearing behavior for the "stuck on thinking until refresh" bug: when
 * the reconcile fetch reports `processing: false` but the local rolling snapshot
 * still shows the turn processing, the reconcile must reseed the snapshot
 * (history invalidation) so the fresh `processing: false` reaches the
 * `snapshotProcessing` CLOSE-gate in `shouldShowThinkingIndicator`. Content diffs
 * are mocked out here so these tests isolate the processing-flag gate; the
 * content-diff detection and the close-gate itself are covered by
 * `reconcile-detection.test.ts` and `turn-selectors.test.ts`.
 */

import {
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  spyOn,
  test,
} from "bun:test";
import { cleanup, renderHook } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";

// Isolate the processing-flag gate: force "no new content" and "assistant
// produced output" so `changed`/`assistantProgress` never drive invalidation.
mock.module("@/domains/chat/utils/reconcile-detection", () => ({
  serverSnapshotHasNewContent: () => false,
  serverHasAssistantProgress: () => true,
}));

mock.module("@/domains/chat/utils/map-runtime-message", () => ({
  mapRuntimeToDisplayMessage: (m: unknown) => m,
}));

// Server fetch is driven per-test — spied (not module-mocked) so the rest of
// the messages module's exports stay real for other importers in the graph.
import * as messagesApi from "@/domains/chat/api/messages";
import * as eventsTailApi from "@/domains/chat/api/events-tail";
let fetchResult: unknown = undefined;
/** Ordered trace of the reconcile's async steps, for ordering assertions. */
const reconcileTrace: Array<{ step: string; args?: unknown[] }> = [];
const fetchSpy = spyOn(
  messagesApi,
  "fetchConversationMessages",
).mockImplementation(async () => fetchResult as never);
spyOn(eventsTailApi, "ingestServerEventsTail").mockImplementation(
  async (...args: unknown[]) => {
    reconcileTrace.push({ step: "ingest-tail", args });
  },
);

const { useMessageReconciliation } = await import(
  "@/domains/chat/hooks/use-message-reconciliation"
);
const { useStreamStore } = await import("@/domains/chat/stream-store");
const { useChatSessionStore } = await import(
  "@/domains/chat/chat-session-store"
);
const { useConversationStore } = await import("@/stores/conversation-store");
const { __resetLocalSeqForTesting } = await import("@/lib/streaming/local-seq");
const { useAssistantIdentityStore } = await import(
  "@/stores/assistant-identity-store"
);

// A daemon build at/above the events-tail floor, and one below it.
const TAIL_CAPABLE_VERSION = "0.10.8";
const SUB_FLOOR_VERSION = "0.10.6";

const ASSISTANT_ID = "asst-1";
const CONV_ID = "conv-A";

function seedSnapshotProcessing(processing: boolean | undefined): void {
  useChatSessionStore.setState({
    snapshot: {
      messages: [],
      seq: 10,
      processing,
      hasMore: false,
      oldestTimestamp: null,
      oldestMessageId: null,
      backgroundToolCompletions: [],
    },
  } as never);
}

function seedServerFetch(processing: boolean | undefined): void {
  fetchResult = {
    messages: [{ id: "a1", role: "assistant" }],
    seq: 11,
    processing,
  };
}

/** Render the hook against a spied query client; returns the invalidate spy. */
function renderReconciliation() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const invalidateSpy = mock(async () => {});
  client.invalidateQueries = invalidateSpy as never;

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  const { result } = renderHook(
    () => useMessageReconciliation({ latestPageOldestTimestamp: null }),
    { wrapper },
  );
  return { result, invalidateSpy };
}

beforeEach(() => {
  reconcileTrace.length = 0;
  __resetLocalSeqForTesting();
  useStreamStore.getState().setStreamContext({
    assistantId: ASSISTANT_ID,
    conversationId: CONV_ID,
  });
  useConversationStore.getState().setActiveConversationId(CONV_ID);
});

afterEach(() => {
  cleanup();
  useStreamStore.getState().setStreamContext(null);
  useConversationStore.getState().setActiveConversationId(null);
  useChatSessionStore.setState({ snapshot: null } as never);
  useAssistantIdentityStore.getState().setIdentity(null, null);
  fetchResult = undefined;
});

describe("useMessageReconciliation — server processing flag drives reseed", () => {
  test("reseeds when the server clears processing but the snapshot still shows it active", async () => {
    seedSnapshotProcessing(true);
    seedServerFetch(false);
    const { result, invalidateSpy } = renderReconciliation();

    const outcome = await result.current.reconcileActiveConversation();

    expect(outcome.changed).toBe(false);
    // No content diff, but the server's `processing: false` must still trigger
    // a reseed so the close-gate receives the fresh flag.
    expect(invalidateSpy).toHaveBeenCalledTimes(1);
  });

  test("does not reseed while the server is still processing and content matches", async () => {
    seedSnapshotProcessing(true);
    seedServerFetch(true);
    const { result, invalidateSpy } = renderReconciliation();

    await result.current.reconcileActiveConversation();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("does not reseed when the snapshot already reflects the idle turn", async () => {
    // Turn already idle locally — no stale spinner to clear, so no refetch.
    seedSnapshotProcessing(false);
    seedServerFetch(false);
    const { result, invalidateSpy } = renderReconciliation();

    await result.current.reconcileActiveConversation();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });

  test("older daemons without the processing field keep phase-only behavior", async () => {
    seedSnapshotProcessing(true);
    seedServerFetch(undefined);
    const { result, invalidateSpy } = renderReconciliation();

    await result.current.reconcileActiveConversation();

    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

describe("useMessageReconciliation — server event-tail catch-up", () => {
  test("pairs the snapshot with the tail from its anchor before reseeding", async () => {
    // GIVEN a reconcile that will reseed (server cleared processing)
    seedSnapshotProcessing(true);
    seedServerFetch(false);
    const { result, invalidateSpy } = renderReconciliation();
    invalidateSpy.mockImplementation(async () => {
      reconcileTrace.push({ step: "invalidate" });
    });

    // WHEN the active conversation reconciles
    await result.current.reconcileActiveConversation();

    // THEN the tail was fetched from the snapshot's anchor ...
    const ingest = reconcileTrace.find((t) => t.step === "ingest-tail");
    expect(ingest?.args).toEqual([ASSISTANT_ID, CONV_ID, 11]);
    // ... and ingested BEFORE the history invalidation, so the reseed
    // replay reads a primed event ring.
    expect(reconcileTrace.map((t) => t.step)).toEqual([
      "ingest-tail",
      "invalidate",
    ]);
  });
});

describe("startReconciliationLoop — single pass vs legacy poll loop", () => {
  test("tail-capable daemon: fires one immediate reconcile, no polling", async () => {
    // GIVEN a daemon at/above the events-tail floor
    useAssistantIdentityStore.getState().setIdentity("Ada", TAIL_CAPABLE_VERSION);
    seedSnapshotProcessing(true);
    seedServerFetch(false);
    const { result } = renderReconciliation();
    fetchSpy.mockClear();

    // WHEN the "loop" is started
    result.current.startReconciliationLoop(
      useStreamStore.getState().streamEpoch,
    );
    // Flush the microtasks of the single reconcile pass.
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // THEN exactly one reconcile fetch fired synchronously (no 5s timer),
    // and it paired the snapshot with the event tail — this is the loop's
    // retirement: a single tail-complete pass, no poll-until-stable.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(reconcileTrace.some((t) => t.step === "ingest-tail")).toBe(true);
  });

  test("sub-floor daemon: defers to the legacy poll loop (no immediate fetch)", async () => {
    // GIVEN a daemon below the events-tail floor
    useAssistantIdentityStore.getState().setIdentity("Ada", SUB_FLOOR_VERSION);
    seedSnapshotProcessing(true);
    seedServerFetch(false);
    const { result } = renderReconciliation();
    fetchSpy.mockClear();

    // WHEN the loop is started
    result.current.startReconciliationLoop(
      useStreamStore.getState().streamEpoch,
    );
    await Promise.resolve();
    await Promise.resolve();

    // THEN nothing fetched yet — the first tick is behind the 5s debounce
    // timer, the legacy poll-until-stable path.
    expect(fetchSpy).not.toHaveBeenCalled();

    // Clean up the pending timer so it can't fire against a torn-down store.
    result.current.cancelReconciliation();
  });
});
