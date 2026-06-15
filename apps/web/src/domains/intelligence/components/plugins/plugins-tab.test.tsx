/**
 * Tests for the Plugins tab: installed + catalog sections rendered
 * together, catalog suppression of already-installed entries.
 *
 * Strategy: pre-populate the React Query cache with the data we want
 * the tab to render — `renderToStaticMarkup` is single-pass, so a
 * useQuery whose queryFn hasn't resolved yet always reports
 * `isLoading=true`. Pre-populating skips the pending state on first
 * render.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { MemoryRouter } from "react-router";

import {
  pluginsByNameInspectGetQueryKey,
  pluginsGetQueryKey,
  pluginsSearchGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameInspectGetData,
  PluginsByNameInspectGetResponse,
  PluginsGetData,
  PluginsGetResponse,
  PluginsSearchGetData,
  PluginsSearchGetResponse,
} from "@/generated/daemon/types.gen";

import { PluginsTab } from "./plugins-tab";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

interface CachedState {
  installed?: PluginsGetResponse;
  catalog?: PluginsSearchGetResponse;
  /** Inspect results keyed by plugin name, seeded for the row's drift query. */
  drift?: Record<string, PluginsByNameInspectGetResponse>;
}

function renderTab(state: CachedState): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  if (state.installed) {
    client.setQueryData(
      pluginsGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: { q: undefined },
      } as Options<PluginsGetData>),
      state.installed,
    );
  }
  if (state.catalog) {
    client.setQueryData(
      pluginsSearchGetQueryKey({
        path: { assistant_id: ASSISTANT_ID },
        query: { q: undefined },
      } as Options<PluginsSearchGetData>),
      state.catalog,
    );
  }
  for (const [name, inspect] of Object.entries(state.drift ?? {})) {
    client.setQueryData(
      pluginsByNameInspectGetQueryKey({
        path: { assistant_id: ASSISTANT_ID, name },
      } as Options<PluginsByNameInspectGetData>),
      inspect,
    );
  }
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <Wrapper>
        <PluginsTab assistantId={ASSISTANT_ID} />
      </Wrapper>
    </QueryClientProvider>,
  );
}

function Wrapper({ children }: { children: ReactNode }) {
  // Catalog/installed rows render react-router `<Link>`s, which need a
  // router context to resolve their `to` into an `<a href>`.
  return (
    <MemoryRouter>
      <div>{children}</div>
    </MemoryRouter>
  );
}

/**
 * Minimal inspect result for the row's drift query. The row only reads
 * `status`, so the local/remote blocks just need to be schema-valid.
 */
function driftResponse(
  name: string,
  status: PluginsByNameInspectGetResponse["status"],
): PluginsByNameInspectGetResponse {
  return {
    name,
    installed: true,
    status,
    local: {
      target: `/ws/plugins/${name}`,
      commit: "60a392b0000000000000000000000000000000aa",
      committedAt: null,
      version: "0.1.0",
      description: "Level Up plugin",
      installedAt: "2026-06-01T00:00:00.000Z",
      source: { kind: "github", owner: "vellum-ai", repo: name, ref: "main" },
      localChanges: { modified: [], added: [], removed: [], clean: true },
      issues: [],
    },
    remote: {
      repo: `vellum-ai/${name}`,
      path: "",
      commit:
        status === "update-available"
          ? "3eae1820000000000000000000000000000000bb"
          : "60a392b0000000000000000000000000000000aa",
      committedAt: null,
      description: "Level Up plugin",
      homepage: null,
      license: "MIT",
      category: null,
      marketplaceRef: "main",
    },
    remoteError: null,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("PluginsTab", () => {
  beforeEach(() => {
    // No per-test state to reset — each renderTab builds a fresh
    // QueryClient.
  });

  test("renders both section headers", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("Installed");
    expect(html).toContain("Available to install");
  });

  test("lists installed plugins under the Installed header", () => {
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "simple-memory",
            name: "simple-memory",
            description: "Memory plugin",
            version: "0.1.0",
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("simple-memory");
    expect(html).toContain("v0.1.0");
    expect(html).toContain("Memory plugin");
  });

  test("flags an installed plugin that is behind the marketplace pin", () => {
    // GIVEN an installed plugin whose inspect result reports drift
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "level-up",
            name: "level-up",
            description: "Level Up plugin",
            version: "0.1.0",
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
      drift: {
        "level-up": driftResponse("level-up", "update-available"),
      },
    });
    // THEN the row advertises the available update
    expect(html).toContain("Update available");
  });

  test("does not flag an installed plugin that is up to date", () => {
    // GIVEN an installed plugin whose inspect result reports no drift
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "level-up",
            name: "level-up",
            description: "Level Up plugin",
            version: "0.1.0",
          },
        ],
      },
      catalog: { query: "", ref: "main", matches: [] },
      drift: {
        "level-up": driftResponse("level-up", "up-to-date"),
      },
    });
    // THEN no update badge is rendered
    expect(html).not.toContain("Update available");
  });

  test("renders catalog matches linking to the detail page", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "apollo-bot-brain",
            path: "github:acme/apollo-bot-brain@1111111111111111111111111111111111111111",
            source: {
              kind: "github",
              repo: "acme/apollo-bot-brain",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
    });
    expect(html).toContain("apollo-bot-brain");
    expect(html).toContain(
      "github:acme/apollo-bot-brain@1111111111111111111111111111111111111111",
    );
    expect(html).toContain('href="/assistant/plugins/apollo-bot-brain"');
    // The inline CLI install hint was replaced by the detail page.
    expect(html).not.toContain("assistant plugins install");
  });

  test("suppresses catalog entries that are already installed", () => {
    const html = renderTab({
      installed: {
        plugins: [
          {
            id: "simple-memory",
            name: "simple-memory",
            description: null,
            version: null,
          },
        ],
      },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "simple-memory",
            path: "github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
            source: {
              kind: "github",
              repo: "vellum-ai/simple-memory",
              ref: "ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3",
            },
          },
          {
            name: "apollo-bot-brain",
            path: "github:acme/apollo-bot-brain@1111111111111111111111111111111111111111",
            source: {
              kind: "github",
              repo: "acme/apollo-bot-brain",
              ref: "1111111111111111111111111111111111111111",
            },
          },
        ],
      },
    });
    // CatalogRow renders the origin locator in a `title` attribute, which is
    // unique to the catalog row — the installed row links to the same detail
    // page (`/assistant/plugins/<name>`) but renders no such title. Asserting
    // on the title attribute proves the already-installed entry was suppressed
    // without colliding with the shared `/assistant/plugins/<name>` href.
    expect(html).not.toContain(
      'title="github:vellum-ai/simple-memory@ed09a4c01bf18e4ac8859faee94cb65c7cbd1ca3"',
    );
    expect(html).toContain(
      'title="github:acme/apollo-bot-brain@1111111111111111111111111111111111111111"',
    );
  });

  test("shows the installed empty state when nothing is installed", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("No Plugins Installed");
  });

  test("shows the catalog empty state when no catalog matches exist", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: { query: "", ref: "main", matches: [] },
    });
    expect(html).toContain("Catalog is empty");
  });
});
