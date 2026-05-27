import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import { routes } from "@/utils/routes";

let searchParams = new URLSearchParams();
const navigateMock = mock(() => {});

let checkAssistantImpl: () => Promise<void> = async () => {};
const checkAssistantMock = mock(() => checkAssistantImpl());

const hatchAssistantMock = mock(async () => ({
  ok: true,
  status: 201,
  data: {
    id: "asst-1",
    status: "initializing",
    is_local: false,
    maintenance_mode: { enabled: false },
  },
}));

const getAssistantMock = mock(async () => ({
  ok: true,
  status: 200,
  data: {
    id: "asst-1",
    status: "active",
    is_local: false,
    maintenance_mode: { enabled: false },
  },
}));

const fetchCharacterTraitsMock = mock(async () => null);
const saveCharacterTraitsMock = mock(async () => undefined);
const setOnboardingCompletedMock = mock(() => {});
const writeSelectedVersionMock = mock(() => {});
const markPrivacyConsentMock = mock(() => {});
const clearPrivacyConsentMock = mock(() => {});
const persistContentAutomationPreChatHandoffMock = mock(() => {});

let onboardingCompleted = false;
let resolvedCohort: string | null = null;

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/root-layout", () => ({
  useRootOutletContext: () => ({
    lifecycle: {
      checkAssistant: checkAssistantMock,
    },
  }),
}));

mock.module("@/assistant/api", () => ({
  hatchAssistant: hatchAssistantMock,
  getAssistant: getAssistantMock,
}));

mock.module("@/assistant/avatar-api", () => ({
  fetchCharacterTraits: fetchCharacterTraitsMock,
  saveCharacterTraits: saveCharacterTraitsMock,
}));

mock.module("@/utils/avatar-bundled-components", () => ({
  BUNDLED_COMPONENTS: {},
}));

mock.module("@/utils/avatar-random", () => ({
  randomCharacterTraits: () => ({
    bodyShape: "round",
    eyeStyle: "dot",
    color: "green",
  }),
}));

mock.module("@/utils/avatar-svg-compositor", () => ({
  composeSvg: () => "<svg />",
}));

mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => (
    <div>{children}</div>
  ),
}));

mock.module("@vellum/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: ReactNode;
    onClick?: () => void;
  }) => (
    <button type="button" onClick={onClick}>
      {children}
    </button>
  ),
}));

mock.module("@vellum/design-library/components/progress-bar", () => ({
  ProgressBar: ({ value }: { value: number }) => (
    <div data-testid="progress" data-value={value} />
  ),
}));

mock.module("@sentry/browser", () => ({
  captureException: mock(() => {}),
  captureMessage: mock(() => {}),
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readAiDataConsent: () => true,
  readOnboardingCompleted: () => onboardingCompleted,
  readSelectedVersion: () => null,
  readTosAccepted: () => true,
  useOnboardingCompleted: () =>
    [onboardingCompleted, setOnboardingCompletedMock] as const,
  writeSelectedVersion: writeSelectedVersionMock,
}));

mock.module("@/domains/onboarding/signals", () => ({
  clearPrivacyConsent: clearPrivacyConsentMock,
  hasRecentPrivacyConsent: () => true,
  markPrivacyConsent: markPrivacyConsentMock,
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  useIsNativePlatform: () => false,
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({
        id: "user-1",
        firstName: "Alice",
        lastName: "",
      }),
      isLoggedIn: () => true,
      isLoading: () => false,
    },
  },
}));

mock.module("@tanstack/react-query", () => ({
  useQuery: () => ({
    data: {
      id: "asst-1",
    },
  }),
}));

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  assistantsActiveRetrieveOptions: () => ({}),
}));

mock.module("@/hooks/use-prefilled-input", () => ({
  usePrefilledInput: (initial: string) => ({
    value: initial,
    onChange: mock(() => {}),
  }),
}));

mock.module("@/runtime/platform-detection", () => ({
  useIsIOSWeb: () => false,
  useIsMacOSWeb: () => false,
}));

mock.module("@/hooks/use-ios-app-nudge", () => ({
  readIOSAppDownloaded: () => true,
}));

