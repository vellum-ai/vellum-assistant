import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  hashKey,
  QueryClient,
  QueryClientProvider,
  QueryObserver,
} from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import { memoryGraphOptions } from "@/domains/intelligence/memory-graph/get-memory-graph";
import { memoryStatsOptions } from "@/domains/intelligence/memory-graph/get-memory-stats";
import {
  appsGetQueryKey,
  configGetQueryKey,
  documentsGetQueryKey,
  homeFeedGetQueryKey,
  homeStateGetQueryKey,
  configLlmCallsitesGetQueryKey,
  inferenceProfilesGetQueryKey,
  pluginsGetQueryKey,
  pluginsSearchGetQueryKey,
  schedulesGetQueryKey,
  soundsConfigGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { AssistantEvent } from "@/types/event-types";
import { useAssistantResourceSync } from "@/hooks/use-assistant-resource-sync";
import { assistantIdentityQueryKey } from "@/hooks/use-assistant-identity-init";
import { avatarQueryKey } from "@/hooks/use-assistant-avatar";
import { SYNC_TAGS } from "@/lib/sync/types";
import type { SyncChangedEvent } from "@/lib/sync/types";
import { __resetForTesting, publish } from "@/lib/event-bus";
import { getClientId } from "@/lib/telemetry/client-identity";

function createWrapper(queryClient: QueryClient) {
  return function Wrapper({ children }: { children: ReactNode }) {
    return (
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    );
  };
}

function freshQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
}

type QueryPredicate = (query: { queryKey: readonly unknown[] }) => boolean;

/**
 * Swaps `invalidateQueries` for a capture that records every predicate handed
 * to it, so a test can ask which query keys the hook claimed.
 */
function capturePredicates(queryClient: QueryClient): QueryPredicate[] {
  const predicates: QueryPredicate[] = [];
  queryClient.invalidateQueries = ((arg: unknown) => {
    const predicate = (arg as { predicate?: QueryPredicate }).predicate;
    if (predicate) {
      predicates.push(predicate);
    }
    return Promise.resolve();
  }) as never;
  return predicates;
}

/** The shape `domains/library/use-library-data.ts` reads documents under. */
const LIBRARY_DOCUMENTS_KEY = documentsGetQueryKey({
  path: { assistant_id: "asst-1" },
});

/** The shape `domains/chat/components/conversation-assets-pill.tsx` reads under. */
const CONVERSATION_DOCUMENTS_KEY = documentsGetQueryKey({
  path: { assistant_id: "asst-1" },
  query: { conversationId: "convo-1" },
});

function syncEvent(tags: string[]): SyncChangedEvent {
  return { type: "sync_changed", tags };
}

function emit(event: AssistantEvent): void {
  publish("sse.event", {
    id: "evt-1",
    emittedAt: new Date().toISOString(),
    message: event,
  } as AssistantEventEnvelope);
}

/** Mirrors RECONNECT_SWEEP_DEBOUNCE_MS in use-assistant-resource-sync.ts. */
const SWEEP_DEBOUNCE_MS = 500;

/**
 * The reconnect sweep runs on a trailing debounce, so assertions have to let
 * the window elapse first. bun:test provides no fake timers, so this is a real
 * sleep, matching the idiom in use-conversation-sync.test.tsx.
 */
async function flushReconnectSweep(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, SWEEP_DEBOUNCE_MS + 150));
}

/** Stable identity for a query key, so predicate-only calls compare as absent. */
function keyId(queryKey: readonly unknown[] | undefined): string | undefined {
  return queryKey === undefined ? undefined : hashKey(queryKey);
}

type InvalidateCall = {
  queryKey?: readonly unknown[];
  refetchType?: string;
};

/** Stand-in for `queryClient.invalidateQueries` that records every call. */
function recordInvalidations(sink: InvalidateCall[]) {
  return (arg: unknown) => {
    sink.push(arg as InvalidateCall);
    return Promise.resolve();
  };
}

/** The recorded invalidations that targeted one exact query key. */
function sweepsFor(
  calls: InvalidateCall[],
  queryKey: readonly unknown[],
): InvalidateCall[] {
  return calls.filter((call) => keyId(call.queryKey) === keyId(queryKey));
}

beforeEach(() => {
  __resetForTesting();
});

afterEach(() => {
  cleanup();
  __resetForTesting();
});

