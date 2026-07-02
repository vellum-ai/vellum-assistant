/**
 * Tests for `PluginDetailMobile` — the single-column phone plugin-detail
 * overlay.
 *
 * The data hook (`usePluginDetail`) is mocked so the component renders a fixed
 * plugin plus drift state without touching React Query or the daemon client. A
 * mutable `hookState` lets individual tests swap the plugin (installed vs not)
 * and drift (update available or not). We verify the back wiring, the header
 * content (title + full description), and that the shared Install / Remove /
 * Upgrade action set surfaces per state — including that Remove stays reachable
 * alongside Upgrade when an update is available (the action set now comes from
 * `plugin-detail-shared`, which renders both together).
 *
 * Mounted via `@testing-library/react` (happy-dom — see `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import type { PluginsByNameGetResponse } from "@/generated/daemon/types.gen.js";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift.js";

function makePlugin(
  overrides: Partial<PluginsByNameGetResponse> = {},
): PluginsByNameGetResponse {
  return {
    name: "test-plugin",
    installed: true,
    description: "A plugin used in mobile detail tests",
    homepage: null,
    license: null,
    version: "1.0.0",
    source: null,
    readme: "# Readme heading",
    ref: "main",
    artifact: null,
    ...overrides,
  };
}

const UPDATE_DRIFT = { status: "update-available" } as unknown as PluginDrift;

const PACKAGE = "\u{1F4E6}"; // 📦 — external (catalog) glyph
const PUZZLE = "\u{1F9E9}"; // 🧩 — local glyph

// Mutable so individual tests can swap the plugin / drift before rendering.
const hookState: {
  plugin: PluginsByNameGetResponse | null;
  drift: PluginDrift | undefined;
  isLoading: boolean;
  isError: boolean;
  isInstalling: boolean;
  isRemoving: boolean;
  isUpgrading: boolean;
  hasLocalEdits: boolean;
} = {
  plugin: makePlugin(),
  drift: undefined,
  isLoading: false,
  isError: false,
  isInstalling: false,
  isRemoving: false,
  isUpgrading: false,
  hasLocalEdits: false,
};

function resetHookState(): void {
  hookState.plugin = makePlugin();
  hookState.drift = undefined;
  hookState.isLoading = false;
  hookState.isError = false;
  hookState.isInstalling = false;
  hookState.isRemoving = false;
  hookState.isUpgrading = false;
  hookState.hasLocalEdits = false;
}

mock.module("@/domains/intelligence/plugins/use-plugin-detail", () => ({
  usePluginDetail: () => ({
    ...hookState,
    install: () => {},
    remove: () => {},
    upgrade: () => {},
    isInstallError: false,
    isRemoveError: false,
    isUpgradeError: false,
  }),
  // `shortSha` is not stubbed: `PluginDetailActions` now imports it from
  // `plugins/utils`, so the real helper runs.
}));

// Stub the toggle hook so the mobile detail doesn't require a QueryClient here.
mock.module("@/domains/intelligence/plugins/use-plugin-toggle", () => ({
  usePluginToggle: () => ({ toggle: () => {}, togglingName: null }),
}));

const { PluginDetailMobile } = await import(
  "@/domains/intelligence/components/plugins/plugin-detail-mobile.js"
);

afterEach(() => {
  cleanup();
  resetHookState();
});

function getButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) {
    throw new Error(`expected a button with aria-label="${label}"`);
  }
  return match;
}

/**
 * The shared `PluginDetailActions` labels its buttons with text (not
 * aria-label), so match by accessible name.
 */
function getActionButton(name: string): HTMLButtonElement {
  return screen.getByRole("button", { name }) as HTMLButtonElement;
}

function queryActionButton(name: string): HTMLButtonElement | null {
  return screen.queryByRole("button", { name }) as HTMLButtonElement | null;
}

