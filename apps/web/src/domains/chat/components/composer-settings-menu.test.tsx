/**
 * Tests for the composer Model Profile quick-add "+".
 *
 * Mounted with `@testing-library/react` (happy-dom — see
 * `apps/web/test-setup.ts`). The real Radix `Menu`/`BottomSheet` only mount
 * their content when open, so we mock `@vellum/design-library` surfaces to
 * render inline (popover/sheet content is always in the DOM and clickable).
 *
 * The quick-add modal now lives in the top-level `ProfileQuickAddProvider`
 * (chat must not import settings — see `local/no-cross-domain-imports`). The
 * composer only consumes `useProfileQuickAdd()`, so we mock that hook: clicking
 * "+" must close the popover and call `openProfileQuickAdd`, and simulating the
 * provider's `onCreated(name)` callback must run the composer's autoselect.
 *
 * We stub the generated daemon/api SDK so the menu's mount-time config fetch
 * and the autoselect per-thread profile PUT are observable.
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

// --- toast -------------------------------------------------------------------
const toastSuccess = mock((_msg: string) => {});
const toastError = mock((_msg: string) => {});
mock.module("@vellum/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
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

// --- profile quick-add controller (top-level) --------------------------------
// Capture the args passed to openProfileQuickAdd so tests can assert the "+"
// wiring and simulate the provider's onCreated callback firing.
type QuickAddArgs = {
  existingNames?: string[];
  onCreated?: (name: string) => void;
};
const openProfileQuickAdd = mock((_args?: QuickAddArgs) => {});
mock.module("@/components/profile-quick-add-provider", () => ({
  useProfileQuickAdd: () => ({ openProfileQuickAdd }),
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

const NEW_PROFILE_NAME = "fast-cheap";

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
  openProfileQuickAdd.mockClear();
  inferenceprofilePut.mockClear();
  clientPatch.mockClear();
  clientGet.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
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

  test("clicking + closes the popover and opens the quick-add controller", async () => {
    renderMenu();
    await waitFor(() => screen.getByLabelText("New Profile"));

    fireEvent.click(screen.getByLabelText("New Profile"));

    // Delegates to the top-level controller with the current profile names.
    await waitFor(() => {
      expect(openProfileQuickAdd).toHaveBeenCalledTimes(1);
    });
    const args = openProfileQuickAdd.mock.calls[0]![0]!;
    expect(args.existingNames).toEqual(["smart"]);
    expect(typeof args.onCreated).toBe("function");
  });

  test("the onCreated callback autoselects the new profile for the thread", async () => {
    renderMenu();
    await waitFor(() => screen.getByLabelText("New Profile"));
    fireEvent.click(screen.getByLabelText("New Profile"));

    await waitFor(() => {
      expect(openProfileQuickAdd).toHaveBeenCalledTimes(1);
    });

    // Simulate the provider persisting a profile and invoking onCreated — the
    // composer must run handleProfileSelect (per-thread override PUT).
    const onCreated = openProfileQuickAdd.mock.calls[0]![0]!.onCreated!;
    onCreated(NEW_PROFILE_NAME);

    await waitFor(() => {
      expect(inferenceprofilePut).toHaveBeenCalledTimes(1);
    });
    expect(
      (inferenceprofilePut.mock.calls[0]![0] as { body: { profile: string } }).body.profile,
    ).toBe(NEW_PROFILE_NAME);

    // The new profile is now reflected locally and renders in the picker.
    await waitFor(() => {
      expect(document.body.textContent).toContain(NEW_PROFILE_NAME);
    });
  });

  test('"+" is disabled until the profile config fetch settles', async () => {
    // Config never resolves — the "+" must stay disabled (opening the modal
    // with the empty initial profileOrder/profileMap would let a duplicate
    // overwrite a profile and reset the persisted order).
    clientGet.mockImplementationOnce(() => new Promise(() => {}));
    renderMenu();

    await waitFor(() => screen.getByLabelText("New Profile"));
    const plus = screen.getByLabelText("New Profile") as HTMLButtonElement;
    expect(plus.disabled).toBe(true);
    expect(plus.getAttribute("aria-disabled")).toBe("true");

    // A click while disabled must NOT open the quick-add controller.
    fireEvent.click(plus);
    expect(openProfileQuickAdd).not.toHaveBeenCalled();
  });

  test('"+" enables once the config fetch settles', async () => {
    renderMenu();
    await waitFor(() => {
      const plus = screen.getByLabelText("New Profile") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
  });

  test("a failed autoselect surfaces an error toast (without claiming creation failed)", async () => {
    // The per-thread profile PUT fails — the new profile was created but could
    // not be switched to. The flow must surface that instead of silently
    // reporting success.
    inferenceprofilePut.mockImplementationOnce(async () => {
      throw new Error("network");
    });

    renderMenu();
    await waitFor(() => screen.getByLabelText("New Profile"));
    fireEvent.click(screen.getByLabelText("New Profile"));

    await waitFor(() => {
      expect(openProfileQuickAdd).toHaveBeenCalledTimes(1);
    });
    const onCreated = openProfileQuickAdd.mock.calls[0]![0]!.onCreated!;
    onCreated(NEW_PROFILE_NAME);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Profile created, but couldn't switch to it",
      );
    });
  });
});
