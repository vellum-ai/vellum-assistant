/**
 * Tests for `NewChatPluginsPicker`, the revealed plugin picker. Presentational —
 * driven directly by props (installed list + selection callbacks) and rendered
 * to static markup. Assertions cover the header, info tooltip, Manage Plugins
 * link href, one pill per plugin, and the collapsed "Show all (+N)" cap.
 */

import { describe, expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import type { PluginsGetResponse } from "@/generated/daemon/types.gen";

import { NewChatPluginsPicker } from "./new-chat-plugins-picker";

type InstalledPlugin = PluginsGetResponse["plugins"][number];

function installed(name: string): InstalledPlugin {
  return { id: name, name, description: null, version: null };
}

function renderPicker(plugins: InstalledPlugin[]): string {
  return renderToStaticMarkup(
    <MemoryRouter>
      <NewChatPluginsPicker
        plugins={plugins}
        isSelected={() => true}
        toggle={() => {}}
      />
    </MemoryRouter>,
  );
}

describe("NewChatPluginsPicker", () => {
  test("renders the header, info tooltip, manage link, and one pill per plugin", () => {
    const html = renderPicker([
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

    const html = renderPicker(plugins);

    // First 12 pills render; the overflow is hidden behind the expander.
    expect(html).toContain("plugin-01");
    expect(html).toContain("plugin-12");
    expect(html).not.toContain("plugin-13");
    expect(html).not.toContain("plugin-14");
    expect(html).toContain("Show all (+2)");
  });
});
