/**
 * ReferralModal wraps ReferralContent in a dialog opened from the Credit
 * Balance header. The referral query cache is seeded so the content resolves
 * synchronously; the GET SDK function is stubbed with a never-resolving promise
 * so the background refetch stays inert.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { MyReferralCodeResponse } from "@/generated/api/types.gen";

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  referralCodesMeRetrieve: () => new Promise(() => {}),
}));

const { referralCodesMeRetrieveQueryKey } = await import(
  "@/generated/api/@tanstack/react-query.gen"
);
const { ReferralModal } = await import("./referral-modal");

function referralData(): MyReferralCodeResponse {
  return {
    code: "ABC123",
    referral_url: "https://vellum.ai/r/ABC123",
    referred_count: 2,
    total_earned_usd: "10.00",
    earning_cap_usd: "50.00",
    total_earned: "10.00",
    earning_cap: "50.00",
    credit_amount: "5.00",
    referrer_credit_amount: "5.00",
    is_eligible_for_credits: true,
  };
}

function renderModal(props: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(referralCodesMeRetrieveQueryKey(), referralData());
  return render(
    <QueryClientProvider client={client}>
      <ReferralModal open={props.open} onOpenChange={props.onOpenChange} />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("ReferralModal", () => {
  test("renders the referral content when open", () => {
    const { getByTestId } = renderModal({
      open: true,
      onOpenChange: () => {},
    });
    expect(getByTestId("referral-modal")).toBeDefined();
    expect(getByTestId("referral-copy-button")).toBeDefined();
  });

  test("renders nothing when closed", () => {
    const { queryByTestId } = renderModal({
      open: false,
      onOpenChange: () => {},
    });
    expect(queryByTestId("referral-modal")).toBeNull();
  });

  test("calls onOpenChange(false) when the close button is clicked", () => {
    const onOpenChange = mock(() => {});
    const { getByLabelText } = renderModal({ open: true, onOpenChange });
    fireEvent.click(getByLabelText("Close"));
    expect(onOpenChange).toHaveBeenCalledWith(false);
  });
});
