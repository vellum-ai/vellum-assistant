/**
 * Tests for the Plugins tab: installed + catalog sections rendered
 * together, catalog suppression of already-installed entries, error
 * branch.
 *
 * Strategy: pre-populate the React Query cache with the data we want
 * the tab to render — `renderToStaticMarkup` is single-pass, so a
 * useQuery whose queryFn hasn't resolved yet always reports
 * `isLoading=true`. Pre-populating skips the pending state on first
 * render. We mock the api module so the queryFn is never invoked.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

import type {
  PluginCatalogResponse,
  PluginsListResponse,
} from "@/domains/intelligence/plugins/types";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

// The api module is mocked so the pre-populated cache wins — no real
// fetch ever fires. The mock functions stay no-op since useQuery only
// calls them on cache miss.
mock.module("@/domains/intelligence/plugins/api", () => ({
  fetchPlugins: async (): Promise<PluginsListResponse> => ({ plugins: [] }),
  fetchPluginCatalog: async (): Promise<PluginCatalogResponse> => ({
    query: "",
    ref: "main",
    matches: [],
  }),
  ApiError: class ApiError extends Error {
    status: number;
    constructor(status: number, message: string) {
      super(message);
      this.status = status;
    }
  },
}));

const { PluginsTab } = await import(
  "@/domains/intelligence/components/plugins/plugins-tab"
);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ASSISTANT_ID = "asst-1";

interface CachedState {
  installed?: PluginsListResponse;
  catalog?: PluginCatalogResponse;
}

function renderTab(state: CachedState): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Pre-populate installed-plugins query
  if (state.installed) {
    client.setQueryData(
      ["assistantPlugins", ASSISTANT_ID, { q: "" }],
      state.installed,
    );
  }
  // Pre-populate catalog query
  if (state.catalog) {
    client.setQueryData(
      ["assistantPluginCatalog", ASSISTANT_ID, { q: "" }],
      state.catalog,
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
  return <div>{children}</div>;
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

  test("renders catalog matches with the install hint", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "apollo-bot-brain",
            path: "experimental/plugins/apollo-bot-brain",
          },
        ],
      },
    });
    expect(html).toContain("apollo-bot-brain");
    expect(html).toContain("experimental/plugins/apollo-bot-brain");
    expect(html).toContain("assistant plugins install apollo-bot-brain");
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
            path: "experimental/plugins/simple-memory",
          },
          {
            name: "apollo-bot-brain",
            path: "experimental/plugins/apollo-bot-brain",
          },
        ],
      },
    });
    // The catalog row for the installed plugin should not render its
    // install hint — the row is suppressed entirely. The other catalog
    // entry's row should still surface.
    expect(html).not.toContain("assistant plugins install simple-memory");
    expect(html).toContain("assistant plugins install apollo-bot-brain");
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

  // The catalog error branch (`CatalogErrorState`) is not exercised
  // here because `renderToStaticMarkup` is single-pass — React Query's
  // observer can't transition into the error state between render and
  // string emission. The error propagation is covered by
  // `api.test.ts` ("throws ApiError on 500"); the visual branch is
  // straightforward CSS and verified by hand.
});
