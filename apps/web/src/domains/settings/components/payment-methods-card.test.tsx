/**
 * Render gate test for the saved-card row's **Remove** button.
 *
 * The button visibility is driven by `subscription.plan_id` — hidden for
 * Pro accounts, shown for everyone else. This is the local-derivation
 * version of the rule (Carson review on platform PR #7781 dropped the
 * server-authored `can_delete_payment_method` flag as redundant: "if the
 * rule reduces to plan_id == PRO the field is redundant").
 *
 * The test pins the gate at the render level so a future refactor can't
 * silently drop the conditional and let the button leak back in for Pro
 * users.
 *
 * Strategy mirrors `ai-page.test.tsx`: pre-populate the React Query cache
 * via the generated query-key helpers so `renderToStaticMarkup` (single-
 * pass, never resolves a pending queryFn) renders the loaded state
 * directly. No happy-dom interaction, no mutation firing — pure render
 * assertion.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type {
  AutoTopUpConfigResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import {
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

// Mirror the toast stub from ai-page.test.tsx — the component's onError
// path imports the toast module via the design-library barrel, which can
// pull a real surface during static render and break the test.
mock.module("@vellum/design-library/components/toast", () => ({
  toast: { success: () => {}, error: () => {} },
  Toaster: () => null,
  ToastContent: () => null,
}));

// AutoTopUpPaymentMethodModal opens its own pricing/SetupIntent flow and
// pulls in extra hooks we don't want to bootstrap for a static render.
// It's closed in our render path (pmModalOpen=false initial state), so
// stubbing the import is safe and keeps the test focused on the gate.
mock.module(
  "@/domains/settings/components/auto-top-up-payment-method-modal",
  () => ({
    AutoTopUpPaymentMethodModal: () => null,
  }),
);

const { PaymentMethodsCard } =
  await import("@/domains/settings/components/payment-methods-card");

function makeConfig(
  overrides: Partial<AutoTopUpConfigResponse> = {},
): AutoTopUpConfigResponse {
  return {
    enabled: false,
    threshold_usd: null,
    amount_usd: null,
    monthly_cap_usd: null,
    has_payment_method: true,
    payment_method_brand: "visa",
    payment_method_last4: "4242",
    stripe_payment_method_updated_at: null,
    last_charge_at: null,
    last_failure_at: null,
    last_failure_reason: null,
    paused_until: null,
    current_month_credits_purchased_usd: "0.00",
    current_month_charged_usd: "0.00",
    next_trigger_amount_usd: null,
    stubbed: false,
    ...overrides,
  };
}

function makeSubscription(
  planId: SubscriptionResponse["plan_id"] = "base",
): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

function renderCard(
  config: AutoTopUpConfigResponse,
  subscription: SubscriptionResponse,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), config);
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PaymentMethodsCard />
    </QueryClientProvider>,
  );
}

describe("PaymentMethodsCard Remove-button gate", () => {
  test("renders Remove when account is not Pro (Base)", () => {
    const html = renderCard(makeConfig(), makeSubscription("base"));
    // The Change button is always present on the saved-card row — pin it
    // so a regression that nukes the entire button group is also caught.
    expect(html).toContain("Change");
    expect(html).toContain("Remove");
  });

  test("hides Remove when account is Pro", () => {
    const html = renderCard(makeConfig(), makeSubscription("pro"));
    // Change must stay — it's the path forward for Pro users (add a new
    // card, which the unified-PM webhook flow promotes to the
    // subscription's default_payment_method, replacing the previous one).
    expect(html).toContain("Change");
    expect(html).not.toContain("Remove");
  });

  test("does not render any PM action buttons when no card is on file", () => {
    // No saved PM → the Add Card CTA renders instead of the saved-card row.
    const html = renderCard(
      makeConfig({
        has_payment_method: false,
        payment_method_brand: null,
        payment_method_last4: null,
      }),
      makeSubscription("base"),
    );
    expect(html).toContain("Add Card");
    expect(html).not.toContain("Change");
    expect(html).not.toContain("Remove");
  });
});
