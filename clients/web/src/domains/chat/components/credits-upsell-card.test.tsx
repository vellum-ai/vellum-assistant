/**
 * Tests for `CreditsUpsellCard`, the in-transcript credit wall that resolves
 * its own CTA mode (experiment arm + plan) and owns its Add Credits modal.
 *
 * The mode inputs are mocked at the hook seam (`useBillingCtaExperimentArm`,
 * `useIsFreePlan`) and toggled per-test: `mock.module` is process-global, so
 * a second registration would leak into the rest of the file. `useNavigate`
 * is mocked so the View-plans wiring can be asserted without a Router, and
 * the lazy `AddCreditsModal` is stubbed so opening it needs no query client.
 */
import * as reactRouter from "react-router";

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import * as billingCtaExperiment from "@/hooks/use-billing-cta-experiment";

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
mock.module("@/hooks/use-is-free-plan", () => ({
  useIsFreePlan: () => isFreePlan,
}));

mock.module("@/components/add-credits-modal", () => ({
  AddCreditsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-credits-modal-stub" /> : null,
}));

import { CreditsUpsellCard } from "./credits-upsell-card";
import { routes } from "@/utils/routes";

beforeEach(() => {
  navigateTargets = [];
  arm = "control";
  isFreePlan = true;
});

afterEach(() => {
  cleanup();
});

describe("CreditsUpsellCard", () => {
  test("upgrade arm + free plan renders the View plans CTA and navigates to plans", () => {
    arm = "upgrade-cta";

    const { getByRole, getByText, queryByTestId } = render(
      <CreditsUpsellCard />,
    );

    expect(getByText("You’re out of Free credits")).toBeTruthy();
    expect(
      getByText("Upgrade your plan to keep the conversation going."),
    ).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "View plans" }));
    expect(navigateTargets).toEqual([routes.plans]);
    expect(queryByTestId("add-credits-modal-stub")).toBeNull();
  });

  test("free plan outside the upgrade arm renders the Add credits CTA and opens the modal", async () => {
    const { getByRole, getByText, findByTestId } = render(
      <CreditsUpsellCard />,
    );

    expect(getByText("You’re out of credits")).toBeTruthy();
    expect(getByText("Add credits to pick up where you left off.")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(await findByTestId("add-credits-modal-stub")).toBeTruthy();
    expect(navigateTargets).toEqual([]);
  });

  test("paid or unresolved plan renders the Add credits CTA even in the upgrade arm", async () => {
    arm = "upgrade-cta";
    isFreePlan = undefined;

    const { findByTestId, getByRole, getByText, queryByRole } = render(
      <CreditsUpsellCard />,
    );

    expect(getByText("You’re out of credits")).toBeTruthy();
    expect(queryByRole("button", { name: "View plans" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(await findByTestId("add-credits-modal-stub")).toBeTruthy();
    expect(navigateTargets).toEqual([]);
  });

  test("renders the leading credits icon", () => {
    const { getByText } = render(<CreditsUpsellCard />);
    expect(getByText("💰")).toBeTruthy();
  });
});
