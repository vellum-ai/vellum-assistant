/**
 * Tests for the merged My Superpowers tab: skills and plugins in a single
 * installed-first list behind one search box, one status/type/source filter,
 * and the shared category rail, with tab-level install/remove/upgrade.
 *
 * The generated SDK layer is mocked so the skills read (`skillsGet`), the
 * installed plugins read (`pluginsGet`), the catalog read (`pluginsSearchGet`),
 * the per-row drift inspect, and the mutations all resolve locally. Per-test
 * fixtures live in module-level holders the mocks read, letting each case
 * drive the payloads (or force a read to fail for the error state). The
 * backwards-compat plugin surface gate is driven through the real identity
 * store (`setIdentity` with a version above/below the plugin minimum).
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
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
import { MemoryRouter, useLocation } from "react-router";
import { PLUGIN_INSTALL_ERROR } from "@/domains/intelligence/plugins/constants";
import type { CategoryInfo } from "@/domains/intelligence/skills/use-skill-categories";
import type {
  PluginsByNameGetResponse,
  PluginsByNameInspectGetResponse,
  PluginsGetResponse,
  PluginsSearchGetResponse,
  SkillsGetResponse,
} from "@/generated/daemon/types.gen";
import { MIN_VERSION as PLUGINS_MIN_VERSION } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";
const okResponse = { response: new Response(), error: undefined };

// The shared Skills taxonomy the rail renders from.
const CATEGORY_DEFS: CategoryInfo[] = [
  { slug: "email", label: "Email", description: "Email tools", icon: "mail" },
  { slug: "system", label: "System", description: "System tools", icon: "settings" },
];

type InstalledPlugin = PluginsGetResponse["plugins"][number];
type CatalogMatch = PluginsSearchGetResponse["matches"][number];
type Skill = SkillsGetResponse["skills"][number];

// Per-test holders the SDK mocks read. `installedStatus` lets a case force the
// installed read into its failure branch (a non-ok, non-404 response).
// `installedCategoryCounts` (when set) makes the installed read taxonomy-aware,
// which is what keeps plugins visible under a selected category.
let skills: Skill[];
let installedPlugins: InstalledPlugin[];
let installedStatus: number;
let installedCategoryCounts: Record<string, number> | undefined;
let catalogMatches: CatalogMatch[];
let categoryDefs: CategoryInfo[];
let inspectByName: Record<string, PluginsByNameInspectGetResponse>;
// When set, the installed read awaits this gate before resolving — lets a test
// hold a category-filtered installed read pending after the initial load.
let installedGate: Promise<unknown> | null = null;

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
  // Mirrors the daemon's server-side skills filtering: kind, origin, category
  // and substring search all narrow the returned list.
  skillsGet: mock(
    async (options: {
      query?: { kind?: string; origin?: string; category?: string; q?: string };
    }) => {
      const { kind, origin, category, q } = options.query ?? {};
      const filtered = skills.filter((s) => {
        if (kind === "installed" && s.kind === "catalog") {return false;}
        if (kind === "available" && s.kind !== "catalog") {return false;}
        if (origin && s.origin !== origin) {return false;}
        if (category && (s.category ?? "system") !== category) {return false;}
        if (q && !s.name.toLowerCase().includes(q.toLowerCase())) {return false;}
        return true;
      });
      return {
        data: { skills: filtered } as SkillsGetResponse,
        ...okResponse,
      };
    },
  ),
  pluginsInstallPost: installSpy,
  pluginsByNameDelete: deleteSpy,
  pluginsByNameUpgradePost: upgradeSpy,
  // Mirrors the daemon: filter installed plugins by the requested category
  // slug, and (when taxonomy-aware) echo the UNFILTERED categoryCounts/total.
  pluginsGet: mock(async (options: { query?: { category?: string } }) => {
    if (installedGate) {await installedGate;}
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
  // Backs the shared category taxonomy the rail renders from.
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

const { SuperpowersTab } = await import("./superpowers-tab");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function skill(overrides: Partial<Skill> = {}): Skill {
  return {
    id: "focus-timer",
    name: "focus-timer",
    description: "A focus timer skill",
    kind: "installed",
    status: "enabled",
    origin: "custom",
    category: "system",
    ...overrides,
  } as Skill;
}

function installed(overrides: Partial<InstalledPlugin> = {}): InstalledPlugin {
  // `enabled` is omitted by default (older-daemon shape); the cast is needed
  // because the generated element type marks it required.
  return {
    id: "simple-memory",
    name: "simple-memory",
    description: "Memory plugin",
    version: "0.1.0",
    ...overrides,
  } as InstalledPlugin;
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
    icon: null,
    hasIcon: false,
    iconVersion: null,
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

function renderTab(props: { plugin?: string; success?: boolean } = {}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  const params = new URLSearchParams();
  if (props.plugin) {
    params.set("plugin", props.plugin);
  }
  if (props.success) {
    params.set("success", "true");
  }
  const query = params.toString();
  const entry = query
    ? `/assistant/superpowers?${query}`
    : "/assistant/superpowers";
  return render(
    <MemoryRouter initialEntries={[entry]}>
      <QueryClientProvider client={client}>
        <SuperpowersTab assistantId={ASSISTANT_ID} />
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

/** Surfaces the live URL search string so tests can assert param changes. */
function LocationProbe() {
  const location = useLocation();
  return <div data-testid="location-search">{location.search}</div>;
}

