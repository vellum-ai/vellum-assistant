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
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  createContext,
  createElement,
  useContext,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";

// --- use-is-mobile -----------------------------------------------------------
const isMobileRef = { value: false };
mock.module("@/hooks/use-is-mobile", () => ({
  useIsMobile: () => isMobileRef.value,
  MOBILE_MEDIA_QUERY: "(max-width: 767px)",
}));

const isTouchMobileRef = { value: false };
mock.module("@/hooks/use-touch-mobile", () => ({
  useTouchMobile: () => isTouchMobileRef.value,
  TOUCH_MOBILE_MEDIA_QUERY: "(width < 48rem) and (pointer: coarse)",
}));

// --- toast -------------------------------------------------------------------
const toastSuccess = mock((_msg: string) => {});
const toastError = mock((_msg: string) => {});
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: toastSuccess, error: toastError },
}));

// --- threshold-api (mount-time access-level fetches) -------------------------
// Mocks rather than plain stubs: the boot-seed cases hold the global-thresholds
// fetch open to observe what the pill renders meanwhile, and assert that a
// press in that window reaches no mutation. `"low"` is a real `RiskThreshold`
// and maps to the Conservative preset, which is the label the rest of the file
// expects the access trigger to settle on.
const getGlobalThresholdsMock = mock(
  async (_assistantId: string): Promise<{ interactive: unknown }> => ({
    interactive: "low",
  }),
);
const getConversationOverrideMock = mock(
  async (..._args: unknown[]): Promise<unknown> => null,
);
const setGlobalThresholdsMock = mock(async (..._args: unknown[]) => {});
const setConversationOverrideMock = mock(async (..._args: unknown[]) => {});
const deleteConversationOverrideMock = mock(async (..._args: unknown[]) => {});
mock.module("@/lib/threshold-api", () => ({
  getGlobalThresholds: getGlobalThresholdsMock,
  getConversationOverride: getConversationOverrideMock,
  setConversationOverride: setConversationOverrideMock,
  deleteConversationOverride: deleteConversationOverrideMock,
  setGlobalThresholds: setGlobalThresholdsMock,
}));

// --- profile quick-add controller (top-level) --------------------------------
// Capture the args passed to openProfileQuickAdd so tests can assert the "+"
// wiring and simulate the provider's onCreated callback firing.
type QuickAddArgs = {
  existingNames?: string[];
  onCreated?: (name: string, label: string | null) => void;
  onClosed?: () => void;
};
const openProfileQuickAdd = mock((_args?: QuickAddArgs) => {});
mock.module("@/components/profile-quick-add-provider", () => ({
  useProfileQuickAdd: () => ({ openProfileQuickAdd }),
}));

// --- design-library surfaces (render content inline) -------------------------
const passthrough = ({ children, ...props }: Record<string, unknown>) =>
  createElement("div", props, children as ReactNode);
// Radix owns the open state on the Root and flips it when the trigger is
// activated. The mock hands the Root's `onOpenChange` down to its Trigger so
// activating a trigger opens the surface the way it does in the app. Each
// surface keeps its own activation gesture (see the two triggers below), since
// which one a pill answers to is exactly what the mobile tests pin down.
const OpenChangeContext = createContext<((open: boolean) => void) | undefined>(
  undefined,
);
const surfaceRoot = ({
  children,
  open: _open,
  onOpenChange,
  ...props
}: Record<string, unknown>) =>
  createElement(
    OpenChangeContext.Provider,
    { value: onOpenChange as ((open: boolean) => void) | undefined },
    createElement("div", props, children as ReactNode),
  );
// The sheet is a Radix Dialog underneath, whose trigger opens on click.
const SheetTrigger = ({
  children,
  asChild: _asChild,
  ...props
}: Record<string, unknown>) => {
  const onOpenChange = useContext(OpenChangeContext);
  return createElement(
    "div",
    { ...props, onClick: () => onOpenChange?.(true) },
    children as ReactNode,
  );
};
// The menu is a Radix DropdownMenu, whose trigger opens on pointerdown rather
// than click, through a composed handler that bails once the child's own
// handler has called preventDefault. Both halves matter here: a trigger child
// that cancels the press would be inert in this surface, so the mock has to be
// able to show that.
const MenuTrigger = ({
  children,
  asChild: _asChild,
  ...props
}: Record<string, unknown>) => {
  const onOpenChange = useContext(OpenChangeContext);
  return createElement(
    "div",
    {
      ...props,
      onPointerDown: (event: ReactPointerEvent) => {
        if (event.defaultPrevented) {
          return;
        }
        onOpenChange?.(true);
      },
    },
    children as ReactNode,
  );
};
// Radix dismisses a dropdown when one of its items is selected, so the mocked
// item reports the close through the same Root callback after running onSelect.
const MenuItem = ({
  children,
  onSelect,
  leftIcon,
  ...rest
}: Record<string, unknown>) => {
  const onOpenChange = useContext(OpenChangeContext);
  return createElement(
    "button",
    {
      "data-testid": "menu-item",
      onClick: () => {
        (onSelect as (() => void) | undefined)?.();
        onOpenChange?.(false);
      },
      ...rest,
    },
    leftIcon as ReactNode,
    children as ReactNode,
  );
};
mock.module("@vellumai/design-library", () => {
  const MenuMock = {
    Root: surfaceRoot,
    Trigger: MenuTrigger,
    Content: passthrough,
    Item: MenuItem,
    Label: passthrough,
    Separator: () => createElement("hr"),
  };
  const BottomSheetMock = {
    Root: surfaceRoot,
    Trigger: SheetTrigger,
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
      leftIcon: _l,
      expandOnMobile: _e,
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
    // Marked rather than transparent so a test can tell whether a trigger was
    // wrapped in a tooltip at all. Radix opens one on focus as well as hover,
    // so on the touch presentation its presence is the bug.
    Tooltip: ({ children, content }: Record<string, unknown>) =>
      createElement(
        "span",
        { "data-testid": "tooltip", "data-tooltip-content": content as string },
        children as ReactNode,
      ),
  };
});

