/**
 * Tests for `NewChatPluginsSection`, the collapsed entry point under the
 * new-chat composer. Reads the installed list via `useNewChatPlugins` (seeded
 * through the pluginsGet query cache) and reveals the `NewChatPluginsPicker`
 * on click. Assertions cover the nothing-installed null render, the collapsed
 * default button, and the reveal interaction.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import { pluginsGetQueryKey } from "@/generated/daemon/@tanstack/react-query.gen";
import type { PluginsGetResponse } from "@/generated/daemon/types.gen";
import { useConversationStore } from "@/stores/conversation-store";

import { NewChatPluginsSection } from "./new-chat-plugins-section";

const ASSISTANT_ID = "asst-1";

type InstalledPlugin = PluginsGetResponse["plugins"][number];

function installed(name: string): InstalledPlugin {
  return { id: name, name, enabled: true, description: null, version: null };
}

/** Query client with the installed list pre-seeded so the hook resolves sync. */
function makeClient(plugins: InstalledPlugin[]): QueryClient {
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
  return client;
}

function ui(client: QueryClient) {
  return (
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <NewChatPluginsSection assistantId={ASSISTANT_ID} />
      </QueryClientProvider>
    </MemoryRouter>
  );
}

beforeEach(() => {
  useConversationStore.getState().reset();
  useConversationStore.getState().setActiveConversationId("draft-1");
});

afterEach(() => {
  cleanup();
});

describe("NewChatPluginsSection", () => {
  test("renders nothing when no plugins are installed", () => {
    expect(renderToStaticMarkup(ui(makeClient([])))).toBe("");
  });

  test("collapsed by default: shows the Add Plugins to Chat button, not the picker", () => {
    const html = renderToStaticMarkup(
      ui(makeClient([installed("simple-memory")])),
    );

    expect(html).toContain("Add Plugins to Chat");
    // The picker header and pills stay hidden until revealed.
    expect(html).not.toContain("Add plugins for new chat");
    expect(html).not.toContain("simple-memory");
  });

  test("clicking Add Plugins to Chat reveals the picker", () => {
    render(ui(makeClient([installed("simple-memory"), installed("weather")])));

    // Collapsed: the picker is absent.
    expect(screen.queryByText("Add plugins for new chat")).toBeNull();

    fireEvent.click(
      screen.getByRole("button", { name: "Add Plugins to Chat" }),
    );

    // Revealed: the picker header and one pill per plugin now render.
    expect(screen.getByText("Add plugins for new chat")).toBeTruthy();
    expect(screen.getByText("simple-memory")).toBeTruthy();
    expect(screen.getByText("weather")).toBeTruthy();
  });
});
