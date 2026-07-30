/**
 * Tests for the proactive low-balance composer banner: the rendered banner
 * (copy, CTA, session dismissal via the store) and the visibility rule
 * `shouldShowLowBalanceBanner` that `chat-route-content` gates the slot with.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the buttons with `fireEvent`. No jest-dom matchers: we assert
 * with plain bun `expect` against query results.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import type { ChatBillingBannerDecision } from "@/domains/chat/utils/error-classification";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

import {
  LowBalanceBanner,
  shouldShowLowBalanceBanner,
} from "./low-balance-banner";

beforeEach(() => {
  useLowBalanceBannerStore.setState({ dismissed: false });
});

afterEach(() => {
  cleanup();
});

describe("LowBalanceBanner", () => {
  test("renders the low-credits copy with an Add credits CTA", () => {
    const onAddCredits = mock(() => {});

    const { getByText, getByRole } = render(
      <LowBalanceBanner onAddCredits={onAddCredits} />,
    );

    expect(getByText("Your credits are running low")).toBeTruthy();
    expect(getByText("Add credits to avoid an interruption.")).toBeTruthy();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(onAddCredits).toHaveBeenCalledTimes(1);
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(false);
  });

  test("the dismiss button latches the session dismissal in the store", () => {
    const { getByRole } = render(<LowBalanceBanner onAddCredits={() => {}} />);

    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(true);
  });
});

describe("shouldShowLowBalanceBanner", () => {
  const visibleArgs = {
    billingBannerDecision: null,
    isLowBalance: true,
    dismissed: false,
  };

  test("shows only in the warn band with no error banner and no dismissal", () => {
    expect(shouldShowLowBalanceBanner(visibleArgs)).toBe(true);
  });

  test("hidden when the server flag is off (normal balance, auto-top-up, or gated-off query)", () => {
    expect(
      shouldShowLowBalanceBanner({ ...visibleArgs, isLowBalance: false }),
    ).toBe(false);
  });

  test("hidden after a session dismissal", () => {
    expect(
      shouldShowLowBalanceBanner({ ...visibleArgs, dismissed: true }),
    ).toBe(false);
  });

  test("hidden while any error-driven billing banner decision is active", () => {
    const decisions: ChatBillingBannerDecision[] = [
      "managed_credits",
      "provider_billing",
      "daily_limit",
    ];
    for (const billingBannerDecision of decisions) {
      expect(
        shouldShowLowBalanceBanner({ ...visibleArgs, billingBannerDecision }),
      ).toBe(false);
    }
  });
});
