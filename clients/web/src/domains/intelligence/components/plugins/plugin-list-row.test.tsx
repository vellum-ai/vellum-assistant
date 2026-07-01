/**
 * Tests for `PluginListRow` action controls.
 *
 * The row is a `role="button"` whose primary click fires `onSelect`. The
 * trailing icon-only action button (install for catalog entries, upgrade
 * when an installed copy is behind the marketplace pin, otherwise remove)
 * must:
 *   - expose the correct `aria-label`
 *   - fire its own handler (`onInstall` / `onUpgrade` / `onRemove`)
 *   - NOT also bubble up to `onSelect` (stopPropagation)
 *
 * The Upgrade affordance is gated on `update-available` drift, so it only
 * appears when that signal is passed in.
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";

import { cleanup, fireEvent, render } from "@testing-library/react";

import { PluginListRow } from "@/domains/intelligence/components/plugins/plugin-list-row.js";
import type { PluginListItem } from "@/domains/intelligence/plugins/types.js";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift.js";

afterEach(() => {
  cleanup();
});

function makeItem(overrides: Partial<PluginListItem> = {}): PluginListItem {
  return {
    name: "Test Plugin",
    description: "A plugin used in tests",
    status: "installed",
    external: false,
    version: "0.1",
    ...overrides,
  };
}

/**
 * Minimal drift stand-in. The row only reads `status`, so the rest of the
 * inspect shape is irrelevant to these assertions.
 */
function makeDrift(status: PluginDrift["status"]): PluginDrift {
  return { status } as PluginDrift;
}

function getButton(label: string): HTMLButtonElement {
  const match = document.querySelector<HTMLButtonElement>(
    `button[aria-label="${label}"]`,
  );
  if (!match) {
    throw new Error(`expected a button with aria-label="${label}"`);
  }
  return match;
}

