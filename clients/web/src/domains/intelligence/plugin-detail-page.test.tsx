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
      artifact: null,
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
      source: null,
      readme: null,
      ref: "main",
      artifact: null,
    });

    expect(html).toContain("Remove");
    // A plugin with no marketplace origin isn't badged external.
    expect(html).not.toContain("external");
    // No README falls back to an explanatory line.
    expect(html).toContain("ship a README");
    // With no artifact descriptor, no download affordance is offered.
    expect(html).not.toContain("Download");
  });

  test("offers a generic download linked to the artifact when an installed plugin ships one", () => {
    const url =
      "https://github.com/example-org/dynamic-notch/releases/download/v1.0.0/DynamicNotch.dmg";
    const html = renderDetail("dynamic-notch", {
      name: "dynamic-notch",
      installed: true,
      description: "A dynamic notch companion.",
      homepage: null,
      license: "MIT",
      version: "1.0.0",
      source: { kind: "github", repo: "example-org/dynamic-notch", ref: "v1.0.0" },
      readme: "# Dynamic Notch",
      ref: "v1.0.0",
      artifact: { url, sha256: "a".repeat(64) },
    });

    // With no label on the artifact, the button falls back to a generic name.
    expect(html).toContain("Download");
    expect(html).toContain(`href="${url}"`);
    // The plugin is installed, so Remove is still available alongside it.
    expect(html).toContain("Remove");
  });

  test("uses the artifact's label for the download button when one is provided", () => {
    const url =
      "https://github.com/example-org/dynamic-notch/releases/download/v1.0.0/DynamicNotch.dmg";
    const html = renderDetail("dynamic-notch", {
      name: "dynamic-notch",
      installed: true,
      description: "A dynamic notch companion.",
      homepage: null,
      license: "MIT",
      version: "1.0.0",
      source: { kind: "github", repo: "example-org/dynamic-notch", ref: "v1.0.0" },
      readme: "# Dynamic Notch",
      ref: "v1.0.0",
      artifact: { url, sha256: "a".repeat(64), label: "Download for macOS" },
    });

    // The plugin-provided label names the download.
    expect(html).toContain("Download for macOS");
    expect(html).toContain(`href="${url}"`);
  });

  test("does not offer a download before an artifact-bearing plugin is installed", () => {
    const html = renderDetail("dynamic-notch", {
      name: "dynamic-notch",
      installed: false,
      description: "A dynamic notch companion.",
      homepage: null,
      license: "MIT",
      version: "1.0.0",
      source: { kind: "github", repo: "example-org/dynamic-notch", ref: "v1.0.0" },
      readme: "# Dynamic Notch",
      ref: "v1.0.0",
      artifact: {
        url: "https://github.com/example-org/dynamic-notch/releases/download/v1.0.0/DynamicNotch.dmg",
        sha256: "a".repeat(64),
      },
    });

    // The install gate hides the download until the plugin is installed.
    expect(html).toContain("Install");
    expect(html).not.toContain("Download");
  });
});