mock.module("@/hooks/use-macos-app-nudge", () => ({
  readMacOsAppDownloaded: () => true,
}));

mock.module("@/domains/onboarding/content-automation", () => ({
  persistContentAutomationPreChatHandoff:
    persistContentAutomationPreChatHandoffMock,
}));

mock.module("@/domains/onboarding/utm-cohort", () => ({
  resolveUserCohort: async () => resolvedCohort,
}));

mock.module("@/domains/onboarding/screens/name-exchange-screen", () => ({
  NameExchangeScreen: ({ onComplete }: { onComplete: () => void }) => (
    <button type="button" data-testid="name-continue" onClick={onComplete}>
      name
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/task-tone-selection-screen", () => ({
  TaskToneSelectionScreen: ({ onContinue }: { onContinue: () => void }) => (
    <button type="button" data-testid="task-continue" onClick={onContinue}>
      tasks
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/tool-selection-screen", () => ({
  ToolSelectionScreen: ({ onContinue }: { onContinue: () => void }) => (
    <button type="button" data-testid="tool-continue" onClick={onContinue}>
      tools
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/prior-assistant-selection-screen", () => ({
  PriorAssistantSelectionScreen: ({
    onContinue,
  }: {
    onContinue: () => void;
  }) => (
    <button type="button" data-testid="prior-continue" onClick={onContinue}>
      prior
    </button>
  ),
}));

mock.module("@/domains/onboarding/screens/google-connect-screen", () => ({
  GoogleConnectScreen: () => <div />,
}));

mock.module("@/domains/onboarding/screens/get-ios-app-screen", () => ({
  GetIOSAppScreen: () => <div />,
}));

mock.module("@/domains/onboarding/screens/get-macos-app-screen", () => ({
  GetMacOSAppScreen: () => <div />,
}));

const { HatchingScreen } = await import(
  "@/domains/onboarding/pages/hatching-screen"
);
const { PreChatFlow } = await import(
  "@/domains/onboarding/pages/pre-chat-flow"
);

beforeEach(() => {
  searchParams = new URLSearchParams();
  checkAssistantImpl = async () => {};
  onboardingCompleted = false;
  resolvedCohort = null;
  sessionStorage.clear();
  localStorage.clear();

  navigateMock.mockClear();
  checkAssistantMock.mockClear();
  hatchAssistantMock.mockClear();
  getAssistantMock.mockClear();
  fetchCharacterTraitsMock.mockClear();
  saveCharacterTraitsMock.mockClear();
  setOnboardingCompletedMock.mockClear();
  writeSelectedVersionMock.mockClear();
  markPrivacyConsentMock.mockClear();
  clearPrivacyConsentMock.mockClear();
  persistContentAutomationPreChatHandoffMock.mockClear();
});

afterEach(() => {
  cleanup();
});

describe("onboarding lifecycle sync", () => {
  test("hatching refreshes the root assistant lifecycle before leaving onboarding", async () => {
    let resolveLifecycle!: () => void;
    checkAssistantImpl = () =>
      new Promise<void>((resolve) => {
        resolveLifecycle = resolve;
      });

    render(<HatchingScreen />);

    await waitFor(() => expect(getAssistantMock).toHaveBeenCalled());
    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled(), {
      timeout: 2_000,
    });
    expect(navigateMock).not.toHaveBeenCalled();

    resolveLifecycle();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.prechat, {
        replace: true,
      }),
    );
  });

  test("pre-chat completion refreshes the root assistant lifecycle before entering chat", async () => {
    let resolveLifecycle!: () => void;
    checkAssistantImpl = () =>
      new Promise<void>((resolve) => {
        resolveLifecycle = resolve;
      });

    render(<PreChatFlow />);

    fireEvent.click(screen.getByTestId("name-continue"));
    fireEvent.click(await screen.findByTestId("task-continue"));
    fireEvent.click(await screen.findByTestId("tool-continue"));
    fireEvent.click(await screen.findByTestId("prior-continue"));

    await waitFor(() => expect(checkAssistantMock).toHaveBeenCalled());
    expect(navigateMock).not.toHaveBeenCalled();

    resolveLifecycle();

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(
        `${routes.assistant}?onboarding=1`,
        { replace: true },
      ),
    );
  });
});
