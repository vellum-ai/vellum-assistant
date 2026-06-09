/**
 * Tests for the billing-address collection in `AutoTopUpPaymentMethodModal`
 * (auto-topup-billing-address plan, PR 1): the saved PaymentMethod must carry
 * `billing_details.address` so the Django webhook can seed `customer.address`
 * for tax.
 *
 * Strategy: mock `@stripe/react-stripe-js` with prop-capturing stand-ins
 * (real Stripe Elements need a live iframe) and mock the generated SDK's
 * SetupIntent create so the modal mounts the form synchronously without
 * network. `STRIPE_PK` is read from `import.meta.env` at module load, so the
 * publishable key is set before the modal module is imported.
 *
 * Coverage:
 *  - a billing-mode AddressElement renders alongside the PaymentElement once
 *    the SetupIntent `client_secret` is loaded, and the PaymentElement's own
 *    address fields are suppressed (no duplicate postal-code input),
 *  - the Save button stays disabled until BOTH elements report `onReady`,
 *  - submitting calls `stripe.confirmSetup` with `elements` and
 *    `redirect: "if_required"` (no manual billing_details plumbing).
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type ElementProps = {
  onReady?: () => void;
  options?: Record<string, unknown>;
};

let paymentElementProps: ElementProps | null = null;
let addressElementProps: ElementProps | null = null;
let confirmSetupCalls: Record<string, unknown>[] = [];

const fakeElements = { __tag: "fake-elements" };
const fakeStripe = {
  confirmSetup: (opts: Record<string, unknown>) => {
    confirmSetupCalls.push(opts);
    return Promise.resolve({});
  },
};

mock.module("@stripe/react-stripe-js", () => ({
  Elements: ({ children }: { children: ReactNode }) => (
    <div data-testid="stripe-elements">{children}</div>
  ),
  PaymentElement: (props: ElementProps) => {
    paymentElementProps = props;
    return <div data-testid="stripe-payment-element" />;
  },
  AddressElement: (props: ElementProps) => {
    addressElementProps = props;
    return <div data-testid="stripe-address-element" />;
  },
  useStripe: () => fakeStripe,
  useElements: () => fakeElements,
}));

// Keep `loadStripe` from injecting Stripe.js script tags into happy-dom.
mock.module("@stripe/stripe-js", () => ({
  loadStripe: () => Promise.resolve(null),
}));

import * as sdkGen from "@/generated/api/sdk.gen";

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpSetupIntentCreate: () =>
    Promise.resolve({
      data: { client_secret: "seti_123_secret_456" },
      response: { ok: true },
    }),
}));

// The modal reads VITE_STRIPE_PUBLISHABLE_KEY into module-scope `STRIPE_PK`
// at evaluation time (import.meta.env is process.env under Bun); without it
// the modal renders only the missing-key notice. Static imports are hoisted
// ahead of this assignment, so the component must be imported dynamically
// after the env var is set.
process.env.VITE_STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
const { AutoTopUpPaymentMethodModal } = await import(
  "./auto-top-up-payment-method-modal"
);

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function renderModal(): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <AutoTopUpPaymentMethodModal
        open
        onClose={() => {}}
        onSavedOptimistic={() => {}}
      />
    </QueryClientProvider>,
  );
}

/** Wait for the SetupIntent mutation to resolve and the card form to mount. */
async function renderModalWithForm(): Promise<ReturnType<typeof render>> {
  const result = renderModal();
  await result.findByTestId("stripe-address-element");
  return result;
}

function saveButton(): HTMLButtonElement {
  const button = document.querySelector<HTMLButtonElement>(
    '[data-testid="auto-top-up-pm-save-button"]',
  );
  if (!button) throw new Error("expected the Save button to be rendered");
  return button;
}

function fireOnReady(props: ElementProps | null): void {
  if (!props?.onReady) throw new Error("expected an onReady handler");
  act(() => props.onReady!());
}

beforeEach(() => {
  paymentElementProps = null;
  addressElementProps = null;
  confirmSetupCalls = [];
});

afterEach(cleanup);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AutoTopUpPaymentMethodModal billing address", () => {
  test("renders a billing-mode AddressElement alongside the PaymentElement once the client_secret loads", async () => {
    await renderModalWithForm();

    expect(
      document.querySelector('[data-testid="stripe-payment-element"]'),
    ).not.toBeNull();
    expect(
      document.querySelector('[data-testid="stripe-address-element"]'),
    ).not.toBeNull();

    // The Address Element collects the billing address...
    expect(addressElementProps?.options?.mode).toBe("billing");
    // ...and the Payment Element's own address fields are suppressed, so the
    // user never sees two postal-code inputs.
    expect(paymentElementProps?.options?.fields).toEqual({
      billingDetails: { address: "never" },
    });
  });

  test("keeps Save disabled until BOTH the PaymentElement and AddressElement report ready", async () => {
    await renderModalWithForm();

    // Neither element ready: disabled.
    expect(saveButton().disabled).toBe(true);

    // Payment Element ready alone is not enough.
    fireOnReady(paymentElementProps);
    expect(saveButton().disabled).toBe(true);

    // Address Element ready too: enabled.
    fireOnReady(addressElementProps);
    expect(saveButton().disabled).toBe(false);
  });

  test("submitting calls stripe.confirmSetup with elements and redirect: 'if_required'", async () => {
    await renderModalWithForm();
    fireOnReady(paymentElementProps);
    fireOnReady(addressElementProps);

    fireEvent.submit(saveButton().closest("form")!);

    await waitFor(() => {
      if (confirmSetupCalls.length === 0) {
        throw new Error("confirmSetup not called");
      }
    });
    expect(confirmSetupCalls).toHaveLength(1);
    const call = confirmSetupCalls[0]!;
    // The Address Element's value flows through `elements` automatically —
    // there must be no manual payment_method_data.billing_details plumbing.
    expect(call.elements).toBe(fakeElements);
    expect(call.redirect).toBe("if_required");
    expect(
      (call.confirmParams as Record<string, unknown>).return_url,
    ).toBeDefined();
    expect(
      (call.confirmParams as Record<string, unknown>).payment_method_data,
    ).toBeUndefined();
  });
});
