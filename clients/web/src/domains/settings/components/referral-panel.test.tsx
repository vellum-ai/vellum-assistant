/**
 * Tests for the ReferralPanel credit-eligibility messaging: when the user is
 * not eligible to earn referral credits (`is_eligible_for_credits === false`),
 * an info notice and invite-focused subtitle render while the stats and copy
 * link stay put. When eligible, the panel is unchanged.
 *
 * Strategy: pre-populate the React Query cache so the panel's `useQuery`
 * resolves synchronously — `renderToStaticMarkup` is single-pass, so a pending
 * query would otherwise report `isLoading` and render the spinner.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import { referralCodesMeRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { MyReferralCodeResponse } from "@/generated/api/types.gen";

import { ReferralPanel } from "./referral-panel";

const NOTICE_COPY = "not currently earning referral credits";

function referralData(
  isEligibleForCredits: boolean,
): MyReferralCodeResponse {
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
    is_eligible_for_credits: isEligibleForCredits,
  };
}

function renderPanel(isEligibleForCredits: boolean): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    referralCodesMeRetrieveQueryKey(),
    referralData(isEligibleForCredits),
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <ReferralPanel />
    </QueryClientProvider>,
  );
}

describe("ReferralPanel credit eligibility", () => {
  test("shows the ineligibility notice and invite-focused subtitle when not eligible", () => {
    const html = renderPanel(false);
    expect(html).toContain(NOTICE_COPY);
    expect(html).toContain("Invite friends to Vellum.");
    // Stats and copy link still render.
    expect(html).toContain("Credits Earned");
    expect(html).toContain("Friends Referred");
    expect(html).toContain("referral-copy-button");
  });

  test("renders no notice and the default subtitle when eligible", () => {
    const html = renderPanel(true);
    expect(html).not.toContain(NOTICE_COPY);
    expect(html).not.toContain("Invite friends to Vellum.");
    expect(html).toContain("Share Vellum with friends");
    expect(html).toContain("Credits Earned");
    expect(html).toContain("referral-copy-button");
  });
});
