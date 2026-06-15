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
const setAiDataConsent = mock((_next: boolean) => {});
mock.module("@/domains/onboarding/prefs", () => ({
  useShareAnalytics: () => [false, setShareAnalytics],
  useShareDiagnostics: () => [false, setShareDiagnostics],
  useTosAccepted: () => [true, setTosAccepted],
  useAiDataConsent: () => [true, setAiDataConsent],
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
  onboardingFunnelVariantFromExperiment: () => "control",
  resolveOnboardingFunnelVariant: () => "control",
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
mock.module("@/runtime/native-auth", () => ({
  useIsNativePlatform: () => false,
}));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }) } },
  useHasPlatformSession: () => false,
}));
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: { use: { stringFlags: () => ({}) } },
}));

// Activation-flow arm — drives the post-consent destination (cast → prechat).
let activationArm = "control";
let activationSettled = true;
mock.module("@/hooks/use-client-feature-flag-sync", () => ({
  useActivationFlowArm: () => ({
    arm: activationArm,
    settled: activationSettled,
  }),
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
    activationArm = "control";
    activationSettled = true;
  });
  afterEach(cleanup);

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

  test("normal mode persists consent and advances to hatching", () => {
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.hatching);
  });

  test("cast arm persists consent and skips hatching for prechat", () => {
    searchParamsValue = new URLSearchParams();
    activationArm = "personal-page";
    render(<PrivacyScreen />);

    clickStart();

    // The cast flow owns its own provisioning, so post-consent goes straight to
    // prechat (no standalone hatching step).
    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.prechat);
    expect(navigateMock).not.toHaveBeenCalledWith(routes.onboarding.hatching);
  });

  test("Start is disabled until the activation arm settles", () => {
    searchParamsValue = new URLSearchParams();
    activationSettled = false;
    render(<PrivacyScreen />);

    // A provisional arm must not be acted on: holding Start prevents a targeted
    // personal-page user from being routed down the hatching path on the stale
    // `control` default before the flag resolves.
    const start = screen.getByText("Start") as HTMLButtonElement;
    expect(start.disabled).toBe(true);
    clickStart();
    expect(saveConsentMock).not.toHaveBeenCalled();
    expect(navigateMock).not.toHaveBeenCalled();
  });

  test("preview Start is not gated on the activation arm", () => {
    searchParamsValue = new URLSearchParams("preview=true");
    activationSettled = false;
    render(<PrivacyScreen />);

    // Preview doesn't branch on the arm, so it must stay usable pre-settle.
    const start = screen.getByText("Start") as HTMLButtonElement;
    expect(start.disabled).toBe(false);
    clickStart();
    expect(navigateMock).toHaveBeenCalledWith(
      `${routes.onboarding.prechat}?preview=true`,
    );
  });
});