/** Click the filter option whose visible label matches (popover portal). */
function clickFilterOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) {
    throw new Error(`expected a "${label}" filter option`);
  }
  fireEvent.click(option);
}

/**
 * Force `useIsMobile` true so the filter button opens the BottomSheet (the
 * mobile category surface) instead of the desktop filter popover. Returns a
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
  skills = [];
  installedPlugins = [];
  installedStatus = 200;
  installedCategoryCounts = undefined;
  catalogMatches = [];
  categoryDefs = CATEGORY_DEFS;
  inspectByName = {};
  installedGate = null;
  installSpy.mockClear();
  deleteSpy.mockClear();
  upgradeSpy.mockClear();
  toastSuccessSpy.mockClear();
  toastErrorSpy.mockClear();
  // Plugin-surface capable by default; individual tests drop below the
  // minimum to exercise the skills-only degradation.
  useAssistantIdentityStore
    .getState()
    .setIdentity("Test", PLUGINS_MIN_VERSION, ASSISTANT_ID);
});

afterEach(() => {
  cleanup();
  useAssistantIdentityStore.getState().clearIdentity();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SuperpowersTab", () => {
  test("renders skills and plugins together, installed first", async () => {
    skills = [skill({ id: "zz-skill", name: "zz-skill" })];
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText } = renderTab();

    expect(await findByText("zz-skill")).toBeTruthy();
    expect(await findByText("simple-memory")).toBeTruthy();
    expect(await findByText("apollo-bot-brain")).toBeTruthy();

    // Installed rows (the skill and the plugin, alphabetical) precede the
    // available catalog row.
    const rows = Array.from(
      document.querySelectorAll<HTMLElement>('li [role="button"]'),
    ).map((r) => r.textContent ?? "");
    const indexOf = (name: string) =>
      rows.findIndex((text) => text.includes(name));
    expect(indexOf("simple-memory")).toBeLessThan(indexOf("zz-skill"));
    expect(indexOf("zz-skill")).toBeLessThan(indexOf("apollo-bot-brain"));

    // No two-section layout.
    expect(queryByText("Available to install")).toBeNull();
  });

  test("plugin rows carry a Plugin badge; skill rows don't", async () => {
    skills = [skill()];
    installedPlugins = [installed()];

    const { findByText } = renderTab();
    await findByText("focus-timer");
    await findByText("simple-memory");

    const rowFor = (name: string) =>
      Array.from(
        document.querySelectorAll<HTMLElement>('li [role="button"]'),
      ).find((r) => r.textContent?.includes(name));
    expect(rowFor("simple-memory")?.textContent).toContain("Plugin");
    expect(rowFor("focus-timer")?.textContent).not.toContain("Plugin");
  });

  test("the Skills type filter hides plugin rows", async () => {
    skills = [skill()];
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("simple-memory");

    fireEvent.click(getByLabelText("Filter superpowers"));
    clickFilterOption("Skills");

    await waitFor(() => expect(queryByText("simple-memory")).toBeNull());
    expect(queryByText("apollo-bot-brain")).toBeNull();
    expect(queryByText("focus-timer")).toBeTruthy();
  });

  test("the Plugins type filter hides skill rows", async () => {
    skills = [skill()];
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("focus-timer");

    fireEvent.click(getByLabelText("Filter superpowers"));
    clickFilterOption("Plugins");

    await waitFor(() => expect(queryByText("focus-timer")).toBeNull());
    expect(queryByText("simple-memory")).toBeTruthy();
    expect(queryByText("apollo-bot-brain")).toBeTruthy();
  });

  test("a skill-origin filter narrows skills and hides plugins", async () => {
    skills = [
      skill({ id: "mine", name: "mine", origin: "custom" }),
      skill({ id: "shipped", name: "shipped", origin: "vellum" }),
    ];
    installedPlugins = [installed()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("simple-memory");

    fireEvent.click(getByLabelText("Filter superpowers"));
    clickFilterOption("Custom");

    await waitFor(() => expect(queryByText("simple-memory")).toBeNull());
    expect(queryByText("shipped")).toBeNull();
    expect(queryByText("mine")).toBeTruthy();
  });

  test("the Installed filter drops available rows of both kinds", async () => {
    skills = [
      skill(),
      skill({ id: "cat-skill", name: "cat-skill", kind: "catalog", status: "available" }),
    ];
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("apollo-bot-brain");

    fireEvent.click(getByLabelText("Filter superpowers"));
    clickFilterOption("Installed");

    await waitFor(() => expect(queryByText("apollo-bot-brain")).toBeNull());
    expect(queryByText("cat-skill")).toBeNull();
    expect(queryByText("focus-timer")).toBeTruthy();
    expect(queryByText("simple-memory")).toBeTruthy();
  });

  test("the Available filter narrows to catalog rows of both kinds", async () => {
    skills = [
      skill(),
      skill({ id: "cat-skill", name: "cat-skill", kind: "catalog", status: "available" }),
    ];
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("simple-memory");

    fireEvent.click(getByLabelText("Filter superpowers"));
    clickFilterOption("Available");

    await waitFor(() => expect(queryByText("simple-memory")).toBeNull());
    expect(queryByText("focus-timer")).toBeNull();
    expect(queryByText("cat-skill")).toBeTruthy();
    expect(queryByText("apollo-bot-brain")).toBeTruthy();
  });

  test("search filters both kinds after the debounce settles", async () => {
    skills = [skill()];
    installedPlugins = [installed()];
    catalogMatches = [catalog()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("simple-memory");

    fireEvent.change(getByLabelText("Search superpowers"), {
      target: { value: "apollo" },
    });

    // The term debounces into the query layer (and re-keys the skills query),
    // so give the debounce window + refetch a beat to settle before asserting.
    await new Promise((r) => setTimeout(r, 600));
    await waitFor(
      () => {
        expect(queryByText("apollo-bot-brain")).toBeTruthy();
        expect(queryByText("simple-memory")).toBeNull();
        expect(queryByText("focus-timer")).toBeNull();
      },
      { timeout: 2000 },
    );
  });

  test("hides the Type group on assistants without the plugin surface", async () => {
    useAssistantIdentityStore.getState().setIdentity("Test", "0.1.0", ASSISTANT_ID);
    skills = [skill()];
    installedPlugins = [installed()];

    const { findByText, queryByText, getByLabelText } = renderTab();
    await findByText("focus-timer");

    // Plugin rows never surface without the plugin routes.
    expect(queryByText("simple-memory")).toBeNull();

    fireEvent.click(getByLabelText("Filter superpowers"));
    const labels = Array.from(
      document.querySelectorAll<HTMLElement>('[role="option"]'),
    ).map((o) => o.textContent?.trim());
    expect(labels).not.toContain("Plugins");
    expect(labels).toContain("Installed");
  });

  test("inline Install on an available plugin row triggers the install mutation", async () => {
    catalogMatches = [catalog()];

    const { findByLabelText } = renderTab();
    fireEvent.click(await findByLabelText("Install plugin"));

    await waitFor(() => expect(installSpy).toHaveBeenCalledTimes(1));
    expect(installSpy.mock.calls[0]?.[0]).toMatchObject({
      path: { assistant_id: ASSISTANT_ID },
      body: { name: "apollo-bot-brain" },
    });
  });

  test("a successful inline plugin install fires a success toast", async () => {
    catalogMatches = [catalog()];

    const { findByLabelText } = renderTab();
    fireEvent.click(await findByLabelText("Install plugin"));

    await waitFor(() => expect(toastSuccessSpy).toHaveBeenCalledTimes(1));
    expect(toastSuccessSpy.mock.calls[0]?.[0]).toContain("apollo-bot-brain");
    expect(toastErrorSpy).not.toHaveBeenCalled();
  });

  test("confirms an external install via ?success=true and strips the flag", async () => {
    installedPlugins = [installed({ name: "coffee-aficionado" })];

    renderTab({ plugin: "coffee-aficionado", success: true });

    await waitFor(() => expect(toastSuccessSpy).toHaveBeenCalledTimes(1));
    expect(toastSuccessSpy.mock.calls[0]?.[0]).toContain("coffee-aficionado");
    expect(toastErrorSpy).not.toHaveBeenCalled();

    // `success` is stripped (so a refresh won't re-toast); `plugin` stays so the
    // installed plugin's detail is still what's open.
    await waitFor(() => {
      const search = screen.getByTestId("location-search").textContent ?? "";
      expect(search).not.toContain("success");
      expect(search).toContain("plugin=coffee-aficionado");
    });
  });

  test("does not toast on a normal deep-link without ?success", async () => {
    installedPlugins = [installed({ name: "coffee-aficionado" })];

    renderTab({ plugin: "coffee-aficionado" });

    await screen.findByTestId("location-search");
    expect(toastSuccessSpy).not.toHaveBeenCalled();
  });

  test("a failed inline plugin install surfaces an error toast", async () => {
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

  test("inline plugin Remove opens the confirm dialog without deleting yet", async () => {
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
    expect(await findByText("No Superpowers Available")).toBeTruthy();
  });

  test("shows the error state when both reads fail", async () => {
    installedStatus = 500;
    const sdk = await import("@/generated/daemon/sdk.gen");
    (sdk.skillsGet as ReturnType<typeof mock>).mockImplementationOnce(
      async () => {
        throw new Error("skills read failed");
      },
    );

    const { findByText } = renderTab();
    expect(await findByText("Failed to load superpowers")).toBeTruthy();
  });

  test("degrades to skills with a notice when only the plugin read fails", async () => {
    skills = [skill()];
    installedStatus = 500;

    const { findByText } = renderTab();
    expect(await findByText("focus-timer")).toBeTruthy();
    expect(
      await findByText(
        "Plugins are temporarily unavailable. Skills are still listed below.",
      ),
    ).toBeTruthy();
  });

  test("selecting a plugin row opens the detail in-tab and back returns to the list", async () => {
    installedPlugins = [installed()];

    const { findByText, findByLabelText, queryByLabelText } = renderTab();
    // Click the row (the name bubbles up to the row's `onSelect`).
    fireEvent.click(await findByText("simple-memory"));

    // The detail renders in-tab (the open plugin is held in `?plugin=`) — its
    // back affordance appears and the list chrome (the search box) is gone.
    const back = await findByLabelText("Back to plugins");
    expect(queryByLabelText("Search superpowers")).toBeNull();

    fireEvent.click(back);

    // Back returns to the list view.
    expect(await findByLabelText("Search superpowers")).toBeTruthy();
    expect(await findByText("simple-memory")).toBeTruthy();
  });

  test("?plugin= deep-links straight into the detail on mount", async () => {
    installedPlugins = [installed()];

    const { findByLabelText } = renderTab({ plugin: "simple-memory" });

    expect(await findByLabelText("Back to plugins")).toBeTruthy();
  });

  test("rail counts merge skills and plugins per category", async () => {
    skills = [skill({ category: "email" })];
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
    ];
    installedCategoryCounts = { email: 1 };
    catalogMatches = [catalog({ name: "sys-cat", category: "system" })];

    const { findByRole } = renderTab();
    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });

    // Email: 1 skill + 1 installed plugin. System: 1 catalog plugin.
    // All: the deduped union total (3).
    expect(
      within(nav).getByRole("button", { name: /Email/ }).textContent,
    ).toContain("2");
    expect(
      within(nav).getByRole("button", { name: /System/ }).textContent,
    ).toContain("1");
    expect(
      within(nav).getByRole("button", { name: /All/ }).textContent,
    ).toContain("3");
  });

  test("hides the rail counts while a search term is active, restoring them when cleared", async () => {
    // Plugin search is client-side (the term never reaches the data hook), so
    // the count gating must key off the term — not react-query's fetch state.
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
    ];
    installedCategoryCounts = { email: 1 };
    catalogMatches = [catalog({ name: "sys-cat", category: "system" })];

    const { findByRole, getByLabelText } = renderTab();
    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });

    // With no active search the per-category badges show (email: 1, system: 1).
    expect(
      within(nav).getByRole("button", { name: /Email/ }).textContent,
    ).toContain("1");
    expect(
      within(nav).getByRole("button", { name: /System/ }).textContent,
    ).toContain("1");

    // Typing a term hides every badge — the unfiltered counts would mislead
    // while the visible rows are filtered client-side.
    fireEvent.change(getByLabelText("Search superpowers"), {
      target: { value: "mailer" },
    });
    await waitFor(() =>
      expect(
        within(nav).getByRole("button", { name: /Email/ }).textContent,
      ).not.toContain("1"),
    );
    expect(
      within(nav).getByRole("button", { name: /System/ }).textContent,
    ).not.toContain("1");

    // Clearing the term restores the badges.
    fireEvent.change(getByLabelText("Search superpowers"), {
      target: { value: "" },
    });
    await waitFor(() =>
      expect(
        within(nav).getByRole("button", { name: /Email/ }).textContent,
      ).toContain("1"),
    );
    expect(
      within(nav).getByRole("button", { name: /System/ }).textContent,
    ).toContain("1");
  });

  test("selecting a category filters skills, installed plugins, and the catalog", async () => {
    skills = [
      skill({ id: "mail-skill", name: "mail-skill", category: "email" }),
      skill({ id: "sys-skill", name: "sys-skill", category: "system" }),
    ];
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
    expect(queryByText("mail-skill")).toBeTruthy();
    expect(queryByText("sys-skill")).toBeTruthy();

    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });
    fireEvent.click(within(nav).getByRole("button", { name: /Email/ }));

    // Skills + installed plugins filter server-side (?category=); the catalog
    // filters client-side.
    await waitFor(() => expect(queryByText("sysd")).toBeNull());
    expect(queryByText("sys-cat")).toBeNull();
    expect(queryByText("sys-skill")).toBeNull();
    expect(queryByText("mailer")).toBeTruthy();
    expect(queryByText("email-cat")).toBeTruthy();
    expect(queryByText("mail-skill")).toBeTruthy();
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
    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });

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
    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });

    fireEvent.click(within(nav).getByRole("button", { name: /Email/ }));

    // `apollo` is the only Available row under Email; the installed `mailer`
    // (bucketed under system) is suppressed despite its email catalog entry.
    await findByText("apollo-bot-brain");
    await waitFor(() => expect(queryByText("mailer")).toBeNull());
  });

  test("hides plugins under a selected category when the daemon lacks the plugin taxonomy", async () => {
    // installedCategoryCounts stays undefined → the daemon ignores the
    // installed read's ?category= param, so plugin rows would leak into every
    // category. Skills still filter fine.
    skills = [skill({ id: "mail-skill", name: "mail-skill", category: "email" })];
    installedPlugins = [installed()];

    const { findByRole, findByText, queryByText } = renderTab();
    await findByText("simple-memory");

    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });
    fireEvent.click(within(nav).getByRole("button", { name: /Email/ }));

    await waitFor(() => expect(queryByText("simple-memory")).toBeNull());
    expect(queryByText("mail-skill")).toBeTruthy();
  });

  test("the mobile filter sheet surfaces status, type, source, and categories", async () => {
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
      fireEvent.click(await findByLabelText("Filter superpowers"));

      const sheet = await screen.findByRole("dialog");
      expect(within(sheet).getByText("Status")).toBeTruthy();
      expect(within(sheet).getByText("Type")).toBeTruthy();
      expect(within(sheet).getByText("Source")).toBeTruthy();
      expect(within(sheet).getByText("Categories")).toBeTruthy();
      // "All" + each seeded category renders a selectable row.
      expect(within(sheet).getByText("Email")).toBeTruthy();
      expect(within(sheet).getByText("System")).toBeTruthy();
    } finally {
      restoreMatchMedia();
    }
  });

  test("keeps the category rail mounted while a category-filtered read is pending", async () => {
    installedPlugins = [
      installed({ id: "mailer", name: "mailer", category: "email" }),
      installed({ id: "sysd", name: "sysd", category: "system" }),
    ];
    installedCategoryCounts = { email: 1, system: 1 };

    const { findByRole, queryByRole } = renderTab();
    const nav = await findByRole("navigation", {
      name: "Superpower categories",
    });

    // Hold every subsequent installed read pending, then select a category. The
    // filtered read stays in flight, but the rail must remain mounted so the
    // user can still switch or clear the category.
    let releaseInstalled: () => void = () => {};
    installedGate = new Promise<void>((resolve) => {
      releaseInstalled = resolve;
    });
    fireEvent.click(within(nav).getByRole("button", { name: /Email/ }));

    expect(
      queryByRole("navigation", { name: "Superpower categories" }),
    ).not.toBeNull();

    // Let the pending read resolve; the rail is still there afterward.
    releaseInstalled();
    await waitFor(() =>
      expect(
        queryByRole("navigation", { name: "Superpower categories" }),
      ).not.toBeNull(),
    );
  });
});
