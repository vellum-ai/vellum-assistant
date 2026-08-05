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

import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();
let hasPlatformSessionValue = false;
let assistantsValue: ResolvedAssistant[] = [];
let localModeHostAvailableValue = false;
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
  useSearchParams: () => [searchParams],
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
  isPairedAssistant: (a: { cloud?: string }) => a?.cloud === "paired",
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  removePairedAssistantFromLockfile: removePairedAssistantFromLockfileMock,
  removePlatformAssistantFromLockfile: removePlatformAssistantFromLockfileMock,
  UnresolvedLocalGatewayError: MockUnresolvedLocalGatewayError,
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

// --- Suite --------------------------------------------------------------------

describe("SelectAssistantScreen paired assistants", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    connectPairedAssistantMock.mockClear();
    connectPairedAssistantMock.mockImplementation(async () => {});
    connectLocalAssistantMock.mockClear();
    connectPlatformAssistantMock.mockClear();
    searchParams = new URLSearchParams();
    hasPlatformSessionValue = false;
    assistantsValue = [];
    localModeHostAvailableValue = false;
    isElectronValue = false;
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
