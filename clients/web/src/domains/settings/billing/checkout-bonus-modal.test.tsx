/**
 * Tests for `CheckoutBonusModal`:
 *  - the offer copy and claim button render the amount from props, never a
 *    hardcoded figure
 *  - a granted claim toasts success with the server-returned amount,
 *    invalidates the billing summary and the eligibility query, and closes
 *  - `already_claimed` / `ineligible` claims toast info, invalidate the
 *    eligibility query so a cached `eligible: true` cannot re-show the offer,
 *    and close without touching the billing summary
 *  - a failed claim toasts an error and keeps the modal open with the button
 *    re-enabled
 *  - both actions are disabled while the claim is in flight
 *
 * The claim call is mocked at the SDK boundary so the real generated mutation
 * factory (and its cache-invalidation contract) stays in the loop. Radix
 * portals the dialog, so queries go through `screen` (document.body).
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { CheckoutBonusClaimResponse } from "@/generated/api/types.gen";
import * as toastModule from "@vellumai/design-library/components/toast";

const GRANTED: CheckoutBonusClaimResponse = {
  status: "granted",
  amount_usd: "5.00",
  balance_usd: "5.00",
};

let claimCalls = 0;
// Lazy so a per-test rejection is only created once a handler will attach.
let claimImpl: () => Promise<{ data: CheckoutBonusClaimResponse }> = () =>
  Promise.resolve({ data: GRANTED });
let successToasts: string[] = [];
let infoToasts: string[] = [];
let errorToasts: string[] = [];

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingCheckoutBonusCreate: () => {
    claimCalls += 1;
    return claimImpl();
  },
}));

mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: {
    success: (message: string) => successToasts.push(message),
    info: (message: string) => infoToasts.push(message),
    error: (message: string) => errorToasts.push(message),
    warning: () => {},
  },
}));

const {
  organizationsBillingCheckoutBonusRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} = await import("@/generated/api/@tanstack/react-query.gen");
const { CheckoutBonusModal } = await import("./checkout-bonus-modal");

const SUMMARY_KEY = organizationsBillingSummaryRetrieveQueryKey();
const ELIGIBILITY_KEY = organizationsBillingCheckoutBonusRetrieveQueryKey();

function renderModal({
  amountUsd = "5.00",
  onOpenChange = () => {},
}: {
  amountUsd?: string;
  onOpenChange?: (open: boolean) => void;
} = {}) {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  // Seed the billing summary and eligibility entries so invalidation is
  // observable without either query ever fetching.
  queryClient.setQueryData(SUMMARY_KEY, { settled_balance_usd: "0.00" });
  queryClient.setQueryData(ELIGIBILITY_KEY, {
    eligible: true,
    amount_usd: "5.00",
  });
  render(
    <QueryClientProvider client={queryClient}>
      <CheckoutBonusModal
        open
        onOpenChange={onOpenChange}
        amountUsd={amountUsd}
      />
    </QueryClientProvider>,
  );
  return queryClient;
}

function claimButton(): HTMLButtonElement {
  return screen.getByTestId("claim-checkout-bonus-button") as HTMLButtonElement;
}

afterEach(() => {
  cleanup();
  claimCalls = 0;
  claimImpl = () => Promise.resolve({ data: GRANTED });
  successToasts = [];
  infoToasts = [];
  errorToasts = [];
});

describe("CheckoutBonusModal", () => {
  test("renders the offered amount from props, not a hardcoded figure", () => {
    renderModal({ amountUsd: "7.50" });

    screen.getByRole("heading", { name: "Here's $7.50 on us" });
    expect(claimButton().textContent).toBe("Claim $7.50 in credits");
    screen.getByRole("button", { name: "No thanks" });
  });

  test("a granted claim toasts, invalidates the summary and eligibility, and closes", async () => {
    claimImpl = () =>
      Promise.resolve({
        data: { ...GRANTED, amount_usd: "10.00", balance_usd: "12.00" },
      });
    const onOpenChange = mock((_open: boolean) => {});
    const queryClient = renderModal({ onOpenChange });

    fireEvent.click(claimButton());

    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
    expect(claimCalls).toBe(1);
    expect(successToasts).toEqual(["$10 in credits added to your account."]);
    expect(infoToasts).toEqual([]);
    expect(queryClient.getQueryState(SUMMARY_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(ELIGIBILITY_KEY)?.isInvalidated).toBe(
      true,
    );
  });

  for (const status of ["already_claimed", "ineligible"] as const) {
    test(`an ${status} claim toasts info and closes without granting`, async () => {
      claimImpl = () => Promise.resolve({ data: { ...GRANTED, status } });
      const onOpenChange = mock((_open: boolean) => {});
      const queryClient = renderModal({ onOpenChange });

      fireEvent.click(claimButton());

      await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
      expect(infoToasts).toEqual(["This offer is no longer available."]);
      expect(successToasts).toEqual([]);
      expect(queryClient.getQueryState(SUMMARY_KEY)?.isInvalidated).toBe(false);
      // The stale `eligible: true` must be dropped so the offer cannot
      // re-show from cache.
      expect(queryClient.getQueryState(ELIGIBILITY_KEY)?.isInvalidated).toBe(
        true,
      );
    });
  }

  test("a failed claim toasts an error and keeps the modal open", async () => {
    claimImpl = () => Promise.reject(new Error("network down"));
    const onOpenChange = mock((_open: boolean) => {});
    renderModal({ onOpenChange });

    fireEvent.click(claimButton());

    await waitFor(() =>
      expect(errorToasts).toEqual([
        "Could not add the credits. Please try again.",
      ]),
    );
    expect(onOpenChange).not.toHaveBeenCalled();
    screen.getByTestId("checkout-bonus-modal");
    await waitFor(() => expect(claimButton().disabled).toBe(false));
  });

  test("both actions are disabled while the claim is in flight", async () => {
    let resolveClaim: (value: { data: CheckoutBonusClaimResponse }) => void;
    claimImpl = () =>
      new Promise((resolve) => {
        resolveClaim = resolve;
      });
    const onOpenChange = mock((_open: boolean) => {});
    renderModal({ onOpenChange });

    fireEvent.click(claimButton());

    await waitFor(() => expect(claimButton().disabled).toBe(true));
    expect(
      (screen.getByRole("button", { name: "No thanks" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);

    resolveClaim!({ data: GRANTED });
    await waitFor(() => expect(onOpenChange).toHaveBeenCalledWith(false));
  });
});
