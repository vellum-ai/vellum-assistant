/**
 * Tests for the composer's free-tier daily-limit banner: the daily wording,
 * and its two ways out (plans, credits).
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";
import * as reactRouter from "react-router";

import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { routes } from "@/utils/routes";

let navigateTargets: unknown[] = [];
mock.module("react-router", () => ({
  ...reactRouter,
  useNavigate: () => (to: unknown) => {
    navigateTargets.push(to);
  },
}));

const { FreeTierDailyLimitBanner } =
  await import("./free-tier-daily-limit-banner");

describe("FreeTierDailyLimitBanner", () => {
  beforeEach(() => {
    navigateTargets = [];
    useAddCreditsModalStore.setState({ open: false });
  });

  afterEach(() => {
    cleanup();
  });

  test("names the daily free usage, not the user's daily limit", () => {
    const { getByText, queryByText } = render(<FreeTierDailyLimitBanner />);

    expect(getByText("Daily free usage used up")).toBeTruthy();
    expect(getByText(/You've used today's free usage\./)).toBeTruthy();
    // No skip and no settings: the cap is the platform's, not a setting.
    expect(queryByText("Skip for today")).toBeNull();
    expect(queryByText("Settings")).toBeNull();
  });

  test("Add credits opens the shared checkout modal", () => {
    const { getByRole } = render(<FreeTierDailyLimitBanner />);

    fireEvent.click(getByRole("button", { name: "Add credits" }));

    expect(useAddCreditsModalStore.getState().open).toBe(true);
  });

  test("View plans navigates to the plans page", () => {
    const { getByRole } = render(<FreeTierDailyLimitBanner />);

    fireEvent.click(getByRole("button", { name: "View plans" }));

    expect(navigateTargets).toEqual([routes.plans]);
  });
});
