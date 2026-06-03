/**
 * Tests for the top-level ProfileQuickAddProvider / useProfileQuickAdd().
 *
 * The provider owns the settings ProfileEditorModal create flow so chat (and
 * other domains) can trigger a profile quick-add without importing settings.
 * We mock the settings modal as a lightweight stub that calls `onSave` with a
 * deterministic entry, then assert the controller persists the new profile via
 * the daemon config PATCH, fires `onCreated` with the new name, and toasts.
 *
 * Mounted with `@testing-library/react` (happy-dom — see `apps/web/test-setup.ts`).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, useEffect } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

const NEW_PROFILE_NAME = "fast-cheap";

// --- selection store (active assistant id) -----------------------------------
mock.module("@/assistant/selection-store", () => {
  const store = () => null;
  store.use = { activeAssistantId: () => "assistant-1" };
  return { useAssistantSelectionStore: store };
});

// --- feature flag store ------------------------------------------------------
mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    openAICompatibleEndpoints: () => false,
    chatgptSubscriptionAuth: () => false,
  };
  return { useAssistantFeatureFlagStore: store };
});

// --- toast -------------------------------------------------------------------
const toastSuccess = mock((_msg: string) => {});
mock.module("@vellum/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: () => {} },
}));

// --- ProfileEditorModal stub -------------------------------------------------
// Renders a Save button (only when open) that invokes onSave with a fixed entry.
mock.module("@/domains/settings/ai/profile-editor-modal", () => ({
  ProfileEditorModal: ({ isOpen, onSave }: { isOpen: boolean; onSave: (n: string, e: unknown) => Promise<void> }) =>
    isOpen
      ? createElement(
          "button",
          {
            "data-testid": "modal-save-btn",
            onClick: () => void onSave(NEW_PROFILE_NAME, { label: "Fast & Cheap" }),
          },
          "Save",
        )
      : null,
}));

mock.module("@/domains/settings/ai/provider-connections-client", () => ({
  filterFlaggedConnections: (c: unknown) => c,
}));

mock.module("@/generated/daemon/@tanstack/react-query.gen", () => ({
  inferenceProviderconnectionsGetOptions: () => ({
    queryKey: [{ _id: "inferenceProviderconnectionsGet" }],
    queryFn: async () => ({ connections: [] }),
  }),
}));

const clientPatch = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({ data: {} }),
);
mock.module("@/generated/api/client.gen", () => ({
  client: { patch: clientPatch },
}));

import {
  ProfileQuickAddProvider,
  useProfileQuickAdd,
} from "@/components/profile-quick-add-provider";

// Test consumer: opens the quick-add on mount and records the onCreated name.
const onCreated = mock((_name: string) => {});
function Opener({ profileOrder }: { profileOrder: string[] }) {
  const { openProfileQuickAdd } = useProfileQuickAdd();
  useEffect(() => {
    openProfileQuickAdd({ existingNames: profileOrder, profileOrder, onCreated });
  }, [openProfileQuickAdd, profileOrder]);
  return null;
}

function renderProvider(profileOrder: string[]) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ProfileQuickAddProvider, null, createElement(Opener, { profileOrder })),
    ),
  );
}

beforeEach(() => {
  toastSuccess.mockClear();
  onCreated.mockClear();
  clientPatch.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("ProfileQuickAddProvider", () => {
  test("opens the create modal when openProfileQuickAdd is called", async () => {
    renderProvider(["smart"]);
    await waitFor(() => {
      expect(screen.getByTestId("modal-save-btn")).toBeTruthy();
    });
  });

  test("persisting a create writes the config PATCH, fires onCreated, and toasts", async () => {
    renderProvider(["smart"]);
    await waitFor(() => screen.getByTestId("modal-save-btn"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    // Persists via the daemon config PATCH with the appended profileOrder.
    await waitFor(() => {
      expect(clientPatch).toHaveBeenCalledTimes(1);
    });
    const patchBody = (clientPatch.mock.calls[0]![0] as { body: { llm: Record<string, unknown> } }).body.llm;
    expect((patchBody.profiles as Record<string, unknown>)[NEW_PROFILE_NAME]).toBeTruthy();
    expect(patchBody.profileOrder).toEqual(["smart", NEW_PROFILE_NAME]);

    // Hands the new name back to the caller.
    await waitFor(() => {
      expect(onCreated).toHaveBeenCalledWith(NEW_PROFILE_NAME);
    });

    // Surfaces the success toast and closes the modal.
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(`Profile "${NEW_PROFILE_NAME}" created`);
    });
    expect(screen.queryByTestId("modal-save-btn")).toBeNull();
  });
});
