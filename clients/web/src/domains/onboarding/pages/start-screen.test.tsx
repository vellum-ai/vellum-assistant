import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

import { routes } from "@/utils/routes";

const navigateMock = mock((..._args: unknown[]) => {});
mock.module("react-router", () => ({
  useNavigate: () => navigateMock,
}));

// Light passthroughs so the screen renders in happy-dom.
mock.module("@/domains/onboarding/components/onboarding-layout", () => ({
  OnboardingLayout: ({ children }: { children: React.ReactNode }) => children,
}));
mock.module("@vellumai/design-library/components/button", () => ({
  Button: ({
    children,
    onClick,
  }: {
    children: React.ReactNode;
    onClick?: () => void;
  }) => <button onClick={onClick}>{children}</button>,
}));

const { StartScreen } = await import(
  "@/domains/onboarding/pages/start-screen"
);

describe("StartScreen", () => {
  beforeEach(() => navigateMock.mockClear());
  afterEach(cleanup);

  test("the single CTA re-enters the funnel at the privacy screen", () => {
    render(<StartScreen />);

    fireEvent.click(screen.getByText("Create your assistant"));

    expect(navigateMock).toHaveBeenCalledWith(routes.onboarding.privacy);
  });
});
