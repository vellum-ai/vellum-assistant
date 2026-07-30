/**
 * Tests for the proactive low-balance composer banner: copy, the Add-credits
 * CTA opening the banner's own modal, and session dismissal via the store.
 * Visibility is decided by `resolveComposerBillingBanner`, tested in
 * `error-classification.test.ts`.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the buttons with `fireEvent`. The lazy `AddCreditsModal` is
 * stubbed so opening it needs no query client. No jest-dom matchers: we assert
 * with plain bun `expect` against query results.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

mock.module("@/components/add-credits-modal", () => ({
  AddCreditsModal: ({ open }: { open: boolean }) =>
    open ? <div data-testid="add-credits-modal-stub" /> : null,
}));

import { LowBalanceBanner } from "./low-balance-banner";

beforeEach(() => {
  useLowBalanceBannerStore.setState({ dismissed: false });
});

afterEach(() => {
  cleanup();
});

describe("LowBalanceBanner", () => {
  test("renders the low-credits copy with an Add credits CTA that opens the modal", async () => {
    const { getByText, getByRole, findByTestId, queryByTestId } = render(
      <LowBalanceBanner />,
    );

    expect(getByText("Your credits are running low")).toBeTruthy();
    expect(getByText("Add credits to avoid an interruption.")).toBeTruthy();
    expect(queryByTestId("add-credits-modal-stub")).toBeNull();

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(await findByTestId("add-credits-modal-stub")).toBeTruthy();
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(false);
  });

  test("the dismiss button latches the session dismissal in the store", () => {
    const { getByRole } = render(<LowBalanceBanner />);

    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(true);
  });
});
