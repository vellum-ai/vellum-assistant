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
  homeFeedGetQueryKey,
  homeStateGetQueryKey,
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
      ((query: { queryKey: readonly unknown[] }) => boolean) | undefined;
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

  // A reconnect is an iOS foreground. Sweeping every family at TanStack's
  // `refetchType: "active"` default lands all their GETs at once, which is
  // most of the measured foreground request burst.
  test("reconnect sweep refetches only the immediate tier and marks the rest lazy", async () => {
    const queryClient = freshQueryClient();
    const calls: { queryKey?: readonly unknown[]; refetchType?: string }[] = [];
    queryClient.invalidateQueries = ((arg: {
      queryKey?: readonly unknown[];
      refetchType?: string;
    }) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    await flushReconnectSweep();

    const pathOpts = { path: { assistant_id: "asst-1" } };
    const immediate = new Set(
      [
        assistantIdentityQueryKey("asst-1"),
        configGetQueryKey(pathOpts),
        avatarQueryKey("asst-1"),
      ].map(keyId),
    );
    // An absent refetchType is TanStack's `"active"` default, which is what
    // the immediate tier wants.
    for (const id of immediate) {
      const call = calls.find((entry) => keyId(entry.queryKey) === id);
      expect(call).toBeDefined();
      expect(call!.refetchType).toBeUndefined();
    }
    const lazy = calls.filter((call) => !immediate.has(keyId(call.queryKey)));
    expect(lazy.length).toBeGreaterThan(0);
    for (const call of lazy) {
      expect(call.refetchType).toBe("none");
    }
  });

  // The behavioral half of the tier policy: with observers actually mounted,
  // the immediate tier issues a network read and the lazy tier does not.
  test("reconnect refetches a mounted config observer but only stales a mounted sounds observer", async () => {
    const queryClient = freshQueryClient();
    const pathOpts = { path: { assistant_id: "asst-1" } };
    const soundsKey = soundsConfigGetQueryKey(pathOpts);
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
      queryKey: soundsKey,
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
      });
      expect(soundsFetches).toBe(1);
      // Stale, not forgotten: the next observer mount refetches it.
      expect(queryClient.getQueryState(soundsKey)?.isInvalidated).toBe(true);
    } finally {
      unsubConfig();
      unsubSounds();
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

  test("unmount cancels a pending reconnect sweep", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    const { unmount } = renderHook(
      () => useAssistantResourceSync("asst-1", true),
      { wrapper: createWrapper(queryClient) },
    );

    publish("sse.opened", { assistantId: "asst-1", cause: "error" });
    unmount();
    await flushReconnectSweep();

    expect(spy).not.toHaveBeenCalled();
  });

  // A queued sweep closes over the assistant that was active when it was
  // scheduled, so switching assistants has to drop it rather than let it
  // refresh caches for the assistant the user just left.
  test("switching assistants cancels the pending reconnect sweep", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
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

    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates home-feed query on home_feed_updated", async () => {
    const queryClient = freshQueryClient();
    let predicate:
      ((query: { queryKey: readonly unknown[] }) => boolean) | undefined;
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
