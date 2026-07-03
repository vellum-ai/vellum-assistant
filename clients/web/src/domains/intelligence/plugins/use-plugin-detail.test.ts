/**
 * Tests for `usePluginDetail`, the shared data hook backing the plugin detail
 * surfaces. It owns the single-plugin read, the install/remove/upgrade
 * mutations (each invalidating the list/search/detail/inspect queries on
 * success), and the `hasLocalEdits` signal derived from the drift inspection.
 *
 * The generated SDK layer is mocked so the mutations resolve locally and we can
 * assert which endpoint each action hits. The detail + inspect reads are seeded
 * into the React Query cache (infinite stale time) so the hook resolves on
 * mount without touching the network, mirroring the detail-page tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameGetData,
  PluginsByNameGetResponse,
  PluginsByNameInspectGetData,
  PluginsByNameInspectGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const NAME = "level-up";
const LOCAL_COMMIT = "60a392b0000000000000000000000000000000aa";
const REMOTE_COMMIT = "3eae1820000000000000000000000000000000bb";

const okResponse = { response: new Response(), error: undefined };

// Spy each mutation endpoint so the actions resolve locally and we can assert
// the path/body each one is called with.
const installSpy = mock(async (_options: unknown) => ({
  data: undefined,
  ...okResponse,
}));
const deleteSpy = mock(async (_options: unknown) => ({
  data: undefined,
  ...okResponse,
}));
const upgradeSpy = mock(async (_options: unknown) => ({
  data: {
    name: NAME,
    outcome: "upgraded" as const,
    fromCommit: LOCAL_COMMIT,
    toCommit: REMOTE_COMMIT,
    target: `/ws/plugins/${NAME}`,
    fileCount: 3,
    dryRun: false,
    provenanceWasUnknown: false,
  },
  ...okResponse,
}));

// Each success path invalidates the list/search/detail/inspect queries, which
// refetch on the next tick. Stub those reads so the refetch resolves locally
// instead of dialing an absent daemon.
const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsInstallPost: installSpy,
  pluginsByNameDelete: deleteSpy,
  pluginsByNameUpgradePost: upgradeSpy,
  pluginsGet: mock(async () => ({ data: { plugins: [] }, ...okResponse })),
  pluginsSearchGet: mock(async () => ({ data: { matches: [] }, ...okResponse })),
  pluginsByNameGet: mock(async (options: { path: { name: string } }) => ({
    data: installedDetail(options.path.name),
    ...okResponse,
  })),
  pluginsByNameInspectGet: mock(
    async (options: { path: { name: string } }) => ({
      data: inspectResponse(options.path.name, true),
      ...okResponse,
    }),
  ),
}));

const { pluginsByNameGetQueryKey, pluginsByNameInspectGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { usePluginDetail } = await import(
  "@/domains/intelligence/plugins/use-plugin-detail"
);

function installedDetail(name: string): PluginsByNameGetResponse {
  return {
    name,
    installed: true,
    description: "Surfaces a Level Up diff card.",
    homepage: null,
    license: "MIT",
    version: "0.1.0",
    source: { kind: "github", repo: "vellum-ai/level-up", ref: "main" },
    readme: "# Level Up",
    ref: "main",
    artifact: null,
  };
}

function inspectResponse(
  name: string,
  localClean: boolean,
): PluginsByNameInspectGetResponse {
  return {
    name,
    installed: true,
    status: "up-to-date",
    local: {
      target: `/ws/plugins/${name}`,
      commit: LOCAL_COMMIT,
      committedAt: null,
      version: "0.1.0",
      description: "Surfaces a Level Up diff card.",
      installedAt: "2026-06-01T00:00:00.000Z",
      source: {
        kind: "github",
        owner: "vellum-ai",
        repo: "level-up",
        ref: LOCAL_COMMIT,
      },
      localChanges: {
        modified: localClean ? [] : ["hooks/stop.ts"],
        added: [],
        removed: [],
        clean: localClean,
      },
      issues: [],
    },
    remote: null,
    remoteError: null,
    surfaces: null,
  };
}

interface RenderArgs {
  localClean?: boolean;
}

function renderPluginDetail({ localClean = true }: RenderArgs = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(
    pluginsByNameGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
    } as Options<PluginsByNameGetData>),
    installedDetail(NAME),
  );
  client.setQueryData(
    pluginsByNameInspectGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
    } as Options<PluginsByNameInspectGetData>),
    inspectResponse(NAME, localClean),
  );
  const invalidateSpy = mock(client.invalidateQueries.bind(client));
  client.invalidateQueries = invalidateSpy;

  function wrapper({ children }: { children: ReactNode }) {
    return createElement(QueryClientProvider, { client }, children);
  }

  const result = renderHook(() => usePluginDetail(ASSISTANT_ID, NAME), {
    wrapper,
  });
  return { ...result, invalidateSpy };
}

afterEach(() => {
  cleanup();
});

beforeEach(() => {
  installSpy.mockClear();
  deleteSpy.mockClear();
  upgradeSpy.mockClear();
});

describe("usePluginDetail", () => {
  test("resolves the seeded plugin from cache", () => {
    const { result } = renderPluginDetail();

    expect(result.current.plugin?.name).toBe(NAME);
    expect(result.current.isLoading).toBe(false);
    expect(result.current.isError).toBe(false);
  });

  test("install hits the install endpoint and invalidates on success", async () => {
    const { result, invalidateSpy } = renderPluginDetail();

    result.current.install();

    await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
    expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: { name: NAME },
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });

  test("remove hits the delete endpoint, invalidates, and fires onRemoved", async () => {
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
      },
    });
    client.setQueryData(
      pluginsByNameGetQueryKey({
        path: { assistant_id: ASSISTANT_ID, name: NAME },
      } as Options<PluginsByNameGetData>),
      installedDetail(NAME),
    );
    const invalidateSpy = mock(client.invalidateQueries.bind(client));
    client.invalidateQueries = invalidateSpy;
    const onRemoved = mock(() => {});

    function wrapper({ children }: { children: ReactNode }) {
      return createElement(QueryClientProvider, { client }, children);
    }

    const { result } = renderHook(
      () => usePluginDetail(ASSISTANT_ID, NAME, { onRemoved }),
      { wrapper },
    );

    result.current.remove();

    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(deleteSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
    });
    await waitFor(() => expect(onRemoved).toHaveBeenCalledTimes(1));
    expect(invalidateSpy).toHaveBeenCalled();
  });

  test("upgrade hits the upgrade endpoint and invalidates on success", async () => {
    const { result, invalidateSpy } = renderPluginDetail();

    result.current.upgrade();

    await waitFor(() => expect(upgradeSpy).toHaveBeenCalledTimes(1));
    expect(upgradeSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: NAME },
      body: {},
    });
    await waitFor(() => expect(invalidateSpy).toHaveBeenCalled());
  });

  test("hasLocalEdits reflects local.localChanges.clean", () => {
    const clean = renderPluginDetail({ localClean: true });
    expect(clean.result.current.hasLocalEdits).toBe(false);
    clean.unmount();

    const dirty = renderPluginDetail({ localClean: false });
    expect(dirty.result.current.hasLocalEdits).toBe(true);
  });
});
