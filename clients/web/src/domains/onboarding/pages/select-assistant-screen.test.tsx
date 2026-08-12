/**
 * Behavioral tests for the assistant chooser's paired-entry support.
 *
 * A paired assistant (a remote machine's assistant imported via
 * `vellum connect import`) is usable with no platform session: its card
 * renders unlocked, Continue connects it through
 * `connectPairedAssistant`, and an expired pairing surfaces re-pair
 * guidance instead of the generic connect error. Self-contained mocks:
 * run this file solo (`mock.module` leaks across a shared `bun test` run).
 */

import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

import type { RememberedOrigin } from "@/stores/remembered-origins-store";
import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();
const setSearchParamsMock = mock(
  (
    _next: (prev: URLSearchParams) => URLSearchParams,
    _opts?: { replace?: boolean },
  ) => {},
);
let hasPlatformSessionValue = false;
let assistantsValue: ResolvedAssistant[] = [];
let localModeHostAvailableValue = false;
let isLocalClientValue = true;
let assistantSwitcherValue = false;
let flagsHydratedValue = true;
let originsValue: RememberedOrigin[] = [];
let originsHydratedValue = true;
/** The origin url `isCurrentOrigin` reports as the serving deployment. */
let currentOriginUrl: string | null = null;
let activeAssistantIdValue: string | null = null;
const setActiveAssistantIdMock = mock((id: string | null) => {
  activeAssistantIdValue = id;
});

const removePairedAssistantFromLockfileMock = mock(
  async (_id: string): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  }),
);
const removePlatformAssistantFromLockfileMock = mock(
  async (_id: string): Promise<{ ok: boolean; error?: string }> => ({
    ok: true,
  }),
);

const connectPairedAssistantMock = mock(async (_id: string) => {});
const connectLocalAssistantMock = mock(async (_id: string) => {});
const connectPlatformAssistantMock = mock(async (_id: string) => {});

const hydrateOriginsMock = mock(async () => {});
// Success path mirrors the real store: the removed entry leaves the list.
const removeOriginMock = mock(async (url: string) => {
  originsValue = originsValue.filter((o) => o.url !== url);
});
const addOriginMock = mock(
  async (input: {
    url: string;
    name?: string;
  }): Promise<
    { ok: true; origin: RememberedOrigin } | { ok: false }
  > => ({
    ok: true,
    origin: {
      url: input.url,
      ...(input.name ? { name: input.name } : {}),
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  }),
);
const switchToOriginMock = mock(async (_origin: RememberedOrigin) => {});
const nativeSwitchToOriginMock = mock(async (_url: string | null) => true);
let isNativeMobileValue = false;
const installNativeRememberedOriginsMock = mock(() => {});
/** What the native shell reports as its baked Vellum Cloud origin, if any. */
let nativeCloudOriginValue: string | null = null;

// Stands in for the real error class (the screen's `instanceof` check runs
// against this mocked module's export).
class MockGuardianTokenError extends Error {
  constructor(
    readonly status: number,
    message = "Guardian token expired",
  ) {
    super(message);
    this.name = "GuardianTokenError";
  }
}

// --- Mocks --------------------------------------------------------------------

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams, setSearchParamsMock],
}));

mock.module("@/assistant/selection", () => ({
  resolveSelectedAssistantId: () => null,
  // Imported by switch-service (pulled in for the paired-removal branch);
  // never reached by these tests.
  setSelectedAssistant: async () => {},
}));

mock.module("@/assistant/retire-service", () => ({
  retireAssistant: async () => ({ ok: true as const, nextRoute: "/welcome" }),
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: () => {},
  isRepairableGatewayTokenError: () => false,
}));

class MockUnresolvedLocalGatewayError extends Error {}

// Includes the surface `@/assistant/switch-service` (the real module, which
// the chooser's paired-removal branch calls into) pulls from local-mode.
mock.module("@/lib/local-mode", () => ({
  getLockfileAssistant: () => undefined,
  getSelectedAssistant: () => undefined,
  isCliWakeableAssistant: () => false,
  isLocalClient: () => isLocalClientValue,
  isPairedAssistant: (a: { cloud?: string }) => a?.cloud === "paired",
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  removePairedAssistantFromLockfile: removePairedAssistantFromLockfileMock,
  removePlatformAssistantFromLockfile: removePlatformAssistantFromLockfileMock,
  UnresolvedLocalGatewayError: MockUnresolvedLocalGatewayError,
}));

mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: {
      assistantSwitcher: () => assistantSwitcherValue,
      hydrated: () => flagsHydratedValue,
    },
  },
}));

// The real normalizer, captured before the module mock below replaces the
// registry entry, so the screen's register-param validation runs with
// production semantics.
const { normalizeOriginUrl } = await import(
  "@/stores/remembered-origins-store"
);

