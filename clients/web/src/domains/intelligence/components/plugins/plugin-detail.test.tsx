/**
 * Tests for the in-tab `PluginDetail` panel: it renders the README, the
 * tracked metadata (source/homepage/license), and the install/remove/upgrade
 * actions that reflect whether the plugin is installed and whether it has
 * drifted behind the marketplace pin. The back button invokes `onBack`.
 *
 * `PluginDetail` is callback-driven with no routing, so there's no
 * `MemoryRouter` or identity-store seeding here — just the React Query cache
 * pre-populated so the detail (and, for installed copies, the drift inspect)
 * queries resolve on mount instead of hitting the network. Uses
 * `@testing-library/react` (happy-dom) so the back-button click can be
 * exercised.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";

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

import { PluginDetail } from "@/domains/intelligence/components/plugins/plugin-detail";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-plugin-icons";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store";

const ASSISTANT_ID = "asst-1";
const LOCAL_COMMIT = "60a392b0000000000000000000000000000000aa";
const REMOTE_COMMIT = "3eae1820000000000000000000000000000000bb";

const PACKAGE = "\u{1F4E6}"; // 📦 — external (catalog) glyph
const PUZZLE = "\u{1F9E9}"; // 🧩 — local glyph

const realFetch = globalThis.fetch;

afterEach(() => {
  cleanup();
  globalThis.fetch = realFetch;
  // Reset the version gate PluginDetail reads for the bundled icon.
  useAssistantIdentityStore.setState({ version: null });
});

/**
 * Render `PluginDetail` with no seeded detail data so the query stays in its
 * loading state, exercising the gated/seeded header icon. `fetch` is stubbed
 * to never resolve so the detail query never settles mid-assertion.
 */
function renderLoadingDetail(externalHint?: boolean) {
  globalThis.fetch = (() =>
    new Promise<Response>(() => {})) as unknown as typeof fetch;
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  return render(
    <QueryClientProvider client={client}>
      <PluginDetail
        assistantId={ASSISTANT_ID}
        name="loading-plugin"
        onBack={() => {}}
        externalHint={externalHint}
      />
    </QueryClientProvider>,
  );
}

function upToDateInspect(
  name: string,
  installed: boolean,
): PluginsByNameInspectGetResponse {
  return {
    name,
    installed,
    status: "up-to-date",
    local: null,
    remote: null,
    remoteError: null,
    surfaces: null,
  };
}

function updateAvailableInspect(name: string): PluginsByNameInspectGetResponse {
  return {
    name,
    installed: true,
    status: "update-available",
    local: {
      target: `/ws/plugins/${name}`,
      commit: LOCAL_COMMIT,
      committedAt: null,
      version: "0.1.0",
      description: null,
      installedAt: "2026-06-01T00:00:00.000Z",
      source: {
        kind: "github",
        owner: "vellum-ai",
        repo: "level-up",
        ref: LOCAL_COMMIT,
      },
      localChanges: {
        modified: [],
        added: [],
        removed: [],
        clean: true,
      },
      issues: [],
    },
    remote: {
      repo: "vellum-ai/level-up",
      path: "",
      commit: REMOTE_COMMIT,
      committedAt: null,
      description: null,
      homepage: null,
      license: "MIT",
      category: null,
      marketplaceRef: "main",
    },
    remoteError: null,
    surfaces: null,
  };
}

function renderDetail(
  name: string,
  detail: PluginsByNameGetResponse,
  inspect: PluginsByNameInspectGetResponse,
) {
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
  client.setQueryData(
    pluginsByNameInspectGetQueryKey({
      path: { assistant_id: ASSISTANT_ID, name },
    } as Options<PluginsByNameInspectGetData>),
    inspect,
  );
  const onBack = mock(() => {});
  const result = render(
    <QueryClientProvider client={client}>
      <PluginDetail assistantId={ASSISTANT_ID} name={name} onBack={onBack} />
    </QueryClientProvider>,
  );
  return { ...result, onBack };
}