const NEW_PROFILE_NAME = "fast-cheap";
const NEW_PROFILE_LABEL = "Fast & Cheap";

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

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
        profiles: {
          smart: {
            label: "Smart",
            provider: "anthropic",
            model: "claude-fable-5",
          },
        },
        activeProfile: "smart",
      },
    },
  }),
);
const conversationsByIdGetMock = mock(
  async (
    _opts: unknown,
  ): Promise<{
    data: { conversation: { inferenceProfile: string | null } };
  }> => ({
    data: { conversation: { inferenceProfile: null } },
  }),
);
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

import { ComposerCompactProvider } from "@/domains/chat/components/chat-composer/composer-compact";
import { ComposerSettingsMenu } from "@/domains/chat/components/composer-settings-menu";
// Real store (not mocked) — the component reads the draft conversation id and
// the pending-profile stash from it.
import { loadComposerPillSnapshot } from "@/domains/chat/utils/composer-pill-storage";
import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";
import { ApiError } from "@/utils/api-errors";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";
import { clearUserScopedOverrides } from "@/utils/typed-storage";

/** The key the composer seeds its pills from on the next launch. */
const PILL_SNAPSHOT_KEY = "vellum:composerPills:assistant-1";

function seedPillSnapshot(snapshot: {
  accessPresetId?: string;
  profileLabel?: string;
}) {
  localStorage.setItem(PILL_SNAPSHOT_KEY, JSON.stringify(snapshot));
}

/** Hold the gateway's threshold fetch open for the length of a test. */
function hangGlobalThresholds() {
  getGlobalThresholdsMock.mockImplementation(() => new Promise(() => {}));
}

/**
 * Let the fetches a first-frame assertion deliberately raced settle inside
 * `act`, so their state updates land before the test tears the tree down.
 */
async function settleMountFetches() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** The config payload most cases mount against: one profile, "Smart". */
const SMART_CONFIG = {
  llm: {
    profileOrder: ["smart"],
    profiles: {
      smart: {
        label: "Smart",
        provider: "anthropic",
        model: "claude-fable-5",
      },
    },
    activeProfile: "smart",
  },
};

function createQueryClient() {
  return new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
}

interface Scaffold {
  /** Props for the menu under test, over the shared assistant/conversation. */
  props?: {
    conversationId?: string;
    segments?: "both" | "access" | "profile";
    onOpenChange?: (open: boolean) => void;
  };
  /**
   * Mount inside a `ComposerCompactProvider` at this width. Left out, the menu
   * mounts bare, the way the wide composer renders it.
   */
  compact?: boolean;
  /** Pass a client to keep its cache across a `rerender`. */
  queryClient?: QueryClient;
}

/**
 * The one provider scaffold for this file: a QueryClient wrapper, optionally a
 * compact composer around it, and the menu with the shared ids.
 */
function menuElement({ props, compact, queryClient }: Scaffold = {}) {
  const menu = createElement(ComposerSettingsMenu, {
    assistantId: "assistant-1",
    conversationId: "conv-1",
    ...props,
  });
  return createElement(
    QueryClientProvider,
    { client: queryClient ?? createQueryClient() },
    compact === undefined
      ? menu
      : createElement(ComposerCompactProvider, { compact, children: menu }),
  );
}

function renderMenu(scaffold?: Scaffold) {
  return render(menuElement(scaffold));
}

beforeEach(() => {
  isMobileRef.value = false;
  isTouchMobileRef.value = false;
  openProfileQuickAdd.mockClear();
  inferenceprofilePut.mockClear();
  configPatchMock.mockClear();
  configGetMock.mockClear();
  conversationsByIdGetMock.mockClear();
  toastSuccess.mockClear();
  toastError.mockClear();
  getGlobalThresholdsMock.mockImplementation(async () => ({
    interactive: "low",
  }));
  getConversationOverrideMock.mockImplementation(async () => null);
  setGlobalThresholdsMock.mockClear();
  setConversationOverrideMock.mockClear();
  deleteConversationOverrideMock.mockClear();
  useConversationStore.getState().reset();
  // The menu writes the settled pill labels here for the next launch, so a
  // mounted test leaves a seed behind that the next one would boot from.
  localStorage.clear();
  clearUserScopedOverrides();
});

afterEach(() => {
  cleanup();
  useConversationStore.getState().reset();
  localStorage.clear();
  clearUserScopedOverrides();
});