mock.module("@/stores/remembered-origins-store", () => ({
  normalizeOriginUrl,
  useRememberedOriginsStore: {
    use: {
      origins: () => originsValue,
      hydrated: () => originsHydratedValue,
    },
    getState: () => ({
      origins: originsValue,
      hydrate: hydrateOriginsMock,
      addOrigin: addOriginMock,
      removeOrigin: removeOriginMock,
    }),
  },
}));

mock.module("@/assistant/switch-origin", () => ({
  switchToOrigin: switchToOriginMock,
  isCurrentOrigin: (origin: RememberedOrigin) =>
    origin.url === currentOriginUrl,
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsNativeMobile: () => isNativeMobileValue,
}));

mock.module("@/runtime/self-hosted-servers", () => ({
  installNativeRememberedOrigins: installNativeRememberedOriginsMock,
  nativeSwitchToOrigin: nativeSwitchToOriginMock,
  nativeVellumCloudOrigin: async () => nativeCloudOriginValue,
}));

mock.module("@/domains/onboarding/components/connect-recovery-dialog", () => ({
  ConnectRecoveryDialog: () => null,
}));

// A stub that surfaces the open state and deep-link payload, and lets tests
// drive close and the imported callback the way real dialog interactions
// would.
mock.module("@/domains/onboarding/components/connect-assistant-dialog", () => ({
  ConnectAssistantDialog: ({
    open,
    initialBundle,
    guidanceMessage,
    onClose,
    onImported,
  }: {
    open: boolean;
    initialBundle?: string;
    guidanceMessage?: string;
    onClose: () => void;
    onImported: (assistantId: string) => void;
  }) =>
    open ? (
      <div>
        Connect dialog open
        {initialBundle && <div>{`bundle:${initialBundle}`}</div>}
        {guidanceMessage && <div>{guidanceMessage}</div>}
        <button onClick={onClose}>Close dialog</button>
        <button onClick={() => onImported("paired-new")}>
          Simulate import
        </button>
      </div>
    ) : null,
}));

// A stub surfacing the open state that lets tests drive close and the
// added callback the way real dialog interactions would.
mock.module("@/domains/onboarding/components/add-remote-origin-dialog", () => ({
  AddRemoteOriginDialog: ({
    open,
    onClose,
    onAdded,
  }: {
    open: boolean;
    onClose: () => void;
    onAdded: (origin: RememberedOrigin) => void;
  }) =>
    open ? (
      <div>
        Add origin dialog open
        <button onClick={onClose}>Close add dialog</button>
        <button
          onClick={() =>
            onAdded({
              url: "https://added.example/assistant-1",
              addedAt: "2026-01-01T00:00:00.000Z",
            })
          }
        >
          Simulate origin add
        </button>
      </div>
    ) : null,
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@/domains/onboarding/components/radio-card-nav", () => ({
  handleRadioCardArrowNav: () => {},
}));

mock.module("@/utils/format-date", () => ({
  formatRelativeDate: () => "3 days ago",
}));

mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({
    loading: false,
    error: null,
    login: async () => {},
    cancel: () => {},
  }),
}));

let isElectronValue = false;
mock.module("@/runtime/is-electron", () => ({
  isElectron: () => isElectronValue,
}));

mock.module("@/runtime/local-mode-host", () => ({
  GuardianTokenError: MockGuardianTokenError,
  isLocalModeHostAvailable: () => localModeHostAvailableValue,
  requiresGuardianReprovision: (error: unknown) =>
    error instanceof MockGuardianTokenError &&
    (error.status === 404 || error.status === 401),
  wakeLocalAssistantHost: async () => ({ ok: true as const }),
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    getState: () => ({
      connectPairedAssistant: connectPairedAssistantMock,
      connectLocalAssistant: connectLocalAssistantMock,
      connectPlatformAssistant: connectPlatformAssistantMock,
    }),
  },
  useHasPlatformSession: () => hasPlatformSessionValue,
}));

mock.module("@/stores/organization-store", () => ({
  useOrganizationStore: {
    use: { currentOrganizationId: () => null },
  },
}));

mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: {
    use: { assistants: () => assistantsValue },
    getState: () => ({
      assistants: assistantsValue,
      activeAssistantId: activeAssistantIdValue,
      setActiveAssistantId: setActiveAssistantIdMock,
    }),
  },
}));

mock.module("@/utils/routes", () => ({
  routes: {
    assistant: "/assistant",
    selectAssistant: "/select-assistant",
    welcome: "/welcome",
    onboarding: { hosting: "/onboarding/hosting" },
  },
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
    ...rest
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
    "aria-label"?: string;
  }) => (
    <button onClick={onClick} disabled={disabled} aria-label={rest["aria-label"]}>
      {children}
    </button>
  ),
}));

mock.module("@vellumai/design-library/components/confirm-dialog", () => ({
  ConfirmDialog: ({
    open,
    message,
    onConfirm,
  }: {
    open: boolean;
    message: ReactNode;
    onConfirm?: () => void;
  }) =>
    open ? (
      <div>
        {message}
        <button onClick={onConfirm}>Confirm remove</button>
      </div>
    ) : null,
}));

