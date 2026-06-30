/**
 * Focused tests for the presentational `PluginDetailMetadata` building block.
 * The panel/page tests cover the install/remove/upgrade flow end-to-end; this
 * pins the metadata table's net-new branch — the contributed-surface counts
 * (Skills / Hooks / Tools) that only render when an installed copy's drift
 * inspection supplies them. Presentational, so no QueryClient is needed.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { PluginDetailMetadata } from "@/domains/intelligence/components/plugins/plugin-detail-shared";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift";
import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen";

afterEach(() => {
  cleanup();
});

const githubPlugin: PluginsByNameGetResponse = {
  name: "level-up",
  installed: true,
  description: "Surfaces a Level Up diff card.",
  homepage: "https://example.com/level-up",
  license: "MIT",
  version: "0.1.0",
  source: { kind: "github", repo: "vellum-ai/level-up", ref: "main" },
  readme: "# Level Up",
  ref: "main",
  artifact: null,
};

describe("PluginDetailMetadata", () => {
  test("renders source repo link, homepage, and license rows", () => {
    const { container } = render(<PluginDetailMetadata plugin={githubPlugin} />);
    const html = container.innerHTML;

    expect(html).toContain("vellum-ai/level-up");
    expect(html).toContain('href="https://github.com/vellum-ai/level-up"');
    expect(html).toContain("https://example.com/level-up");
    expect(html).toContain("MIT");
    // Without surfaces, no contributed-surface counts appear.
    expect(html).not.toContain("Skills");
  });

  test("lists only the non-empty contributed-surface counts", () => {
    const surfaces: PluginDrift["surfaces"] = {
      skills: ["a", "b"],
      hooks: [],
      tools: ["t"],
    };
    const { container } = render(
      <PluginDetailMetadata plugin={githubPlugin} surfaces={surfaces} />,
    );
    const html = container.innerHTML;

    expect(html).toContain("Skills");
    expect(html).toContain("Tools");
    // An empty surface list is omitted rather than shown as "0".
    expect(html).not.toContain("Hooks");
  });

  test("labels a local plugin source without a repo link", () => {
    const localPlugin: PluginsByNameGetResponse = {
      ...githubPlugin,
      source: null,
      homepage: null,
      license: null,
    };
    const { container } = render(<PluginDetailMetadata plugin={localPlugin} />);
    const html = container.innerHTML;

    expect(html).toContain("Local");
    expect(html).not.toContain("href=\"https://github.com");
  });
});