describe("Model Profile quick-add", () => {
  test('"+" New Model renders on desktop, including with profiles present', async () => {
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Model")).toBeTruthy();
    });
    // Header is present alongside the existing profile.
    expect(document.body.textContent).toContain("Model Profile");
  });

  test('"+" New Model renders on mobile', async () => {
    isMobileRef.value = true;
    isTouchMobileRef.value = true;
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Model")).toBeTruthy();
    });
  });

  test("the touch presentation carries no tooltip on the quick-add", async () => {
    // Radix opens a tooltip on focus as well as hover, and the bottom sheet
    // autofocuses this button as its first tabbable element, so a tooltip here
    // shows itself every time the sheet rises rather than on any hover.
    isMobileRef.value = true;
    isTouchMobileRef.value = true;
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Model")).toBeTruthy();
    });
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  test("the mouse presentation keeps the quick-add tooltip", async () => {
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Model")).toBeTruthy();
    });
    const tooltip = screen.getByTestId("tooltip");
    expect(tooltip.getAttribute("data-tooltip-content")).toBe("New Model");
    expect(tooltip.querySelector('[aria-label="New Model"]')).toBeTruthy();
  });

  test('"+" New Model renders even with zero profiles', async () => {
    configGetMock.mockImplementationOnce(async () => ({
      data: { llm: { profileOrder: [], profiles: {}, activeProfile: null } },
    }));
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Model")).toBeTruthy();
    });
    expect(document.body.textContent).toContain("Model Profile");
  });

  test("clicking + closes the popover and opens the quick-add controller", async () => {
    renderMenu();
    await waitFor(() => screen.getByLabelText("New Model"));

    // Wait for config to load so the "+" is enabled.
    await waitFor(() => {
      const plus = screen.getByLabelText("New Model") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });

    fireEvent.click(screen.getByLabelText("New Model"));

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
      const plus = screen.getByLabelText("New Model") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText("New Model"));

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
            smart: {
              label: "Smart",
              provider: "anthropic",
              model: "claude-fable-5",
            },
            [NEW_PROFILE_NAME]: {
              label: NEW_PROFILE_LABEL,
              provider: "anthropic",
              model: "claude-fable-5",
            },
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

    await waitFor(() => screen.getByLabelText("New Model"));
    const plus = screen.getByLabelText("New Model") as HTMLButtonElement;
    expect(plus.disabled).toBe(true);
    expect(plus.getAttribute("aria-disabled")).toBe("true");

    // A click while disabled must NOT open the quick-add controller.
    fireEvent.click(plus);
    expect(openProfileQuickAdd).not.toHaveBeenCalled();
  });

  test('"+" enables once the config fetch settles', async () => {
    renderMenu();
    await waitFor(() => {
      const plus = screen.getByLabelText("New Model") as HTMLButtonElement;
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
      const plus = screen.getByLabelText("New Model") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText("New Model"));

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
    const queryClient = createQueryClient();
    const tree = (conversationId: string) =>
      menuElement({ props: { conversationId }, queryClient });

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

describe("Profile trigger updates", () => {
  test("keeps the selected label while the conversation refetch settles", async () => {
    const configData = {
      llm: {
        profileOrder: ["balanced", "quality"],
        profiles: {
          balanced: {
            label: "Balanced",
            provider: "anthropic",
            model: "claude-fable-5",
          },
          quality: {
            label: "Quality",
            provider: "anthropic",
            model: "claude-fable-5",
          },
        },
        activeProfile: "balanced",
      },
    };
    const configRefetch = deferred<{ data: unknown }>();
    let configCallCount = 0;
    configGetMock.mockImplementation(() => {
      configCallCount += 1;
      if (configCallCount === 1) {
        return Promise.resolve({ data: configData });
      }
      return configRefetch.promise;
    });

    const conversationRefetch = deferred<{
      data: { conversation: { inferenceProfile: string } };
    }>();
    let conversationCallCount = 0;
    conversationsByIdGetMock.mockImplementation(() => {
      conversationCallCount += 1;
      if (conversationCallCount === 1) {
        return Promise.resolve({
          data: { conversation: { inferenceProfile: "balanced" } },
        });
      }
      return conversationRefetch.promise;
    });

    renderMenu();
    const trigger = await screen.findByLabelText(/^Model profile/);
    await waitFor(() => expect(trigger.textContent).toContain("Balanced"));

    const qualityItem = screen
      .getAllByTestId("menu-item")
      .find((item) => item.textContent?.includes("Quality"));
    fireEvent.click(qualityItem!);

    await waitFor(() => {
      expect(inferenceprofilePut).toHaveBeenCalledTimes(1);
      expect(configCallCount).toBe(2);
      expect(conversationCallCount).toBe(2);
    });

    await act(async () => {
      configRefetch.resolve({ data: configData });
      await configRefetch.promise;
      await Promise.resolve();
    });

    expect(trigger.textContent).toContain("Quality");

    await act(async () => {
      conversationRefetch.resolve({
        data: { conversation: { inferenceProfile: "quality" } },
      });
      await conversationRefetch.promise;
    });

    expect(trigger.textContent).toContain("Quality");
  });
});

describe("Profile selection with no active conversation (new draft chat)", () => {
  test("stashes the selection for the draft instead of overwriting the global default", async () => {
    // Guard against a hanging/altered config impl leaking from a prior test.
    configGetMock.mockImplementation(async () => ({ data: SMART_CONFIG }));
    // The composer is on a brand-new draft chat: a draft id lives in the store,
    // but there is no server conversation yet (conversationId prop undefined).
    useConversationStore.getState().setActiveConversationId("draft-xyz");

    renderMenu({ props: { conversationId: undefined } });

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

describe("Profile activation rejected by the daemon", () => {
  /** Load the menu and click the "Smart" profile row. */
  async function selectSmart() {
    // Guard against a hanging/altered config impl leaking from a prior test.
    configGetMock.mockImplementation(async () => ({ data: SMART_CONFIG }));
    renderMenu();
    await waitFor(() =>
      expect(screen.getAllByText("Smart").length).toBeGreaterThan(0),
    );
    const smart = screen
      .getAllByTestId("menu-item")
      .find((b) => b.textContent?.includes("Smart"));
    // The rejection rolls the optimistic selection back asynchronously — flush
    // that state update inside `act` so the assertion sees a settled tree.
    await act(async () => {
      fireEvent.click(smart!);
    });
  }

  test("surfaces the server's 400 reason instead of generic retry copy", async () => {
    // The daemon rejects a profile it can't dispatch through with a 400 naming
    // what's missing; retry copy would send the user round the same loop.
    inferenceprofilePut.mockImplementationOnce(async () => {
      throw new ApiError(
        400,
        'Profile "smart" has no API key for provider "gemini".',
      );
    });

    await selectSmart();

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        'Profile "smart" has no API key for provider "gemini".',
      );
    });
  });

  test("keeps the generic copy for a non-400 failure", async () => {
    inferenceprofilePut.mockImplementationOnce(async () => {
      throw new ApiError(500, "boom: db offline");
    });

    await selectSmart();

    await waitFor(() => {
      expect(toastError).toHaveBeenCalledWith(
        "Failed to switch profile. Please try again.",
      );
    });
  });
});

describe("mobile pill triggers", () => {
  // Preset[1] ("Conservative") is what the mocked global threshold of 50
  // resolves to, so it is the label the access trigger settles on.
  const ACCESS_TRIGGER_LABEL = "Assistant access: Conservative";
  // The fill the pills float on. Distinct from the composer card's own
  // `--surface-lift`, which reads as no pill at all against the card.
  const PILL_FILL_CLASS = "bg-[var(--border-subtle)]";

  /**
   * The pill's glyph sits at the design's 20px (Figma 7840-8818), so it rides
   * as a child of the button rather than in the Button's own narrower icon
   * box. Both classes matter: the box holds the space, the `svg` rule sizes
   * the icon, which would otherwise render at its own default.
   */
  function expectGlyphSizedForPill(pill: HTMLElement) {
    const glyph = pill.querySelector('span[aria-hidden="true"]');
    const glyphClass = glyph?.getAttribute("class") ?? "";
    expect(glyphClass).toContain("size-5");
    expect(glyphClass).toContain("[&_svg]:size-5");
  }

  beforeEach(() => {
    isMobileRef.value = true;
    isTouchMobileRef.value = true;
    // Guard against a hanging/altered impl leaking from a prior test.
    configGetMock.mockImplementation(async () => ({ data: SMART_CONFIG }));
    conversationsByIdGetMock.mockImplementation(async () => ({
      data: { conversation: { inferenceProfile: null } },
    }));
  });

  test("renders the resolved access and profile labels on the pills", async () => {
    renderMenu();

    const accessTrigger = await screen.findByLabelText(ACCESS_TRIGGER_LABEL);
    expect(accessTrigger.textContent).toContain("Conservative");
    expect(accessTrigger.getAttribute("class")).toContain(PILL_FILL_CLASS);

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    await waitFor(() => {
      expect(profileTrigger.textContent).toContain("Smart");
    });
    expect(profileTrigger.getAttribute("class")).toContain(PILL_FILL_CLASS);
  });

  test("renders both pill glyphs at the design's 20px", async () => {
    renderMenu();

    const accessTrigger = await screen.findByLabelText(ACCESS_TRIGGER_LABEL);
    expectGlyphSizedForPill(accessTrigger);

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    await waitFor(() => {
      expect(profileTrigger.textContent).toContain("Smart");
    });
    expectGlyphSizedForPill(profileTrigger);
  });

  test("names the profile pill by the profile it displays", async () => {
    // An aria-label overrides the pill's visible text, so a generic one leaves
    // a screen reader unable to announce the selection and voice control unable
    // to activate the pill by the words it shows.
    renderMenu();

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    await waitFor(() => {
      expect(profileTrigger.getAttribute("aria-label")).toBe(
        "Model profile: Smart",
      );
    });
    expect(profileTrigger.textContent).toContain("Smart");

    // The access pill already carries its own selection in its name.
    const accessTrigger = await screen.findByLabelText(ACCESS_TRIGGER_LABEL);
    expect(accessTrigger.textContent).toContain("Conservative");
  });

  test("keeps the pill shape when the profile label never resolves", async () => {
    // No profile to name, so the pill has no label to carry. It still has to
    // hold the row's geometry: the action row's icon button would render a
    // 40px circle beside the 32px access pill.
    configGetMock.mockImplementation(async () => ({
      data: { llm: { profileOrder: [], profiles: {}, activeProfile: null } },
    }));
    renderMenu();

    const profileTrigger = await screen.findByLabelText("Model profile");
    expect(profileTrigger.textContent).toBe("");
    const pillClass = profileTrigger.getAttribute("class") ?? "";
    expect(pillClass).toContain("h-8");
    expect(pillClass).toContain("w-8");
    expect(pillClass).toContain("rounded-full");
    expect(pillClass).toContain(PILL_FILL_CLASS);
    expectGlyphSizedForPill(profileTrigger);
  });

  test("tapping a pill opens the same bottom sheet and reports the open state", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    renderMenu({ props: { onOpenChange } });

    const accessTrigger = await screen.findByLabelText(ACCESS_TRIGGER_LABEL);
    // WebKit blurs the textarea before the click if the press is allowed to
    // move focus. The pill must cancel that transfer so the focus-gated row
    // remains mounted long enough for the sheet trigger to receive the click.
    //
    // Both halves of the press matter. `mousedown` is the one that carries the
    // focus transfer, so it has to be cancelled; `pointerdown` must be left
    // alone, because WebKit drops the rest of the sequence when it is
    // cancelled and the sheet would never get its click.
    expect(fireEvent.pointerDown(accessTrigger)).toBe(true);
    expect(fireEvent.mouseDown(accessTrigger)).toBe(false);
    fireEvent.click(accessTrigger);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });

    // The sheet the pill opens holds the same access rows the icon trigger
    // opens today; picking one closes it again.
    const relaxed = screen
      .getAllByTestId("panel-item")
      .find((row) => row.textContent?.includes("Relaxed"));
    fireEvent.click(relaxed!);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  test("reports the profile sheet's open state too", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    renderMenu({ props: { onOpenChange } });

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    // Same press contract as the access pill: hold the focus on mousedown,
    // leave pointerdown alone so the click still lands.
    expect(fireEvent.pointerDown(profileTrigger)).toBe(true);
    expect(fireEvent.mouseDown(profileTrigger)).toBe(false);
    fireEvent.click(profileTrigger);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });

    const smart = screen
      .getAllByTestId("panel-item")
      .find((row) => row.textContent?.includes("Smart"));
    fireEvent.click(smart!);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  test("presses through to the menu in a narrow window with a mouse", async () => {
    // Same pills, mouse pointer: the surface is a dropdown, which opens on the
    // pointerdown itself. Cancelling that press to protect the touch sheet
    // would leave the pill dead here, with no click activation to fall back on.
    isTouchMobileRef.value = false;
    const onOpenChange = mock((_open: boolean) => {});
    renderMenu({ props: { onOpenChange } });

    const accessTrigger = await screen.findByLabelText(ACCESS_TRIGGER_LABEL);
    expect(fireEvent.pointerDown(accessTrigger)).toBe(true);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });
  });

  test("presses the profile pill through to its menu too", async () => {
    isTouchMobileRef.value = false;
    const onOpenChange = mock((_open: boolean) => {});
    renderMenu({ props: { onOpenChange } });

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    await waitFor(() => {
      expect(profileTrigger.textContent).toContain("Smart");
    });
    expect(fireEvent.pointerDown(profileTrigger)).toBe(true);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });
  });
});