mock.module("@vellumai/design-library/components/menu", () => ({
  Menu: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Trigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Item: ({
      children,
      onSelect,
    }: {
      children: ReactNode;
      onSelect?: () => void;
    }) => <div onClick={onSelect}>{children}</div>,
  },
}));

// The real (unmocked) store: the screen reads its dialog state from it so a
// deep link parked by the global consumer opens the dialog on mount.
const { __resetConnectDialogForTesting, useConnectDialogStore } = await import(
  "@/stores/connect-dialog-store"
);

const { SelectAssistantScreen } = await import(
  "@/domains/onboarding/pages/select-assistant-screen"
);

// --- Helpers ------------------------------------------------------------------

const PAIRED_ID = "paired-1";
const PLATFORM_ID = "platform-1";

function makePairedAssistant(
  overrides: Partial<ResolvedAssistant> = {},
): ResolvedAssistant {
  return {
    id: PAIRED_ID,
    name: "Office Mac",
    isLocal: false,
    isPlatformHosted: false,
    isPaired: true,
    runtimeUrl: "https://remote-host.example:8443",
    ...overrides,
  };
}

function makePlatformAssistant(
  overrides: Partial<ResolvedAssistant> = {},
): ResolvedAssistant {
  return {
    id: PLATFORM_ID,
    name: "Cloud Helper",
    cloud: "vellum",
    isLocal: false,
    isPlatformHosted: true,
    isPaired: false,
    ...overrides,
  };
}

const REPAIR_COPY =
  "This pairing has expired. Run vellum pair on the assistant's machine and import it again with vellum connect import.";

/**
 * What a shell reports as its baked Vellum Cloud origin. It is the Capacitor
 * `server.url`, which is the hub's `/assistant` root rather than a bare base.
 */
const BAKED_CLOUD_URL = "https://www.vellum.ai/assistant";

function makeOrigin(
  overrides: Partial<RememberedOrigin> = {},
): RememberedOrigin {
  return {
    url: "https://assistant.example.com",
    name: "Home Server",
    addedAt: "2026-01-01T00:00:00.000Z",
    ...overrides,
  };
}

// --- Suite --------------------------------------------------------------------

beforeEach(() => {
  navigateMock.mockClear();
  connectPairedAssistantMock.mockClear();
  connectPairedAssistantMock.mockImplementation(async () => {});
  connectLocalAssistantMock.mockClear();
  connectPlatformAssistantMock.mockClear();
  searchParams = new URLSearchParams();
  setSearchParamsMock.mockClear();
  hasPlatformSessionValue = false;
  assistantsValue = [];
  localModeHostAvailableValue = false;
  isElectronValue = false;
  isLocalClientValue = true;
  assistantSwitcherValue = false;
  flagsHydratedValue = true;
  originsValue = [];
  originsHydratedValue = true;
  currentOriginUrl = null;
  hydrateOriginsMock.mockClear();
  removeOriginMock.mockClear();
  removeOriginMock.mockImplementation(async (url: string) => {
    originsValue = originsValue.filter((o) => o.url !== url);
  });
  addOriginMock.mockClear();
  addOriginMock.mockImplementation(async (input) => ({
    ok: true,
    origin: {
      url: input.url,
      ...(input.name ? { name: input.name } : {}),
      addedAt: "2026-01-01T00:00:00.000Z",
    },
  }));
  switchToOriginMock.mockClear();
  nativeSwitchToOriginMock.mockClear();
  nativeSwitchToOriginMock.mockImplementation(async () => true);
  isNativeMobileValue = false;
  nativeCloudOriginValue = null;
  installNativeRememberedOriginsMock.mockClear();
  removePairedAssistantFromLockfileMock.mockClear();
  removePairedAssistantFromLockfileMock.mockImplementation(async () => ({
    ok: true,
  }));
  removePlatformAssistantFromLockfileMock.mockClear();
  activeAssistantIdValue = null;
  setActiveAssistantIdMock.mockClear();
  __resetConnectDialogForTesting();
});

afterEach(cleanup);

