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
  within,
} from "@testing-library/react";
import { MemoryRouter } from "react-router";
import { PLUGIN_INSTALL_ERROR } from "@/domains/intelligence/plugins/constants";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";
import type {
  PluginsByNameGetResponse,
  PluginsByNameInspectGetResponse,
  PluginsGetResponse,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

// The shared Skills taxonomy the rail renders from. Seeded by default so the
// rail gate hinges solely on whether the installed read carries categoryCounts.
const CATEGORY_DEFS: CategoryInfo[] = [
  { slug: "email", label: "Email", description: "Email tools", icon: "mail" },
  { slug: "system", label: "System", description: "System tools", icon: "settings" },
];

type InstalledPlugin = PluginsGetResponse["plugins"][number];
type CatalogMatch = PluginsSearchGetResponse["matches"][number];

// Per-test holders the SDK mocks read. `installedStatus` lets a case force the
// installed read into its failure branch (a non-ok, non-404 response).
// `installedCategoryCounts` (when set) makes the installed read taxonomy-aware,
// which is what gates the category rail.
let installedPlugins: InstalledPlugin[];
let installedStatus: number;
let installedCategoryCounts: Record<string, number> | undefined;
let catalogMatches: CatalogMatch[];
let categoryDefs: CategoryInfo[];
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
  // Mirrors the daemon: filter installed plugins by the requested category
  // slug, and (when taxonomy-aware) echo the UNFILTERED categoryCounts/total.
  pluginsGet: mock(async (options: { query?: { category?: string } }) => {
    const selected = options.query?.category;
    const plugins = selected
      ? installedPlugins.filter((p) => (p.category ?? "system") === selected)
      : installedPlugins;
    const body = installedCategoryCounts
      ? ({
          plugins,
          categoryCounts: installedCategoryCounts,
          totalCount: installedPlugins.length,
        } as PluginsGetResponse)
      : ({ plugins } as PluginsGetResponse);
    return {
      data: body,
      response: new Response(null, { status: installedStatus }),
      error: undefined,
    };
  }),
  pluginsSearchGet: mock(async () => ({
    data: { query: "", ref: "main", matches: catalogMatches } as PluginsSearchGetResponse,
    ...okResponse,
  })),
  // Backs the shared Skills category taxonomy the rail renders from.
  skillsCategoriesGet: mock(async () => ({
    data: { categories: categoryDefs },
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

// The tab-level mutations toast on success / error; spy on `toast` while
// keeping the rest of the design library (Button, Card, ConfirmDialog) real so
// the list still renders under happy-dom.
const toastSuccessSpy = mock((_message: string) => {});
const toastErrorSpy = mock((_message: string) => {});
const dlActual = await import("@vellumai/design-library");
mock.module("@vellumai/design-library", () => ({
  ...dlActual,
  toast: Object.assign((_message: string) => {}, {
    success: toastSuccessSpy,
    error: toastErrorSpy,
    dismiss: () => {},
  }),
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
    category: null,
    source: {
      kind: "github",
      repo: "acme/apollo-bot-brain",
      ref: "1111111111111111111111111111111111111111",
    },
    ...overrides,
  };
}

function renderTab(props: { plugin?: string } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const entry = props.plugin
    ? `/assistant/plugins?plugin=${encodeURIComponent(props.plugin)}`
    : "/assistant/plugins";
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={client}>
        <PluginsTab assistantId={ASSISTANT_ID} />
      </QueryClientProvider>
    </MemoryRouter>,
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

/**
 * Force `useIsMobile` true so the filter button opens the BottomSheet (the
 * mobile category surface) instead of the desktop Status popover. Returns a
 * restore fn the caller invokes once done.
 */
function forceMobile(): () => void {
  const original = window.matchMedia;
  window.matchMedia = ((query: string) => ({
    matches: true,
    media: query,
    onchange: null,
    addEventListener: () => {},
    removeEventListener: () => {},
    addListener: () => {},
    removeListener: () => {},
    dispatchEvent: () => false,
  })) as unknown as typeof window.matchMedia;
  return () => {
    window.matchMedia = original;
  };
}

beforeEach(() => {
  installedPlugins = [];
  installedStatus = 200;
  installedCategoryCounts = undefined;
  catalogMatches = [];
  categoryDefs = CATEGORY_DEFS;
  inspectByName = {};
  installSpy.mockClear();
  deleteSpy.mockClear();
  upgradeSpy.mockClear();
  toastSuccessSpy.mockClear();
  toastErrorSpy.mockClear();
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

  test("a successful inline install fires a success toast", async () => {
    catalogMatches = [catalog()];

    const { findByLabelText } = renderTab();
    fireEvent.click(await findByLabelText("Install plugin"));

    await waitFor(() => expect(toastSuccessSpy).toHaveBeenCalledTimes(1));
    expect(toastSuccessSpy.mock.calls[0]?.[0]).toContain("apollo-bot-brain");
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  test("a failed inline install surfaces an error toast", async () => {
    catalogMatches = [catalog()];
    // Force the next install into the mutation's error branch (the SDK throws
    // because the generated mutationFn passes `throwOnError: true`).
    installSpy.mockImplementationOnce(async () => {
      throw new Error("install failed");
    });

    const { findByLabelText } = renderTab();
    fireEvent.click(await findByLabelText("Install plugin"));

    await waitFor(() =>
      expect(toastErrorSpy).toHaveBeenCalledWith(PLUGIN_INSTALL_ERROR),
    );
    expect(toastSuccessSpy).not.toHaveBeenCalled();
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

    // The detail renders in-tab (the open plugin is held in `?plugin=`) — its
    // back affordance appears and the list chrome (the search box) is gone.
    const back = await findByLabelText("Back to plugins");
    expect(queryByLabelText("Search plugins")).toBeNull();

    fireEvent.click(back);

    // Back returns to the list view.
    expect(await findByLabelText("Search plugins")).toBeTruthy();
    expect(await findByText("simple-memory")).toBeTruthy();
  });

  test("?plugin= deep-links straight into the detail on mount", async () => {
    installedPlugins = [installed()];

    const { findByLabelText } = renderTab({ plugin: "simple-memory" });

    expect(await findByLabelText("Back to plugins")).toBeTruthy();
  });

  test("renders the category rail with counts when the daemon supports categories", async () => {
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
    ];
    installedCategoryCounts = { email: 1 };
    catalogMatches = [catalog({ name: "sys-cat", category: "system" })];

    const { findByRole } = renderTab();
    const nav = await findByRole("navigation", { name: "Plugin categories" });

    // "All" + each seeded Skills category renders a row.
    expect(within(nav).getByRole("button", { name: /All/ })).toBeTruthy();
    const emailRow = within(nav).getByRole("button", { name: /Email/ });
    const systemRow = within(nav).getByRole("button", { name: /System/ });
    // Email: 1 installed + 0 catalog. System: 0 installed + 1 catalog.
    expect(emailRow.textContent).toContain("1");
    expect(systemRow.textContent).toContain("1");
  });

  test("selecting a category filters both installed and available", async () => {
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
      installed({ id: "sysd", name: "sysd", category: "system" }),
    ];
    installedCategoryCounts = { email: 1, system: 1 };
    catalogMatches = [
      catalog({ name: "email-cat", category: "email" }),
      catalog({ name: "sys-cat", category: "system" }),
    ];

    const { findByRole, findByText, queryByText } = renderTab();

    // Everything shows under the default "All" selection.
    await findByText("mailer");
    expect(queryByText("sysd")).toBeTruthy();
    expect(queryByText("email-cat")).toBeTruthy();
    expect(queryByText("sys-cat")).toBeTruthy();

    const nav = await findByRole("navigation", { name: "Plugin categories" });
    fireEvent.click(within(nav).getByRole("button", { name: /Email/ }));

    // Installed filters server-side (?category=); available filters client-side.
    await waitFor(() => expect(queryByText("sysd")).toBeNull());
    expect(queryByText("sys-cat")).toBeNull();
    expect(queryByText("mailer")).toBeTruthy();
    expect(queryByText("email-cat")).toBeTruthy();
  });

  test("a plugin both installed and in the catalog is deduped from rows and counts", async () => {
    // `mailer` is installed AND surfaces in the catalog (the two reads are
    // independent). It must render once (installed) and count once, not twice.
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
    ];
    installedCategoryCounts = { email: 1 };
    catalogMatches = [
      catalog({ name: "mailer", category: "email" }),
      catalog({ name: "apollo-bot-brain", category: "email" }),
    ];

    const { findByRole, findByText, queryAllByText } = renderTab();
    const nav = await findByRole("navigation", { name: "Plugin categories" });

    // The fresh catalog plugin is Available; `mailer` renders once, never as a
    // second "Available" row alongside its installed row.
    await findByText("apollo-bot-brain");
    expect(queryAllByText("mailer")).toHaveLength(1);

    // Email: 1 installed + 1 deduped catalog (apollo) = 2 — NOT 3 (no double
    // count of the installed `mailer`). "All" mirrors the deduped union total.
    const allRow = within(nav).getByRole("button", { name: /All/ });
    const emailRow = within(nav).getByRole("button", { name: /Email/ });
    expect(allRow.textContent).toContain("2");
    expect(emailRow.textContent).toContain("2");
  });

  test("an installed plugin is not Available even when its catalog category differs", async () => {
    // Installed under "system" (e.g. the marketplace lookup degraded the
    // category), but its catalog entry is "email". Selecting Email must NOT
    // surface it as Available — dedup is against the UNFILTERED installed names.
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "system" }),
    ];
    installedCategoryCounts = { system: 1 };
    catalogMatches = [
      catalog({ name: "mailer", category: "email" }),
      catalog({ name: "apollo-bot-brain", category: "email" }),
    ];

    const { findByRole, findByText, queryByText } = renderTab();
    const nav = await findByRole("navigation", { name: "Plugin categories" });

    fireEvent.click(within(nav).getByRole("button", { name: /Email/ }));

    // `apollo` is the only Available row under Email; the installed `mailer`
    // (bucketed under system) is suppressed despite its email catalog entry.
    await findByText("apollo-bot-brain");
    await waitFor(() => expect(queryByText("mailer")).toBeNull());
  });

  test("falls back to a single column when the daemon omits categoryCounts", async () => {
    installedPlugins = [installed()];
    catalogMatches = [catalog()];
    // installedCategoryCounts stays undefined → older daemon, no rail.

    const { findByText, queryByRole } = renderTab();
    await findByText("simple-memory");

    expect(
      queryByRole("navigation", { name: "Plugin categories" }),
    ).toBeNull();
  });

  test("the mobile filter sheet surfaces the category taxonomy", async () => {
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
    ];
    installedCategoryCounts = { email: 1 };
    catalogMatches = [catalog({ name: "sys-cat", category: "system" })];

    const restoreMatchMedia = forceMobile();
    try {
      const { findByLabelText } = renderTab();
      // The desktop <aside> rail is hidden on mobile; the sheet is the only
      // category surface. Open it via the filter button.
      fireEvent.click(await findByLabelText("Filter plugins"));

      const sheet = await screen.findByRole("dialog");
      // Status stays available alongside the new Categories axis.
      expect(within(sheet).getByText("Status")).toBeTruthy();
      expect(within(sheet).getByText("Categories")).toBeTruthy();
      // "All" + each seeded Skills category renders a selectable row.
      expect(within(sheet).getByText("Email")).toBeTruthy();
      expect(within(sheet).getByText("System")).toBeTruthy();
    } finally {
      restoreMatchMedia();
    }
  });

  test("the mobile filter sheet omits Categories when the daemon lacks support", async () => {
    installedPlugins = [installed()];
    // installedCategoryCounts stays undefined → older daemon, no taxonomy.

    const restoreMatchMedia = forceMobile();
    try {
      const { findByLabelText } = renderTab();
      fireEvent.click(await findByLabelText("Filter plugins"));

      const sheet = await screen.findByRole("dialog");
      // Status is still offered, but no Categories section is rendered.
      expect(within(sheet).getByText("Status")).toBeTruthy();
      expect(within(sheet).queryByText("Categories")).toBeNull();
    } finally {
      restoreMatchMedia();
    }
  });

  test("hides the rail when no categories load even if categoryCounts is present", async () => {
    installedPlugins = [installed({ category: "email" })];
    installedCategoryCounts = { email: 1 };
    categoryDefs = [];

    const { findByText, queryByRole } = renderTab();
    await findByText("simple-memory");

    expect(
      queryByRole("navigation", { name: "Plugin categories" }),
    ).toBeNull();
  });
});