describe("pills seeded from the last launch", () => {
  beforeEach(() => {
    isMobileRef.value = true;
    isTouchMobileRef.value = true;
    configGetMock.mockImplementation(async () => ({ data: SMART_CONFIG }));
    conversationsByIdGetMock.mockImplementation(async () => ({
      data: { conversation: { inferenceProfile: null } },
    }));
  });

  test("paints both pills labelled on the very first render", async () => {
    // Nothing has answered yet: the config fetch is daemon-proxied and slow on
    // boot, and the thresholds fetch is held open here to stand for the same
    // window. Both pills still have to be readable in the first frame.
    seedPillSnapshot({ accessPresetId: "relaxed", profileLabel: "Balanced" });
    hangGlobalThresholds();
    configGetMock.mockImplementation(() => new Promise(() => {}));

    renderMenu();

    const accessTrigger = screen.getByLabelText("Assistant access: Relaxed");
    expect(accessTrigger.textContent).toContain("Relaxed");
    const profileTrigger = screen.getByLabelText("Model profile: Balanced");
    expect(profileTrigger.textContent).toContain("Balanced");

    await settleMountFetches();
  });

  test("reconciles to the server's answer without unmounting the pill", async () => {
    // The seed is a display stand-in, so a stale label must give way silently
    // once the real fetches land, in the same element the fade plays in.
    seedPillSnapshot({ accessPresetId: "relaxed", profileLabel: "Balanced" });

    renderMenu();

    const profileTrigger = screen.getByLabelText("Model profile: Balanced");
    expect(
      screen.getByLabelText("Assistant access: Relaxed").textContent,
    ).toContain("Relaxed");

    await waitFor(() => {
      expect(profileTrigger.textContent).toContain("Smart");
    });
    await waitFor(() => {
      expect(
        screen.getByLabelText("Assistant access: Conservative"),
      ).toBeTruthy();
    });
    // Same node throughout: the label swapped inside the pill rather than the
    // pill being replaced.
    expect(screen.getByLabelText("Model profile: Smart")).toBe(profileTrigger);
  });

  test("an unrecognized stored preset leaves the access pill hidden", async () => {
    // The un-fetched fallback preset names a stricter level than the server's
    // own default, so a seed that no longer maps to a preset has to fall back
    // to showing nothing rather than to that fallback.
    seedPillSnapshot({ accessPresetId: "wide-open", profileLabel: "Balanced" });
    hangGlobalThresholds();
    configGetMock.mockImplementation(() => new Promise(() => {}));

    renderMenu();

    expect(screen.queryByLabelText(/^Assistant access/)).toBeNull();
    expect(screen.getByLabelText("Model profile: Balanced")).toBeTruthy();

    await settleMountFetches();
  });

  test("records what each pill settled on for the next launch", async () => {
    renderMenu();

    await waitFor(() => {
      const stored = loadComposerPillSnapshot("assistant-1");
      expect(stored.accessPresetId).toBe("conservative");
      expect(stored.profileLabel).toBe("Smart");
    });
  });

  test("maps the server's threshold onto the preset it actually names", async () => {
    // "medium" is Relaxed, and is also the gateway's own no-row default, so
    // getting this mapping wrong is what the seed exists to avoid.
    getGlobalThresholdsMock.mockImplementation(async () => ({
      interactive: "medium",
    }));

    renderMenu();

    await waitFor(() => {
      expect(loadComposerPillSnapshot("assistant-1").accessPresetId).toBe(
        "relaxed",
      );
    });
    expect(
      await screen.findByLabelText("Assistant access: Relaxed"),
    ).toBeTruthy();
  });

  test("stores nothing for a threshold it can't name", async () => {
    // Version skew between the gateway and the web app: an unrecognized
    // threshold resolves to the conservative preset for display, and freezing
    // that into the seed would boot every later launch on a stricter level than
    // the server holds.
    getGlobalThresholdsMock.mockImplementation(async () => ({
      interactive: "paranoid",
    }));

    renderMenu();

    await waitFor(() => {
      expect(loadComposerPillSnapshot("assistant-1").profileLabel).toBe(
        "Smart",
      );
    });
    expect(loadComposerPillSnapshot("assistant-1").accessPresetId).toBeNull();
  });

  test("an unrecognized answer clears the seed it contradicts", async () => {
    // The stored preset is from the old vocabulary, so this build would keep
    // repainting it on every cold launch while the server holds something it
    // cannot name. A non-null answer with no matching preset invalidates the
    // seed rather than leaving it to reconcile again every boot.
    seedPillSnapshot({ accessPresetId: "relaxed", profileLabel: "Balanced" });
    getGlobalThresholdsMock.mockImplementation(async () => ({
      interactive: "paranoid",
    }));

    renderMenu();

    await waitFor(() => {
      const stored = loadComposerPillSnapshot("assistant-1");
      expect(stored.accessPresetId).toBeNull();
      expect(stored.profileLabel).toBe("Smart");
    });
  });

  test("a successful config with no nameable profile clears that seed", async () => {
    // The server answered: there is no active profile this build can label.
    // Leaving the old label stored would repaint it on every cold launch, the
    // profile-side twin of the unnameable-threshold case above.
    seedPillSnapshot({ accessPresetId: "relaxed", profileLabel: "Balanced" });
    configGetMock.mockImplementation(async () => ({
      data: {
        llm: {
          profileOrder: ["smart"],
          profiles: {
            smart: {
              label: "Smart",
              provider: "anthropic",
              model: "claude-fable-5",
            },
          },
        },
      },
    }));

    renderMenu();

    await waitFor(() => {
      const stored = loadComposerPillSnapshot("assistant-1");
      expect(stored.profileLabel).toBeNull();
      expect(stored.accessPresetId).toBe("conservative");
    });
  });

  test("a conversation override is not what the next launch boots from", async () => {
    // The seed stands in for every conversation the assistant opens, so it
    // tracks the global default rather than one thread's override.
    conversationsByIdGetMock.mockImplementation(async () => ({
      data: { conversation: { inferenceProfile: "quality" } },
    }));
    configGetMock.mockImplementation(async () => ({
      data: {
        llm: {
          profileOrder: ["smart", "quality"],
          profiles: {
            smart: {
              label: "Smart",
              provider: "anthropic",
              model: "claude-fable-5",
            },
            quality: {
              label: "Quality",
              provider: "anthropic",
              model: "claude-fable-5",
            },
          },
          activeProfile: "smart",
        },
      },
    }));

    renderMenu();

    const profileTrigger = await screen.findByLabelText(
      "Model profile: Quality",
    );
    expect(profileTrigger.textContent).toContain("Quality");
    expect(loadComposerPillSnapshot("assistant-1").profileLabel).toBe("Smart");
  });

  test("the seeded access pill is inert until the real value lands", async () => {
    // `handleSelect` needs the global threshold to decide between setting an
    // override and clearing one, so it refuses to act without it. A pill that
    // looked live in that window would take a press, close its surface, and
    // send nothing, which on a failed fetch never resolves itself.
    seedPillSnapshot({ accessPresetId: "relaxed" });
    hangGlobalThresholds();

    renderMenu();

    const accessTrigger = screen.getByLabelText(
      "Assistant access: Relaxed",
    ) as HTMLButtonElement;
    expect(accessTrigger.textContent).toContain("Relaxed");
    expect(accessTrigger.disabled).toBe(true);

    // Reaching a row anyway (the compact hamburger opens one without passing
    // through this trigger) must still not mutate anything.
    const relaxedRow = screen
      .getAllByTestId("panel-item")
      .find((row) => row.textContent?.includes("Relaxed"));
    await act(async () => {
      fireEvent.click(relaxedRow!);
    });

    expect(setGlobalThresholdsMock).not.toHaveBeenCalled();
    expect(setConversationOverrideMock).not.toHaveBeenCalled();
    expect(deleteConversationOverrideMock).not.toHaveBeenCalled();

    await settleMountFetches();
  });

  test("the access pill goes live once the fetch lands", async () => {
    // The other half of the gate: the inert state has to end, or the seed has
    // traded one broken control for another.
    seedPillSnapshot({ accessPresetId: "relaxed" });

    renderMenu();

    await waitFor(() => {
      const accessTrigger = screen.getByLabelText(
        "Assistant access: Conservative",
      ) as HTMLButtonElement;
      expect(accessTrigger.disabled).toBe(false);
    });

    const relaxedRow = screen
      .getAllByTestId("panel-item")
      .find((row) => row.textContent?.includes("Relaxed"));
    await act(async () => {
      fireEvent.click(relaxedRow!);
    });

    await waitFor(() => {
      expect(setConversationOverrideMock).toHaveBeenCalledTimes(1);
    });
  });

  test("an override arriving first shows its level but stays inert", async () => {
    // The two threshold fetches are independent, and the per-conversation one
    // can land first. It names the level to display, but `handleSelect` still
    // needs the global value to choose between setting an override and
    // clearing one, so the picker must not open on the override alone.
    const globalSettle = deferred<{ interactive: string }>();
    getGlobalThresholdsMock.mockImplementation(() => globalSettle.promise);
    getConversationOverrideMock.mockImplementation(async () => "high");

    renderMenu();

    const accessTrigger = (await screen.findByLabelText(
      "Assistant access: Full access",
    )) as HTMLButtonElement;
    expect(accessTrigger.textContent).toContain("Full access");
    expect(accessTrigger.disabled).toBe(true);

    const relaxedRow = screen
      .getAllByTestId("panel-item")
      .find((row) => row.textContent?.includes("Relaxed"));
    await act(async () => {
      fireEvent.click(relaxedRow!);
    });
    expect(setConversationOverrideMock).not.toHaveBeenCalled();
    expect(deleteConversationOverrideMock).not.toHaveBeenCalled();
    expect(setGlobalThresholdsMock).not.toHaveBeenCalled();

    // The global value lands: the same pill goes live and the press it would
    // have dropped now reaches the server.
    await act(async () => {
      globalSettle.resolve({ interactive: "low" });
      await globalSettle.promise;
    });
    await waitFor(() => {
      expect(accessTrigger.disabled).toBe(false);
    });

    await act(async () => {
      fireEvent.click(relaxedRow!);
    });
    await waitFor(() => {
      expect(setConversationOverrideMock).toHaveBeenCalledTimes(1);
    });
  });

  test("a failed thresholds fetch drops the seeded level instead of holding it", async () => {
    // Mirrors the profile side: with no answer coming, a stored permission
    // level would sit on the composer for the rest of the session claiming a
    // setting the app cannot confirm.
    seedPillSnapshot({ accessPresetId: "relaxed" });
    getGlobalThresholdsMock.mockImplementation(async () => {
      throw new ApiError(500, "gateway unreachable");
    });

    renderMenu();

    expect(screen.getByLabelText("Assistant access: Relaxed")).toBeTruthy();

    await waitFor(() => {
      expect(screen.queryByLabelText(/^Assistant access/)).toBeNull();
    });
  });

  test("the seeded profile pill offers nothing to select before config lands", async () => {
    // The profile picker's selection handler bails while the config fetch is
    // unsettled. Nothing is swallowed only because there is nothing to press:
    // the seed names a label, it does not invent a list to pick from.
    seedPillSnapshot({ profileLabel: "Balanced" });
    configGetMock.mockImplementation(() => new Promise(() => {}));

    renderMenu();

    expect(screen.getByLabelText("Model profile: Balanced")).toBeTruthy();
    expect(
      screen
        .queryAllByTestId("panel-item")
        .filter((row) => row.textContent?.includes("Balanced")),
    ).toHaveLength(0);
    expect(inferenceprofilePut).not.toHaveBeenCalled();

    await settleMountFetches();
  });

  test("a failed config fetch drops the seeded label instead of holding it", async () => {
    // With no answer coming, the stale label would sit there for the life of
    // the session claiming a selection the app cannot confirm.
    seedPillSnapshot({ profileLabel: "Balanced" });
    configGetMock.mockImplementation(async () => {
      throw new ApiError(500, "daemon unreachable");
    });

    renderMenu();

    expect(screen.getByLabelText("Model profile: Balanced")).toBeTruthy();

    const profileTrigger = await screen.findByLabelText("Model profile");
    expect(profileTrigger.textContent).toBe("");
  });

  test("first run, with nothing stored, still holds the pill's shape", async () => {
    hangGlobalThresholds();
    configGetMock.mockImplementation(() => new Promise(() => {}));

    renderMenu();

    // No seed to show, so the access pill stays hidden rather than naming a
    // level the server never returned.
    expect(screen.queryByLabelText(/^Assistant access/)).toBeNull();
    const profileTrigger = screen.getByLabelText("Model profile");
    expect(profileTrigger.textContent).toBe("");
    const pillClass = profileTrigger.getAttribute("class") ?? "";
    expect(pillClass).toContain("h-8");
    expect(pillClass).toContain("w-8");

    await settleMountFetches();
  });

  test("the label fades into the pill the icon-only state already mounted", async () => {
    // The genuine first run has no seed, so the label does arrive late. It has
    // to land inside the same button, or there is nothing to transition.
    const configSettle = deferred<{ data: unknown }>();
    configGetMock.mockImplementation(() => configSettle.promise);

    renderMenu();

    const profileTrigger = screen.getByLabelText("Model profile");
    expect(profileTrigger.textContent).toBe("");

    await act(async () => {
      configSettle.resolve({ data: SMART_CONFIG });
      await configSettle.promise;
    });

    await waitFor(() => {
      expect(profileTrigger.textContent).toContain("Smart");
    });
    expect(screen.getByLabelText("Model profile: Smart")).toBe(profileTrigger);
    const labelSpan = profileTrigger.querySelector(
      'span:not([aria-hidden="true"])',
    );
    expect(labelSpan?.getAttribute("class")).toContain("animate-[fadeIn_");
    expect(labelSpan?.getAttribute("class")).toContain(
      "motion-reduce:animate-none",
    );
  });
});

