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
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { createElement } from "react";
import type { ProgressiveAttachmentLoadingPolicy } from "@/lib/backwards-compat/use-supports-progressive-attachment-loading";

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
const ingestTailSpy = spyOn(
  eventsTailApi,
  "ingestServerEventsTail",
).mockImplementation(
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

function mockPendingServerFetch(): AbortSignal[] {
  const signals: AbortSignal[] = [];
  fetchSpy.mockImplementation(
    async (_assistantId, _conversationId, options) =>
      new Promise<never>((_resolve, reject) => {
        const signal = options?.signal;
        if (!signal) {
          reject(new Error("expected reconciliation signal"));
          return;
        }
        signals.push(signal);
        signal.addEventListener(
          "abort",
          () => reject(signal.reason),
          { once: true },
        );
      }),
  );
  return signals;
}

/** Render the hook against a spied query client; returns the invalidate spy. */
function renderReconciliation(
  initialProps: {
    assistantId: string | null;
    activeConversationId: string | null;
    progressiveAttachmentLoadingPolicy: ProgressiveAttachmentLoadingPolicy;
  } = {
    assistantId: ASSISTANT_ID,
    activeConversationId: CONV_ID,
    progressiveAttachmentLoadingPolicy: "inline",
  },
) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const invalidateSpy = mock(async () => {});
  client.invalidateQueries = invalidateSpy as never;

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  const view = renderHook(
    (props) =>
      useMessageReconciliation({
        ...props,
        latestPageOldestTimestamp: null,
      }),
    { wrapper, initialProps },
  );
  return { ...view, invalidateSpy };
}

beforeEach(() => {
  reconcileTrace.length = 0;
  ingestTailSpy.mockImplementation(async (...args: unknown[]) => {
    reconcileTrace.push({ step: "ingest-tail", args });
  });
  ingestTailSpy.mockClear();
  fetchSpy.mockImplementation(async () => fetchResult as never);
  fetchSpy.mockClear();
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
    expect(ingest?.args?.slice(0, 3)).toEqual([ASSISTANT_ID, CONV_ID, 11]);
    expect(ingest?.args?.[3]).toBe(
      fetchSpy.mock.calls[0]?.[2]?.signal,
    );
    // ... and ingested BEFORE the history invalidation, so the reseed
    // replay reads a primed event ring.
    expect(reconcileTrace.map((t) => t.step)).toEqual([
      "ingest-tail",
      "invalidate",
    ]);
  });
});

