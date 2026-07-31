/**
 * Tests for `CreditsUpsellCard`, the in-transcript credit wall that resolves
 * its own CTA mode (experiment arm + plan) and opens the shared Add Credits
 * modal store (the modal mount itself is covered in
 * `lazy-add-credits-modal.test.tsx`).
 *
 * The mode inputs are mocked at the hook seam (`useBillingCtaExperimentArm`,
 * `useIsFreePlan`, `usePlatformGate`) and toggled per-test: `mock.module` is
 * process-global, so a second registration would leak into the rest of the
 * file. `useNavigate` is mocked so the View-plans wiring can be asserted
 * without a Router, and `PlatformLoginNotice` is stubbed (its login flow needs
 * a Router + auth context).
 */
import type { ReactNode } from "react";
import * as reactRouter from "react-router";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import * as billingCtaExperiment from "@/hooks/use-billing-cta-experiment";
import * as platformGateModule from "@/hooks/use-platform-gate";
import type { PlatformGateState } from "@/hooks/use-platform-gate";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";

let navigateTargets: unknown[] = [];
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => (to: unknown) => {
    navigateTargets.push(to);
  },
}));

let arm = "control";
mock.module("@/hooks/use-billing-cta-experiment", () => ({
  ...billingCtaExperiment,
  useBillingCtaExperimentArm: () => arm,
}));

let isFreePlan: boolean | undefined = true;
let freePlanEnabledArgs: unknown[] = [];
mock.module("@/hooks/use-is-free-plan", () => ({
  useIsFreePlan: (enabled?: boolean) => {
    freePlanEnabledArgs.push(enabled);
    return isFreePlan;
  },
}));

let platformGate: PlatformGateState = "full";
mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGateModule,
  usePlatformGate: () => platformGate,
}));

mock.module("@/components/platform-login-notice", () => ({
  PlatformLoginNotice: ({ children }: { children: ReactNode }) => (
    <div data-testid="platform-login-notice-stub">{children}</div>
  ),
}));

import { CreditsUpsellCard } from "./credits-upsell-card";
import { routes } from "@/utils/routes";

beforeEach(() => {
  navigateTargets = [];
  arm = "control";
  isFreePlan = true;
  freePlanEnabledArgs = [];
  platformGate = "full";
  useAddCreditsModalStore.setState({ open: false });
});

afterEach(() => {
  cleanup();
});

describe("CreditsUpsellCard", () => {
  test("upgrade arm + free plan renders the View plans CTA and navigates to plans", () => {
    arm = "upgrade-cta";

    const { getByRole, getByText } = render(<CreditsUpsellCard />);

    expect(getByText("You’re out of Free credits")).toBeTruthy();
    expect(
      getByText("Upgrade your plan to keep the conversation going."),
    ).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "View plans" }));
    expect(navigateTargets).toEqual([routes.plans]);
    expect(useAddCreditsModalStore.getState().open).toBe(false);
  });

  test("free plan outside the upgrade arm renders the Add credits CTA and opens the shared modal store", () => {
    const { getByRole, getByText } = render(<CreditsUpsellCard />);

    expect(getByText("You’re out of credits")).toBeTruthy();
    expect(
      getByText("Add credits to pick up where you left off."),
    ).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(useAddCreditsModalStore.getState().open).toBe(true);
    expect(navigateTargets).toEqual([]);
  });

  test("paid or unresolved plan renders the Add credits CTA even in the upgrade arm", () => {
    arm = "upgrade-cta";
    isFreePlan = undefined;

    const { getByRole, getByText, queryByRole } = render(<CreditsUpsellCard />);

    expect(getByText("You’re out of credits")).toBeTruthy();
    expect(queryByRole("button", { name: "View plans" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(useAddCreditsModalStore.getState().open).toBe(true);
    expect(navigateTargets).toEqual([]);
  });

  test("renders the leading credits icon", () => {
    const { getByText } = render(<CreditsUpsellCard />);
    expect(getByText("💰")).toBeTruthy();
  });

  test("full gate enables the subscription fetch behind useIsFreePlan", () => {
    render(<CreditsUpsellCard />);
    expect(freePlanEnabledArgs).toEqual([true]);
  });

  test("disabled gate renders the login treatment instead of a billing CTA", () => {
    platformGate = "disabled";

    const { getByTestId, getByText, queryByRole } = render(
      <CreditsUpsellCard />,
    );

    expect(getByTestId("platform-login-notice-stub")).toBeTruthy();
    expect(
      getByText("Log in to the Vellum platform to add credits."),
    ).toBeTruthy();
    expect(queryByRole("button", { name: "Add credits" })).toBeNull();
    expect(queryByRole("button", { name: "View plans" })).toBeNull();
    // No platform session means the subscription request would go out
    // unauthenticated; the gate must keep the fetch disabled.
    expect(freePlanEnabledArgs).toEqual([false]);
  });

  test("gated (self-hosted assistant) renders nothing", () => {
    platformGate = "gated";

    const { container } = render(<CreditsUpsellCard />);

    expect(container.innerHTML).toBe("");
    expect(freePlanEnabledArgs).toEqual([false]);
  });
});