describe("open-state reporting across the quick-add and unmount", () => {
  test("stays open while the quick-add modal it launched is up", async () => {
    // The modal renders outside the composer, and opening it closes the sheet
    // it was launched from. Reporting that close would put the pills row away
    // mid-flow, under a modal the user is still filling in.
    const onOpenChange = mock((_open: boolean) => {});
    renderMenu({ props: { onOpenChange } });

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    fireEvent.pointerDown(profileTrigger);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });

    await waitFor(() => {
      const plus = screen.getByLabelText("New Model") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText("New Model"));
    await waitFor(() => {
      expect(openProfileQuickAdd).toHaveBeenCalledTimes(1);
    });

    // The surface closed, but the flow it started has not.
    expect(onOpenChange).toHaveBeenLastCalledWith(true);

    // The provider reports the modal's close, whether it saved or cancelled.
    const onClosed = openProfileQuickAdd.mock.calls[0]![0]!.onClosed!;
    act(() => onClosed());
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  test("reports closed when it unmounts with a surface open", async () => {
    // Crossing the mobile breakpoint swaps the presentation and unmounts this
    // instance. A parent left holding `true` would keep a row up that nothing
    // is left to close.
    const onOpenChange = mock((_open: boolean) => {});
    const { unmount } = renderMenu({ props: { onOpenChange } });

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    fireEvent.pointerDown(profileTrigger);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });

    unmount();

    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  test("stays quiet when it unmounts with everything closed", async () => {
    const onOpenChange = mock((_open: boolean) => {});
    const { unmount } = renderMenu({ props: { onOpenChange } });

    await screen.findByLabelText(/^Model profile/);
    unmount();

    expect(onOpenChange).not.toHaveBeenCalled();
  });
});

describe("compact composer collapse", () => {
  test("folds both segments into one hamburger trigger", async () => {
    // The composer mounts only the access-segment instance when compact, so
    // that instance has to carry the model profile too, or the picker is
    // unreachable on a narrow window.
    renderMenu({ compact: true, props: { segments: "access" } });

    const trigger = await screen.findByLabelText(
      "Assistant access and model profile",
    );
    expect(trigger).toBeTruthy();
    // No labelled split triggers alongside it.
    expect(screen.queryByLabelText(/^Model profile/)).toBeNull();

    await waitFor(() => {
      expect(screen.getByText("Smart")).toBeTruthy();
    });
    // Access presets live in the same menu, under their own section label.
    expect(screen.getByText("Assistant Access")).toBeTruthy();
    expect(screen.getByText("Model Profile")).toBeTruthy();
  });

  test("reports the hamburger menu's open state", async () => {
    // The compact branch is the only surface this instance opens, so a parent
    // holding its trigger chrome visible has to hear about it too.
    const onOpenChange = mock((_open: boolean) => {});
    renderMenu({ compact: true, props: { segments: "access", onOpenChange } });

    const trigger = await screen.findByLabelText(
      "Assistant access and model profile",
    );
    fireEvent.pointerDown(trigger);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });

    await waitFor(() => {
      expect(screen.getByText("Smart")).toBeTruthy();
    });
    const smart = screen
      .getAllByTestId("menu-item")
      .find((row) => row.textContent?.includes("Smart"));
    fireEvent.click(smart!);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
  });

  test("summarizes the seeded pills before either fetch lands", async () => {
    // The hamburger carries the same two values in its title, so it seeds from
    // the same snapshot rather than announcing an empty selection on boot.
    seedPillSnapshot({ accessPresetId: "relaxed", profileLabel: "Balanced" });
    hangGlobalThresholds();
    configGetMock.mockImplementation(() => new Promise(() => {}));

    renderMenu({ compact: true, props: { segments: "access" } });

    const trigger = screen.getByLabelText("Assistant access and model profile");
    expect(trigger.getAttribute("title")).toBe(
      "Assistant access and model profile: Relaxed · Balanced",
    );

    await settleMountFetches();
  });

  test("holds the seeded access rows inert until the real value lands", async () => {
    // The hamburger reaches the access rows without passing through the pill
    // that the split layout disables, so the rows carry the gate themselves.
    seedPillSnapshot({ accessPresetId: "relaxed" });
    hangGlobalThresholds();

    renderMenu({ compact: true, props: { segments: "access" } });

    const relaxedRow = screen
      .getAllByTestId("menu-item")
      .find((row) => row.textContent?.includes("Relaxed"));
    expect((relaxedRow as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      fireEvent.click(relaxedRow!);
    });
    expect(setGlobalThresholdsMock).not.toHaveBeenCalled();
    expect(setConversationOverrideMock).not.toHaveBeenCalled();

    await settleMountFetches();
  });

  test("stays split when the composer is wide", async () => {
    renderMenu();

    await waitFor(() => {
      expect(screen.getByLabelText(/^Model profile/)).toBeTruthy();
    });
    expect(
      screen.queryByLabelText("Assistant access and model profile"),
    ).toBeNull();
  });

  test("stops reporting open when the width swap unmounts the open branch", async () => {
    // Resizing across the compact threshold unmounts whichever branch was
    // open. Its flag survives the unmount, so the report has to follow the
    // branch that is actually mounted or a parent holding trigger chrome
    // visible never hears the surface close.
    const onOpenChange = mock((_open: boolean) => {});
    const queryClient = createQueryClient();
    const tree = (compact: boolean) =>
      menuElement({
        compact,
        queryClient,
        props: { segments: "both", onOpenChange },
      });

    const { rerender } = render(tree(false));

    const profileTrigger = await screen.findByLabelText(/^Model profile/);
    fireEvent.pointerDown(profileTrigger);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(true);
    });

    // The composer narrows: the split triggers give way to the hamburger.
    rerender(tree(true));
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });

    // Widening back must not resurrect the surface the resize took away.
    rerender(tree(false));
    await screen.findByLabelText(/^Model profile/);
    await waitFor(() => {
      expect(onOpenChange).toHaveBeenLastCalledWith(false);
    });
    expect(onOpenChange.mock.calls.map((call) => call[0])).toEqual([
      true,
      false,
    ]);
  });
});

