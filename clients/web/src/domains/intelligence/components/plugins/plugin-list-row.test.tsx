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
 * The bundled icon is fetched through the authenticated daemon client (see
 * `usePluginIconSrc`), so the rows are wrapped in a `QueryClientProvider` and
 * the icon test seeds the fetched blob into the cache; object URLs are stubbed
 * (happy-dom has none).
 *
 * Mounted via `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

import { PluginListRow } from "@/domains/intelligence/components/plugins/plugin-list-row.js";
import type { PluginListItem } from "@/domains/intelligence/plugins/types.js";
import type { PluginDrift } from "@/domains/intelligence/use-plugin-drift.js";
import { useAssistantIdentityStore } from "@/stores/assistant-identity-store.js";
import { MIN_VERSION } from "@/lib/backwards-compat/use-supports-plugin-icons.js";

const ASSISTANT_ID = "asst-1";

let queryClient: QueryClient;

function Wrapper({ children }: { children: ReactNode }) {
  return (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
}

// Wrap every row so `usePluginIconSrc`'s `useQuery` has a client. The wrapper
// is re-applied on `rerender`, so the same client is reused across re-renders.
function renderRow(ui: ReactElement) {
  return render(ui, { wrapper: Wrapper });
}

beforeEach(() => {
  queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Number.POSITIVE_INFINITY },
    },
  });
  // happy-dom doesn't implement object URLs.
  globalThis.URL.createObjectURL = () => "blob:row-icon";
  globalThis.URL.revokeObjectURL = () => undefined;
});

afterEach(() => {
  cleanup();
  // Reset the version gate that PluginListRow reads for the bundled icon.
  useAssistantIdentityStore.setState({ version: null });
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

    const { getByText } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
        item={makeItem()}
        onSelect={onSelect}
      />,
    );

    fireEvent.click(getByText("Test Plugin"));

    expect(onSelect).toHaveBeenCalledTimes(1);
  });

  test("installed plugin: trash control removes without selecting", () => {
    const onSelect = mock(() => {});
    const onRemove = mock(() => {});

    renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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

    renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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

    renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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

    renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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
    renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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

    const { container } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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
    const { rerender } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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
        assistantId={ASSISTANT_ID}
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
    const { getByText } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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
    const { getByText } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
        item={makeItem({ status: "installed", enabled: false })}
        onSelect={mock(() => {})}
      />,
    );

    expect(getByText("Disabled")).toBeTruthy();
    // Disabled rows dim the name to the tertiary content token.
    expect(getByText("Test Plugin").style.color).toContain("content-tertiary");
  });

  test("drift renders the Update chip (Remove stays), even when Disabled", () => {
    const { getByText } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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
    const { queryByText } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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

  test("supporting daemon + hasIcon renders the bundled-icon <img> from the fetched blob", async () => {
    useAssistantIdentityStore.setState({ version: MIN_VERSION });
    // Seed the icon fetch so the hook resolves it to an object URL without a
    // network call (key mirrors `usePluginIconSrc`'s query key).
    queryClient.setQueryData(
      ["pluginIcon", ASSISTANT_ID, "cool plugin", "abc123"],
      new Blob(["icon"]),
    );

    const { container } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
        item={makeItem({
          name: "cool plugin",
          status: "installed",
          hasIcon: true,
          iconVersion: "abc123",
        })}
        onSelect={mock(() => {})}
        onRemove={mock(() => {})}
      />,
    );

    // The image renders once the fetched blob's object URL is created.
    const img = await waitFor(() => {
      const el = container.querySelector("img");
      if (!el) {
        throw new Error("icon <img> not rendered yet");
      }
      return el;
    });
    expect(img.getAttribute("src")).toBe("blob:row-icon");
  });

  test("gate off (older daemon) renders no <img> even with hasIcon", () => {
    // Version stays null (default) — the daemon doesn't serve the icon endpoint.
    const { container } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
        item={makeItem({
          status: "installed",
          hasIcon: true,
          iconVersion: "abc123",
        })}
        onSelect={mock(() => {})}
        onRemove={mock(() => {})}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
  });

  test("supporting daemon but no hasIcon renders no <img>", () => {
    useAssistantIdentityStore.setState({ version: MIN_VERSION });

    const { container } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
        item={makeItem({ status: "installed", hasIcon: false })}
        onSelect={mock(() => {})}
        onRemove={mock(() => {})}
      />,
    );

    expect(container.querySelector("img")).toBeNull();
  });

  test("installed row without `enabled` (older daemon) renders no tag", () => {
    const { queryByText } = renderRow(
      <PluginListRow
        assistantId={ASSISTANT_ID}
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