describe("PluginDetailMobile", () => {
  test("back button calls onBack", () => {
    const onBack = mock(() => {});

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={onBack} />,
    );

    fireEvent.click(getButton("Back to plugins"));

    expect(onBack).toHaveBeenCalledTimes(1);
  });

  test("renders the title and full description", () => {
    hookState.plugin = makePlugin({
      name: "My Plugin",
      description: "A long description that should not be clamped.",
    });

    render(
      <PluginDetailMobile assistantId="asst-1" name="My Plugin" onBack={() => {}} />,
    );

    // Title appears both in the action bar and the header block.
    expect(screen.getAllByText("My Plugin").length).toBeGreaterThan(0);
    expect(
      screen.getByText("A long description that should not be clamped."),
    ).toBeTruthy();
  });

  test("renders the README markdown", () => {
    hookState.plugin = makePlugin({ readme: "# Readme heading" });

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(screen.getByText("Readme heading")).toBeTruthy();
  });

  test("uninstalled plugin: install action appears", () => {
    hookState.plugin = makePlugin({ installed: false });

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(getActionButton("Install")).toBeTruthy();
    // An available plugin offers Install, not Remove.
    expect(queryActionButton("Remove")).toBeNull();
  });

  test("installed plugin: remove action appears", () => {
    hookState.plugin = makePlugin({ installed: true });

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(getActionButton("Remove")).toBeTruthy();
  });

  test("installed plugin: auto-include toggle appears when enabled is provided", () => {
    hookState.plugin = makePlugin({ installed: true });

    render(
      <PluginDetailMobile
        assistantId="asst-1"
        name="test-plugin"
        onBack={() => {}}
        enabled={true}
      />,
    );

    // The Auto-include Toggle renders a role="switch"; mobile detail must wire
    // it so phone users can enable/disable, matching desktop detail.
    expect(screen.getByRole("switch")).toBeTruthy();
  });

  test("installed plugin: no toggle when enabled is undefined", () => {
    hookState.plugin = makePlugin({ installed: true });

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(screen.queryByRole("switch")).toBeNull();
  });

  test("while loading with no externalHint, the header shows a glyph-less placeholder (no 🧩, no 📦)", () => {
    // No resolved plugin and no seeded hint: the header must not flash either
    // glyph (avoids the 🧩 → 📦 load flicker).
    hookState.plugin = null;
    hookState.isLoading = true;

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(document.body.textContent).not.toContain(PUZZLE);
    expect(document.body.textContent).not.toContain(PACKAGE);
  });

  test("while loading with externalHint, the header shows the seeded 📦 (not 🧩)", () => {
    hookState.plugin = null;
    hookState.isLoading = true;

    render(
      <PluginDetailMobile
        assistantId="asst-1"
        name="test-plugin"
        onBack={() => {}}
        externalHint
      />,
    );

    expect(document.body.textContent).toContain(PACKAGE);
    expect(document.body.textContent).not.toContain(PUZZLE);
  });

  test("renders the external 📦 glyph once a github-sourced plugin has loaded", () => {
    hookState.plugin = makePlugin({
      source: { kind: "github", repo: "vellum-ai/level-up", ref: "main" },
    });

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(document.body.textContent).toContain(PACKAGE);
    expect(document.body.textContent).not.toContain(PUZZLE);
  });

  test("origin badge stays hidden until the plugin loads", () => {
    // While loading there's no `source`, so the badge would mislabel the
    // plugin as Local. It must not render until the plugin resolves.
    hookState.plugin = null;
    hookState.isLoading = true;

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(screen.queryByText("Local")).toBeNull();
    expect(screen.queryByText("External")).toBeNull();
  });

  test("update available: Upgrade and Remove are both reachable, plus the badge", () => {
    // Regression for Codex P2: an update must not hide the uninstall path. The
    // shared action set renders Upgrade *and* Remove together, so mobile users
    // can still remove a plugin when an upgrade is offered.
    hookState.plugin = makePlugin({ installed: true });
    hookState.drift = UPDATE_DRIFT;

    render(
      <PluginDetailMobile assistantId="asst-1" name="test-plugin" onBack={() => {}} />,
    );

    expect(getActionButton("Upgrade")).toBeTruthy();
    expect(getActionButton("Remove")).toBeTruthy();
    expect(screen.getByText("Update available")).toBeTruthy();
  });
});
