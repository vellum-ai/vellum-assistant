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
  // The shared `PluginDetailActions` imports `shortSha` from this module for its
  // upgrade tooltip, so the mock must re-export it.
  shortSha: (sha: string | null) => (sha ? sha.slice(0, 7) : "unknown"),
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
