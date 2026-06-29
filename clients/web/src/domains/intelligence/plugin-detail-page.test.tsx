/**
 * Tests for the plugin detail page: it renders the README, the tracked
 * metadata (source/homepage/license), and the install/remove action that
 * reflects whether the plugin is already installed.
 *
 * Strategy mirrors the Plugins tab tests — pre-populate the React Query
 * cache so the detail `useQuery` resolves on mount. The active assistant
 * id is stubbed via `mock.module`, matching the approach in
 * `intelligence-layout.test.tsx`, and the identity store is seeded with a
 * plugin-capable version so the backwards-compat gate lets the page render
 * instead of redirecting.
 *
 * Uses `@testing-library/react` (happy-dom) rather than
 * `renderToStaticMarkup`: the gate reads the assistant version off the
 * identity store, and zustand serves its *initial* snapshot during static
 * markup rendering (so a runtime-seeded version would read back null). A
 * client render reflects the seeded value.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import { MemoryRouter, Route, Routes } from "react-router";

import {
  pluginsByNameGetQueryKey,
  pluginsByNameInspectGetQueryKey,
} from "@/generated/daemon/@tanstack/react-query.gen";
import type { Options } from "@/generated/daemon/sdk.gen";
import type {
  PluginsByNameGetData,
  PluginsByNameGetResponse,
  PluginsByNameInspectGetData,
  PluginsByNameInspectGetResponse,
} from "@/generated/daemon/types.gen";
import { MIN_VERSION } from "@/lib/backwards-compat/plugins-surface";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";

mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const { PluginDetailPage } = await import(
  "@/domains/intelligence/plugin-detail-page"
);

// Seed a plugin-capable version before each test. The identity store is a
// shared singleton across web test files, so set it per-test rather than
// once at module load (a sibling file's teardown can otherwise clear it).
beforeEach(() => {
  useAssistantIdentityStore.getState().setIdentity("Test Assistant", MIN_VERSION);
});

afterEach(() => {
  cleanup();
});

function renderDetail(name: string, detail: PluginsByNameGetResponse): string {
  const client = new QueryClient({
    // Infinite stale time keeps the seeded queries from refetching on mount
    // (a client render runs query effects), so neither the detail read nor
    // the installed-copy drift inspect touches the network.
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  client.setQueryData(
    pluginsByNameGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name },
    } as Options<PluginsByNameGetData>),
    detail,
  );
  // The detail header inspects an installed copy for update drift; seed a
  // benign "up to date" result so that query also resolves from cache.
  client.setQueryData(
    pluginsByNameInspectGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name },
    } as Options<PluginsByNameInspectGetData>),
    {
      name,
      installed: detail.installed,
      status: "up-to-date",
      local: null,
      remote: null,
      remoteError: null,
      surfaces: null,
    } as PluginsByNameInspectGetResponse,
  );
  const { container } = render(
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[`/assistant/plugins/${name}`]}>
        <Routes>
          <Route path="/assistant/plugins/:name" element={<PluginDetailPage />} />
        </Routes>
      </MemoryRouter>
    </QueryClientProvider>,
  );
  return container.innerHTML;
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