describe("SelectAssistantScreen paired assistants", () => {
  test("a paired card renders unlocked with the paired subtitle and no login button while logged out", () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    // The paired entry is the only selectable (radio) card; its subtitle
    // names the remote host.
    const radios = screen.getAllByRole("radio");
    expect(radios).toHaveLength(1);
    expect(radios[0].textContent).toContain("Office Mac");
    expect(radios[0].textContent).toContain("Paired · remote-host.example");
    expect(radios[0].textContent).not.toContain("Log in to use");
  });

  test("a paired entry with no parseable runtimeUrl falls back to the plain Paired subtitle", () => {
    assistantsValue = [
      makePairedAssistant({ runtimeUrl: undefined }),
      makePlatformAssistant(),
    ];

    render(<SelectAssistantScreen />);

    expect(screen.getByText("Paired")).toBeTruthy();
  });

  test("a cloud platform card stays locked while logged out", () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    // The platform card is not a radio and carries the login affordance.
    const radios = screen.getAllByRole("radio");
    expect(radios.some((r) => r.textContent?.includes("Cloud Helper"))).toBe(
      false,
    );
    expect(screen.getByText("Log in to use")).toBeTruthy();
  });

  test("Continue connects the selected paired assistant via connectPairedAssistant", async () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    // The paired entry is the sole accessible card, so it is auto-selected.
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(connectPairedAssistantMock).toHaveBeenCalledWith(PAIRED_ID),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/assistant", {
        replace: true,
      }),
    );
    expect(connectLocalAssistantMock).not.toHaveBeenCalled();
    expect(connectPlatformAssistantMock).not.toHaveBeenCalled();
  });

  test("an expired pairing (GuardianTokenError 401) surfaces the re-pair copy", async () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    connectPairedAssistantMock.mockImplementation(async () => {
      throw new MockGuardianTokenError(401);
    });

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => expect(screen.getByText(REPAIR_COPY)).toBeTruthy());
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("a non-token paired connect failure keeps the generic error", async () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    connectPairedAssistantMock.mockImplementation(async () => {
      throw new Error("network down");
    });

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(
        screen.getByText("Failed to connect. Please try again."),
      ).toBeTruthy(),
    );
  });

  test("a sole paired entry auto-connects", async () => {
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(connectPairedAssistantMock).toHaveBeenCalledWith(PAIRED_ID),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/assistant", {
        replace: true,
      }),
    );
  });

  test("fromLogin=1 suppresses the auto-skip", async () => {
    assistantsValue = [makePairedAssistant()];
    searchParams = new URLSearchParams("fromLogin=1");

    render(<SelectAssistantScreen />);

    // The chooser renders instead of auto-connecting.
    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("a paired card offers the remove menu when the local-mode host is available", () => {
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.getByLabelText("Actions for Office Mac")).toBeTruthy();
  });

  test("a paired card offers no remove menu without a local-mode host", () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByLabelText("Actions for Office Mac")).toBeNull();
  });

  test("confirming a paired removal shows the pairing copy and calls removePairedAssistantFromLockfile", async () => {
    // A pairing is device-local, so the affordance survives a platform
    // session (which locks out the platform-card removal instead).
    localModeHostAvailableValue = true;
    hasPlatformSessionValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Remove from this device…"));

    expect(
      screen.getByText(/It only forgets the pairing on this device/),
    ).toBeTruthy();
    expect(
      screen.getByText(/Pair again anytime with vellum connect import/),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(removePairedAssistantFromLockfileMock).toHaveBeenCalledWith(
        PAIRED_ID,
      ),
    );
    expect(removePlatformAssistantFromLockfileMock).not.toHaveBeenCalled();
  });

  test("removing the lifecycle-active paired entry clears the active id", async () => {
    localModeHostAvailableValue = true;
    hasPlatformSessionValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    activeAssistantIdValue = PAIRED_ID;

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Remove from this device…"));
    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(setActiveAssistantIdMock).toHaveBeenCalledWith(null),
    );
  });

  test("removing a non-active paired entry leaves the active id alone", async () => {
    localModeHostAvailableValue = true;
    hasPlatformSessionValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    activeAssistantIdValue = "some-other-assistant";

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Remove from this device…"));
    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(removePairedAssistantFromLockfileMock).toHaveBeenCalled(),
    );
    expect(setActiveAssistantIdMock).not.toHaveBeenCalled();
  });

  test("a paired removal failure surfaces the host error in the dialog", async () => {
    localModeHostAvailableValue = true;
    hasPlatformSessionValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    removePairedAssistantFromLockfileMock.mockImplementation(async () => ({
      ok: false,
      error: "Unpair is not supported by this app version",
    }));

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Remove from this device…"));
    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(
        screen.getByText("Unpair is not supported by this app version"),
      ).toBeTruthy(),
    );
  });

  test("clicking the remove menu does not select the card", () => {
    localModeHostAvailableValue = true;
    assistantsValue = [
      makePairedAssistant(),
      makePairedAssistant({ id: "paired-2", name: "Second Mac" }),
    ];

    render(<SelectAssistantScreen />);

    // The first accessible card is auto-selected; poking the second card's
    // menu trigger must not move the selection.
    fireEvent.click(screen.getByLabelText("Actions for Second Mac"));

    const radios = screen.getAllByRole("radio");
    expect(
      radios.find((r) => r.textContent?.includes("Office Mac"))
        ?.getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      radios.find((r) => r.textContent?.includes("Second Mac"))
        ?.getAttribute("aria-checked"),
    ).toBe("false");
  });

  test("the connect-a-remote-assistant affordance is hidden without a local-mode host", () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByText("Connect a remote assistant")).toBeNull();
  });

  test("the connect-a-remote-assistant affordance opens the dialog when a local-mode host is available", () => {
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByText("Connect dialog open")).toBeNull();

    fireEvent.click(screen.getByText("Connect a remote assistant"));

    expect(screen.getByText("Connect dialog open")).toBeTruthy();
  });

  test("a successful import connects the new pairing and navigates", async () => {
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Connect a remote assistant"));
    fireEvent.click(screen.getByText("Simulate import"));

    await waitFor(() =>
      expect(connectPairedAssistantMock).toHaveBeenCalledWith("paired-new"),
    );
    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/assistant", {
        replace: true,
      }),
    );
    // The dialog closes as the connect kicks off.
    expect(screen.queryByText("Connect dialog open")).toBeNull();
  });

  test("a connect deep link parked in the store opens the dialog on mount with the bundle prefilled", () => {
    // What `useGlobalDeepLinkConsumer` does for a `<scheme>://connect?bundle=`
    // link before navigating here.
    useConnectDialogStore
      .getState()
      .openConnectDialog({ initialBundle: "eyJnYXRld2F5" });
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.getByText("Connect dialog open")).toBeTruthy();
    expect(screen.getByText("bundle:eyJnYXRld2F5")).toBeTruthy();
  });

  test("a bundle-less connect deep link opens the dialog with its guidance copy", () => {
    useConnectDialogStore.getState().openConnectDialog({
      guidanceMessage: "Run vellum pair on the assistant's machine.",
    });
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(
      screen.getByText("Run vellum pair on the assistant's machine."),
    ).toBeTruthy();
  });

  test("closing the dialog clears the parked deep-link payload", () => {
    useConnectDialogStore
      .getState()
      .openConnectDialog({ initialBundle: "eyJnYXRld2F5" });
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Close dialog"));

    expect(screen.queryByText("Connect dialog open")).toBeNull();
    expect(useConnectDialogStore.getState().open).toBe(false);
    expect(useConnectDialogStore.getState().initialBundle).toBeNull();
  });

  test("a manual open after a deep-link close starts empty", () => {
    useConnectDialogStore
      .getState()
      .openConnectDialog({ initialBundle: "eyJnYXRld2F5" });
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Close dialog"));
    fireEvent.click(screen.getByText("Connect a remote assistant"));

    expect(screen.getByText("Connect dialog open")).toBeTruthy();
    expect(screen.queryByText("bundle:eyJnYXRld2F5")).toBeNull();
  });

  test("a parked connect deep link suppresses the sole-assistant auto-skip", async () => {
    useConnectDialogStore
      .getState()
      .openConnectDialog({ initialBundle: "eyJnYXRld2F5" });
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Connect dialog open")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("an open connect dialog suppresses the sole-assistant auto-skip", async () => {
    localModeHostAvailableValue = true;
    assistantsValue = [];

    const { rerender } = render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Connect a remote assistant"));

    // The import's lockfile reload populates the store while the dialog is
    // still open (e.g. the access-only warning step is showing).
    assistantsValue = [makePairedAssistant()];
    rerender(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Connect dialog open")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("on Electron the sole-assistant auto-skip waits for the deep-link drain, so a buffered connect link wins", async () => {
    isElectronValue = true;
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    // Drain not settled yet: the chooser holds instead of auto-connecting.
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();

    // The buffered connect link publishes (parking the dialog), then the
    // drain settles.
    act(() => {
      useConnectDialogStore
        .getState()
        .openConnectDialog({ initialBundle: "eyJnYXRld2F5" });
      useConnectDialogStore.getState().markDeepLinkDrainSettled();
    });

    await waitFor(() =>
      expect(screen.getByText("Connect dialog open")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("on Electron an empty drain releases the sole-assistant auto-skip", async () => {
    isElectronValue = true;
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();

    act(() => {
      useConnectDialogStore.getState().markDeepLinkDrainSettled();
    });

    await waitFor(() =>
      expect(connectPairedAssistantMock).toHaveBeenCalledWith(PAIRED_ID),
    );
  });

  test("confirming a locked platform removal still calls removePlatformAssistantFromLockfile", async () => {
    localModeHostAvailableValue = true;
    assistantsValue = [makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Remove from this device…"));

    expect(
      screen.getByText(/It only removes it from this device/),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(removePlatformAssistantFromLockfileMock).toHaveBeenCalledWith(
        PLATFORM_ID,
      ),
    );
    expect(removePairedAssistantFromLockfileMock).not.toHaveBeenCalled();
  });
});

describe("SelectAssistantScreen remembered origins", () => {
  test("origin cards render from the store when the assistant-switcher flag is on", () => {
    assistantSwitcherValue = true;
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.getByText("Home Server")).toBeTruthy();
    expect(
      screen.getByText("Remote · assistant.example.com"),
    ).toBeTruthy();
    expect(hydrateOriginsMock).toHaveBeenCalled();
  });

  test("no origin UI renders with the flag off, even with stored origins", () => {
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByText("Home Server")).toBeNull();
    expect(screen.queryByText(/assistant\.example\.com/)).toBeNull();
    expect(hydrateOriginsMock).not.toHaveBeenCalled();
  });

  test("an unnamed origin falls back to its hostname as the title", () => {
    assistantSwitcherValue = true;
    originsValue = [makeOrigin({ name: undefined })];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.getByText("assistant.example.com")).toBeTruthy();
  });

  test("Continue on a selected origin card performs the origin switch", async () => {
    assistantSwitcherValue = true;
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Home Server"));
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(switchToOriginMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://assistant.example.com" }),
      ),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
    expect(connectPlatformAssistantMock).not.toHaveBeenCalled();
  });

  test("the current-origin card shows Current and Continue stays in-app", async () => {
    assistantSwitcherValue = true;
    currentOriginUrl = "https://assistant.example.com";
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(
      screen.getByText("Current · assistant.example.com"),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Home Server"));
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/assistant", {
        replace: true,
      }),
    );
    expect(switchToOriginMock).not.toHaveBeenCalled();
  });

  test("the current-origin card offers no remove menu on a native shell", () => {
    // A native shell always lists the origin it serves, and forgetting that
    // one relocates the app, which the removal copy promises it will not do.
    assistantSwitcherValue = true;
    isNativeMobileValue = true;
    currentOriginUrl = "https://assistant.example.com";
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByLabelText("Actions for Home Server")).toBeNull();
  });

  test("the current-origin card keeps its remove menu in a browser", () => {
    // The browser list is local and inert: forgetting the entry cannot move
    // the page, so the user keeps the affordance.
    assistantSwitcherValue = true;
    currentOriginUrl = "https://assistant.example.com";
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.getByLabelText("Actions for Home Server")).toBeTruthy();
  });

  test("removing an origin shows the origin copy and forgets the entry", async () => {
    assistantSwitcherValue = true;
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByLabelText("Actions for Home Server"));
    fireEvent.click(screen.getByText("Remove from this device…"));

    expect(
      screen.getByText(/It only forgets the entry on this device/),
    ).toBeTruthy();

    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(removeOriginMock).toHaveBeenCalledWith(
        "https://assistant.example.com",
      ),
    );
  });

  test("a persistence failure keeps the dialog open with an error", async () => {
    assistantSwitcherValue = true;
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    // The store's removeOrigin resolves silently on failure and leaves the
    // entry listed, which is the screen's failure signal.
    removeOriginMock.mockImplementation(async () => {});

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByLabelText("Actions for Home Server"));
    fireEvent.click(screen.getByText("Remove from this device…"));
    fireEvent.click(screen.getByText("Confirm remove"));

    await waitFor(() =>
      expect(
        screen.getByText("Failed to remove. Please try again."),
      ).toBeTruthy(),
    );
  });

  test("a flagged origin suppresses the sole-assistant auto-skip", async () => {
    assistantSwitcherValue = true;
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("with the flag off, stored origins leave the auto-skip untouched", async () => {
    originsValue = [makeOrigin()];
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(connectPairedAssistantMock).toHaveBeenCalledWith(PAIRED_ID),
    );
  });

  test("auto-skip holds until the origins store hydrates when the flag is on", async () => {
    assistantSwitcherValue = true;
    originsHydratedValue = false;
    originsValue = [];
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
  });

  test("auto-skip holds until the feature flags hydrate", async () => {
    // The flag store boots to the registry default (off), so a targeted `on`
    // lands after mount; skipping before then would strand this device's
    // remembered origins behind an auto-connect.
    flagsHydratedValue = false;
    assistantsValue = [makePairedAssistant()];

    const { rerender } = render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();

    flagsHydratedValue = true;
    assistantSwitcherValue = true;
    originsValue = [makeOrigin()];
    rerender(<SelectAssistantScreen />);

    await waitFor(() => expect(screen.getByText("Home Server")).toBeTruthy());
    expect(connectPairedAssistantMock).not.toHaveBeenCalled();
  });
});

