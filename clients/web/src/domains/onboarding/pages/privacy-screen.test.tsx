import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { SKIP_RESEARCH_PARAM } from "@/domains/onboarding/onboarding-destination";
import { ONBOARDED_HATCH_AGE_MS } from "@/domains/onboarding/onboarded-assistant";
import { useResolvedAssistantsStore } from "@/stores/resolved-assistants-store";
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
mock.module("@/lib/consent/consent-persistence", () => ({
  saveConsent: saveConsentMock,
}));

// Pending checkout intent — a pricing-CTA signup stashes the chosen package
// (see navigation-resolver post-auth). Mutable so individual tests can pre-seed
// it or leave it absent.
let checkoutIntentValue: unknown = null;
const clearCheckoutIntentMock = mock(() => {});
mock.module("@/lib/billing/checkout-intent", () => ({
  readCheckoutIntent: () => checkoutIntentValue,
  clearCheckoutIntent: clearCheckoutIntentMock,
  // The screen reads the paid-hatch carry off `navigation-resolver`, which
  // pulls in the post-auth checkout carry. Omitting this export fails the
  // module link, so the mock has to cover the whole surface the graph needs.
  saveCheckoutIntent: mock((_intent: unknown) => {}),
}));

// `marketing-pricing-takeover` state — the pricing funnel kill switch.
let takeoverValue = "enabled";
mock.module("@/hooks/use-marketing-pricing-takeover", () => ({
  useMarketingPricingTakeover: () => takeoverValue,
}));

