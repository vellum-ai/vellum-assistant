/**
 * Tests for the PaymentMethodsCard section:
 *  - Renders the payment-method row (brand, last4, Update Card) whenever a
 *    card is on file (including while auto-reload is off) and a muted empty
 *    state otherwise.
 *  - The backend enforces a single payment method, so a saved card offers
 *    Update Card only (no Remove) and the "Add Payment Method" header button
 *    appears only while no card is on file.
 *  - "Add Payment Method" and "Update Card" open the Stripe setup modal
 *    (stubbed here; the modal has its own tests).
 *
 * Strategy: pre-populate the React Query cache so `useQuery` resolves
 * synchronously; mock the SDK boundary so any background refetch is
 * deterministic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render } from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

let retrieveResponse: AutoTopUpConfigResponse;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpRetrieve: () =>
    Promise.resolve({ data: retrieveResponse, response: { ok: true } }),
}));

// Stub the Stripe setup modal: these tests only assert it is opened/closed.
mock.module(
  "@/domains/settings/components/auto-top-up-payment-method-modal",
  () => ({
    AutoTopUpPaymentMethodModal: ({ open }: { open: boolean }) =>
      open ? <div data-testid="pm-modal-stub" /> : null,
  }),
);

import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

const { PaymentMethodsCard, paymentMethodCards } =
  await import("./payment-methods-card");
const { DISABLED_CONFIG } = await import("./auto-top-up-card");

const ENABLED_WITH_CARD: AutoTopUpConfigResponse = {
  ...DISABLED_CONFIG,
  enabled: true,
  threshold_usd: "50.00",
  amount_usd: "200.00",
  has_payment_method: true,
  payment_method_brand: "visa",
  payment_method_last4: "4242",
};

const DISABLED_WITH_CARD: AutoTopUpConfigResponse = {
  ...DISABLED_CONFIG,
  enabled: false,
  has_payment_method: true,
  payment_method_brand: "visa",
  payment_method_last4: "4242",
};

function wrap(config: AutoTopUpConfigResponse) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), config);
  return (
    <QueryClientProvider client={client}>
      <PaymentMethodsCard />
    </QueryClientProvider>
  );
}

beforeEach(() => {
  retrieveResponse = { ...DISABLED_CONFIG };
});

afterEach(cleanup);

describe("PaymentMethodsCard row and empty state", () => {
  test("renders the saved card row with Update Card as the only action", () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container } = render(wrap(ENABLED_WITH_CARD));

    const row = container.querySelector('[data-testid="payment-method-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Visa");
    expect(row?.textContent).toContain("Ending in 4242");
    expect(
      container.querySelector('[data-testid="payment-method-update"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="payment-method-remove"]'),
    ).toBeNull();
  });

  test("keeps the card row reachable while auto-reload is off", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { container } = render(wrap(DISABLED_WITH_CARD));

    expect(
      container.querySelector('[data-testid="payment-method-row"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="payment-methods-empty"]'),
    ).toBeNull();
  });

  test("renders the muted empty state when no card is on file", () => {
    const { container, getByTestId } = render(wrap(DISABLED_CONFIG));

    expect(getByTestId("payment-methods-empty").textContent).toContain(
      "No payment method on file",
    );
    expect(
      container.querySelector('[data-testid="payment-method-row"]'),
    ).toBeNull();
  });
});

describe("PaymentMethodsCard add button", () => {
  test("shows Add Payment Method while no card is on file", () => {
    const { container } = render(wrap(DISABLED_CONFIG));

    expect(
      container.querySelector('[data-testid="payment-methods-add"]'),
    ).not.toBeNull();
  });

  test("hides Add Payment Method once a card is on file", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { container } = render(wrap(DISABLED_WITH_CARD));

    expect(
      container.querySelector('[data-testid="payment-methods-add"]'),
    ).toBeNull();
  });
});

describe("PaymentMethodsCard modal wiring", () => {
  test("Add Payment Method opens the setup modal", () => {
    const { container, getByTestId } = render(wrap(DISABLED_CONFIG));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).toBeNull();

    fireEvent.click(getByTestId("payment-methods-add"));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).not.toBeNull();
  });

  test("Update Card opens the setup modal", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { container, getByTestId } = render(wrap(DISABLED_WITH_CARD));

    fireEvent.click(getByTestId("payment-method-update"));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).not.toBeNull();
  });
});

/**
 * The backend stores at most one payment method and has no list endpoint, so
 * the multi-card shape is only reachable through the pure helper.
 */
describe("paymentMethodCards", () => {
  test("maps a saved card onto a single stably-keyed entry", () => {
    expect(paymentMethodCards(ENABLED_WITH_CARD)).toEqual([
      { id: "primary", brand: "visa", last4: "4242" },
    ]);
  });

  test("maps no card and a missing config onto an empty list", () => {
    expect(paymentMethodCards(DISABLED_CONFIG)).toEqual([]);
    expect(paymentMethodCards(undefined)).toEqual([]);
  });
});