describe("Profile selection on a draft stub conversation (ATL-1136)", () => {
  test("stashes the selection instead of PUTting against the unminted id", async () => {
    // Guard against a hanging/altered config impl leaking from a prior test.
    configGetMock.mockImplementation(async () => ({ data: SMART_CONFIG }));
    // First send in flight: the optimistic draft stub is in the foreground
    // list cache, so the composer's `conversationId` prop is the client-minted
    // draft id — which has no server row yet, so a PUT against it would 404.
    useConversationStore.getState().setActiveConversationId("draft-xyz");
    const qc = createQueryClient();
    qc.setQueryData(conversationListQueryKey("assistant-1"), {
      conversations: [
        { conversationId: "draft-xyz", draft: true } as Conversation,
      ],
      hasMore: false,
    });
    renderMenu({ props: { conversationId: "draft-xyz" }, queryClient: qc });

    await waitFor(() =>
      expect(screen.getAllByText("Smart").length).toBeGreaterThan(0),
    );
    const smart = screen
      .getAllByTestId("menu-item")
      .find((b) => b.textContent?.includes("Smart"));
    fireEvent.click(smart!);

    // The selection lands in the stash (the send path / mint-time re-key
    // applies it), with no network write and no error toast.
    await waitFor(() => {
      expect(
        useConversationStore.getState().pendingDraftProfiles.get("draft-xyz"),
      ).toBe("smart");
    });
    expect(inferenceprofilePut).not.toHaveBeenCalled();
    expect(toastError).not.toHaveBeenCalled();
  });
});