const PRIVACY_TOS_STEP = "privacy_tos";
const emitFunnelStepCompletedMock = mock((..._args: unknown[]) => {});
const getFunnelSessionIdMock = mock(() => "session-1");
mock.module("@/domains/onboarding/funnel-events", () => ({
  emitOnboardingFunnelStepCompleted: emitFunnelStepCompletedMock,
  getOnboardingFunnelSessionId: getFunnelSessionIdMock,
  ONBOARDING_FUNNEL_STEPS: { privacyTos: PRIVACY_TOS_STEP },
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => true }));
// Mutable platform/flag state so individual tests can flip them.
let nativePlatform = false;
let localMode = false;
mock.module("@/lib/local-mode", () => ({ isLocalClient: () => localMode }));
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
mock.module("@/components/onboarding-layout", () => ({
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

const { PrivacyScreen } =
  await import("@/domains/onboarding/pages/privacy-screen");

function clickStart(): void {
  fireEvent.click(screen.getByText("Start"));
}

function clickSkipToChat(): void {
  fireEvent.click(screen.getByText("Skip to chat"));
}

/** The query of the single URL `navigate()` was called with. */
function navigatedQuery(): URLSearchParams {
  const target = navigateMock.mock.calls[0]?.[0] as string;
  return new URLSearchParams(target.slice(target.indexOf("?")));
}

describe("PrivacyScreen — Start navigation", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    emitFunnelStepCompletedMock.mockClear();
    getFunnelSessionIdMock.mockClear();
    clearCheckoutIntentMock.mockClear();
    nativePlatform = false;
    localMode = false;
    checkoutIntentValue = null;
    takeoverValue = "enabled";
    useResolvedAssistantsStore.setState({ assistants: [] });
  });
  afterEach(() => {
    cleanup();
    nativePlatform = false;
    localMode = false;
    checkoutIntentValue = null;
    takeoverValue = "enabled";
    useResolvedAssistantsStore.setState({ assistants: [] });
  });

  test("preview mode no-ops on Start without persisting consent", () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<PrivacyScreen />);

    clickStart();

    // Developer "Replay Onboarding": preview mode allows only non-side-effecting
    // routes, so Start is a no-op — it neither navigates nor persists consent.
    expect(navigateMock).not.toHaveBeenCalled();
    expect(saveConsentMock).not.toHaveBeenCalled();
    expect(emitFunnelStepCompletedMock).not.toHaveBeenCalled();
  });

  test("web persists consent and advances to the research flow, preserving hosting", () => {
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

  test("carries the marketing plugin attribution forward to the research flow", () => {
    nativePlatform = false;
    searchParamsValue = new URLSearchParams(
      "hosting=managed&plugin=coffee-aficionado",
    );
    render(<PrivacyScreen />);

    clickStart();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    // The runner reads `plugin` off the (stable) research URL to pre-install it.
    expect(target).toContain("plugin=coffee-aficionado");
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

  test("native follows the same research onboarding as web", () => {
    nativePlatform = true;
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(getFunnelSessionIdMock).toHaveBeenCalledTimes(1);
    expect(emitFunnelStepCompletedMock).toHaveBeenCalledWith(PRIVACY_TOS_STEP, {
      userId: "user-1",
    });
    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.research, {
      replace: true,
    });
  });

  test("skips research when the assistant was hatched over a week ago", () => {
    useResolvedAssistantsStore.setState({
      assistants: [
        {
          id: "asst-1",
          hatchedAt: new Date(Date.now() - ONBOARDED_HATCH_AGE_MS).toISOString(),
          isLocal: false,
          isPlatformHosted: true,
          isPaired: false,
        },
      ],
    });
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledWith(routes.assistant, {
      replace: true,
    });
  });

  // The funnel is one history entry, so Back can never re-enter it after setup
  // finishes — a pushed step here would put consent back on the stack.
  test("advances by replacing the current history entry, never pushing", () => {
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock.mock.calls[0]?.[1]).toEqual({ replace: true });
  });

  test("resumes checkout when a pending signup-marked package intent is present", () => {
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    // Consent is still recorded before checkout resumes — payment after consent.
    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`${routes.checkout}?`)).toBe(true);
    expect(navigatedQuery().get("package")).toBe("super");
  });

  test("drops the carried package and proceeds when the pricing funnel is off", () => {
    // Kill switch flipped between the pricing CTA and this click. Handing off
    // would land on a checkout route that bounces to plans, dropping the user
    // out of onboarding before research runs.
    takeoverValue = "disabled";
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(clearCheckoutIntentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).not.toContain(routes.checkout);
  });

  test("still resumes while the funnel flag is unresolved, carrying the onboarding step", () => {
    // The flag defaults off; dropping the package before its real value lands
    // would strand every legitimate pricing signup, and blocking Start until it
    // resolves would put a network round-trip in front of the most important
    // click in onboarding. So hand off — but carry the step this click would
    // otherwise have taken, so a pending→disabled transition lands back in the
    // funnel rather than on the plans takeover.
    takeoverValue = "pending";
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams(
      "hosting=managed&plugin=coffee-aficionado",
    );
    render(<PrivacyScreen />);

    clickStart();

    expect(clearCheckoutIntentMock).not.toHaveBeenCalled();
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`${routes.checkout}?`)).toBe(true);
    const query = navigatedQuery();
    expect(query.get("package")).toBe("super");
    // The continuation is the exact URL the non-checkout branch would have
    // navigated to, attribution and hosting included.
    expect(query.get("continue")).toBe(
      `${routes.onboarding.research}?hosting=managed&plugin=coffee-aficionado`,
    );
  });

  test("the carried continuation follows the local-hatch destination", () => {
    // Local hosting must run the foreground hatch first, so the continuation is
    // `hatching`, not `research` — the checkout bail has to resume the same step
    // the standard branch would have.
    takeoverValue = "pending";
    localMode = true;
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=local");
    render(<PrivacyScreen />);

    clickStart();

    expect(navigatedQuery().get("continue")).toBe(
      `${routes.onboarding.hatching}?hosting=local`,
    );
  });

  test("does NOT resume an unmarked billing-surface intent — onboarding proceeds normally", () => {
    // An abandoned CheckoutPage/takeover checkout leaves a discriminator-less
    // package intent. Without the signup marker it must not hijack onboarding:
    // Start advances to the normal next step instead of launching checkout.
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).not.toContain(routes.checkout);
  });

  test("resumes checkout when a pending signup-marked custom intent is present", () => {
    checkoutIntentValue = {
      kind: "custom",
      machineTier: "large",
      storageTier: "s",
      creditTier: "credits_50",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`${routes.checkout}?`)).toBe(true);
    const query = navigatedQuery();
    // The tier params the checkout route parses back into an upgrade body.
    expect(query.get("machine_tier")).toBe("large");
    expect(query.get("storage_tier")).toBe("s");
    expect(query.get("credit_tier")).toBe("credits_50");
    expect(query.get("continue")).toBe(
      `${routes.onboarding.research}?hosting=managed`,
    );
  });

  test("a resumed custom config omits the dimensions it leaves unset", () => {
    checkoutIntentValue = {
      kind: "custom",
      machineTier: null,
      storageTier: "xs",
      creditTier: null,
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    const query = navigatedQuery();
    expect(query.get("storage_tier")).toBe("xs");
    // Absent, not empty: an empty tier param would fail the checkout parse.
    expect(query.has("machine_tier")).toBe(false);
    expect(query.has("credit_tier")).toBe(false);
  });

  test("proceeds with onboarding when a marked custom stash names no storage tier", () => {
    // Storage is required on a package-less upgrade, so such a stash names
    // nothing the checkout route could buy. Fall through rather than hand off
    // to a route that would only bail back out of the funnel.
    checkoutIntentValue = {
      kind: "custom",
      machineTier: "medium",
      storageTier: null,
      creditTier: null,
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).not.toContain(routes.checkout);
  });

  test("drops the carried custom config and proceeds when the pricing funnel is off", () => {
    takeoverValue = "disabled";
    checkoutIntentValue = {
      kind: "custom",
      machineTier: "medium",
      storageTier: "m",
      creditTier: null,
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(clearCheckoutIntentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).not.toContain(routes.checkout);
  });

  test("does NOT resume an unmarked custom intent: onboarding proceeds normally", () => {
    // The Stripe hand-off rewrites the stash without the marker, so an
    // unmarked custom intent describes a checkout that already ran.
    checkoutIntentValue = {
      kind: "custom",
      machineTier: "medium",
      storageTier: "m",
      creditTier: null,
      savedAt: Date.now(),
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).not.toContain(routes.checkout);
  });

  // -- paid post-checkout return bounced here for consent -------------------
  //
  // A checkout return with nothing provisioned is funneled to the hatching
  // screen; an unconsented user is bounced here, and the funnel URL rides
  // along as `returnTo`. Start has to resume it — the standard onboarding step
  // carries neither the managed-hatch nor the paid-return marker, so the
  // paying user would finish the hatch at the baseline plan.
  const PAID_HATCH = `${routes.onboarding.hatching}?hosting=vellum-cloud&post_checkout=1`;

  test("resumes the paid hatch carried through the consent bounce", () => {
    searchParamsValue = new URLSearchParams({ returnTo: PAID_HATCH });
    render(<PrivacyScreen />);

    clickStart();

    // Consent is recorded first — the resume never skips it.
    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledWith(PAID_HATCH, { replace: true });
  });

  test("the paid hatch wins over a pending signup-marked package intent", () => {
    // Money has already changed hands, so resuming checkout again is the worse
    // failure of the two.
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams({ returnTo: PAID_HATCH });
    render(<PrivacyScreen />);

    clickStart();

    expect(navigateMock).toHaveBeenCalledWith(PAID_HATCH, { replace: true });
  });

  test("ignores a returnTo that is not a paid hatch", () => {
    // Resuming an arbitrary same-origin path would let a crafted link skip the
    // rest of the funnel, so only the paid hatch URL is honored.
    searchParamsValue = new URLSearchParams({
      hosting: "managed",
      returnTo: routes.settings.usage,
    });
    render(<PrivacyScreen />);

    clickStart();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.research)).toBe(true);
    expect(target).toContain("hosting=managed");
  });

  test("resume fires only on the Start click, not on render (no loop)", () => {
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams();
    render(<PrivacyScreen />);

    // Mounting the screen must never navigate — the resume is action-gated, so
    // a consented user returning here cannot loop between consent and checkout.
    expect(navigateMock).not.toHaveBeenCalled();

    clickStart();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`${routes.checkout}?`)).toBe(true);
    expect(navigatedQuery().get("package")).toBe("super");
  });
});

