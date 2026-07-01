/**
 * Tests for `usePluginToggle`, the optimistic enable/disable mutation backing
 * the Plugins tab toggle. It flips the installed row's `enabled` across every
 * cached `pluginsGet` variant (unfiltered + each `?category=` read)
 * immediately, treats a 409 (already-in-state) as success, rolls back only the
 * toggled row's field and toasts on real failure, invalidates the plugin
 * queries on settle, and exposes the in-flight `togglingName`.
 *
 * The generated SDK layer is mocked so the enable/disable endpoints resolve
 * locally with a controllable HTTP status (or reject, to drive the rollback
 * branch); the design-library barrel is mocked so `toast.error` is spy-able.
 * Module-level holders let a case gate the request pending, set the response
 * status, or force the endpoint to reject.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { PLUGIN_TOGGLE_ERROR } from "@/domains/intelligence/plugins/constants";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const NAME = "alpha";
const CATEGORY = "system";

// Per-test holders the SDK mocks read. `*Status` sets the HTTP status the
// matching endpoint responds with (200 ok, 409 already-in-state). `*Fails`
// forces the matching endpoint to reject (a network-level failure).
// `toggleGate`, when set, holds the request pending so a case can assert the
// optimistic state before it settles.
let enableStatus = 200;
let disableStatus = 200;
let enableFails = false;
let disableFails = false;
let toggleGate: Promise<unknown> | null = null;

function respond(status: number) {
  return {
    data: { ok: true },
    error: undefined,
    response: new Response(null, { status }),
  };
}

const enableSpy = mock(async (_options: unknown) => {
  if (toggleGate) await toggleGate;
  if (enableFails) throw new Error("enable failed");
  return respond(enableStatus);
});
const disableSpy = mock(async (_options: unknown) => {
  if (toggleGate) await toggleGate;
  if (disableFails) throw new Error("disable failed");
  return respond(disableStatus);
});

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsByNameEnablePost: enableSpy,
  pluginsByNameDisablePost: disableSpy,
}));

const toastErrorSpy = mock((_message: string) => {});
const dlActual = await import("@vellumai/design-library");
mock.module("@vellumai/design-library", () => ({
  ...dlActual,
  toast: Object.assign((_message: string) => {}, {
    success: () => {},
    error: toastErrorSpy,
    dismiss: () => {},
  }),
}));

const { pluginsGetQueryKey } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
const { usePluginToggle } = await import(
  "@/domains/intelligence/plugins/use-plugin-toggle"
);

const LIST_KEY = pluginsGetQueryKey({
  path: { assistant_id: ASSISTANT_ID },
  query: { q: undefined },
});
// The distinct key `usePluginsList` reads when a category rail item is picked.
const CATEGORY_KEY = pluginsGetQueryKey({
  path: { assistant_id: ASSISTANT_ID },
  query: { q: undefined, category: CATEGORY },
});

function listOf(
  plugins: Array<{ name: string; enabled: boolean }>,
): PluginsGetResponse {
  return {
    plugins: plugins.map(({ name, enabled }) => ({
      id: name,
      name,
      description: null,
      version: null,
      enabled,
    })),
  } as PluginsGetResponse;
}

function cachedEnabled(
  client: QueryClient,
  name = NAME,
  key: readonly unknown[] = LIST_KEY,
): boolean | undefined {
  return client
    .getQueryData<PluginsGetResponse>(key)
    ?.plugins.find((p) => p.name === name)?.enabled;
}

function newClient() {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
}

function mountToggle(client: QueryClient) {
  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }
  return renderHook(() => usePluginToggle(ASSISTANT_ID), { wrapper });
}

function renderToggle({ enabled = true }: { enabled?: boolean } = {}) {
  const client = newClient();
  client.setQueryData<PluginsGetResponse>(LIST_KEY, listOf([{ name: NAME, enabled }]));
  const invalidateSpy = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidateSpy;

  const view = mountToggle(client);
  return { ...view, client, invalidateSpy };
}

beforeEach(() => {
  enableStatus = 200;
  disableStatus = 200;
  enableFails = false;
  disableFails = false;
  toggleGate = null;
  enableSpy.mockClear();
  disableSpy.mockClear();
  toastErrorSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("usePluginToggle", () => {
  test("flips enabled optimistically and exposes togglingName while pending", async () => {
    // Hold the request pending so the optimistic flip is observable before it
    // settles.
    let release: () => void = () => {};
    toggleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result, client } = renderToggle({ enabled: true });

    result.current.toggle(NAME, false);

    // The cached row flips to disabled and the in-flight name is exposed, all
    // before the endpoint resolves.
    await waitFor(() => expect(cachedEnabled(client)).toBe(false));
    expect(result.current.togglingName).toBe(NAME);

    // Once it settles, togglingName clears.
    release();
    await waitFor(() => expect(result.current.togglingName).toBe(null));
  });

  test("flips the row across category-filtered cache variants too", async () => {
    let release: () => void = () => {};
    toggleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const { result, client } = renderToggle({ enabled: true });
    // Seed a second, category-filtered cache holding the same row — the view a
    // selected category rail item mounts.
    client.setQueryData<PluginsGetResponse>(
      CATEGORY_KEY,
      listOf([{ name: NAME, enabled: true }]),
    );

    result.current.toggle(NAME, false);

    // Both the unfiltered and the category-filtered caches flip optimistically.
    await waitFor(() => expect(cachedEnabled(client)).toBe(false));
    expect(cachedEnabled(client, NAME, CATEGORY_KEY)).toBe(false);

    release();
    await waitFor(() => expect(result.current.togglingName).toBe(null));
  });

  test("calls the enable endpoint with the assistant + name path", async () => {
    const { result } = renderToggle({ enabled: false });

    result.current.toggle(NAME, true);

    await waitFor(() => expect(enableSpy).toHaveBeenCalledTimes(1));
    expect(enableSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
    });
    expect(disableSpy).not.toHaveBeenCalled();
  });

  test("calls the disable endpoint when disabling", async () => {
    const { result } = renderToggle({ enabled: true });

    result.current.toggle(NAME, false);

    await waitFor(() => expect(disableSpy).toHaveBeenCalledTimes(1));
    expect(disableSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
    });
    expect(enableSpy).not.toHaveBeenCalled();
  });

  test("treats a 409 (already in state) as success — no rollback, no toast", async () => {
    // Enabling an already-enabled plugin: the daemon 409s but the desired end
    // state already holds.
    enableStatus = 409;
    const { result, client, invalidateSpy } = renderToggle({ enabled: false });

    result.current.toggle(NAME, true);

    // Settles as success: the optimistic value stays, no rollback, no error
    // toast, and the invalidation still runs to reconcile with the server.
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
    expect(cachedEnabled(client)).toBe(true);
    expect(toastErrorSpy).not.toHaveBeenCalled();
    expect(result.current.togglingName).toBe(null);
  });

  test("rolls back the optimistic flip and toasts on error", async () => {
    disableFails = true;
    const { result, client } = renderToggle({ enabled: true });

    result.current.toggle(NAME, false);

    // Rolls back to the pre-toggle value and surfaces the failure copy.
    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(PLUGIN_TOGGLE_ERROR),
    );
    expect(cachedEnabled(client)).toBe(true);
    expect(result.current.togglingName).toBe(null);
  });

  test("rollback restores only the toggled row, preserving a concurrent update", async () => {
    // Two rows both enabled. `alpha` is toggled off and will fail; `beta` is
    // concurrently flipped off (as another client / mutation would) while
    // alpha's request is in flight.
    let release: () => void = () => {};
    toggleGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    disableFails = true;

    const client = newClient();
    client.setQueryData<PluginsGetResponse>(
      LIST_KEY,
      listOf([
        { name: "alpha", enabled: true },
        { name: "beta", enabled: true },
      ]),
    );
    const { result } = mountToggle(client);

    result.current.toggle("alpha", false);
    await waitFor(() => expect(cachedEnabled(client, "alpha")).toBe(false));

    // A concurrent update flips beta off while alpha's request is pending.
    client.setQueryData<PluginsGetResponse>(LIST_KEY, (prev) =>
      prev
        ? {
            ...prev,
            plugins: prev.plugins.map((p) =>
              p.name === "beta" ? { ...p, enabled: false } : p,
            ),
          }
        : prev,
    );

    // Alpha fails: only alpha is rolled back; beta's newer value survives.
    release();
    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(PLUGIN_TOGGLE_ERROR),
    );
    expect(cachedEnabled(client, "alpha")).toBe(true);
    expect(cachedEnabled(client, "beta")).toBe(false);
  });

  test("invalidates the plugin queries on settle", async () => {
    const { result, invalidateSpy } = renderToggle({ enabled: true });

    result.current.toggle(NAME, false);

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });
});
