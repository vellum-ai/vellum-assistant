/**
 * Tests for the composer Model Profile quick-add "+".
 *
 * Mounted with `@testing-library/react` (happy-dom — see
 * `apps/web/test-setup.ts`). The real Radix `Menu`/`BottomSheet` only mount
 * their content when open, and the real `ProfileEditorModal` pulls in the
 * provider/model catalog plus its own queries — so we mock both:
 *   - `@vellum/design-library` surfaces render inline so popover/sheet content
 *     is always in the DOM and clickable.
 *   - `ProfileEditorModal` is a lightweight stub that renders a
 *     `data-testid="modal-save-btn"` calling `onSave` with a fixed entry,
 *     letting us assert the create → autoselect → toast flow.
 *
 * We also stub the generated daemon/api SDK so the menu's mount-time config
 * fetch and the quick-add config PATCH / per-thread profile PUT are observable.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

// --- use-is-mobile -----------------------------------------------------------
const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// --- feature flag store ------------------------------------------------------
mock.module("@/stores/assistant-feature-flag-store", () => {
  const store = () => null;
  store.use = {
    queryComplexityRouting: () => false,
    openAICompatibleEndpoints: () => false,
    chatgptSubscriptionAuth: () => false,
  };
  return { useAssistantFeatureFlagStore: store };
});

// --- threshold-api (mount-time access-level fetches) -------------------------
mock.module("@/lib/threshold-api", () => ({
  getGlobalThresholds: async () => ({ interactive: 50 }),
  getConversationOverride: async () => null,
  setConversationOverride: async () => {},
  deleteConversationOverride: async () => {},
  setGlobalThresholds: async () => {},
}));

// --- toast -------------------------------------------------------------------
const toastSuccess = mock((_msg: string) => {});
mock.module("@vellum/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: () => {} },
}));

// --- design-library surfaces (render content inline) -------------------------
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
mock.module("@vellum/design-library", () => {
  const MenuMock = {
    Root: passthrough,
    Trigger: passthrough,
    Content: passthrough,
    Item: ({ children, onSelect, leftIcon, ...rest }: Record<string, unknown>) =>
      createElement(
        "button",
        {
          "data-testid": "menu-item",
          onClick: onSelect as (() => void) | undefined,
          ...rest,
        },
        leftIcon as ReactNode,
        children as ReactNode,
      ),
    Label: passthrough,
    Separator: () => createElement("hr"),
  };
  const BottomSheetMock = {
    Root: passthrough,
    Trigger: passthrough,
    Content: passthrough,
    Header: passthrough,
    Title: passthrough,
    Body: passthrough,
  };
  return {
    Menu: MenuMock,
    BottomSheet: BottomSheetMock,
    Button: ({ onClick, "aria-label": ariaLabel, iconOnly: _i, ...rest }: Record<string, unknown>) =>
      createElement("button", { onClick, "aria-label": ariaLabel, ...rest }),
    PanelItem: ({ label, onSelect, ...rest }: Record<string, unknown>) =>
      createElement(
        "button",
        { "data-testid": "panel-item", onClick: onSelect as (() => void) | undefined, ...rest },
        label as ReactNode,
      ),
    Tooltip: ({ children }: Record<string, unknown>) => children as ReactNode,
  };
});

// --- ProfileEditorModal stub -------------------------------------------------
// Renders a Save button that invokes onSave with a deterministic entry so the
// test drives the create flow without the real provider-first form.
const NEW_PROFILE_NAME = "fast-cheap";
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

// --- generated SDK -----------------------------------------------------------
// Mocks are loosely typed (`unknown` args, structural returns) so per-test
// overrides and `.mock.calls` indexing don't fight the generated SDK types.
const inferenceprofilePut = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({ data: {} }),
);
const clientGet = mock(
  // One pre-existing profile so the picker renders a list and order.
  async (_opts: unknown): Promise<{ data: unknown }> => ({
    data: { llm: { profileOrder: ["smart"], profiles: { smart: { label: "Smart" } }, activeProfile: "smart" } },
  }),
);
const clientPatch = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({ data: {} }),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  conversationsByIdGet: async () => ({
    data: { conversation: { inferenceProfile: null } },
  }),
  conversationsByIdInferenceprofilePut: inferenceprofilePut,
}));

mock.module("@/generated/api/client.gen", () => ({
  client: { get: clientGet, patch: clientPatch },
}));

import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";

function renderMenu() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ComposerSettingsMenu, {
        assistantId: "assistant-1",
        conversationId: "conv-1",
      }),
    ),
  );
}

beforeEach(() => {
  isMobileRef.value = false;
  toastSuccess.mockClear();
  inferenceprofilePut.mockClear();
  clientPatch.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("Model Profile quick-add", () => {
  test('"+" New Profile renders on desktop, including with profiles present', async () => {
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Profile")).toBeTruthy();
    });
    // Header is present alongside the existing profile.
    expect(document.body.textContent).toContain("Model Profile");
  });

  test('"+" New Profile renders on mobile', async () => {
    isMobileRef.value = true;
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Profile")).toBeTruthy();
    });
  });

  test('"+" New Profile renders even with zero profiles', async () => {
    clientGet.mockImplementationOnce(async () => ({
      data: { llm: { profileOrder: [], profiles: {}, activeProfile: null } },
    }));
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Profile")).toBeTruthy();
    });
    expect(document.body.textContent).toContain("Model Profile");
  });

  test("clicking + closes the popover and opens the create modal", async () => {
    renderMenu();
    await waitFor(() => screen.getByLabelText("New Profile"));

    expect(screen.queryByTestId("modal-save-btn")).toBeNull();
    fireEvent.click(screen.getByLabelText("New Profile"));
    expect(screen.getByTestId("modal-save-btn")).toBeTruthy();
  });

  test("completing a create autoselects the new profile and toasts", async () => {
    renderMenu();
    await waitFor(() => screen.getByLabelText("New Profile"));
    fireEvent.click(screen.getByLabelText("New Profile"));
    fireEvent.click(screen.getByTestId("modal-save-btn"));

    // Persists the profile via the daemon config PATCH.
    await waitFor(() => {
      expect(clientPatch).toHaveBeenCalledTimes(1);
    });
    const patchBody = (clientPatch.mock.calls[0]![0] as { body: { llm: Record<string, unknown> } }).body.llm;
    expect((patchBody.profiles as Record<string, unknown>)[NEW_PROFILE_NAME]).toBeTruthy();
    expect(patchBody.profileOrder).toEqual(["smart", NEW_PROFILE_NAME]);

    // Autoselects the new profile as the per-thread override.
    await waitFor(() => {
      expect(inferenceprofilePut).toHaveBeenCalledTimes(1);
    });
    expect(
      (inferenceprofilePut.mock.calls[0]![0] as { body: { profile: string } }).body.profile,
    ).toBe(NEW_PROFILE_NAME);

    // Surfaces the success toast and closes the modal.
    await waitFor(() => {
      expect(toastSuccess).toHaveBeenCalledWith(`Profile "${NEW_PROFILE_NAME}" created`);
    });
    expect(screen.queryByTestId("modal-save-btn")).toBeNull();

    // The new profile now renders as active/checked in the picker.
    expect(document.body.textContent).toContain("Fast & Cheap");
  });
});
