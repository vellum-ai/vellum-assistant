/**
 * Tests for LibraryView's import affordance.
 *
 * Import is the only way someone who was sent a `.vellum` bundle gets their
 * first app, and their library is empty by definition, so the header control
 * has to survive the empty/populated split. The `accept` filter is asserted
 * here too: on desktop the picker is constrained to `.vellum`, while touch
 * devices (where iOS ignores extension filters) get an unrestricted picker so
 * the bundle is actually selectable.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";

import type { AppSummary } from "@/types/app-types";

let apps: AppSummary[] = [];
let pointerIsCoarse = false;
const isMobileRef = { value: false };

mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

mock.module("@/utils/pointer", () => ({
  isPointerCoarse: () => pointerIsCoarse,
}));

mock.module("@/domains/library/use-library-data", () => ({
  useLibraryData: () => ({
    apps,
    documents: [],
    filteredApps: apps,
    pinnedApps: [],
    recentApps: apps,
    filteredDocuments: [],
    searchText: "",
    setSearchText: () => {},
    loading: false,
    error: null,
  }),
}));

mock.module("@/hooks/use-pinned-apps", () => ({
  usePinnedApps: () => ({
    togglePin: () => {},
    pinnedAppIds: new Set<string>(),
  }),
}));

mock.module("@/hooks/use-app-delete", () => ({
  useAppDelete: () => ({
    pendingDelete: null,
    isDeleting: false,
    requestDelete: () => {},
    confirmDelete: () => {},
    cancelDelete: () => {},
  }),
}));

mock.module("@/stores/deploy-store", () => ({
  useDeployStore: {
    use: { isDeploying: () => false },
    getState: () => ({ deployApp: () => {} }),
  },
}));

mock.module("@/components/deploy-dialogs", () => ({
  DeployDialogs: () => null,
}));

mock.module("@/components/delete-app-dialog", () => ({
  DeleteAppDialog: () => null,
}));

const { LibraryView } = await import("./library-view");
const { useIntelligenceLayoutSlotsStore } =
  await import("@/components/layout/intelligence-layout-slots-store");

/* The Import button lives on the layout's heading row, which the view
   reaches through the slot store; this stands in for the layout so the
   button lands in the same tree as the view's file input. */
function HeaderTrailing() {
  return <>{useIntelligenceLayoutSlotsStore.use.headerTrailing()}</>;
}

const APP: AppSummary = {
  id: "app-123",
  name: "Example App",
  createdAt: 1767225600000,
  updatedAt: 1767225600000,
  version: "1",
  contentId: "content-123",
  origin: "workspace",
};

function renderView() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={queryClient}>
      <HeaderTrailing />
      <LibraryView assistantId="assistant-123" onOpenApp={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apps = [];
  pointerIsCoarse = false;
  isMobileRef.value = false;
});

afterEach(() => {
  cleanup();
  useIntelligenceLayoutSlotsStore.getState().setHeaderTrailing(null);
});

describe("LibraryView import affordance", () => {
  test("keeps the header import button when the library is empty", () => {
    const { container } = renderView();

    expect(screen.getByText("Your library is empty")).not.toBeNull();
    expect(screen.getByRole("button", { name: /Import/ })).not.toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  test("keeps a single file input when the library has apps", () => {
    apps = [APP];
    const { container } = renderView();

    expect(screen.queryByText("Your library is empty")).toBeNull();
    expect(screen.getByRole("button", { name: /Import/ })).not.toBeNull();
    expect(container.querySelectorAll('input[type="file"]')).toHaveLength(1);
  });

  test("hides app dates at mobile widths", () => {
    apps = [APP];
    renderView();

    const appName = screen.getByText("Example App");
    expect(appName.nextElementSibling?.className).toContain("max-md:hidden");
  });

  test("uses compact secondary app-name typography at mobile widths", () => {
    apps = [APP];
    renderView();

    const appName = screen.getByText("Example App");
    expect(appName.className).toContain("max-md:text-body-medium-lighter");
    expect(appName.className).toContain(
      "max-md:text-[color:var(--content-secondary)]",
    );
  });

  test("uses an icon-only import action in the mobile top bar", () => {
    isMobileRef.value = true;
    renderView();

    const importButton = screen.getByRole("button", { name: "Import" });
    expect(importButton.textContent).toBe("");
    expect(importButton.className).toContain(
      "max-md:bg-[var(--surface-active)]",
    );
    expect(importButton.className).toContain("rounded-full");
  });

  test("constrains the picker to .vellum on a fine-pointer device", () => {
    const { container } = renderView();

    expect(
      container.querySelector('input[type="file"]')?.getAttribute("accept"),
    ).toBe(".vellum");
  });

  test("the import button opens the view's own file input", () => {
    const { container } = renderView();
    const input =
      container.querySelector<HTMLInputElement>('input[type="file"]')!;
    const click = mock(() => {});
    input.click = click;

    screen.getByRole("button", { name: /Import/ }).click();
    expect(click).toHaveBeenCalledTimes(1);
  });

  test("clears the header slot on unmount", () => {
    const { unmount } = renderView();
    expect(
      useIntelligenceLayoutSlotsStore.getState().headerTrailing,
    ).not.toBeNull();
    unmount();
    expect(
      useIntelligenceLayoutSlotsStore.getState().headerTrailing,
    ).toBeNull();
  });

  test("leaves the picker unrestricted on a touch device", () => {
    pointerIsCoarse = true;
    const { container } = renderView();

    expect(
      container.querySelector('input[type="file"]')?.getAttribute("accept"),
    ).toBeNull();
  });
});
