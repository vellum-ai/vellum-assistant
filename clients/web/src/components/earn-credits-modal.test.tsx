/**
 * Tests for the Earn Credits modal's referral-credit gating.
 *
 * When the backend reports `is_eligible_for_credits: false`, the modal swaps
 * in invite-focused copy that sets expectations: an invite-focused subtitle, a
 * qualified "You earn credits" step, and an info Notice — while the share link
 * stays visible and copyable. When the user is eligible, none of that gating
 * copy renders and the modal looks exactly as it does today.
 *
 * The modal renders its content into a Radix portal, so we drive it with
 * @testing-library/react (happy-dom is registered via the test preload) and
 * assert on `document.body`. The React Query cache is pre-populated so the
 * modal's `useQuery` resolves without a network round-trip.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";

import { referralCodesMeRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { MyReferralCodeResponse } from "@/generated/api/types.gen";

import { EarnCreditsModal } from "./earn-credits-modal";

const BASE_REFERRAL: MyReferralCodeResponse = {
  code: "ABC123",
  referral_url: "https://vellum.ai/r/ABC123",
  referred_count: 0,
  total_earned_usd: "0.00",
  earning_cap_usd: "100.00",
  total_earned: "0.00",
  earning_cap: "100.00",
  credit_amount: "10.00",
  referrer_credit_amount: "10.00",
  is_eligible_for_credits: true,
};

function renderModal(referral: MyReferralCodeResponse): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(referralCodesMeRetrieveQueryKey(), referral);
  render(
    <QueryClientProvider client={client}>
      <EarnCreditsModal open onClose={() => {}} />
    </QueryClientProvider>,
  );
  return document.body.textContent ?? "";
}

const INELIGIBLE_NOTICE = "You're not currently earning referral credits.";
const INELIGIBLE_SUBTITLE =
  "You'll start earning referral credits once you've purchased credits or upgraded to Pro.";
const GATED_STEP =
  "You earn credits — once you've purchased credits or upgraded to Pro";

afterEach(() => {
  cleanup();
});

describe("EarnCreditsModal referral credit gating", () => {
  test("ineligible: renders the notice and invite-focused subtitle", () => {
    const text = renderModal({
      ...BASE_REFERRAL,
      is_eligible_for_credits: false,
    });
    expect(text).toContain(INELIGIBLE_NOTICE);
    expect(text).toContain(INELIGIBLE_SUBTITLE);
    expect(text).toContain(GATED_STEP);
    // Share link stays visible/copyable regardless of eligibility.
    expect(
      document.querySelector<HTMLInputElement>(
        `input[value="${BASE_REFERRAL.referral_url}"]`,
      ),
    ).not.toBeNull();
  });

  test("eligible: renders neither the notice nor the gating copy", () => {
    const text = renderModal({
      ...BASE_REFERRAL,
      is_eligible_for_credits: true,
    });
    expect(text).not.toContain(INELIGIBLE_NOTICE);
    expect(text).not.toContain(INELIGIBLE_SUBTITLE);
    expect(text).not.toContain(GATED_STEP);
    expect(text).toContain("You earn credits");
    expect(
      document.querySelector<HTMLInputElement>(
        `input[value="${BASE_REFERRAL.referral_url}"]`,
      ),
    ).not.toBeNull();
  });
});