describe("SelectAssistantScreen native mobile", () => {
  test("the flag-gated mount installs the native origins provider", () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    expect(installNativeRememberedOriginsMock).toHaveBeenCalled();
  });

  test("with the flag off nothing reaches the native bridge", () => {
    assistantsValue = [makePairedAssistant()];

    render(<SelectAssistantScreen />);

    expect(installNativeRememberedOriginsMock).not.toHaveBeenCalled();
  });

  test("a shell serving a self-hosted origin offers a Vellum Cloud card", async () => {
    assistantSwitcherValue = true;
    isNativeMobileValue = true;
    nativeCloudOriginValue = BAKED_CLOUD_URL;
    assistantsValue = [];

    render(<SelectAssistantScreen />);

    await waitFor(() => expect(screen.getByText("Vellum Cloud")).toBeTruthy());
    // No device-local entry to forget, so the card carries no actions menu.
    expect(screen.queryByLabelText("Actions for Vellum Cloud")).toBeNull();

    fireEvent.click(screen.getByText("Vellum Cloud"));
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(nativeSwitchToOriginMock).toHaveBeenCalledWith(null),
    );
    expect(switchToOriginMock).not.toHaveBeenCalled();
  });

  test("a rejected cloud switch navigates to the baked url as-is", async () => {
    assistantSwitcherValue = true;
    isNativeMobileValue = true;
    // The shell's baked `server.url` already carries the hub's `/assistant`
    // root, so the fallback must not append the route a second time.
    nativeCloudOriginValue = BAKED_CLOUD_URL;
    assistantsValue = [];
    nativeSwitchToOriginMock.mockImplementation(async () => false);
    const assignSpy = mock((_url: string) => {});
    const originalLocation = window.location;
    Object.defineProperty(window, "location", {
      configurable: true,
      value: { ...originalLocation, assign: assignSpy },
    });

    try {
      render(<SelectAssistantScreen />);

      await waitFor(() =>
        expect(screen.getByText("Vellum Cloud")).toBeTruthy(),
      );
      fireEvent.click(screen.getByText("Vellum Cloud"));
      fireEvent.click(screen.getByText("Continue"));

      await waitFor(() =>
        expect(assignSpy).toHaveBeenCalledWith(BAKED_CLOUD_URL),
      );
    } finally {
      Object.defineProperty(window, "location", {
        configurable: true,
        value: originalLocation,
      });
    }
  });

  test("an origins-only chooser defaults its selection so Continue can act", async () => {
    assistantSwitcherValue = true;
    isNativeMobileValue = true;
    nativeCloudOriginValue = BAKED_CLOUD_URL;
    originsValue = [makeOrigin()];
    assistantsValue = [];

    render(<SelectAssistantScreen />);

    // The first origin card wins the default, ahead of the cloud card.
    await waitFor(() =>
      expect(
        screen
          .getAllByRole("radio")
          .find((r) => r.textContent?.includes("Home Server"))
          ?.getAttribute("aria-checked"),
      ).toBe("true"),
    );
    expect(
      (screen.getByText("Continue") as HTMLButtonElement).disabled,
    ).toBe(false);

    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() => expect(switchToOriginMock).toHaveBeenCalled());
  });

  test("with only the cloud card the selection defaults to it", async () => {
    assistantSwitcherValue = true;
    isNativeMobileValue = true;
    nativeCloudOriginValue = BAKED_CLOUD_URL;
    assistantsValue = [];

    render(<SelectAssistantScreen />);

    await waitFor(() => expect(screen.getByText("Vellum Cloud")).toBeTruthy());
    // The default selection commits in an effect after the card renders, so
    // clicking on render alone hits a disabled Continue and does nothing.
    await waitFor(() =>
      expect(
        (screen.getByText("Continue") as HTMLButtonElement).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByText("Continue"));

    await waitFor(() =>
      expect(nativeSwitchToOriginMock).toHaveBeenCalledWith(null),
    );
  });

  test("no Vellum Cloud card when the shell already serves the baked origin", async () => {
    assistantSwitcherValue = true;
    isNativeMobileValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(screen.queryByText("Vellum Cloud")).toBeNull();
  });

  test("no Vellum Cloud card on a browser surface", async () => {
    assistantSwitcherValue = true;
    nativeCloudOriginValue = BAKED_CLOUD_URL;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(screen.queryByText("Vellum Cloud")).toBeNull();
  });
});

