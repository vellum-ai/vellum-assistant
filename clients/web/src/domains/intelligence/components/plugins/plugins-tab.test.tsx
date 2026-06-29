/**
 * Tests for the rewritten Plugins tab: a single installed-first list (not the
 * old two-section "Installed" / "Available to install" layout) filtered by a
 * status filter + in-memory search, with tab-level install/remove/upgrade.
 *
 * The generated SDK layer is mocked so the installed read (`pluginsGet`), the
 * catalog read (`pluginsSearchGet`), the per-row drift inspect, and the
 * mutations all resolve locally. Per-test fixtures live in module-level
 * holders the mocks read, letting each case drive the payloads (or force the
 * installed read to fail for the error state). Mounted via
 * `@testing-library/react` (happy-dom — see `clients/web/test-setup.ts`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type {
  PluginsByNameGetResponse,
  PluginsByNameInspectGetResponse,
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

type InstalledPlugin = PluginsGetResponse["plugins"][number];
type CatalogMatch = PluginsSearchGetResponse["matches"][number];

// Per-test holders the SDK mocks read. `installedStatus` lets a case force the
// installed read into its failure branch (a non-ok, non-404 response).
let installedPlugins: InstalledPlugin[];
let installedStatus: number;
let catalogMatches: CatalogMatch[];
let inspectByName: Record<string, PluginsByNameInspectGetResponse>;

const installSpy = mock(async (_options: unknown) => ({
  data: { ok: true },
  ...okResponse,
}));
const deleteSpy = mock(async (_options: unknown) => ({
  data: undefined,
  ...okResponse,
}));
const upgradeSpy = mock(async (_options: unknown) => ({
  data: undefined,
  ...okResponse,
}));

const sdkActual = await import("@/generated/daemon/sdk.gen");
mock.module("@/generated/daemon/sdk.gen", () => ({
  ...sdkActual,
  pluginsInstallPost: installSpy,
  pluginsByNameDelete: deleteSpy,
  pluginsByNameUpgradePost: upgradeSpy,
  pluginsGet: mock(async () => ({
    data: { plugins: installedPlugins } as PluginsGetResponse,
    response: new Response(null, { status: installedStatus }),
    error: undefined,
  })),
  pluginsSearchGet: mock(async () => ({
    data: { query: "", ref: "main", matches: catalogMatches } as PluginsSearchGetResponse,
    ...okResponse,
  })),
  pluginsByNameInspectGet: mock(async (options: { path: { name: string } }) => ({
    data: inspectByName[options.path.name] ?? upToDateInspect(options.path.name),
    ...okResponse,
  })),
  // Backs the in-tab detail (`usePluginDetail`) once a row is selected.
  pluginsByNameGet: mock(async (options: { path: { name: string } }) => ({
    data: pluginDetail(options.path.name),
    ...okResponse,
  })),
}));

const { PluginsTab } = await import("./plugins-tab");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  return {
    id: "simple-memory",
    name: "simple-memory",
    description: "Memory plugin",
    version: "0.1.0",
    ...overrides,
  };
}

/** Minimal schema-valid inspect result reporting no drift (the row reads
 *  `status`; the rest just needs to be non-undefined for React Query). */
function upToDateInspect(name: string): PluginsByNameInspectGetResponse {
  return {
    name,
    installed: true,
    status: "up-to-date",
    local: null,
    remote: null,
    remoteError: null,
    surfaces: null,
  };
}

/** Minimal schema-valid detail response backing the in-tab `PluginDetail`. */
function pluginDetail(name: string): PluginsByNameGetResponse {
  return {
    name,
    installed: true,
    description: null,
    homepage: null,
    license: null,
    version: "0.1.0",
    source: null,
    readme: null,
    ref: "main",
    artifact: null,
  };
}

function catalog(overrides: Partial<CatalogMatch> = {}): CatalogMatch {
  return {
    name: "apollo-bot-brain",
    path: "github:acme/apollo-bot-brain@1111111111111111111111111111111111111111",
    source: {
      kind: "github",
      repo: "acme/apollo-bot-brain",
      ref: "1111111111111111111111111111111111111111",
    },
    ...overrides,
  };
}

