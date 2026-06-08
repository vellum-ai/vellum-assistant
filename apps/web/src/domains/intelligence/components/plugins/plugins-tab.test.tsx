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
  pluginsGetQueryKey,
  pluginsSearchGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
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

  test("renders catalog matches linking to the detail page", () => {
    const html = renderTab({
      installed: { plugins: [] },
      catalog: {
        query: "",
        ref: "main",
        matches: [
          {
            name: "apollo-bot-brain",
            path: "experimental/plugins/apollo-bot-brain",
            source: { kind: "first-party" },
          },
        ],
      },
    });
    expect(html).toContain("apollo-bot-brain");
    expect(html).toContain("experimental/plugins/apollo-bot-brain");
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
            path: "experimental/plugins/simple-memory",
            source: { kind: "first-party" },
          },
          {
            name: "apollo-bot-brain",
            path: "experimental/plugins/apollo-bot-brain",
            source: { kind: "first-party" },
          },
        ],
      },
    });
    // The catalog path string is rendered only by CatalogRow, so its
    // absence proves the already-installed entry was suppressed there
    // (the installed row links to the same detail page but omits the path).
    expect(html).not.toContain("experimental/plugins/simple-memory");
    expect(html).toContain("experimental/plugins/apollo-bot-brain");
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
