/**
 * Gate tests for `EmailServiceCard`'s managed-email subscription gate.
 *
 * The gate keys off the `managed_email` entitlement, NOT `plan_id`, so an
 * admin `EntitlementOverride` that grants managed email to a Base org is
 * honored in-product. We verify both directions:
 *
 *  - Base org WITHOUT the entitlement → "Upgrade to Pro" notice, form gated.
 *  - Base org WITH the entitlement (override) → domain/address form renders,
 *    proving the gate reads the entitlement and not the plan.
 *
 * Strategy mirrors `plugins-tab.test.tsx`: pre-populate the React Query cache
 * via the generated query-key helper so `renderToStaticMarkup` (single-pass,
 * never resolves a pending queryFn) renders the loaded state directly.
 */

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { describe, expect, mock, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import {
    assistantsListQueryKey,
    organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

// The settings-card barrel re-exports toast surfaces; stub them so barrel
// resolution doesn't pull the real toast module during the static render.
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

// These tests exercise the subscription entitlement gate, not the platform
// gate. Mock usePlatformGate to always return "full" so the managed email
// form renders and the entitlement logic is reachable.
mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => "full",
}));

const ASSISTANT_ID = "asst-1";

// Seed the selection store so useActiveAssistantId() (called by
// EmailServiceCard) finds a non-null id without a route-level gate.
mock.module("@/assistant/use-active-assistant-id", () => ({
  useActiveAssistantId: () => ASSISTANT_ID,
}));

const { EmailServiceCard } = await import("@/domains/settings/ai/email-service-card");

const ASSISTANT_HANDLE = "my-assistant";

function makeSubscription(
  managedEmail: boolean,
  planId: SubscriptionResponse["plan_id"] = "base",
): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: managedEmail, phone_number: false },
  };
}

function renderCard(subscription: SubscriptionResponse): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    assistantsListQueryKey(),
    { results: [{ id: ASSISTANT_ID, handle: ASSISTANT_HANDLE }] },
  );
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <EmailServiceCard />
      </MemoryRouter>
    </QueryClientProvider>,
  );
}

describe("EmailServiceCard managed-email gate", () => {
  test("Base org without the managed_email entitlement sees the upgrade notice", () => {
    const html = renderCard(makeSubscription(false, "base"));
    expect(html).toContain("Upgrade to Pro");
    expect(html).toContain("Get a dedicated email address for your assistant");
    // The domain registration form must NOT render when gated.
    expect(html).not.toContain("Register");
  });

  test("Base org WITH the managed_email entitlement sees the form, not the notice", () => {
    // plan_id stays "base" — only the entitlement (admin override) is true.
    const html = renderCard(makeSubscription(true, "base"));
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Get a dedicated email address for your assistant");
    // The domain registration form renders for entitled orgs.
    expect(html).toContain("Subdomain");
    expect(html).toContain("Register");
  });

  test("Successful payload WITHOUT entitlements is treated as unknown and fails open", () => {
    // Simulates an older platform deploy / partial response: a successful
    // subscription payload that omits `entitlements` entirely. This must be
    // treated as unknown (fail-open), NOT as explicit denial, so otherwise
    // eligible users (e.g. Pro) aren't locked out of their managed email.
    const subscriptionWithoutEntitlements = {
      plan_id: "pro",
      status: "active",
      renewal_date: null,
      current_period_end: null,
      cancel_at_period_end: false,
      cancel_at: null,
    } as unknown as SubscriptionResponse;
    const html = renderCard(subscriptionWithoutEntitlements);
    expect(html).not.toContain("Upgrade to Pro");
    expect(html).not.toContain("Get a dedicated email address for your assistant");
    // The domain registration form renders (fail-open).
    expect(html).toContain("Subdomain");
    expect(html).toContain("Register");
  });
});