describe("PrivacyScreen — Skip to chat", () => {
  const env = import.meta.env as Record<string, string | undefined>;
  let previousEnv: string | undefined;

  beforeEach(() => {
    previousEnv = env.VITE_SENTRY_ENVIRONMENT;
    env.VITE_SENTRY_ENVIRONMENT = "staging";
    navigateMock.mockClear();
    saveConsentMock.mockClear();
    emitFunnelStepCompletedMock.mockClear();
    nativePlatform = false;
    localMode = false;
    checkoutIntentValue = null;
    takeoverValue = "enabled";
  });
  afterEach(() => {
    env.VITE_SENTRY_ENVIRONMENT = previousEnv;
    cleanup();
    nativePlatform = false;
    localMode = false;
    checkoutIntentValue = null;
    takeoverValue = "enabled";
  });

  test("saves consent and hatches, skipping the research funnel", () => {
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickSkipToChat();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    expect(navigateMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.hatching)).toBe(true);
    expect(target).toContain("hosting=managed");
    expect(target).toContain(`${SKIP_RESEARCH_PARAM}=1`);
    expect(navigateMock.mock.calls[0]?.[1]).toEqual({ replace: true });
  });

  test("preview mode no-ops on Skip to chat without persisting consent", () => {
    searchParamsValue = new URLSearchParams("preview=true");
    render(<PrivacyScreen />);

    clickSkipToChat();

    expect(navigateMock).not.toHaveBeenCalled();
    expect(saveConsentMock).not.toHaveBeenCalled();
  });

  test("carries skip_research onto a paid hatch return", () => {
    const paidHatch = `${routes.onboarding.hatching}?hosting=vellum-cloud&post_checkout=1`;
    searchParamsValue = new URLSearchParams({ returnTo: paidHatch });
    render(<PrivacyScreen />);

    clickSkipToChat();

    expect(saveConsentMock).toHaveBeenCalledTimes(1);
    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(routes.onboarding.hatching)).toBe(true);
    expect(target).toContain("post_checkout=1");
    expect(target).toContain(`${SKIP_RESEARCH_PARAM}=1`);
  });

  test("checkout continuation carries the skip-to-chat hatch URL", () => {
    checkoutIntentValue = {
      kind: "package",
      packageKey: "super",
      savedAt: Date.now(),
      resumeAfterOnboarding: true,
    };
    searchParamsValue = new URLSearchParams("hosting=managed");
    render(<PrivacyScreen />);

    clickSkipToChat();

    const target = navigateMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`${routes.checkout}?`)).toBe(true);
    expect(navigatedQuery().get("continue")).toBe(
      `${routes.onboarding.hatching}?hosting=managed&${SKIP_RESEARCH_PARAM}=1`,
    );
  });
});

