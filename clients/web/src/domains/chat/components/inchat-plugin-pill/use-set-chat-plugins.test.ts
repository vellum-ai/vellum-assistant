/**
 * Tests for `useSetChatPlugins`, the write half of the in-chat plugin pill.
 *
 * The generated SDK is mocked so the two read queries (installed list +
 * conversation row) resolve locally and the `enabledplugins` PUT is a spy; the
 * design-library toast and `captureError` are mocked to observe the failure
 * path. The conversation store is the real module — reset per test.
 *
 * Mocks are registered before the hook is dynamically imported so the
 * generated TanStack Query factories bind to the mocked SDK.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  ConversationsByIdGetResponse,
  PluginsGetResponse,
} from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";

const ASSISTANT_ID = "asst-1";
const CONVERSATION_ID = "conv-1";

type InstalledPlugin = PluginsGetResponse["plugins"][number];

interface InstalledResult {
  data?: PluginsGetResponse;
  response: { ok: boolean; status: number };
}

// Per-test holders the SDK mocks read.
let installedResult: InstalledResult;
let conversationImpl: () => Promise<{ data: ConversationsByIdGetResponse }>;
let putImpl: () => Promise<unknown>;

const sdkActual = await import("@/generated/daemon/sdk.gen");
const pluginsGetSpy = mock(async () => installedResult);
const conversationsByIdGetSpy = mock(() => conversationImpl());
const enabledPluginsPutSpy = mock(() => putImpl());
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsGet: pluginsGetSpy,
  conversationsByIdGet: conversationsByIdGetSpy,
  conversationsByIdEnabledpluginsPut: enabledPluginsPutSpy,
}));

const toastErrorSpy = mock(() => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { error: toastErrorSpy },
}));

const captureErrorSpy = mock(() => {});
mock.module("@/lib/sentry/capture-error", () => ({
  captureError: captureErrorSpy,
}));

const { useSetChatPlugins } = await import("./use-set-chat-plugins");
const { conversationsByIdGetQueryKey, pluginsGetQueryKey } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);

const CONVERSATION_KEY = conversationsByIdGetQueryKey({
  path: { assistant_id: ASSISTANT_ID, id: CONVERSATION_ID },
});
const PLUGINS_KEY = pluginsGetQueryKey({
  path: { assistant_id: ASSISTANT_ID },
  query: { q: undefined },
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function installed(name: string): InstalledPlugin {
  return { id: name, name, description: null, version: null };
}

function installedOk(plugins: InstalledPlugin[]): InstalledResult {
  return { data: { plugins }, response: { ok: true, status: 200 } };
}

/** A loaded conversation row carrying an explicit `enabledPlugins` scope. */
function conversationWith(
  enabledPlugins: string[] | null,
): { data: ConversationsByIdGetResponse } {
  return {
    data: {
      conversation: { id: CONVERSATION_ID, enabledPlugins },
    } as unknown as ConversationsByIdGetResponse,
  };
}

/** Default conversation read: reject, standing in for a draft with no server row. */
function noServerRow(): Promise<{ data: ConversationsByIdGetResponse }> {
  return Promise.reject(new Error("404 — no server row"));
}

function renderSetHook(conversationId: string | undefined = CONVERSATION_ID) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  const view = renderHook(
    () => useSetChatPlugins(ASSISTANT_ID, conversationId),
    { wrapper },
  );
  return { ...view, client };
}

function enabledInCache(client: QueryClient): string[] | null | undefined {
  const data = client.getQueryData<ConversationsByIdGetResponse>(CONVERSATION_KEY);
  return data?.conversation.enabledPlugins;
}

beforeEach(() => {
  installedResult = installedOk([installed("a"), installed("b"), installed("c")]);
  conversationImpl = noServerRow;
  putImpl = () =>
    Promise.resolve({
      data: { conversationId: CONVERSATION_ID, enabledPlugins: [] },
    });
  pluginsGetSpy.mockClear();
  conversationsByIdGetSpy.mockClear();
  enabledPluginsPutSpy.mockClear();
  toastErrorSpy.mockClear();
  captureErrorSpy.mockClear();
  useConversationStore.getState().reset();
});

