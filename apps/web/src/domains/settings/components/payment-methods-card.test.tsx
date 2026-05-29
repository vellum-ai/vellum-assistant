/**
 * Render gate test for the saved-card row's **Remove** button.
 *
 * The button visibility is driven by `config.can_delete_payment_method` on
 * the AutoTopUpConfig response — a server-authored boolean that's `false`
 * for Pro accounts and `true` for Base. The UI rule has a single source of
 * truth on the backend; this test pins the client-side gate so a refactor
 * can't silently re-derive the rule locally (e.g. via `plan_id === "pro"`)
 * or drop the conditional render altogether.
 *
 * Strategy mirrors `ai-page.test.tsx`: pre-populate the React Query cache
 * via the generated query-key helper so `renderToStaticMarkup` (single-pass,
 * never resolves a pending queryFn) renders the loaded state directly. No
 * happy-dom interaction, no mutation firing — pure render assertion.
 */

import { describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";
import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

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

const { PaymentMethodsCard } = await import(
  "@/domains/settings/components/payment-methods-card"
);

function makeConfig(
  overrides: Partial<AutoTopUpConfigResponse> = {},
): AutoTopUpConfigResponse {
  return {
    enabled: false,
    threshold_usd: null,
    amount_usd: null,
    monthly_cap_usd: null,
    has_payment_method: true,
    can_delete_payment_method: true,
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

function renderCard(config: AutoTopUpConfigResponse): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingAutoTopUpRetrieveQueryKey(),
    config,
  );
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PaymentMethodsCard />
    </QueryClientProvider>,
  );
}

describe("PaymentMethodsCard Remove-button gate", () => {
  test("renders Remove when can_delete_payment_method is true (Base account)", () => {
    const html = renderCard(makeConfig({ can_delete_payment_method: true }));
    // The Change button is always present on the saved-card row — pin it
    // so a regression that nukes the entire button group is also caught.
    expect(html).toContain("Change");
    expect(html).toContain("Remove");
  });

  test("hides Remove when can_delete_payment_method is false (Pro account)", () => {
    const html = renderCard(makeConfig({ can_delete_payment_method: false }));
    // Change must stay — it's the path forward for Pro users (add a new
    // card, which the unified-PM webhook flow promotes to the
    // subscription's default_payment_method, replacing the previous one).
    expect(html).toContain("Change");
    expect(html).not.toContain("Remove");
  });

  test("does not render any PM action buttons when no card is on file", () => {
    // No saved PM → the Add Card CTA renders instead of the saved-card row.
    // can_delete_payment_method defaults to true here from the backend
    // (no PM to gate against) but is unused in this branch.
    const html = renderCard(
      makeConfig({
        has_payment_method: false,
        payment_method_brand: null,
        payment_method_last4: null,
        can_delete_payment_method: true,
      }),
    );
    expect(html).toContain("Add Card");
    expect(html).not.toContain("Change");
    expect(html).not.toContain("Remove");
  });
});
