/**
 * Focused tests for the presentational plugin-detail building blocks. The
 * panel/page tests cover the install/remove/upgrade flow end-to-end; this pins
 * `PluginDetailMetadata`'s net-new branch — the contributed-surface counts
 * (Skills / Hooks / Tools) that only render when an installed copy's drift
 * inspection supplies them — plus the `PluginDetailActions` Active/Off toggle.
 * Both are presentational, so no QueryClient is needed.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import {
    PluginDetailActions,
    PluginDetailMetadata,
} from "@/domains/intelligence/components/plugins/plugin-detail-shared";
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

const updateAvailableDrift: PluginDrift = {
  name: "level-up",
  installed: true,
  status: "update-available",
  local: null,
  remote: null,
  remoteError: null,
  surfaces: null,
};

const noop = () => {};

const baseActionsProps = {
  plugin: githubPlugin,
  drift: undefined,
  onInstall: noop,
  onRemove: noop,
  onUpgrade: noop,
  isInstalling: false,
  isRemoving: false,
  isUpgrading: false,
  hasLocalEdits: false,
};

describe("PluginDetailActions Active/Off control", () => {
  test("renders the Active segment checked for an enabled plugin", () => {
    render(
      <PluginDetailActions
        {...baseActionsProps}
        enabled
        onToggle={noop}
        isToggling={false}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "Active" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("renders the Off segment checked for a disabled plugin", () => {
    render(
      <PluginDetailActions
        {...baseActionsProps}
        enabled={false}
        onToggle={noop}
        isToggling={false}
      />,
    );

    expect(
      screen.getByRole("radio", { name: "Off" }).getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      screen.getByRole("radio", { name: "Active" }).getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("calls onToggle when the other segment is clicked (no confirm)", () => {
    const onToggle = mock(noop);
    render(
      <PluginDetailActions
        {...baseActionsProps}
        enabled
        onToggle={onToggle}
        isToggling={false}
      />,
    );

    fireEvent.click(screen.getByRole("radio", { name: "Off" }));

    expect(onToggle).toHaveBeenCalledTimes(1);
    // Optimistic: the state flips without opening any dialog.
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  test("keeps Upgrade available and enabled when the plugin is Off and drifted", () => {
    render(
      <PluginDetailActions
        {...baseActionsProps}
        drift={updateAvailableDrift}
        enabled={false}
        onToggle={noop}
        isToggling={false}
      />,
    );

    const upgrade = screen.getByRole("button", { name: /Upgrade/ });
    expect(upgrade.hasAttribute("disabled")).toBe(false);
  });

  test("Remove still opens its confirm dialog", async () => {
    render(
      <PluginDetailActions
        {...baseActionsProps}
        enabled
        onToggle={noop}
        isToggling={false}
      />,
    );

    fireEvent.click(screen.getByRole("button", { name: "Remove" }));

    expect(
      await screen.findByText(/Remove "level-up" from this assistant\?/),
    ).toBeTruthy();
  });

  test("hides the control when enablement is unknown", () => {
    render(<PluginDetailActions {...baseActionsProps} />);

    expect(screen.queryByRole("radiogroup")).toBeNull();
    expect(screen.queryByText("Active")).toBeNull();
    expect(screen.queryByText("Off")).toBeNull();
  });
});