afterEach(() => {
  cleanup();
});

describe("useSetChatPlugins", () => {
  test("existing conversation toggle → PUT the materialized set + optimistic cache write", async () => {
    // Loaded server row at its default (no explicit scope → all selected).
    conversationImpl = () => Promise.resolve(conversationWith(null));
    // Keep the PUT pending so the optimistic write is stable to assert.
    const putDeferred = deferred<{ data: unknown }>();
    putImpl = () => putDeferred.promise;

    const { result, client } = renderSetHook();

    // Both reads must resolve so the row is loaded (existing path) and the
    // installed list is present (toggle materializes from it).
    await waitFor(() => {
      expect(client.getQueryData(PLUGINS_KEY)).toBeTruthy();
      expect(enabledInCache(client)).toBeNull();
    });

    act(() => {
      result.current.toggle("b");
    });

    // Optimistic write is synchronous: default (all) minus the toggled-off 'b'.
    expect(enabledInCache(client)).toEqual(["a", "c"]);

    await waitFor(() => expect(enabledPluginsPutSpy).toHaveBeenCalled());
    const call = (enabledPluginsPutSpy.mock.calls[0] as unknown[])[0] as {
      path: { assistant_id: string; id: string };
      body: { enabledPlugins: string[] | null };
    };
    expect(call.path).toEqual({ assistant_id: ASSISTANT_ID, id: CONVERSATION_ID });
    expect(new Set(call.body.enabledPlugins)).toEqual(new Set(["a", "c"]));

    // No draft stash was touched — this is the server-row path.
    expect(
      useConversationStore.getState().pendingDraftPlugins.has(CONVERSATION_ID),
    ).toBe(false);
  });

  test("draft toggle → store action only, no network", async () => {
    // Conversation read rejects → no server row → draft path.
    conversationImpl = noServerRow;
    const { result, client } = renderSetHook();

    await waitFor(() => expect(client.getQueryData(PLUGINS_KEY)).toBeTruthy());

    act(() => {
      result.current.toggle("b");
    });

    // Materialized the explicit set "all installed except 'b'" into the store.
    await waitFor(() =>
      expect(
        useConversationStore.getState().pendingDraftPlugins.has(CONVERSATION_ID),
      ).toBe(true),
    );
    const stash = useConversationStore
      .getState()
      .pendingDraftPlugins.get(CONVERSATION_ID)!;
    expect(new Set(stash)).toEqual(new Set(["a", "c"]));

    // No network on the draft path.
    expect(enabledPluginsPutSpy).not.toHaveBeenCalled();
  });

  test("PUT failure → rollback optimistic write + error toast", async () => {
    conversationImpl = () => Promise.resolve(conversationWith(["a"]));
    const putDeferred = deferred<{ data: unknown }>();
    putImpl = () => putDeferred.promise;

    const { result, client } = renderSetHook();

    await waitFor(() => {
      expect(client.getQueryData(PLUGINS_KEY)).toBeTruthy();
      expect(enabledInCache(client)).toEqual(["a"]);
    });

    act(() => {
      result.current.toggle("b");
    });

    // Optimistic: prior scope ['a'] plus the toggled-on 'b'.
    expect(new Set(enabledInCache(client) ?? [])).toEqual(new Set(["a", "b"]));
    await waitFor(() => expect(enabledPluginsPutSpy).toHaveBeenCalled());

    // Reject → catch rolls the cache back to the prior scope and toasts.
    putDeferred.reject(new Error("500 — boom"));

    await waitFor(() => expect(toastErrorSpy).toHaveBeenCalled());
    await waitFor(() => expect(enabledInCache(client)).toEqual(["a"]));
    expect(captureErrorSpy).toHaveBeenCalled();
  });
});