describe("SelectAssistantScreen add-remote-assistant affordance", () => {
  test("renders on hostless surfaces with the flag on and opens the dialog", () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByText("Add origin dialog open")).toBeNull();
    // The local bundle-paste affordance needs a local-mode host.
    expect(screen.queryByText("Connect a remote assistant")).toBeNull();

    fireEvent.click(screen.getByText("Add a remote assistant"));

    expect(screen.getByText("Add origin dialog open")).toBeTruthy();
  });

  test("renders on the platform hub", () => {
    assistantSwitcherValue = true;
    isLocalClientValue = false;
    hasPlatformSessionValue = true;
    assistantsValue = [makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.getByText("Add a remote assistant")).toBeTruthy();
  });

  test("is hidden where a local-mode host offers the bundle-paste connect instead", () => {
    assistantSwitcherValue = true;
    localModeHostAvailableValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByText("Add a remote assistant")).toBeNull();
    expect(screen.getByText("Connect a remote assistant")).toBeTruthy();
  });

  test("is hidden with the flag off", () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    expect(screen.queryByText("Add a remote assistant")).toBeNull();
  });

  test("an added origin closes the dialog and switches to it", async () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Add a remote assistant"));
    fireEvent.click(screen.getByText("Simulate origin add"));

    await waitFor(() =>
      expect(switchToOriginMock).toHaveBeenCalledWith(
        expect.objectContaining({ url: "https://added.example/assistant-1" }),
      ),
    );
    expect(screen.queryByText("Add origin dialog open")).toBeNull();
  });

  test("closing the dialog leaves the chooser untouched", () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Add a remote assistant"));
    fireEvent.click(screen.getByText("Close add dialog"));

    expect(screen.queryByText("Add origin dialog open")).toBeNull();
    expect(switchToOriginMock).not.toHaveBeenCalled();
  });
});

