/**
 * Tests for the proactive low-balance composer banner: copy, the Add-credits
 * CTA opening the shared checkout modal store, and session dismissal via the
 * store. Visibility is decided by `resolveComposerBillingBanner`, tested in
 * `error-classification.test.ts`; the modal mount itself is covered in
 * `lazy-add-credits-modal.test.tsx`.
 *
 * Renders via `@testing-library/react` (happy-dom registered in test-setup.ts)
 * and drives the buttons with `fireEvent`. No jest-dom matchers: we assert
 * with plain bun `expect` against query results.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { cleanup, fireEvent, render } from "@testing-library/react";

import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { useLowBalanceBannerStore } from "@/stores/low-balance-banner-store";

import { LowBalanceBanner } from "./low-balance-banner";

beforeEach(() => {
  useAddCreditsModalStore.setState({ open: false });
  useLowBalanceBannerStore.setState({ dismissed: false });
});

afterEach(() => {
  cleanup();
});

describe("LowBalanceBanner", () => {
  test("renders the low-credits copy with an Add credits CTA that opens the shared modal store", () => {
    const { getByText, getByRole } = render(<LowBalanceBanner />);

    expect(getByText("Your credits are running low")).toBeTruthy();
    expect(getByText("Add credits to avoid an interruption.")).toBeTruthy();
    expect(useAddCreditsModalStore.getState().open).toBe(false);

    fireEvent.click(getByRole("button", { name: "Add credits" }));
    expect(useAddCreditsModalStore.getState().open).toBe(true);
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(false);
  });

  test("the dismiss button latches the session dismissal in the store", () => {
    const { getByRole } = render(<LowBalanceBanner />);

    fireEvent.click(getByRole("button", { name: "Dismiss" }));
    expect(useLowBalanceBannerStore.getState().dismissed).toBe(true);
  });
});
