import { beforeEach, describe, expect, mock, spyOn, test } from "bun:test";

import { QueryClient } from "@tanstack/react-query";

import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import * as toastModule from "@vellumai/design-library/components/toast";

// Stub the toaster: no <Toaster /> is mounted here. Full toast surface:
// `mock.module` is process-global in bun, so a partial shape would shadow
// the other methods for later test files.
const toastSuccessMock = mock((..._args: unknown[]) => undefined);
mock.module("@vellumai/design-library/components/toast", () => ({
  ...toastModule,
  toast: Object.assign((..._args: unknown[]) => {}, {
    success: toastSuccessMock,
    error: () => {},
    info: () => {},
    warning: () => {},
  }),
}));

const { notifyCheckoutSuccess } = await import("./checkout-success");

beforeEach(() => {
  toastSuccessMock.mockClear();
});

describe("notifyCheckoutSuccess", () => {
  test("toasts the payment confirmation and refetches the billing summary", () => {
    const queryClient = new QueryClient();
    const invalidateSpy = spyOn(queryClient, "invalidateQueries");

    notifyCheckoutSuccess(queryClient);

    // The copy both return paths (web `billing_status=success` and the
    // native `flow=top_up` deep link) must keep showing.
    expect(toastSuccessMock).toHaveBeenCalledWith(
      "Payment received! Your credit balance will update shortly.",
      { id: "billing-status" },
    );
    expect(invalidateSpy).toHaveBeenCalledWith({
      queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
    });
  });
});