describe("PrivacyScreen — Back navigation", () => {
  const assignMock = mock((_url: string) => {});

  beforeEach(() => {
    navigateMock.mockClear();
    assignMock.mockClear();
    nativePlatform = false;
    localMode = false;
    searchParamsValue = new URLSearchParams();
    // Guard against regressions: Back must stay inside the SPA and never reach
    // for a full-document navigation to the marketing host.
    Object.defineProperty(window, "location", {
      value: { assign: assignMock },
      configurable: true,
      writable: true,
    });
  });
  afterEach(() => {
    cleanup();
    nativePlatform = false;
    localMode = false;
  });

  test("local mode: Back returns to the hosting screen deterministically", () => {
    localMode = true;
    render(<PrivacyScreen />);

    fireEvent.click(screen.getByText("Back"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.hosting, {
      replace: true,
    });
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("platform mode: Back lands on the in-SPA onboarding start screen", () => {
    localMode = false;
    render(<PrivacyScreen />);

    fireEvent.click(screen.getByText("Back"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.start, {
      replace: true,
    });
    // Must not leave the SPA for the marketing host — that would switch a
    // Capacitor staging/dev shell onto production.
    expect(assignMock).not.toHaveBeenCalled();
  });

  test("native platform shell: Back stays in-SPA (no marketing-host escape)", () => {
    // The environment-preservation case Codex flagged: on Capacitor
    // staging/dev, isLocalClient() is false, so platform-mode Back applies. It
    // must remain an in-SPA navigation, never a full-document nav to `/`.
    localMode = false;
    nativePlatform = true;
    render(<PrivacyScreen />);

    fireEvent.click(screen.getByText("Back"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.start, {
      replace: true,
    });
    expect(assignMock).not.toHaveBeenCalled();
  });
});
