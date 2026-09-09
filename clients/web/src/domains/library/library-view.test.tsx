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
      <LibraryView assistantId="assistant-123" onOpenApp={() => {}} />
    </QueryClientProvider>,
  );
}

beforeEach(() => {
  apps = [];
  pointerIsCoarse = false;
});

afterEach(() => {
  cleanup();
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

  test("constrains the picker to .vellum on a fine-pointer device", () => {
    const { container } = renderView();

    expect(
      container.querySelector('input[type="file"]')?.getAttribute("accept"),
    ).toBe(".vellum");
  });

  test("leaves the picker unrestricted on a touch device", () => {
    pointerIsCoarse = true;
    const { container } = renderView();

    expect(
      container.querySelector('input[type="file"]')?.getAttribute("accept"),
    ).toBeNull();
  });
});
