/**
 * Tests for `usePluginToggle`, the optimistic enable/disable mutation backing
 * the Plugins tab toggle. It flips the installed row's `enabled` in the cached
 * list immediately, rolls the snapshot back and toasts on failure, invalidates
 * the plugin queries on settle, and exposes the in-flight `togglingName`.
 *
 * The generated SDK layer is mocked so the enable/disable endpoints resolve
 * locally (or reject, to drive the rollback branch); the design-library barrel
 * is mocked so `toast.error` is spy-able. Module-level holders let a case gate
 * the request pending or force the endpoint to fail.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import { PLUGIN_TOGGLE_ERROR } from "@/domains/intelligence/plugins/constants";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const NAME = "alpha";
const okResponse = { response: new Response(), error: undefined };

// Per-test holders the SDK mocks read. `*Fails` forces the matching endpoint to
// reject (the rollback branch); `toggleGate`, when set, holds the request
// pending so a case can assert the optimistic state before it settles.
let enableFails = false;
let disableFails = false;
let toggleGate: Promise<unknown> | null = null;

const enableSpy = mock(async (_options: unknown) => {
  if (toggleGate) await toggleGate;
  if (enableFails) throw new Error("enable failed");
  return { data: { ok: true }, ...okResponse };
});
const disableSpy = mock(async (_options: unknown) => {
  if (toggleGate) await toggleGate;
  if (disableFails) throw new Error("disable failed");
  return { data: { ok: true }, ...okResponse };
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

function seededList(enabled: boolean): PluginsGetResponse {
  return {
    plugins: [
      { id: NAME, name: NAME, description: null, version: null, enabled },
    ],
  } as PluginsGetResponse;
}

function cachedEnabled(client: QueryClient): boolean | undefined {
  return client
    .getQueryData<PluginsGetResponse>(LIST_KEY)
    ?.plugins.find((p) => p.name === NAME)?.enabled;
}

function renderToggle({ enabled = true }: { enabled?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client.setQueryData<PluginsGetResponse>(LIST_KEY, seededList(enabled));
  const invalidateSpy = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidateSpy;

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  const view = renderHook(() => usePluginToggle(ASSISTANT_ID), { wrapper });
  return { ...view, client, invalidateSpy };
}

beforeEach(() => {
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

  test("invalidates the plugin queries on settle", async () => {
    const { result, invalidateSpy } = renderToggle({ enabled: true });

    result.current.toggle(NAME, false);

    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });
});
