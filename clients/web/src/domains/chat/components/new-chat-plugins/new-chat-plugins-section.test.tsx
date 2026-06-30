/**
 * Tests for `NewChatPluginsSection`, the plugin picker under the new-chat
 * composer. Rendered to static markup (no DOM needed): the installed list is
 * supplied by seeding the `pluginsGet` React Query cache so `useNewChatPlugins`
 * resolves synchronously on the first render, mirroring how `plugins-tab.test`
 * drives the same read. Assertions cover the header, the Manage Plugins link
 * href, one pill per plugin, the collapsed "Show all (+N)" cap, and the
 * nothing-installed null render.
 */

import { beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { pluginsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";

import { NewChatPluginsSection } from "./new-chat-plugins-section";

const ASSISTANT_ID = "asst-1";

type InstalledPlugin = PluginsGetResponse["plugins"][number];

function installed(name: string): InstalledPlugin {
  return { id: name, name, description: null, version: null };
}

/**
 * Render the section to static markup with the installed list pre-seeded in
 * the query cache so the data hook reports it synchronously.
 */
function renderSection(plugins: InstalledPlugin[]): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    pluginsGetQueryKey({
      path: { assistant_id: ASSISTANT_ID },
      query: { q: undefined },
    }),
    { plugins } as PluginsGetResponse,
  );

  return renderToStaticMarkup(
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NewChatPluginsSection assistantId={ASSISTANT_ID} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("draft-1");
});

describe("NewChatPluginsSection", () => {
  test("renders the header, info tooltip, manage link, and one pill per plugin", () => {
    const html = renderSection([
      installed("simple-memory"),
      installed("weather"),
      installed("calendar"),
    ]);

    expect(html).toContain("Add plugins for new chat");
    // The info tooltip trigger renders the lucide Info glyph.
    expect(html).toContain("lucide-info");
    // Manage Plugins links to the plugins route.
    expect(html).toContain("Manage Plugins");
    expect(html).toContain('href="/assistant/plugins"');
    // One pill per installed plugin.
    expect(html).toContain("simple-memory");
    expect(html).toContain("weather");
    expect(html).toContain("calendar");
    // Below the collapse threshold, no expander.
    expect(html).not.toContain("Show all");
  });

  test("caps the collapsed view and shows a Show all (+N) affordance", () => {
    const plugins = Array.from({ length: 14 }, (_, i) =>
      installed(`plugin-${String(i + 1).padStart(2, "0")}`),
    );

    const html = renderSection(plugins);

    // First 12 pills render; the overflow is hidden behind the expander.
    expect(html).toContain("plugin-01");
    expect(html).toContain("plugin-12");
    expect(html).not.toContain("plugin-13");
    expect(html).not.toContain("plugin-14");
    expect(html).toContain("Show all (+2)");
  });

  test("renders nothing when no plugins are installed", () => {
    expect(renderSection([])).toBe("");
  });
});
