import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

// react-router: capture navigate() targets.
const navigateMock = mock((..._args: unknown[]) => {});
let searchParamsValue = new URLSearchParams();
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, mock(() => {})],
}));

// Prefs hooks — mutable per-test so we can model each staleness combination.
let tosAccepted = true;
let privacyConsent = true;
let shareAnalytics = true;
let shareDiagnostics = true;
let analyticsConsentCurrent = true;
let diagnosticsConsentCurrent = true;
const setTosAccepted = mock((next: boolean) => {
  tosAccepted = next;
});
const setPrivacyConsent = mock((next: boolean) => {
  privacyConsent = next;
});
const setShareAnalytics = mock((next: boolean) => {
  shareAnalytics = next;
});
const setShareDiagnostics = mock((next: boolean) => {
  shareDiagnostics = next;
});
mock.module("@/domains/onboarding/prefs", () => ({
  useTosAccepted: () => [tosAccepted, setTosAccepted],
  usePrivacyConsent: () => [privacyConsent, setPrivacyConsent],
  useShareAnalytics: () => [shareAnalytics, setShareAnalytics],
  useShareDiagnostics: () => [shareDiagnostics, setShareDiagnostics],
  useAnalyticsConsentCurrent: () => [analyticsConsentCurrent, mock(() => {})],
  useDiagnosticsConsentCurrent: () => [diagnosticsConsentCurrent, mock(() => {})],
}));

const saveConsentMock = mock((_args: unknown) => {});
mock.module("@/utils/onboarding-cleanup", () => ({
  saveConsent: saveConsentMock,
  PRIVACY_CONSENT_VERSION: "2026-06-22",
  TOS_CONSENT_VERSION: "2026-06-08",
}));

mock.module("@/lib/auth/hard-navigate", () => ({
  hardNavigate: mock(() => {}),
}));
mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
mock.module("@/stores/auth-store", () => ({
  useAuthStore: { use: { user: () => ({ id: "user-1" }), logout: () => mock(async () => {}) } },
  useHasPlatformSession: () => true,
}));

// Light passthroughs for layout/design-library so the screen renders in happy-dom.
mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => children,
}));
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
mock.module("@vellumai/design-library/components/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
    "aria-label": ariaLabel,
  }: {
    checked: boolean;
    onCheckedChange: (next: boolean) => void;
    "aria-label"?: string;
  }) => (
    <input
      type="checkbox"
      aria-label={ariaLabel}
      checked={checked}
      onChange={(e) => onCheckedChange(e.target.checked)}
    />
  ),
}));
mock.module("@vellumai/design-library/components/toggle", () => ({
  Toggle: ({
    checked,
    onChange,
    id,
  }: {
    checked: boolean;
    onChange: (next: boolean) => void;
    id?: string;
  }) => (
    <input
      type="checkbox"
      role="switch"
      id={id}
      checked={checked}
      onChange={(e) => onChange(e.target.checked)}
    />
  ),
}));

const { ReviewTermsScreen } = await import(
  "@/domains/onboarding/pages/review-terms-screen"
);

const TOS_LABEL = "I agree to the Terms of Service";
const AI_LABEL = "I agree to the Privacy and AI Data Sharing Policy";

function continueButton(): HTMLButtonElement {
  return screen.getByText("Continue") as HTMLButtonElement;
}

describe("ReviewTermsScreen", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    setShareAnalytics.mockClear();
    searchParamsValue = new URLSearchParams();
    tosAccepted = true;
    privacyConsent = true;
    shareAnalytics = true;
    shareDiagnostics = true;
    analyticsConsentCurrent = true;
    diagnosticsConsentCurrent = true;
  });
  afterEach(cleanup);

  test("nothing stale (direct navigation) renders all sections and enables Continue", () => {
    // All consent current — e.g. the user typed /assistant/review-terms directly.
    render(<ReviewTermsScreen />);

    // Every section is shown rather than an empty page.
    expect(screen.getByLabelText(TOS_LABEL)).toBeTruthy();
    expect(screen.getByLabelText(AI_LABEL)).toBeTruthy();
    expect(screen.getAllByRole("switch").length).toBe(2);
    // Copy is the neutral review variant, not the "we've updated" wording.
    expect(screen.getByText("Terms & privacy")).toBeTruthy();
    expect(
      screen.getByText("Review your terms and privacy preferences anytime."),
    ).toBeTruthy();
    // Already-accepted consent means Continue is enabled immediately.
    expect(continueButton().disabled).toBe(false);
  });

  test("toggle-only staleness renders the toggle, no legal checkboxes, and Continue enabled", () => {
    analyticsConsentCurrent = false; // analytics stale; tos/ai current
    render(<ReviewTermsScreen />);

    // The analytics toggle is shown.
    expect(screen.getByRole("switch")).toBeTruthy();
    // No legal checkboxes.
    expect(screen.queryByLabelText(TOS_LABEL)).toBeNull();
    expect(screen.queryByLabelText(AI_LABEL)).toBeNull();
    // Continue is enabled.
    expect(continueButton().disabled).toBe(false);
  });

  test("flipping a toggle then Continue calls saveConsent with the chosen value", () => {
    analyticsConsentCurrent = false;
    shareAnalytics = true;
    const { rerender } = render(<ReviewTermsScreen />);

    fireEvent.click(screen.getByRole("switch"));
    expect(setShareAnalytics).toHaveBeenCalledWith(false);

    // Re-render so the component picks up the new store value before Continue.
    rerender(<ReviewTermsScreen />);
    fireEvent.click(continueButton());

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(saveConsentMock.mock.calls[0]?.[0]).toMatchObject({
      shareAnalytics: false,
    });
  });

  test("stale TOS renders its checkbox and gates Continue until checked", () => {
    tosAccepted = false; // tos stale
    const { rerender } = render(<ReviewTermsScreen />);

    const tosCheckbox = screen.getByLabelText(TOS_LABEL);
    expect(tosCheckbox).toBeTruthy();
    expect(continueButton().disabled).toBe(true);

    fireEvent.click(tosCheckbox);
    expect(setTosAccepted).toHaveBeenCalledWith(true);

    rerender(<ReviewTermsScreen />);
    // Staleness is snapshotted at mount, so the checkbox stays visible (now
    // showing the checked state) instead of unmounting the instant it's checked.
    const checkedTos = screen.getByLabelText(TOS_LABEL) as HTMLInputElement;
    expect(checkedTos).toBeTruthy();
    expect(checkedTos.checked).toBe(true);
    expect(continueButton().disabled).toBe(false);
  });

  test("heading stays on 'Updated terms' after the last legal box is checked", () => {
    tosAccepted = false; // tos stale -> "Updated terms" heading
    const { rerender } = render(<ReviewTermsScreen />);

    expect(screen.getByText("Updated terms")).toBeTruthy();

    fireEvent.click(screen.getByLabelText(TOS_LABEL));
    rerender(<ReviewTermsScreen />);

    // Heading must not flip mid-flow once the box is checked.
    expect(screen.getByText("Updated terms")).toBeTruthy();
    expect(screen.queryByText("Review your privacy preferences")).toBeNull();
  });
});
