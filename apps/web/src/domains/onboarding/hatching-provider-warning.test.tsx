import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import type { ReactNode } from "react";

import { routes } from "@/utils/routes";

// Drives the openai-compatible local-hatch path: when applyPendingProviderKey
// reports a failed probe, the screen must hold on the ready state with the
// warning (no auto-navigate within the delay) and only navigate when Continue
// is clicked.

let searchParams = new URLSearchParams("hosting=local");
const navigateMock = mock(() => {});
const checkAssistantMock = mock(async () => {});

let applyResult: { validation?: { ok: boolean; reason?: string } } = {};
const applyPendingProviderKeyMock = mock(async () => applyResult);

const getAssistantMock = mock(async () => ({
  ok: true,
  status: 200,
  data: {
    id: "local-1",
    status: "active",
    is_local: true,
    maintenance_mode: { enabled: false },
  },
}));

const fetchCharacterTraitsMock = mock(async () => null);
const saveCharacterTraitsMock = mock(async () => undefined);
const setOnboardingCompletedMock = mock(() => {});

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParams],
}));

mock.module("@/assistant/lifecycle-service", () => ({
  lifecycleService: {
    checkAssistant: checkAssistantMock,
    markExpectingFirstMessage: () => {},
  },
}));

mock.module("@/assistant/api", () => ({
  hatchAssistant: mock(async () => ({ ok: true, status: 201, data: {} })),
  getAssistant: getAssistantMock,
}));

mock.module("@/domains/onboarding/provider-key", () => ({
  applyPendingProviderKey: applyPendingProviderKeyMock,
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
  setContext: () => {},
}));
mock.module("@sentry/react", () => ({
  captureException: mock(() => {}),
  captureMessage: mock(() => {}),
  setContext: () => {},
}));

mock.module("@/domains/onboarding/prefs", () => ({
  readAiDataConsent: () => true,
  readOnboardingCompleted: () => false,
  readSelectedVersion: () => null,
  readShareAnalytics: () => true,
  readTosAccepted: () => true,
  clearOnboardingCompleted: mock(() => {}),
  useOnboardingCompleted: () => [false, setOnboardingCompletedMock] as const,
  writeSelectedVersion: mock(() => {}),
}));

mock.module("@/domains/onboarding/signals", () => ({
  clearPrivacyConsent: mock(() => {}),
  hasRecentPrivacyConsent: () => true,
  markPrivacyConsent: mock(() => {}),
}));

mock.module("@/runtime/native-auth", () => ({
  isNativePlatform: () => false,
  useIsNativePlatform: () => false,
}));

mock.module("@/lib/local-mode", () => ({
  isLocalMode: () => true,
  hasAssistants: () => false,
  getPlatformAssistants: () => [],
  getSelectedAssistant: () => undefined,
  loadLockfile: async () => ({ assistants: [], activeAssistant: null }),
  setSelectedAssistantId: () => {},
  saveLockfileAssistant: async () => {},
  primeLocalGatewayConnection: async () => {},
  getLocalGatewayUrl: () => "http://localhost:4242",
}));

mock.module("@/runtime/local-mode-host", () => ({
  hatchLocalAssistant: async () => ({ ok: true, assistantId: "local-1" }),
}));

mock.module("@/stores/auth-store", () => ({
  useAuthStore: {
    use: {
      user: () => ({ id: "user-1", firstName: "Alice", lastName: "" }),
      isLoggedIn: () => true,
      isLoading: () => false,
      hasPlatformSession: () => false,
    },
  },
}));

const originalFetch = globalThis.fetch;

const { HatchingScreen } = await import(
  "@/domains/onboarding/pages/hatching-screen"
);

beforeEach(() => {
  searchParams = new URLSearchParams("hosting=local");
  applyResult = {};
  sessionStorage.clear();
  localStorage.clear();

  navigateMock.mockClear();
  checkAssistantMock.mockClear();
  applyPendingProviderKeyMock.mockClear();
  getAssistantMock.mockClear();
  setOnboardingCompletedMock.mockClear();

  // Local-hatch polls the gateway /readyz before applying the provider key.
  globalThis.fetch = mock(async () => ({
    ok: true,
    json: async () => ({ status: "ok" }),
  })) as unknown as typeof fetch;
});

afterEach(() => {
  cleanup();
  globalThis.fetch = originalFetch;
});

describe("hatching openai-compatible provider warning", () => {
  test("a failed probe holds on the ready screen with the warning and does not auto-navigate", async () => {
    applyResult = { validation: { ok: false, reason: "endpoint timed out" } };

    render(<HatchingScreen />);

    await waitFor(() =>
      expect(applyPendingProviderKeyMock).toHaveBeenCalled(),
    );
    await waitFor(() =>
      expect(screen.getByText(/couldn't verify your OpenAI-compatible/i)).toBeTruthy(),
    );

    // The auto-navigate timer is 800ms; give it well past that and confirm we
    // stay put because the failed probe held for acknowledgement.
    await new Promise((r) => setTimeout(r, 1200));
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("clicking Continue navigates forward", async () => {
    applyResult = { validation: { ok: false, reason: "endpoint timed out" } };

    render(<HatchingScreen />);

    const continueButton = await screen.findByText("Continue");
    fireEvent.click(continueButton);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.prechat, {
        replace: true,
      }),
    );
    expect(checkAssistantMock).toHaveBeenCalled();
  });

  test("a successful probe auto-navigates without a warning", async () => {
    applyResult = { validation: { ok: true } };

    render(<HatchingScreen />);

    await waitFor(() =>
      expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.prechat, {
        replace: true,
      }),
    );
    expect(screen.queryByText(/couldn't verify your OpenAI-compatible/i)).toBeNull();
  });
});
