import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { routes } from "@/utils/routes";

// react-router: capture navigate() targets and drive the ?preview flag.
const navigateMock = mock((..._args: unknown[]) => {});
let searchParamsValue = new URLSearchParams();
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, mock(() => {})],
}));

// Consent setters — spied so we can assert they are NOT persisted in preview.
const setShareAnalytics = mock((_next: boolean) => {});
const setShareDiagnostics = mock((_next: boolean) => {});
const setTosAccepted = mock((_next: boolean) => {});
const setPrivacyConsent = mock((_next: boolean) => {});
mock.module("@/domains/onboarding/prefs", () => ({
  useShareAnalytics: () => [false, setShareAnalytics],
  useShareDiagnostics: () => [false, setShareDiagnostics],
  useTosAccepted: () => [true, setTosAccepted],
  usePrivacyConsent: () => [true, setPrivacyConsent],
  useAnalyticsConsentCurrent: () => [true, mock(() => {})],
  useDiagnosticsConsentCurrent: () => [true, mock(() => {})],
}));

const saveConsentMock = mock((_args: unknown) => {});
mock.module("@/utils/onboarding-cleanup", () => ({
  saveConsent: saveConsentMock,
}));

const emitFunnelStepCompletedMock = mock((..._args: unknown[]) => {});
mock.module("@/domains/onboarding/funnel-events", () => ({
  emitOnboardingFunnelStepCompleted: emitFunnelStepCompletedMock,
  getOnboardingFunnelSessionId: () => "session-1",
  ONBOARDING_FUNNEL_STEPS: { privacyTos: "privacy_tos" },
  ONBOARDING_FUNNEL_VARIANTS: { control: "control", paredDown: "pared_down" },
  resolveOnboardingFunnelVariant: () => "control",
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
// Mutable platform/flag state so individual tests can flip them.
let nativePlatform = false;
let localMode = false;
mock.module("@/lib/local-mode", () => ({ isLocalMode: () => localMode }));
mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => nativePlatform,
}));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
  useHasPlatformSession: () => false,
}));
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: { stringFlags: () => ({}) },
  },
}));

// Light passthroughs for layout/design-library so the screen renders in happy-dom.
mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@/domains/onboarding/components/step-indicator-dots", () => ({
  StepIndicatorDots: () => null,
}));
mock.module("lucide-react", () => ({ EyeOff: () => null }));
mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module("@vellumai/design-library/components/card", () => ({
  Card: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
}));
mock.module("@vellumai/design-library/components/checkbox", () => ({
  Checkbox: () => null,
}));
mock.module("@vellumai/design-library/components/toggle", () => ({
  Toggle: () => null,
}));

const { PrivacyScreen } = await import(
  "@/domains/onboarding/pages/privacy-screen"
);

function clickStart(): void {
  fireEvent.click(screen.getByText("Start"));
}

describe("PrivacyScreen — Start navigation", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    emitFunnelStepCompletedMock.mockClear();
    nativePlatform = false;
    localMode = false;
  });
  afterEach(() => {
    cleanup();
    nativePlatform = false;
    localMode = false;
  });

  test("preview mode replays forward into prechat without persisting consent", () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<PrivacyScreen />);

    clickStart();

    // Developer "Replay Onboarding" advances privacy → prechat (sandboxed),
    // never to the side-effecting hatching route, and never persists consent.
    expect(navigateMock).toHaveBeenCalledWith(
      `${routes.onboarding.prechat}?preview=true`,
    );
    expect(saveConsentMock).not.toHaveBeenCalled();
    expect(emitFunnelStepCompletedMock).not.toHaveBeenCalled();
  });

  test("web persists consent and advances to the research flow (now the default), preserving hosting", () => {
    nativePlatform = false;
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).toContain("hosting=managed");
  });

  test("local hosting routes to hatching first (foreground local hatch), preserving hosting", () => {
    localMode = true;
    nativePlatform = false;
    searchParamsValue = new URLSearchParams("hosting=local");
    render(<PrivacyScreen />);

    clickStart();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.hatching)).toBe(true);
    expect(target).toContain("hosting=local");
  });

  test("native keeps the standard hatching flow (research not wired for the native shell)", () => {
    nativePlatform = true;
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.hatching);
  });
});
