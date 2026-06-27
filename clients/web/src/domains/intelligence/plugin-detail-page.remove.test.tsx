/**
 * Tests for the plugin detail page's remove flow: confirming a removal
 * fires the delete mutation and, on success, navigates back to the
 * plugins list rather than stranding the user on the now-empty detail
 * page (which would render a "We couldn't load this plugin" error once
 * the deleted plugin's detail query refetches).
 *
 * Mounted via `@testing-library/react` (happy-dom — see `test-setup.ts`)
 * so the click → confirm-dialog → mutation → navigation flow can be
 * exercised. The detail query is pre-seeded into the React Query cache
 * (with an infinite stale time) so it doesn't refetch on mount, and the
 * delete SDK call is spied so confirming never touches the network. The
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
  within,
} from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameGetData,
  PluginsByNameGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

// Spy the delete SDK call so confirming a removal resolves locally
// instead of hitting the daemon. Spread the real module so the rest of
// the generated client (used by the seeded query) stays intact.
const sdkActual = await import("@/generated/daemon/sdk.gen");
const okResponse = { response: new Response(), error: undefined };
const deleteSpy = mock(
  async (_options: { path: { assistant_id: string; name: string } }) => ({
    data: undefined,
    ...okResponse,
  }),
);
// The success path invalidates the list / search / detail / inspect
// queries, which refetch on the next tick. Stub those reads so the
// refetch resolves locally instead of hitting an absent daemon (which
// would log ECONNREFUSED). The body is irrelevant — nothing asserts on
// the refetched data.
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsByNameDelete: deleteSpy,
  pluginsGet: mock(async () => ({ data: { plugins: [] }, ...okResponse })),
  pluginsSearchGet: mock(async () => ({ data: { matches: [] }, ...okResponse })),
  pluginsByNameGet: mock(async (options: { path: { name: string } }) => ({
    data: installedDetail(options.path.name),
    ...okResponse,
  })),
  // The installed-plugin drift check fires on mount; stub it so it
  // resolves locally instead of dialing an absent daemon.
  pluginsByNameInspectGet: mock(async (options: { path: { name: string } }) => ({
    data: {
      name: options.path.name,
      installed: true,
      status: "up-to-date",
      local: null,
      remote: null,
      remoteError: null,
      surfaces: null,
    },
    ...okResponse,
  })),
}));

const { pluginsByNameGetQueryKey } = await import(
  "@/generated/daemon/@tanstack/react-query.gen"
);
const { PluginDetailPage } = await import(
  "@/domains/intelligence/plugin-detail-page"
);

function installedDetail(name: string): PluginsByNameGetResponse {
  return {
    name,
    installed: true,
    description: "Converts Telegram voice notes into text.",
    homepage: null,
    license: "MIT",
    version: "0.1.0",
    source: {
      kind: "github",
      repo: "vellum-ai/telegram-voice-transcribe",
      ref: "main",
    },
    readme: "# Telegram Voice Transcribe",
    ref: "main",
    artifact: null,
  };
}

function renderDetail(name: string): void {
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
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/assistant/plugins/${name}`]}>
        <Routes>
          <Route
            path="/assistant/plugins/:name"
            element={<PluginDetailPage />}
          />
          {/* A sentinel for the list route so the test can prove the
              page navigated here after the removal succeeded. */}
          <Route
            path="/assistant/plugins"
            element={<div>Plugins list landing</div>}
          />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
  deleteSpy.mockClear();
});

describe("PluginDetailPage remove flow", () => {
  test("removing a plugin navigates back to the plugins list", async () => {
    // GIVEN an installed plugin's detail page
    renderDetail("telegram-voice-transcribe");
    expect(screen.queryByText("Plugins list landing")).toBeNull();

    // WHEN the user clicks Remove and confirms in the dialog. Both the
    // header action and the dialog's confirm button read "Remove", so
    // scope the confirm click to the dialog.
    fireEvent.click(screen.getByRole("button", { name: "Remove" }));
    const dialog = await screen.findByRole("dialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Remove" }));

    // THEN the delete runs
    await waitFor(() => expect(deleteSpy).toHaveBeenCalledTimes(1));
    expect(deleteSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID, name: "telegram-voice-transcribe" },
    });

    // AND the user lands on the plugins list rather than staying on the
    // now-stale detail page
    await waitFor(() =>
      expect(screen.getByText("Plugins list landing")).toBeDefined(),
    );
  });
});
