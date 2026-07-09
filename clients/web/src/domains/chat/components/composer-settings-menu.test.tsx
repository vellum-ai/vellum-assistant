/**
 * Tests for the composer Model Profile quick-add "+".
 *
 * Mounted with `@testing-library/react` (happy-dom — see
 * `clients/web/test-setup.ts`). The real Radix `Menu`/`BottomSheet` only mount
 * their content when open, so we mock `@vellumai/design-library` surfaces to
 * render inline (popover/sheet content is always in the DOM and clickable).
 *
 * The quick-add modal now lives in the top-level `ProfileQuickAddProvider`
 * (chat must not import settings — see `local/no-cross-domain-imports`). The
 * composer only consumes `useProfileQuickAdd()`, so we mock that hook: clicking
 * "+" must close the popover and call `openProfileQuickAdd`, and simulating the
 * provider's `onCreated(name)` callback must run the composer's autoselect.
 *
 * We stub the generated daemon SDK so the component's TanStack Query hooks
 * receive test data without network requests.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { createElement, type ReactNode } from "react";

// --- use-is-mobile -----------------------------------------------------------
const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

// --- toast -------------------------------------------------------------------
const toastSuccess = mock((_msg: string) => {});
const toastError = mock((_msg: string) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

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
  onCreated?: (name: string, label: string | null) => void;
};
const openProfileQuickAdd = mock((_args?: QuickAddArgs) => {});
mock.module("@/components/profile-quick-add-provider", () => ({
  useProfileQuickAdd: () => ({ openProfileQuickAdd }),
}));

// --- design-library surfaces (render content inline) -------------------------
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
mock.module("@vellumai/design-library", () => {
  const MenuMock = {
    Root: passthrough,
    Trigger: passthrough,
    Content: passthrough,
    Item: ({
      children,
      onSelect,
      leftIcon,
      ...rest
    }: Record<string, unknown>) =>
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
    Button: ({
      onClick,
      "aria-label": ariaLabel,
      iconOnly: _i,
      ...rest
    }: Record<string, unknown>) =>
      createElement("button", { onClick, "aria-label": ariaLabel, ...rest }),
    PanelItem: ({ label, onSelect, ...rest }: Record<string, unknown>) =>
      createElement(
        "button",
        {
          "data-testid": "panel-item",
          onClick: onSelect as (() => void) | undefined,
          ...rest,
        },
        label as ReactNode,
      ),
    Tooltip: ({ children }: Record<string, unknown>) => children as ReactNode,
  };
});

const NEW_PROFILE_NAME = "fast-cheap";
const NEW_PROFILE_LABEL = "Fast & Cheap";

// --- generated daemon SDK ----------------------------------------------------
// Mock the SDK functions used by the component (directly and via generated
// TanStack Query options). configGetOptions/conversationsByIdGetOptions from
// the generated react-query module call configGet/conversationsByIdGet
// internally, so mocking the SDK module covers both layers.
const configGetMock = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({
    data: {
      llm: {
        profileOrder: ["smart"],
        profiles: { smart: { label: "Smart" } },
        activeProfile: "smart",
      },
    },
  }),
);
const conversationsByIdGetMock = mock(async (_opts: unknown) => ({
  data: { conversation: { inferenceProfile: null } },
}));
const configPatchMock = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({ data: {} }),
);
const inferenceprofilePut = mock(
  async (_opts: unknown): Promise<{ data: unknown }> => ({ data: {} }),
);

mock.module("@/generated/daemon/sdk.gen", () => ({
  configGet: configGetMock,
  conversationsByIdGet: conversationsByIdGetMock,
  configPatch: configPatchMock,
  conversationsByIdInferenceprofilePut: inferenceprofilePut,
}));

import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
// Real store (not mocked) — the component reads the draft conversation id and
// the pending-profile stash from it.
import { useConversationStore } from "@/stores/conversation-store";

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
  configPatchMock.mockClear();
  configGetMock.mockClear();
  conversationsByIdGetMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  useConversationStore.getState().reset();
});

afterEach(() => {
  cleanup();
  useConversationStore.getState().reset();
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
    configGetMock.mockImplementationOnce(async () => ({
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

    // Wait for config to load so the "+" is enabled.
    await waitFor(() => {
      const plus = screen.getByLabelText("New Profile") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });

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
    // Wait for the config to load and "+" to enable.
    await waitFor(() => {
      const plus = screen.getByLabelText("New Profile") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText("New Profile"));

    await waitFor(() => {
      expect(openProfileQuickAdd).toHaveBeenCalledTimes(1);
    });

    // Simulate the provider persisting a profile and invoking onCreated — the
    // composer must run handleProfileSelect (per-thread override PUT).
    // Update the mock first: after creation the server returns the new profile,
    // so the background refetch (triggered by handleProfileSelect's success
    // handler) must see the new entry to avoid overwriting the optimistic cache.
    configGetMock.mockImplementation(async () => ({
      data: {
        llm: {
          profileOrder: ["smart", NEW_PROFILE_NAME],
          profiles: {
            smart: { label: "Smart" },
            [NEW_PROFILE_NAME]: { label: NEW_PROFILE_LABEL },
          },
          activeProfile: "smart",
        },
      },
    }));
    const onCreated = openProfileQuickAdd.mock.calls[0]![0]!.onCreated!;
    onCreated(NEW_PROFILE_NAME, NEW_PROFILE_LABEL);

    await waitFor(() => {
      expect(inferenceprofilePut).toHaveBeenCalledTimes(1);
    });
    expect(
      (inferenceprofilePut.mock.calls[0]![0] as { body: { profile: string } })
        .body.profile,
    ).toBe(NEW_PROFILE_NAME);

    // The new profile is now reflected locally and renders in the picker by
    // its display-name label (not the slugified key) — the label is handed
    // through onCreated so the entry shows its Name without a config refetch.
    await waitFor(() => {
      expect(document.body.textContent).toContain(NEW_PROFILE_LABEL);
    });
  });

  test('"+" is disabled until the profile config fetch settles', async () => {
    // Config never resolves — the "+" must stay disabled (opening the modal
    // with the empty initial profileOrder/profileMap would let a duplicate
    // overwrite a profile and reset the persisted order).
    configGetMock.mockImplementationOnce(() => new Promise(() => {}));
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
    // Wait for config to load.
    await waitFor(() => {
      const plus = screen.getByLabelText("New Profile") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText("New Profile"));

    await waitFor(() => {
      expect(openProfileQuickAdd).toHaveBeenCalledTimes(1);
    });
    const onCreated = openProfileQuickAdd.mock.calls[0]![0]!.onCreated!;
    onCreated(NEW_PROFILE_NAME, NEW_PROFILE_LABEL);

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Profile created, but couldn't switch to it",
      );
    });
  });
});

describe("Profile selection after conversation change (LUM-2279)", () => {
  test("selecting a profile works immediately after conversationId changes", async () => {
    const qc = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const tree = (convId: string) =>
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(ComposerSettingsMenu, {
          assistantId: "assistant-1",
          conversationId: convId,
        }),
      );

    const { rerender } = render(tree("conv-1"));
    // "Smart" now renders both on the composer trigger and in the menu row, so
    // wait for at least one occurrence rather than asserting a single match.
    await waitFor(() =>
      expect(screen.getAllByText("Smart").length).toBeGreaterThan(0),
    );

    // Hang subsequent config fetches so the re-fetch from the conversationId
    // change never completes — holds the race window open.
    configGetMock.mockImplementation(() => new Promise(() => {}));
    rerender(tree("conv-2"));

    // Click the profile — without the fix this is silently dropped.
    const smart = screen
      .getAllByTestId("menu-item")
      .find((b) => b.textContent?.includes("Smart"));
    fireEvent.click(smart!);

    await waitFor(() => expect(inferenceprofilePut).toHaveBeenCalledTimes(1));
    expect(
      (inferenceprofilePut.mock.calls[0]![0] as { body: { profile: string } })
        .body.profile,
    ).toBe("smart");
  });
});

describe("Profile selection with no active conversation (new draft chat)", () => {
  test("stashes the selection for the draft instead of overwriting the global default", async () => {
    // Guard against a hanging/altered config impl leaking from a prior test.
    configGetMock.mockImplementation(async () => ({
      data: {
        llm: {
          profileOrder: ["smart"],
          profiles: { smart: { label: "Smart" } },
          activeProfile: "smart",
        },
      },
    }));
    // The composer is on a brand-new draft chat: a draft id lives in the store,
    // but there is no server conversation yet (conversationId prop undefined).
    useConversationStore.getState().setActiveConversationId("draft-xyz");

    const qc = new QueryClient({
      defaultOptions: {
        queries: { retry: false },
        mutations: { retry: false },
      },
    });
    render(
      createElement(
        QueryClientProvider,
        { client: qc },
        createElement(ComposerSettingsMenu, {
          assistantId: "assistant-1",
          conversationId: undefined,
        }),
      ),
    );

    // "Smart" now renders both on the composer trigger and in the menu row, so
    // wait for at least one occurrence rather than asserting a single match.
    await waitFor(() =>
      expect(screen.getAllByText("Smart").length).toBeGreaterThan(0),
    );

    const smart = screen
      .getAllByTestId("menu-item")
      .find((b) => b.textContent?.includes("Smart"));
    fireEvent.click(smart!);

    // The selection is stashed on the draft, scoped to its client-side id...
    await waitFor(() => {
      expect(
        useConversationStore.getState().pendingDraftProfiles.get("draft-xyz"),
      ).toBe("smart");
    });
    // ...and neither the global default profile nor a per-conversation override
    // is written (no server conversation exists yet).
    expect(configPatchMock).not.toHaveBeenCalled();
    expect(inferenceprofilePut).not.toHaveBeenCalled();
  });
});
