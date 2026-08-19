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
import { useConversationStore } from "@/stores/conversation-store";
import type { Conversation } from "@/types/conversation-types";
import { ApiError } from "@/utils/api-errors";
import { conversationListQueryKey } from "@/utils/conversation-list-keys";

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
    isTouchMobileRef.value = true;
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Profile")).toBeTruthy();
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
      expect(screen.getByLabelText("New Profile")).toBeTruthy();
    });
    expect(screen.queryByTestId("tooltip")).toBeNull();
  });

  test("the mouse presentation keeps the quick-add tooltip", async () => {
    renderMenu();
    await waitFor(() => {
      expect(screen.getByLabelText("New Profile")).toBeTruthy();
    });
    const tooltip = screen.getByTestId("tooltip");
    expect(tooltip.getAttribute("data-tooltip-content")).toBe("New Profile");
    expect(tooltip.querySelector('[aria-label="New Profile"]')).toBeTruthy();
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
      const plus = screen.getByLabelText("New Profile") as HTMLButtonElement;
      expect(plus.disabled).toBe(false);
    });
    fireEvent.click(screen.getByLabelText("New Profile"));
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