describe("SelectAssistantScreen register handoff", () => {
  /** The query string the screen's updater produces from the current one. */
  function strippedQuery(): string {
    const [update] = setSearchParamsMock.mock.calls[0];
    return update(searchParams).toString();
  }

  test("a valid register param records the origin with its label and strips the params through the router", async () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    searchParams = new URLSearchParams(
      "register=https%3A%2F%2Fhost.example%2Fassistant-1&name=Homelab&keep=1",
    );

    render(<SelectAssistantScreen />);

    // The rename-vs-add decision lives in the store: `addOrigin` on an
    // already-remembered url updates its name in place.
    await waitFor(() =>
      expect(addOriginMock).toHaveBeenCalledWith({
        url: "https://host.example/assistant-1",
        name: "Homelab",
      }),
    );
    await waitFor(() => expect(setSearchParamsMock).toHaveBeenCalled());
    // Only the consumed params go; the rest of the query survives, and the
    // strip replaces the entry rather than pushing a new one.
    expect(strippedQuery()).toBe("keep=1");
    expect(setSearchParamsMock.mock.calls[0][1]).toEqual({ replace: true });
    // Records only; the user stays on the chooser to see the updated list.
    expect(switchToOriginMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("a failed add keeps the register params for a retry", async () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    searchParams = new URLSearchParams(
      "register=https%3A%2F%2Fhost.example%2Fassistant-1&name=Homelab",
    );
    addOriginMock.mockImplementation(async () => ({ ok: false }) as const);

    render(<SelectAssistantScreen />);

    await waitFor(() => expect(addOriginMock).toHaveBeenCalled());
    // The handoff params are the only copy of the registration; a failed
    // persistence keeps them so a reload retries.
    expect(setSearchParamsMock).not.toHaveBeenCalled();
  });

  test("a name-less register param records the origin without a label", async () => {
    assistantSwitcherValue = true;
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    searchParams = new URLSearchParams(
      "register=https%3A%2F%2Fhost.example%2Fassistant-1",
    );

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(addOriginMock).toHaveBeenCalledWith({
        url: "https://host.example/assistant-1",
        name: undefined,
      }),
    );
  });

  test.each([
    "javascript:alert(1)",
    "http://host.example/assistant-1",
    "not a url",
  ])(
    "an invalid register value is ignored without error UI: %s",
    async (value) => {
      assistantSwitcherValue = true;
      assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
      searchParams = new URLSearchParams([["register", value]]);

      render(<SelectAssistantScreen />);

      await waitFor(() =>
        expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
      );
      expect(addOriginMock).not.toHaveBeenCalled();
      expect(screen.queryByText(/Failed|Please try again/)).toBeNull();
      // The consumed params still leave the address bar.
      expect(setSearchParamsMock).toHaveBeenCalled();
      expect(strippedQuery()).toBe("");
    },
  );

  test("with the flag off the register params are ignored and left untouched", async () => {
    assistantsValue = [makePairedAssistant(), makePlatformAssistant()];
    searchParams = new URLSearchParams(
      "register=https%3A%2F%2Fhost.example%2Fassistant-1&name=Homelab",
    );

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(addOriginMock).not.toHaveBeenCalled();
    expect(setSearchParamsMock).not.toHaveBeenCalled();
  });
});