describe("useMessageReconciliation — attachment policy and cancellation", () => {
  test("uses metadata for supported assistants and skips unresolved identity", async () => {
    seedServerFetch(false);
    const metadataView = renderReconciliation({
      assistantId: ASSISTANT_ID,
      activeConversationId: CONV_ID,
      progressiveAttachmentLoadingPolicy: "metadata",
    });

    await metadataView.result.current.reconcileActiveConversation();

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0]?.[2]).toMatchObject({
      latestPageLimit: messagesApi.RECONCILE_LATEST_PAGE_LIMIT,
      attachmentContent: "metadata",
      signal: expect.any(AbortSignal),
    });
    metadataView.unmount();
    fetchSpy.mockClear();

    const pendingView = renderReconciliation({
      assistantId: ASSISTANT_ID,
      activeConversationId: CONV_ID,
      progressiveAttachmentLoadingPolicy: "pending",
    });
    const outcome =
      await pendingView.result.current.reconcileActiveConversation();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(outcome).toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
  });

  test("superseding reconciles abort the obsolete request without rejecting", async () => {
    const signals = mockPendingServerFetch();
    const view = renderReconciliation();

    const first = view.result.current.reconcileActiveConversation();
    await waitFor(() => expect(signals).toHaveLength(1));
    const second = view.result.current.reconcileActiveConversation();
    await waitFor(() => expect(signals).toHaveLength(2));

    expect(signals[0]?.aborted).toBe(true);
    await expect(first).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });

    view.unmount();
    expect(signals[1]?.aborted).toBe(true);
    await expect(second).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
  });

  test("public live cancellation leaves an active one-shot reconcile running", async () => {
    const signals = mockPendingServerFetch();
    const view = renderReconciliation();

    const request = view.result.current.reconcileActiveConversation();
    await waitFor(() => expect(signals).toHaveLength(1));
    view.result.current.cancelReconciliation();

    expect(signals[0]?.aborted).toBe(false);
    view.unmount();
    expect(signals[0]?.aborted).toBe(true);
    await expect(request).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
  });

  test("epoch cancellation aborts a pending tail without reconciliation effects", async () => {
    seedSnapshotProcessing(true);
    seedServerFetch(false);
    let tailSignal: AbortSignal | undefined;
    ingestTailSpy.mockImplementation(
      async (_assistantId, _conversationId, _serverSeq, signal) => {
        tailSignal = signal;
        return await new Promise<void>((_resolve, reject) => {
          tailSignal?.addEventListener(
            "abort",
            () => reject(tailSignal?.reason),
            { once: true },
          );
        });
      },
    );
    const { result, invalidateSpy } = renderReconciliation();

    const request = result.current.reconcileActiveConversation();
    await waitFor(() => expect(tailSignal).toBeDefined());
    expect(tailSignal).toBe(fetchSpy.mock.calls[0]?.[2]?.signal);
    useStreamStore.getState().bumpEpoch();

    expect(tailSignal?.aborted).toBe(true);
    await expect(request).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(reconcileTrace).toHaveLength(0);
  });

  test("epoch and assistant-scope changes abort in-flight reconciliation", async () => {
    const signals = mockPendingServerFetch();
    const view = renderReconciliation();

    const epochRequest = view.result.current.reconcileActiveConversation();
    await waitFor(() => expect(signals).toHaveLength(1));
    useStreamStore.getState().bumpEpoch();

    expect(signals[0]?.aborted).toBe(true);
    await expect(epochRequest).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });

    const scopeRequest = view.result.current.reconcileActiveConversation();
    await waitFor(() => expect(signals).toHaveLength(2));
    view.rerender({
      assistantId: "asst-2",
      activeConversationId: CONV_ID,
      progressiveAttachmentLoadingPolicy: "metadata",
    });

    expect(signals[1]?.aborted).toBe(true);
    await expect(scopeRequest).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
  });

  test("drops a response when stream scope changes without an epoch bump", async () => {
    const deferred: { resolve?: () => void } = {};
    fetchSpy.mockImplementation(
      async () =>
        new Promise<never>((resolve) => {
          deferred.resolve = () => resolve(fetchResult as never);
        }),
    );
    const { result, invalidateSpy } = renderReconciliation();

    const request = result.current.reconcileActiveConversation();
    await waitFor(() => expect(deferred.resolve).toBeDefined());
    useStreamStore.getState().setStreamContext({
      assistantId: "asst-2",
      conversationId: CONV_ID,
    });
    fetchResult = {
      messages: [{ id: "a1", role: "assistant" }],
      seq: 11,
      processing: false,
    };
    deferred.resolve?.();

    await expect(request).resolves.toEqual({
      changed: false,
      messagesAdded: 0,
      assistantProgress: false,
    });
    expect(invalidateSpy).not.toHaveBeenCalled();
    expect(reconcileTrace).toHaveLength(0);
  });
});

describe("startReconciliationLoop — off above the floor, poll loop below", () => {
  test("tail-capable daemon: fully off — no fetch, no loop", async () => {
    // GIVEN a daemon at/above the events-tail floor
    useAssistantIdentityStore.getState().setIdentity("Ada", TAIL_CAPABLE_VERSION);
    seedSnapshotProcessing(true);
    seedServerFetch(false);
    const { result } = renderReconciliation();
    fetchSpy.mockClear();

    // WHEN the loop-invoking method is called
    result.current.startReconciliationLoop(
      useStreamStore.getState().streamEpoch,
    );
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();

    // THEN it is a no-op: no fetch, no timer. Recovery above the floor is
    // driven entirely by the event-triggered reconcileActiveConversation()
    // calls (reopen / seq-gap / sync-tag), not by this method.
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  test("tail-capable daemon: cancelReconciliation is safe without active work", () => {
    // GIVEN a daemon at/above the events-tail floor
    useAssistantIdentityStore.getState().setIdentity("Ada", TAIL_CAPABLE_VERSION);
    const { result } = renderReconciliation();

    // WHEN cancel is invoked (as the stream handlers do on live events)
    // THEN it does not throw and there is nothing to cancel — no loop runs.
    expect(() => result.current.cancelReconciliation()).not.toThrow();
  });

  test("sub-floor daemon: runs the legacy poll loop (deferred first fetch)", async () => {
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
