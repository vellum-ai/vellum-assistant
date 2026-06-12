/**
 * Tests for the plugin detail page's upgrade affordances: the
 * "Update available" badge + Upgrade button only appear when the
 * installed copy has drifted behind the marketplace pin, a clean copy
 * upgrades directly, and a locally-edited copy prompts for confirmation
 * before the re-install clobbers those edits.
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`)
 * so the click → confirm-dialog → mutation flow can be exercised. The
 * detail + inspect queries are pre-seeded into the React Query cache
 * (with an infinite stale time) so neither refetches on mount, and the
 * upgrade SDK call is spied so confirming never touches the network. The
 * feature-flag store and active assistant id are stubbed, matching the
 * sibling `plugin-detail-page.test.tsx`.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameGetData,
  PluginsByNameGetResponse,
  PluginsByNameInspectGetData,
  PluginsByNameInspectGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const LOCAL_COMMIT = "60a392b0000000000000000000000000000000aa";
const REMOTE_COMMIT = "3eae1820000000000000000000000000000000bb";

mock.module("@/stores/assistant-feature-flag-store", () => ({
  useAssistantFeatureFlagStore: {
    use: {
      hasHydrated: () => true,
      externalPlugins: () => true,
    },
  },
}));

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

// Spy the upgrade SDK call so confirming an upgrade resolves locally
// instead of hitting the daemon. Spread the real module so the rest of
// the generated client (used by the seeded queries) stays intact.
const sdkActual = await import("@/generated/daemon/sdk.gen");
const upgradeSpy = mock(
  async (options: { path: { name: string } }) =>
    ({
      data: {
        name: options.path.name,
        outcome: "upgraded" as const,
        fromCommit: LOCAL_COMMIT,
        toCommit: REMOTE_COMMIT,
        target: `/ws/plugins/${options.path.name}`,
        fileCount: 3,
        dryRun: false,
        provenanceWasUnknown: false,
      },
      response: new Response(),
    }) as Awaited<ReturnType<typeof sdkActual.pluginsByNameUpgradePost>>,
);
// The success path invalidates the list / search / detail / inspect
// queries, which refetch on the next tick. Stub those reads so the
// refetch resolves locally instead of hitting an absent daemon (which
// would log ECONNREFUSED). The body is irrelevant — nothing asserts on
// the refetched data.
const okResponse = { response: new Response(), error: undefined };
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsByNameUpgradePost: upgradeSpy,
  pluginsGet: mock(async () => ({ data: { plugins: [] }, ...okResponse })),
  pluginsSearchGet: mock(async () => ({ data: { matches: [] }, ...okResponse })),
  pluginsByNameGet: mock(async (options: { path: { name: string } }) => ({
    data: installedDetail(options.path.name),
    ...okResponse,
  })),
  pluginsByNameInspectGet: mock(async (options: { path: { name: string } }) => ({
    data: inspectResponse(options.path.name, { status: "up-to-date" }),
    ...okResponse,
  })),
}));

const { pluginsByNameGetQueryKey, pluginsByNameInspectGetQueryKey } =
  await import("@/generated/daemon/@tanstack/react-query.gen");
const { PluginDetailPage } = await import(
  "@/domains/intelligence/plugin-detail-page"
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
  {
    status,
    localClean = true,
  }: {
    status: PluginsByNameInspectGetResponse["status"];
    localClean?: boolean;
  },
): PluginsByNameInspectGetResponse {
  const behind = status === "update-available";
  return {
    name,
    installed: true,
    status,
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
    remote: {
      repo: "vellum-ai/level-up",
      path: "",
      commit: behind ? REMOTE_COMMIT : LOCAL_COMMIT,
      committedAt: null,
      description: "Surfaces a Level Up diff card.",
      homepage: null,
      license: "MIT",
      category: null,
      marketplaceRef: "main",
    },
    remoteError: null,
  };
}

function renderDetail(
  name: string,
  inspect: PluginsByNameInspectGetResponse,
): void {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(
    pluginsByNameGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name },
    } as Options<PluginsByNameGetData>),
    installedDetail(name),
  );
  client.setQueryData(
    pluginsByNameInspectGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name },
    } as Options<PluginsByNameInspectGetData>),
    inspect,
  );
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/assistant/plugins/${name}`]}>
        <Routes>
          <Route
            path="/assistant/plugins/:name"
            element={<PluginDetailPage />}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  upgradeSpy.mockClear();
});

describe("PluginDetailPage upgrade flow", () => {
  test("badges and upgrades a clean copy that has drifted behind the pin", async () => {
    // GIVEN an installed plugin whose copy is behind the marketplace pin
    // AND has no local edits
    renderDetail(
      "level-up",
      inspectResponse("level-up", { status: "update-available" }),
    );

    // THEN the drift is advertised on the header
    expect(screen.getByText("Update available")).toBeDefined();
    const upgradeButton = screen.getByRole("button", { name: "Upgrade" });

    // WHEN the user clicks Upgrade
    fireEvent.click(upgradeButton);

    // THEN the upgrade runs immediately (a clean copy needs no
    // confirmation) and no local-edits warning is shown
    await waitFor(() => expect(upgradeSpy).toHaveBeenCalledTimes(1));
    expect(
      screen.queryByText(/local edits that will be overwritten/i),
    ).toBeNull();
    expect(upgradeSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: "level-up" },
      body: {},
    });
  });

  test("hides the upgrade affordances when the copy is up to date", () => {
    // GIVEN an installed plugin already on the marketplace pin
    renderDetail(
      "level-up",
      inspectResponse("level-up", { status: "up-to-date" }),
    );

    // THEN neither the badge nor the Upgrade button render
    expect(screen.queryByText("Update available")).toBeNull();
    expect(screen.queryByRole("button", { name: "Upgrade" })).toBeNull();
  });

  test("confirms before clobbering local edits, then upgrades", async () => {
    // GIVEN an installed plugin that is behind the pin AND locally edited
    renderDetail(
      "level-up",
      inspectResponse("level-up", {
        status: "update-available",
        localClean: false,
      }),
    );

    // WHEN the user clicks Upgrade
    fireEvent.click(screen.getByRole("button", { name: "Upgrade" }));

    // THEN a confirmation warns the edits will be overwritten and the
    // upgrade has not yet run
    expect(
      await screen.findByText(/local edits that will be overwritten/i),
    ).toBeDefined();
    expect(upgradeSpy).not.toHaveBeenCalled();

    // WHEN the user confirms
    fireEvent.click(screen.getByRole("button", { name: "Upgrade anyway" }));

    // THEN the upgrade runs
    await waitFor(() => expect(upgradeSpy).toHaveBeenCalledTimes(1));
  });
});
