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

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

import type { ResolvedAssistant } from "@/stores/resolved-assistants-store";

// --- Mutable per-test state, reset in beforeEach ------------------------------

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParams = new URLSearchParams();
let hasPlatformSessionValue = false;
let assistantsValue: ResolvedAssistant[] = [];

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
}));

mock.module("@/assistant/retire-service", () => ({
  retireAssistant: async () => ({ ok: true as const, nextRoute: "/welcome" }),
}));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: () => {},
  isRepairableGatewayTokenError: () => false,
}));

class MockUnresolvedLocalGatewayError extends Error {}

mock.module("@/lib/local-mode", () => ({
  isCliWakeableAssistant: () => false,
  removePlatformAssistantFromLockfile: async () => ({ ok: true as const }),
  UnresolvedLocalGatewayError: MockUnresolvedLocalGatewayError,
}));

mock.module("@/domains/onboarding/components/connect-recovery-dialog", () => ({
  ConnectRecoveryDialog: () => null,
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

mock.module("@/runtime/is-electron", () => ({
  isElectron: () => false,
}));

mock.module("@/runtime/local-mode-host", () => ({
  GuardianTokenError: MockGuardianTokenError,
  isLocalModeHostAvailable: () => false,
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
  },
}));

mock.module("@/utils/routes", () => ({
  routes: {
    assistant: "/assistant",
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
  ConfirmDialog: ({ open, message }: { open: boolean; message: ReactNode }) =>
    open ? <div>{message}</div> : null,
}));

mock.module("@vellumai/design-library/components/menu", () => ({
  Menu: {
    Root: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Trigger: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Content: ({ children }: { children: ReactNode }) => <div>{children}</div>,
    Item: ({ children }: { children: ReactNode }) => <div>{children}</div>,
  },
}));

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
});