describe("PluginListRow", () => {
  test("clicking the row fires onSelect", () => {
    const onSelect = mock(() => {});

    const { getByText } = render(
      <PluginListRow item={makeItem()} onSelect={onSelect} />,
    );

    fireEvent.click(getByText("Test Plugin"));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("installed plugin: trash control removes without selecting", () => {
    const onSelect = mock(() => {});
    const onRemove = mock(() => {});

    render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        onSelect={onSelect}
        onRemove={onRemove}
      />,
    );

    fireEvent.click(getButton("Remove plugin"));

    expect(onRemove).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("catalog plugin: install control installs without selecting", () => {
    const onSelect = mock(() => {});
    const onInstall = mock(() => {});

    render(
      <PluginListRow
        item={makeItem({ status: "available" })}
        onSelect={onSelect}
        onInstall={onInstall}
      />,
    );

    fireEvent.click(getButton("Install plugin"));

    expect(onInstall).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("Enter on a focused inline action does not also select the row", () => {
    const onSelect = mock(() => {});
    const onRemove = mock(() => {});

    render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        onSelect={onSelect}
        onRemove={onRemove}
      />,
    );

    // Key events originating on the action button must not bubble into the
    // row's keydown handler and trigger selection.
    fireEvent.keyDown(getButton("Remove plugin"), { key: "Enter" });

    expect(onSelect).not.toHaveBeenCalled();
  });

  test("update-available drift: upgrade control upgrades without selecting", () => {
    const onSelect = mock(() => {});
    const onUpgrade = mock(() => {});

    render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        drift={makeDrift("update-available")}
        onSelect={onSelect}
        onUpgrade={onUpgrade}
      />,
    );

    fireEvent.click(getButton("Upgrade plugin"));

    expect(onUpgrade).toHaveBeenCalledTimes(1);
    expect(onSelect).not.toHaveBeenCalled();
  });

  test("Remove is disabled while an upgrade is in flight (no concurrent delete)", () => {
    render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        drift={makeDrift("update-available")}
        onSelect={() => {}}
        onRemove={() => {}}
        onUpgrade={() => {}}
        isUpgrading
      />,
    );

    expect(getButton("Remove plugin").disabled).toBe(true);
  });

  test("does not render an origin badge (origin is unknowable from the list)", () => {
    const onSelect = mock(() => {});

    const { container } = render(
      <PluginListRow
        item={makeItem({ status: "installed", external: false })}
        onSelect={onSelect}
      />,
    );

    // The installed-list endpoint carries no source, so the row must not claim
    // an origin. No Local/External tag and no globe/drive icon.
    expect(container.querySelector(".lucide-globe")).toBeNull();
    expect(container.querySelector(".lucide-hard-drive")).toBeNull();
    expect(container.textContent).not.toContain("Local");
    expect(container.textContent).not.toContain("External");
  });

  test("upgrade affordance only appears with update-available drift", () => {
    const onSelect = mock(() => {});
    const onUpgrade = mock(() => {});

    // Up-to-date installed plugin shows Remove, not Upgrade.
    const { rerender } = render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        drift={makeDrift("up-to-date")}
        onSelect={onSelect}
        onUpgrade={onUpgrade}
      />,
    );

    expect(
      document.querySelector('button[aria-label="Upgrade plugin"]'),
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Remove plugin"]'),
    ).not.toBeNull();

    // Same plugin with drift now exposes Upgrade (Remove stays put).
    rerender(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        drift={makeDrift("update-available")}
        onSelect={onSelect}
        onUpgrade={onUpgrade}
      />,
    );

    expect(
      document.querySelector('button[aria-label="Upgrade plugin"]'),
    ).not.toBeNull();
  });

  test("Enabled installed row shows an Enabled tag beside Remove (no toggle)", () => {
    const { getByText } = render(
      <PluginListRow
        item={makeItem({ status: "installed", enabled: true })}
        onSelect={mock(() => {})}
        onRemove={mock(() => {})}
      />,
    );

    expect(getByText("Enabled")).toBeTruthy();
    // The row carries no interactive toggle — changing it happens on detail.
    expect(document.querySelector('button[role="switch"]')).toBeNull();
    expect(
      document.querySelector('button[aria-label="Remove plugin"]'),
    ).not.toBeNull();
  });

  test("Disabled row is dimmed and shows a Disabled tag", () => {
    const { getByText } = render(
      <PluginListRow
        item={makeItem({ status: "installed", enabled: false })}
        onSelect={mock(() => {})}
      />,
    );

    expect(getByText("Disabled")).toBeTruthy();
    // Disabled rows dim the name to the tertiary content token.
    expect(getByText("Test Plugin").style.color).toContain("content-tertiary");
  });

  test("drift renders the Update chip (Remove stays), even when Disabled", () => {
    const { getByText } = render(
      <PluginListRow
        item={makeItem({ status: "installed", enabled: false })}
        drift={makeDrift("update-available")}
        onSelect={mock(() => {})}
        onRemove={mock(() => {})}
        onUpgrade={mock(() => {})}
      />,
    );

    // Drift is an Update chip, not a Remove-replacing button: both are present.
    expect(
      document.querySelector('button[aria-label="Upgrade plugin"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('button[aria-label="Remove plugin"]'),
    ).not.toBeNull();
    // The chip shows regardless of the enablement state — here it's Disabled.
    expect(getByText("Disabled")).toBeTruthy();
  });

  test("available row shows only Install (no tag, no Remove)", () => {
    const { queryByText } = render(
      <PluginListRow
        item={makeItem({ status: "available" })}
        onSelect={mock(() => {})}
        onInstall={mock(() => {})}
      />,
    );

    expect(
      document.querySelector('button[aria-label="Install plugin"]'),
    ).not.toBeNull();
    expect(queryByText("Enabled")).toBeNull();
    expect(queryByText("Disabled")).toBeNull();
    expect(
      document.querySelector('button[aria-label="Remove plugin"]'),
    ).toBeNull();
  });

  test("installed row without `enabled` (older daemon) renders no tag", () => {
    const { queryByText } = render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        onSelect={mock(() => {})}
        onRemove={mock(() => {})}
      />,
    );

    expect(queryByText("Enabled")).toBeNull();
    expect(queryByText("Disabled")).toBeNull();
    // Remove is still present for installed rows.
    expect(
      document.querySelector('button[aria-label="Remove plugin"]'),
    ).not.toBeNull();
  });
});