describe("useAssistantResourceSync", () => {
  test("does not fire when assistant is not active", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", false), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("does not fire when assistantId is null", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync(null, true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates avatar query on assistant:self:avatar sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: avatarQueryKey("asst-1"),
      });
    });
  });

  test("invalidates identity query on assistant:self:identity sync tag", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantIdentity]) as unknown as AssistantEvent);
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([assistantIdentityQueryKey("asst-1")]) as never,
      );
    });
  });

  test("invalidates config / sounds / schedules queries on their sync tags", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[][] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push([arg]);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(
      syncEvent([
        SYNC_TAGS.assistantConfig,
        SYNC_TAGS.assistantSounds,
        SYNC_TAGS.assistantSchedules,
      ]) as unknown as AssistantEvent,
    );
    await waitFor(() => {
      const queryKeys = calls.map(
        ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      const pathOpts = { path: { assistant_id: "asst-1" } };
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          configGetQueryKey(pathOpts),
          inferenceProfilesGetQueryKey(pathOpts),
          configLlmCallsitesGetQueryKey(pathOpts),
          soundsConfigGetQueryKey(pathOpts),
          schedulesGetQueryKey(pathOpts),
          [
            {
              _id: "schedulesUsagesummaryGet",
              path: { assistant_id: "asst-1" },
            },
          ],
        ]) as never,
      );
    });
  });

  // Memory availability is derived from config, so the config tag has to reach
  // the two memory reads as well. They use hand-rolled query keys, so the
  // generated config invalidation never touches them on its own.
  test("invalidates memory graph / stats queries on the config sync tag", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[][] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push([arg]);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.assistantConfig]) as unknown as AssistantEvent);
    await waitFor(() => {
      const queryKeys = calls.map(
        ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          memoryGraphOptions("asst-1").queryKey,
          memoryStatsOptions("asst-1").queryKey,
        ]) as never,
      );
    });
  });

  // The reconnect catch-up exists because `sync_changed` events are missed
  // while the transport is down. A resource covered by a tag but not by the
  // reconnect sweep silently keeps serving pre-gap data for its whole
  // staleTime, which for the memory reads is five minutes.
  test("reconciles memory graph / stats queries on non-fresh sse.opened reconnect", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await flushReconnectSweep();
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          memoryGraphOptions("asst-1").queryKey,
          memoryStatsOptions("asst-1").queryKey,
        ]) as never,
      );
    });
  });

  test("invalidates app list queries on apps:list sync tag", async () => {
    const queryClient = freshQueryClient();
    let predicate:
      | ((query: { queryKey: readonly unknown[] }) => boolean)
      | undefined;
    queryClient.invalidateQueries = ((arg: unknown) => {
      predicate = (
        arg as {
          predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
        }
      ).predicate;
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.appsList]) as unknown as AssistantEvent);

    await waitFor(() => {
      expect(predicate).toBeDefined();
    });
    expect(
      predicate!({
        queryKey: appsGetQueryKey({ path: { assistant_id: "asst-1" } }),
      }),
    ).toBe(true);
    expect(predicate!({ queryKey: avatarQueryKey("asst-1") })).toBe(false);
  });

  // The Library keys the documents read by assistant alone while the
  // conversation assets pill adds `query.conversationId`. Covering only the
  // conversation-scoped key leaves the Library serving a pre-edit list.
  test("invalidates both documents key shapes on documents:list sync tag", async () => {
    const queryClient = freshQueryClient();
    const predicates = capturePredicates(queryClient);
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit(syncEvent([SYNC_TAGS.documentsList]) as unknown as AssistantEvent);

    const claims = (queryKey: readonly unknown[]) =>
      predicates.some((p) => p({ queryKey }));
    await waitFor(() => {
      expect(claims(LIBRARY_DOCUMENTS_KEY)).toBe(true);
    });
    expect(claims(CONVERSATION_DOCUMENTS_KEY)).toBe(true);
    expect(claims(appsGetQueryKey({ path: { assistant_id: "asst-1" } }))).toBe(
      false,
    );
  });

  test("reconciles both documents key shapes on non-fresh sse.opened reconnect", async () => {
    const queryClient = freshQueryClient();
    const predicates = capturePredicates(queryClient);
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });

    const claims = (queryKey: readonly unknown[]) =>
      predicates.some((p) => p({ queryKey }));
    await waitFor(() => {
      expect(claims(LIBRARY_DOCUMENTS_KEY)).toBe(true);
    });
    expect(claims(CONVERSATION_DOCUMENTS_KEY)).toBe(true);
  });

  test("invalidates plugin list / catalog / open-detail queries on plugins:list sync tag", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(syncEvent([SYNC_TAGS.pluginsList]) as unknown as AssistantEvent);
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      const pathOpts = { path: { assistant_id: "asst-1" } };
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          pluginsGetQueryKey(pathOpts),
          pluginsSearchGetQueryKey(pathOpts),
          // The broad sync carries no name, so every open plugin detail + drift
          // inspect is invalidated via partial key (see invalidatePluginQueries).
          [{ _id: "pluginsByNameGet", path: { assistant_id: "asst-1" } }],
          [
            {
              _id: "pluginsByNameInspectGet",
              path: { assistant_id: "asst-1" },
            },
          ],
        ]) as never,
      );
    });
  });

  test("reconciles plugin queries on non-fresh sse.opened reconnect", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await flushReconnectSweep();
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey,
      );
      const pathOpts = { path: { assistant_id: "asst-1" } };
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          pluginsGetQueryKey(pathOpts),
          pluginsSearchGetQueryKey(pathOpts),
          // Reconnect reconcile is name-agnostic too — open details invalidate.
          [{ _id: "pluginsByNameGet", path: { assistant_id: "asst-1" } }],
          [
            {
              _id: "pluginsByNameInspectGet",
              path: { assistant_id: "asst-1" },
            },
          ],
        ]) as never,
      );
    });
  });

  test("does not reconcile on fresh sse.opened", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });
    await flushReconnectSweep();
    expect(spy).not.toHaveBeenCalled();
  });

  // The sweep is the only thing that reconciles a view that was already open
  // when the stream dropped: it missed every `sync_changed` in the gap, and
  // nothing else will tell it to read again while it stays mounted and fresh.
  test("reconnect sweep refetches mounted observers across every swept family", async () => {
    const queryClient = freshQueryClient();
    const pathOpts = { path: { assistant_id: "asst-1" } };
    let configFetches = 0;
    let soundsFetches = 0;
    const configObserver = new QueryObserver(queryClient, {
      queryKey: configGetQueryKey(pathOpts),
      queryFn: () => {
        configFetches += 1;
        return Promise.resolve({ ok: true });
      },
      staleTime: Infinity,
    });
    const soundsObserver = new QueryObserver(queryClient, {
      queryKey: soundsConfigGetQueryKey(pathOpts),
      queryFn: () => {
        soundsFetches += 1;
        return Promise.resolve({ ok: true });
      },
      staleTime: Infinity,
    });
    const unsubConfig = configObserver.subscribe(() => {});
    const unsubSounds = soundsObserver.subscribe(() => {});
    try {
      await waitFor(() => {
        expect(configFetches).toBe(1);
        expect(soundsFetches).toBe(1);
      });
      renderHook(() => useAssistantResourceSync("asst-1", true), {
        wrapper: createWrapper(queryClient),
      });

      publish("sse.opened", { assistantId: "asst-1", cause: "error" });
      await flushReconnectSweep();

      await waitFor(() => {
        expect(configFetches).toBe(2);
        expect(soundsFetches).toBe(2);
      });
    } finally {
      unsubConfig();
      unsubSounds();
    }
  });

  // The other half of that bargain: a view nobody has open costs no request.
  // TanStack's default `refetchType` only refetches observed queries, so an
  // unobserved family is marked stale and reads through on its next mount.
  test("reconnect sweep stales an unobserved query without fetching it", async () => {
    const queryClient = freshQueryClient();
    const soundsKey = soundsConfigGetQueryKey({
      path: { assistant_id: "asst-1" },
    });
    let fetches = 0;
    const queryFn = () => {
      fetches += 1;
      return Promise.resolve({ ok: true });
    };
    const observer = new QueryObserver(queryClient, {
      queryKey: soundsKey,
      queryFn,
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    await waitFor(() => {
      expect(fetches).toBe(1);
    });
    unsubscribe();

    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await flushReconnectSweep();

    expect(fetches).toBe(1);
    expect(queryClient.getQueryState(soundsKey)?.isInvalidated).toBe(true);

    // Stale, not forgotten: the next observer mount reads through.
    const remounted = new QueryObserver(queryClient, {
      queryKey: soundsKey,
      queryFn,
      staleTime: Infinity,
    });
    const unsubRemount = remounted.subscribe(() => {});
    try {
      await waitFor(() => {
        expect(fetches).toBe(2);
      });
    } finally {
      unsubRemount();
    }
  });

  test("collapses a reconnect flap into a single sweep", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await new Promise((resolve) => setTimeout(resolve, 100));
    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await flushReconnectSweep();

    const avatarSweeps = calls.filter(
      (arg) =>
        keyId((arg as { queryKey?: readonly unknown[] }).queryKey) ===
        keyId(avatarQueryKey("asst-1")),
    );
    expect(avatarSweeps.length).toBe(1);
  });

  // The debounce window is the only place a scheduled catch-up could go
  // missing: leaving inside it used to cancel the timer outright, and the
  // return trip attaches fresh, which this hook ignores. Cleanup flushes
  // instead, so the gap is always reconciled for the assistant it was
  // scheduled for.
  test("unmount flushes the pending reconnect sweep as stale-marking", async () => {
    const queryClient = freshQueryClient();
    const calls: InvalidateCall[] = [];
    queryClient.invalidateQueries = recordInvalidations(calls) as never;
    const { unmount } = renderHook(
      () => useAssistantResourceSync("asst-1", true),
      { wrapper: createWrapper(queryClient) },
    );

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    unmount();

    const avatarSweeps = sweepsFor(calls, avatarQueryKey("asst-1"));
    expect(avatarSweeps.length).toBe(1);
    expect(avatarSweeps[0]?.refetchType).toBe("none");

    // The flush consumed the pending timer, so the debounce never fires again.
    await flushReconnectSweep();
    expect(sweepsFor(calls, avatarQueryKey("asst-1")).length).toBe(1);
  });

  // A queued sweep closes over the assistant that was active when it was
  // scheduled, so switching assistants flushes it for that assistant rather
  // than letting it run against the one the user just switched to.
  test("switching assistants flushes the pending sweep for the assistant left behind", async () => {
    const queryClient = freshQueryClient();
    const calls: InvalidateCall[] = [];
    queryClient.invalidateQueries = recordInvalidations(calls) as never;
    const { rerender } = renderHook(
      ({ id }: { id: string }) => useAssistantResourceSync(id, true),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { id: "asst-1" },
      },
    );

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    rerender({ id: "asst-2" });

    const avatarSweeps = sweepsFor(calls, avatarQueryKey("asst-1"));
    expect(avatarSweeps.length).toBe(1);
    expect(avatarSweeps[0]?.refetchType).toBe("none");
    expect(sweepsFor(calls, avatarQueryKey("asst-2")).length).toBe(0);

    await flushReconnectSweep();
    expect(sweepsFor(calls, avatarQueryKey("asst-1")).length).toBe(1);
  });

  // The departing flush is the whole point of the invariant: the long
  // staleTime families (memory reads at five minutes) would otherwise serve
  // pre-gap data on the next visit, well past the 10s global staleTime that
  // rescues everything else.
  test("switching assistants stales the departing assistant's memory reads without fetching", async () => {
    const queryClient = freshQueryClient();
    const oldKey = memoryGraphOptions("asst-1").queryKey;
    const newKey = memoryGraphOptions("asst-2").queryKey;
    let oldFetches = 0;
    let newFetches = 0;
    const oldObserver = new QueryObserver(queryClient, {
      queryKey: oldKey,
      queryFn: () => {
        oldFetches += 1;
        return Promise.resolve({ ok: true });
      },
      staleTime: Infinity,
    });
    const newObserver = new QueryObserver(queryClient, {
      queryKey: newKey,
      queryFn: () => {
        newFetches += 1;
        return Promise.resolve({ ok: true });
      },
      staleTime: Infinity,
    });
    const unsubOld = oldObserver.subscribe(() => {});
    const unsubNew = newObserver.subscribe(() => {});
    try {
      await waitFor(() => {
        expect(oldFetches).toBe(1);
        expect(newFetches).toBe(1);
      });
      const { rerender } = renderHook(
        ({ id }: { id: string }) => useAssistantResourceSync(id, true),
        {
          wrapper: createWrapper(queryClient),
          initialProps: { id: "asst-1" },
        },
      );

      publish("sse.opened", { assistantId: "asst-1", cause: "error" });
      rerender({ id: "asst-2" });
      await flushReconnectSweep();

      expect(queryClient.getQueryState(oldKey)?.isInvalidated).toBe(true);
      expect(oldFetches).toBe(1);
      expect(queryClient.getQueryState(newKey)?.isInvalidated).toBe(false);
      expect(newFetches).toBe(1);
    } finally {
      unsubOld();
      unsubNew();
    }
  });

  test("unmount stales the assistant's memory reads without fetching", async () => {
    const queryClient = freshQueryClient();
    const memoryKey = memoryGraphOptions("asst-1").queryKey;
    let fetches = 0;
    const observer = new QueryObserver(queryClient, {
      queryKey: memoryKey,
      queryFn: () => {
        fetches += 1;
        return Promise.resolve({ ok: true });
      },
      staleTime: Infinity,
    });
    const unsubscribe = observer.subscribe(() => {});
    try {
      await waitFor(() => {
        expect(fetches).toBe(1);
      });
      const { unmount } = renderHook(
        () => useAssistantResourceSync("asst-1", true),
        { wrapper: createWrapper(queryClient) },
      );

      publish("sse.opened", { assistantId: "asst-1", cause: "error" });
      unmount();
      await flushReconnectSweep();

      expect(queryClient.getQueryState(memoryKey)?.isInvalidated).toBe(true);
      expect(fetches).toBe(1);
    } finally {
      unsubscribe();
    }
  });

  // Cleanup only flushes what is still pending, so a sweep that already ran on
  // its own timer is not run a second time when the hook later tears down.
  test("cleanup after the debounce has fired does not sweep twice", async () => {
    const queryClient = freshQueryClient();
    const calls: InvalidateCall[] = [];
    queryClient.invalidateQueries = recordInvalidations(calls) as never;
    const { unmount } = renderHook(
      () => useAssistantResourceSync("asst-1", true),
      { wrapper: createWrapper(queryClient) },
    );

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await flushReconnectSweep();
    expect(sweepsFor(calls, avatarQueryKey("asst-1")).length).toBe(1);

    unmount();
    await flushReconnectSweep();

    expect(sweepsFor(calls, avatarQueryKey("asst-1")).length).toBe(1);
  });

  test("invalidates home-feed query on home_feed_updated", async () => {
    const queryClient = freshQueryClient();
    let predicate:
      | ((query: { queryKey: readonly unknown[] }) => boolean)
      | undefined;
    queryClient.invalidateQueries = ((arg: unknown) => {
      predicate = (
        arg as {
          predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
        }
      ).predicate;
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "home_feed_updated",
      updatedAt: "2026-05-21T00:00:00Z",
      newItemCount: 1,
    } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(predicate).toBeDefined();
    });
    expect(
      predicate!({
        queryKey: homeFeedGetQueryKey({
          path: { assistant_id: "asst-1" },
          query: { timeAwaySeconds: 0 },
        }),
      }),
    ).toBe(true);
    expect(predicate!({ queryKey: avatarQueryKey("asst-1") })).toBe(false);
  });

  test("invalidates both home-feed and home-state on relationship_state_updated", async () => {
    const queryClient = freshQueryClient();
    const predicates: Array<
      (query: { queryKey: readonly unknown[] }) => boolean
    > = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      const pred = (
        arg as {
          predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
        }
      ).predicate;
      if (pred) {
        predicates.push(pred);
      }
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "relationship_state_updated",
      updatedAt: "2026-05-21T00:00:00Z",
    } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(predicates.length).toBe(2);
    });
    const feedKey = homeFeedGetQueryKey({
      path: { assistant_id: "asst-1" },
      query: { timeAwaySeconds: 0 },
    });
    const stateKey = homeStateGetQueryKey({
      path: { assistant_id: "asst-1" },
    });
    expect(predicates.some((p) => p({ queryKey: feedKey }))).toBe(true);
    expect(predicates.some((p) => p({ queryKey: stateKey }))).toBe(true);
    expect(
      predicates.every((p) => !p({ queryKey: avatarQueryKey("asst-1") })),
    ).toBe(true);
  });

  test("invalidates identity query on identity_changed event", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({ type: "identity_changed" } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: assistantIdentityQueryKey("asst-1"),
      });
    });
  });

  test("invalidates avatar query on avatar_updated event", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({ type: "avatar_updated" } as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: avatarQueryKey("asst-1"),
      });
    });
  });

  test("ignores conversation-scoped events (text deltas, tool calls, etc.)", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit({
      type: "assistant_text_delta",
      conversationId: "convo-1",
      delta: "hi",
    } as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("unsubscribes from the bus when isAssistantActive flips true -> false", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    const { rerender } = renderHook(
      ({ active }: { active: boolean }) =>
        useAssistantResourceSync("asst-1", active),
      {
        wrapper: createWrapper(queryClient),
        initialProps: { active: true },
      },
    );
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    rerender({ active: false });
    emit(syncEvent([SYNC_TAGS.assistantAvatar]) as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("self-echo suppression: ignores sync_changed from same client", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    const selfEvent = {
      ...syncEvent([SYNC_TAGS.assistantAvatar]),
      originClientId: getClientId(),
    };
    emit(selfEvent as unknown as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("self-echo suppression: processes sync_changed from different client", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    const otherEvent = {
      ...syncEvent([SYNC_TAGS.assistantAvatar]),
      originClientId: "other-client-id",
    };
    emit(otherEvent as unknown as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: avatarQueryKey("asst-1"),
      });
    });
  });
});