describe("SelectAssistantScreen platform-mode gate", () => {
  beforeEach(() => {
    isLocalClientValue = false;
    hasPlatformSessionValue = true;
    assistantsValue = [makePlatformAssistant()];
  });

  test("holds on the connecting state until the flag hydrates", () => {
    flagsHydratedValue = false;

    render(<SelectAssistantScreen />);

    expect(screen.getByText("Connecting to your assistant…")).toBeTruthy();
    expect(screen.queryByText("Choose an Assistant")).toBeNull();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("redirects to /assistant once hydration lands with the flag off", async () => {
    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith("/assistant", {
        replace: true,
      }),
    );
    expect(screen.queryByText("Choose an Assistant")).toBeNull();
  });

  test("with the flag on the hub renders the chooser and never auto-connects", async () => {
    assistantSwitcherValue = true;

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(connectPlatformAssistantMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("Back leaves for /assistant instead of the local-only welcome", async () => {
    assistantSwitcherValue = true;

    render(<SelectAssistantScreen />);

    fireEvent.click(screen.getByText("Back"));

    await waitFor(() => expect(navigateMock).toHaveBeenCalledWith("/assistant"));
  });

  test("hides the local-only create action on non-local clients", async () => {
    assistantSwitcherValue = true;

    render(<SelectAssistantScreen />);

    await waitFor(() =>
      expect(screen.getByText("Choose an Assistant")).toBeTruthy(),
    );
    expect(screen.queryByText("Create a new assistant")).toBeNull();
  });
});