describe("PluginDetail", () => {
  test("renders README, metadata, and an Install button for an available plugin", () => {
    const { container } = renderDetail(
      "caveman",
      {
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
        icon: null,
        hasIcon: false,
        iconVersion: null,
      },
      upToDateInspect("caveman", false),
    );
    const html = container.innerHTML;

    // README markdown is rendered.
    expect(html).toContain("Makes the agent speak in grunts.");
    // Tracked metadata is surfaced.
    expect(html).toContain("example-org/caveman");
    expect(html).toContain("https://example.com/caveman");
    expect(html).toContain("MIT");
    // A github-sourced plugin is badged External.
    expect(html).toContain("External");
    // An available plugin offers Install, not Remove.
    expect(html).toContain("Install");
    expect(html).not.toContain("Remove");
  });

  test("renders a Remove action when the plugin is already installed", () => {
    const { container } = renderDetail(
      "simple-memory",
      {
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
        icon: null,
        hasIcon: false,
        iconVersion: null,
      },
      upToDateInspect("simple-memory", true),
    );
    const html = container.innerHTML;

    expect(html).toContain("Remove");
    // A plugin with no marketplace origin isn't badged External.
    expect(html).not.toContain("External");
    // No README falls back to an explanatory line.
    expect(html).toContain("ship a README");
    // With no artifact descriptor, no download affordance is offered.
    expect(html).not.toContain("Download");
  });

  test("offers an Upgrade action and update badge when an installed copy has drifted", () => {
    const { container } = renderDetail(
      "level-up",
      {
        name: "level-up",
        installed: true,
        description: "Surfaces a Level Up diff card.",
        homepage: null,
        license: "MIT",
        version: "0.1.0",
        source: { kind: "github", repo: "vellum-ai/level-up", ref: "main" },
        readme: "# Level Up",
        ref: "main",
        artifact: null,
        icon: null,
        hasIcon: false,
        iconVersion: null,
      },
      updateAvailableInspect("level-up"),
    );
    const html = container.innerHTML;

    expect(html).toContain("Update available");
    expect(html).toContain("Upgrade");
    // The drifted copy is still installed, so Remove remains available.
    expect(html).toContain("Remove");
  });

  test("offers a download linked to the artifact when an installed plugin ships one", () => {
    const url =
      "https://github.com/example-org/dynamic-notch/releases/download/v1.0.0/DynamicNotch.dmg";
    const { container } = renderDetail(
      "dynamic-notch",
      {
        name: "dynamic-notch",
        installed: true,
        description: "A dynamic notch companion.",
        homepage: null,
        license: "MIT",
        version: "1.0.0",
        source: {
          kind: "github",
          repo: "example-org/dynamic-notch",
          ref: "v1.0.0",
        },
        readme: "# Dynamic Notch",
        ref: "v1.0.0",
        artifact: { url, sha256: "a".repeat(64), label: "Download for macOS" },
        icon: null,
        hasIcon: false,
        iconVersion: null,
      },
      upToDateInspect("dynamic-notch", true),
    );
    const html = container.innerHTML;

    expect(html).toContain("Download for macOS");
    expect(html).toContain(`href="${url}"`);
    expect(html).toContain("Remove");
  });

  test("while loading with no externalHint, the header shows a glyph-less placeholder (no 🧩, no 📦)", () => {
    const { container } = renderLoadingDetail();

    // The detail query hasn't resolved and there's no seeded hint, so the
    // header must not flash either glyph (avoids the 🧩 → 📦 load flicker).
    expect(container.textContent).not.toContain(PUZZLE);
    expect(container.textContent).not.toContain(PACKAGE);
  });

  test("while loading with externalHint, the header shows the seeded 📦 (not 🧩)", () => {
    const { container } = renderLoadingDetail(true);

    expect(container.textContent).toContain(PACKAGE);
    expect(container.textContent).not.toContain(PUZZLE);
  });

  test("renders the external 📦 glyph once a github-sourced plugin has loaded", () => {
    const { container } = renderDetail(
      "caveman",
      {
        name: "caveman",
        installed: false,
        description: "Talk like a caveman.",
        homepage: null,
        license: null,
        version: "1.8.2",
        source: { kind: "github", repo: "example-org/caveman", ref: "v1.8.2" },
        readme: "# Caveman",
        ref: "v1.8.2",
        artifact: null,
        icon: null,
        hasIcon: false,
        iconVersion: null,
      },
      upToDateInspect("caveman", false),
    );

    expect(container.textContent).toContain(PACKAGE);
    expect(container.textContent).not.toContain(PUZZLE);
  });

  test("renders the author emoji when the plugin declares one, overriding the origin glyph", () => {
    const AUTHOR_EMOJI = "\u{1F3A8}"; // 🎨
    const { container } = renderDetail(
      "caveman",
      {
        name: "caveman",
        installed: false,
        description: "Talk like a caveman.",
        homepage: null,
        license: null,
        version: "1.8.2",
        source: { kind: "github", repo: "example-org/caveman", ref: "v1.8.2" },
        readme: "# Caveman",
        ref: "v1.8.2",
        artifact: null,
        icon: AUTHOR_EMOJI,
        hasIcon: false,
        iconVersion: null,
      },
      upToDateInspect("caveman", false),
    );

    expect(container.textContent).toContain(AUTHOR_EMOJI);
    expect(container.textContent).not.toContain(PACKAGE);
    expect(container.textContent).not.toContain(PUZZLE);
  });

  test("supporting daemon + hasIcon renders the bundled-icon <img>", () => {
    useAssistantIdentityStore.setState({ version: MIN_VERSION });

    const { container } = renderDetail(
      "simple-memory",
      {
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
        icon: null,
        hasIcon: true,
        iconVersion: "v9",
      },
      upToDateInspect("simple-memory", true),
    );

    const img = container.querySelector("img");
    expect(img).not.toBeNull();
    expect(img?.getAttribute("src")).toBe(
      `/v1/assistants/${ASSISTANT_ID}/plugins/simple-memory/icon?v=v9`,
    );
    // With the image showing, neither origin glyph is rendered.
    expect(container.textContent).not.toContain(PUZZLE);
    expect(container.textContent).not.toContain(PACKAGE);
  });

  test("gate off (older daemon) renders no <img> even with hasIcon", () => {
    // Version stays null (default) — the daemon doesn't serve the icon endpoint.
    const { container } = renderDetail(
      "simple-memory",
      {
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
        icon: null,
        hasIcon: true,
        iconVersion: "v9",
      },
      upToDateInspect("simple-memory", true),
    );

    expect(container.querySelector("img")).toBeNull();
    // Falls back to the local origin glyph.
    expect(container.textContent).toContain(PUZZLE);
  });

  test("invokes onBack when the back button is clicked", () => {
    const { getByLabelText, onBack } = renderDetail(
      "caveman",
      {
        name: "caveman",
        installed: false,
        description: "Talk like a caveman.",
        homepage: null,
        license: null,
        version: "1.8.2",
        source: { kind: "github", repo: "example-org/caveman", ref: "v1.8.2" },
        readme: "# Caveman",
        ref: "v1.8.2",
        artifact: null,
        icon: null,
        hasIcon: false,
        iconVersion: null,
      },
      upToDateInspect("caveman", false),
    );

    fireEvent.click(getByLabelText("Back to plugins"));
    expect(onBack).toHaveBeenCalledTimes(1);
  });
});
