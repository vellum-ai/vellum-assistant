/**
 * Tests for the plugin detail page: it renders the README, the tracked
 * metadata (source/homepage/license), and the install/remove action that
 * reflects whether the plugin is already installed.
 *
 * Strategy mirrors the Plugins tab tests — pre-populate the React Query
 * cache so the detail `useQuery` resolves on the first (single-pass)
 * `renderToStaticMarkup` render. The feature-flag store and active
 * assistant id are stubbed via `mock.module`, matching the approach in
 * `intelligence-layout.test.tsx`.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter, Route, Routes } from "react-router";

import {
  pluginsByNameGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameGetData,
  PluginsByNameGetResponse,
} from "@/generated/daemon/types.gen";

const ASSISTANT_ID = "asst-1";

// The real feature-flag store imports the generated API client, which
// isn't available under the test runner. Stub the two selectors the page
// reads so the flag gate passes and the detail content renders.
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

const { PluginDetailPage } = await import(
  "@/domains/intelligence/plugin-detail-page"
);

function renderDetail(name: string, detail: PluginsByNameGetResponse): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    pluginsByNameGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name },
    } as Options<PluginsByNameGetData>),
    detail,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/assistant/plugins/${name}`]}>
        <Routes>
          <Route path="/assistant/plugins/:name" element={<PluginDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("PluginDetailPage", () => {
  test("renders README, metadata, and an Install button for an available plugin", () => {
    const html = renderDetail("caveman", {
      name: "caveman",
      installed: false,
      description: "Talk like a caveman.",
      homepage: "https://example.com/caveman",
      license: "MIT",
      version: "1.8.2",
      source: { kind: "github", repo: "example-org/caveman", ref: "v1.8.2" },
      readme: "# Caveman\n\nMakes the agent speak in grunts.",
      ref: "v1.8.2",
    });

    // README markdown is rendered.
    expect(html).toContain("Makes the agent speak in grunts.");
    // Tracked metadata is surfaced.
    expect(html).toContain("example-org/caveman");
    expect(html).toContain("https://example.com/caveman");
    expect(html).toContain("MIT");
    expect(html).toContain("external");
    // An available plugin offers Install, not Remove.
    expect(html).toContain("Install");
    expect(html).not.toContain("Remove");
  });

  test("renders a Remove action when the plugin is already installed", () => {
    const html = renderDetail("simple-memory", {
      name: "simple-memory",
      installed: true,
      description: null,
      homepage: null,
      license: null,
      version: "0.1.0",
      source: { kind: "first-party" },
      readme: null,
      ref: "main",
    });

    expect(html).toContain("Remove");
    // First-party plugins aren't badged external.
    expect(html).not.toContain("external");
    // No README falls back to an explanatory line.
    expect(html).toContain("ship a README");
  });
});
