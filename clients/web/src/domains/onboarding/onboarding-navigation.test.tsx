/**
 * The funnel's history contract: every move between setup screens REPLACES the
 * current entry.
 *
 * This is what makes Back inert once setup finishes. The handoff to chat has
 * always replaced, but that drops one entry — so before this contract, each
 * screen the funnel pushed on the way in survived, and a single Back press
 * landed a finished user back inside setup (`onboarding/start` on platform,
 * `onboarding/hatching` in local mode). A pushed navigation anywhere in the
 * funnel puts that entry back on the stack, which is exactly the regression
 * these assertions catch — so they check the options argument, not just the
 * destination.
 *
 * Covers the screens with no test file of their own; `StartScreen` asserts the
 * same contract in `pages/start-screen.test.tsx`, and `PrivacyScreen` /
 * `HatchingScreen` in theirs.
 *
 * Self-contained mocks (run this file solo — `mock.module` leaks across a shared
 * `bun test` run).
 */

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { ReactNode } from "react";

import { routes } from "@/utils/routes";

const navigateMock = mock((_to: string, _opts?: unknown) => {});
let searchParamsValue = new URLSearchParams();

mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
  useSearchParams: () => [searchParamsValue, mock(() => {})],
  // The welcome screen's shared chrome renders a `Link` for the secondary
  // action on the surfaces that navigate rather than handle it in place.
  Link: ({
    to,
    children,
    ...rest
  }: {
    to: string;
    children: React.ReactNode;
  } & React.AnchorHTMLAttributes<HTMLAnchorElement>) => (
    <a href={to} {...rest}>
      {children}
    </a>
  ),
}));

let localAssistants = false;
mock.module("@/lib/local-mode", () => ({
  hasAssistants: () => localAssistants,
  isLocalClient: () => true,
}));

mock.module("@/hooks/use-onboarding-login", () => ({
  useOnboardingLogin: () => ({
    loading: false,
    error: null,
    login: mock(() => {}),
    cancel: mock(() => {}),
  }),
}));

mock.module("@/runtime/is-electron", () => ({ isElectron: () => false }));

mock.module("@/lib/auth/gateway-session", () => ({
  clearGatewayToken: mock(() => {}),
}));
mock.module("@/lib/self-hosted/connection", () => ({
  setSelfHostedConnection: mock(() => {}),
}));
mock.module("@/domains/onboarding/provider-key", () => ({
  setPendingProviderKey: mock(() => {}),
  // A staged key so the api-key screen's Continue is enabled without the test
  // having to drive the (mocked-out) provider inputs.
  peekPendingProviderKey: () => ({ provider: "anthropic", key: "sk-test" }),
}));

mock.module("@/stores/auth-store", () => ({
  useHasPlatformSession: () => true,
}));
mock.module("@/stores/client-feature-flag-store", () => ({
  useClientFeatureFlagStore: {
    use: { multiPlatformAssistant: () => true },
  },
}));
mock.module("@/stores/resolved-assistants-store", () => ({
  useResolvedAssistantsStore: { use: { assistants: () => [] } },
}));

mock.module("@/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: ReactNode }) => children,
}));

mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
    disabled,
  }: {
    children?: ReactNode;
    onClick?: () => void;
    disabled?: boolean;
  }) => (
    <button onClick={onClick} disabled={disabled}>
      {children}
    </button>
  ),
}));
mock.module("@vellumai/design-library/components/select", () => ({
  Select: () => null,
}));
mock.module("@vellumai/design-library/components/input", () => ({
  Input: () => null,
}));

const { WelcomeScreen } = await import(
  "@/domains/onboarding/pages/welcome-screen"
);
const { HostingScreen } = await import(
  "@/domains/onboarding/pages/hosting-screen"
);
const { ApiKeyScreen } = await import(
  "@/domains/onboarding/pages/api-key-screen"
);

/** The options argument of the single `navigate()` this click produced. */
function navigatedWith(): { to: string; opts: unknown } {
  expect(navigateMock).toHaveBeenCalledTimes(1);
  const [to, opts] = navigateMock.mock.calls[0] as [string, unknown];
  return { to, opts };
}

function click(label: string): void {
  fireEvent.click(screen.getByText(label));
}

describe("onboarding funnel history contract", () => {
  beforeEach(() => {
    navigateMock.mockClear();
    searchParamsValue = new URLSearchParams();
    localAssistants = false;
  });
  afterEach(cleanup);

  test("WelcomeScreen replaces on the way into the funnel", () => {
    render(<WelcomeScreen />);
    click("Continue without account");

    const { to, opts } = navigatedWith();
    expect(to).toBe(routes.onboarding.hosting);
    expect(opts).toEqual({ replace: true });
  });

  test("WelcomeScreen replaces on the way to the chooser too", () => {
    localAssistants = true;
    render(<WelcomeScreen />);
    click("Continue without account");

    const { to, opts } = navigatedWith();
    expect(to).toBe(routes.selectAssistant);
    expect(opts).toEqual({ replace: true });
  });

  test("HostingScreen replaces going forward", () => {
    render(<HostingScreen />);
    click("Continue");

    const { to, opts } = navigatedWith();
    expect(to).toBe(routes.onboarding.privacy);
    expect(opts).toEqual({ replace: true });
  });

  // The in-screen Back affordances have to replace too: a pushed back-step is
  // an entry the user can then Back INTO after finishing.
  test("HostingScreen replaces going back", () => {
    render(<HostingScreen />);
    click("Back");

    const { to, opts } = navigatedWith();
    expect(to).toBe(routes.welcome);
    expect(opts).toEqual({ replace: true });
  });

  test("ApiKeyScreen replaces in both directions", () => {
    searchParamsValue = new URLSearchParams("hosting=local");
    render(<ApiKeyScreen />);

    click("Back");
    expect(navigatedWith()).toEqual({
      to: routes.onboarding.hosting,
      opts: { replace: true },
    });

    navigateMock.mockClear();
    click("Continue");
    const { to, opts } = navigatedWith();
    expect(to.startsWith(routes.onboarding.privacy)).toBe(true);
    expect(opts).toEqual({ replace: true });
  });
});
