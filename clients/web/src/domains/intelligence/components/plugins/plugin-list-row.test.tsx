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

  test("upgrade affordance only appears with update-available drift", () => {
    const onSelect = mock(() => {});

    // Up-to-date installed plugin shows Remove, not Upgrade.
    const { rerender } = render(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        drift={makeDrift("up-to-date")}
        onSelect={onSelect}
      />,
    );

    expect(
      document.querySelector('button[aria-label="Upgrade plugin"]'),
    ).toBeNull();
    expect(
      document.querySelector('button[aria-label="Remove plugin"]'),
    ).not.toBeNull();

    // Same plugin with drift now exposes Upgrade.
    rerender(
      <PluginListRow
        item={makeItem({ status: "installed" })}
        drift={makeDrift("update-available")}
        onSelect={onSelect}
      />,
    );

    expect(
      document.querySelector('button[aria-label="Upgrade plugin"]'),
    ).not.toBeNull();
  });
});
