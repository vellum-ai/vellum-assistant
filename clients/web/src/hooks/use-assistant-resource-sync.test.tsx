import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";

import type { AssistantEventEnvelope } from "@vellumai/assistant-api";
import {
  appsGetQueryKey,
  configGetQueryKey,
  homeFeedGetQueryKey,
  homeStateGetQueryKey,
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
    emit((syncEvent([SYNC_TAGS.assistantAvatar]) as unknown) as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("does not fire when assistantId is null", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync(null, true), {
      wrapper: createWrapper(queryClient),
    });
    emit((syncEvent([SYNC_TAGS.assistantAvatar]) as unknown) as AssistantEvent);
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates avatar query on assistant:self:avatar sync tag", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit((syncEvent([SYNC_TAGS.assistantAvatar]) as unknown) as AssistantEvent);
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
    emit(
      (syncEvent([SYNC_TAGS.assistantIdentity]) as unknown) as AssistantEvent
    );
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey
      );
      expect(queryKeys).toEqual(
        expect.arrayContaining([assistantIdentityQueryKey("asst-1")]) as never
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
      (syncEvent([
        SYNC_TAGS.assistantConfig,
        SYNC_TAGS.assistantSounds,
        SYNC_TAGS.assistantSchedules,
      ]) as unknown) as AssistantEvent
    );
    await waitFor(() => {
      const queryKeys = calls.map(
        ([arg]) => (arg as { queryKey: readonly unknown[] }).queryKey
      );
      const pathOpts = { path: { assistant_id: "asst-1" } };
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          configGetQueryKey(pathOpts),
          soundsConfigGetQueryKey(pathOpts),
          schedulesGetQueryKey(pathOpts),
          [{ _id: "schedulesUsagesummaryGet", path: { assistant_id: "asst-1" } }],
        ]) as never
      );
    });
  });

  test("invalidates app list queries on apps:list sync tag", async () => {
    const queryClient = freshQueryClient();
    let predicate:
      | ((query: { queryKey: readonly unknown[] }) => boolean)
      | undefined;
    queryClient.invalidateQueries = ((arg: unknown) => {
      predicate = (arg as {
        predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
      }).predicate;
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });

    emit((syncEvent([SYNC_TAGS.appsList]) as unknown) as AssistantEvent);

    await waitFor(() => {
      expect(predicate).toBeDefined();
    });
    expect(
      predicate!({
        queryKey: appsGetQueryKey({ path: { assistant_id: "asst-1" } }),
      })
    ).toBe(true);
    expect(predicate!({ queryKey: avatarQueryKey("asst-1") })).toBe(false);
  });

  test("invalidates plugin list / catalog queries on plugins:list sync tag", async () => {
    const queryClient = freshQueryClient();
    const calls: unknown[] = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      calls.push(arg);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit((syncEvent([SYNC_TAGS.pluginsList]) as unknown) as AssistantEvent);
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey
      );
      const pathOpts = { path: { assistant_id: "asst-1" } };
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          pluginsGetQueryKey(pathOpts),
          pluginsSearchGetQueryKey(pathOpts),
        ]) as never
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
    await waitFor(() => {
      const queryKeys = calls.map(
        (arg) => (arg as { queryKey: readonly unknown[] }).queryKey
      );
      const pathOpts = { path: { assistant_id: "asst-1" } };
      expect(queryKeys).toEqual(
        expect.arrayContaining([
          pluginsGetQueryKey(pathOpts),
          pluginsSearchGetQueryKey(pathOpts),
        ]) as never
      );
    });
  });

  test("does not reconcile on fresh sse.opened", () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    publish("sse.opened", { assistantId: "asst-1", cause: "fresh" });
    expect(spy).not.toHaveBeenCalled();
  });

  test("invalidates home-feed query on home_feed_updated", async () => {
    const queryClient = freshQueryClient();
    let predicate:
      | ((query: { queryKey: readonly unknown[] }) => boolean)
      | undefined;
    queryClient.invalidateQueries = ((arg: unknown) => {
      predicate = (arg as {
        predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
      }).predicate;
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(({
      type: "home_feed_updated",
      updatedAt: "2026-05-21T00:00:00Z",
      newItemCount: 1,
    } as unknown) as AssistantEvent);
    await waitFor(() => {
      expect(predicate).toBeDefined();
    });
    expect(
      predicate!({
        queryKey: homeFeedGetQueryKey({
          path: { assistant_id: "asst-1" },
          query: { timeAwaySeconds: 0 },
        }),
      })
    ).toBe(true);
    expect(predicate!({ queryKey: avatarQueryKey("asst-1") })).toBe(false);
  });

  test("invalidates both home-feed and home-state on relationship_state_updated", async () => {
    const queryClient = freshQueryClient();
    const predicates: Array<
      (query: { queryKey: readonly unknown[] }) => boolean
    > = [];
    queryClient.invalidateQueries = ((arg: unknown) => {
      const pred = (arg as {
        predicate?: (query: { queryKey: readonly unknown[] }) => boolean;
      }).predicate;
      if (pred) predicates.push(pred);
      return Promise.resolve();
    }) as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(({
      type: "relationship_state_updated",
      updatedAt: "2026-05-21T00:00:00Z",
    } as unknown) as AssistantEvent);
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
      predicates.every((p) => !p({ queryKey: avatarQueryKey("asst-1") }))
    ).toBe(true);
  });

  test("invalidates identity query on identity_changed event", async () => {
    const queryClient = freshQueryClient();
    const spy = mock(() => Promise.resolve());
    queryClient.invalidateQueries = spy as never;
    renderHook(() => useAssistantResourceSync("asst-1", true), {
      wrapper: createWrapper(queryClient),
    });
    emit(({ type: "identity_changed" } as unknown) as AssistantEvent);
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
    emit(({ type: "avatar_updated" } as unknown) as AssistantEvent);
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
    emit(({
      type: "assistant_text_delta",
      conversationId: "convo-1",
      delta: "hi",
    } as unknown) as AssistantEvent);
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
      }
    );
    emit((syncEvent([SYNC_TAGS.assistantAvatar]) as unknown) as AssistantEvent);
    expect(spy).toHaveBeenCalledTimes(1);
    spy.mockClear();
    rerender({ active: false });
    emit((syncEvent([SYNC_TAGS.assistantAvatar]) as unknown) as AssistantEvent);
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
    emit((selfEvent as unknown) as AssistantEvent);
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
    emit((otherEvent as unknown) as AssistantEvent);
    await waitFor(() => {
      expect(spy).toHaveBeenCalledWith({
        queryKey: avatarQueryKey("asst-1"),
      });
    });
  });
});