function renderTab(props: { initialPluginName?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return render(
    <QueryClientProvider client={client}>
      <PluginsTab assistantId={ASSISTANT_ID} {...props} />
    </QueryClientProvider>,
  );
}

/** Click the Status option whose visible label matches (popover portal). */
function clickStatusOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(`expected a "${label}" status option`);
  }
  fireEvent.click(option);
}

beforeEach(() => {
  installedPlugins = [];
  installedStatus = 200;
  catalogMatches = [];
  inspectByName = {};
  installSpy.mockClear();
  deleteSpy.mockClear();
  upgradeSpy.mockClear();
});

afterEach(() => {
  cleanup();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginsTab", () => {
  test("renders installed and available plugins in a single list", async () => {
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText } = renderTab();

    expect(await findByText("simple-memory")).toBeTruthy();
    expect(await findByText("apollo-bot-brain")).toBeTruthy();
    // The old two-section layout is gone.
    expect(queryByText("Available to install")).toBeNull();
  });

  test("status filter narrows the list to installed only", async () => {
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("apollo-bot-brain");

    fireEvent.click(getByLabelText("Filter plugins"));
    clickStatusOption("Installed");

    await waitFor(() => expect(queryByText("apollo-bot-brain")).toBeNull());
    expect(queryByText("simple-memory")).toBeTruthy();
  });

  test("search filters the list in memory", async () => {
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("simple-memory");

    fireEvent.change(getByLabelText("Search plugins"), {
      target: { value: "apollo" },
    });

    await waitFor(() => expect(queryByText("simple-memory")).toBeNull());
    expect(queryByText("apollo-bot-brain")).toBeTruthy();
  });

  test("inline Install on an available row triggers the install mutation", async () => {
    catalogMatches = [catalog()];

    const { findByLabelText } = renderTab();
    fireEvent.click(await findByLabelText("Install plugin"));

    await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
    expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: { name: "apollo-bot-brain" },
    });
  });

  test("inline Remove opens the confirm dialog without deleting yet", async () => {
    installedPlugins = [installed()];

    const { findByLabelText } = renderTab();
    fireEvent.click(await findByLabelText("Remove plugin"));

    // The destructive confirm dialog (portaled) gates the actual deletion.
    expect(
      await screen.findByText(/Remove "simple-memory" from this assistant\?/),
    ).toBeTruthy();
    expect(deleteSpy).not.toHaveBeenCalled();
  });

  test("shows the empty state when nothing is installed or available", async () => {
    const { findByText } = renderTab();
    expect(await findByText("No Plugins Found")).toBeTruthy();
  });

  test("shows the error state when the installed read fails", async () => {
    installedStatus = 500;

    const { findByText } = renderTab();
    expect(await findByText("Failed to load plugins")).toBeTruthy();
  });

  test("selecting a row opens the detail in-tab and back returns to the list", async () => {
    installedPlugins = [installed()];

    const { findByText, findByLabelText, queryByLabelText } = renderTab();
    // Click the row (the name bubbles up to the row's `onSelect`).
    fireEvent.click(await findByText("simple-memory"));

    // The detail renders in-tab — its back affordance appears and the list
    // chrome (the search box) is gone. No route change is involved.
    const back = await findByLabelText("Back to plugins");
    expect(queryByLabelText("Search plugins")).toBeNull();

    fireEvent.click(back);

    // Back returns to the list view.
    expect(await findByLabelText("Search plugins")).toBeTruthy();
    expect(await findByText("simple-memory")).toBeTruthy();
  });

  test("initialPluginName deep-links straight into the detail on mount", async () => {
    installedPlugins = [installed()];

    const { findByLabelText } = renderTab({ initialPluginName: "simple-memory" });

    expect(await findByLabelText("Back to plugins")).toBeTruthy();
  });
});
