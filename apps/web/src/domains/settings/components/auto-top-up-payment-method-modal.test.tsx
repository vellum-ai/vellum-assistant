/**
 * Tests for the billing-address collection in `AutoTopUpPaymentMethodModal`
 * (auto-topup-billing-address plan, PR 1).
 *
 * Strategy: mock `@stripe/react-stripe-js` with prop-capturing stand-ins
 * (real Stripe Elements need a live iframe) and mock the generated SDK's
 * SetupIntent create so the modal mounts the form synchronously without
 * network.
 */

import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type ElementProps = {
  onReady?: () => void;
  onLoadError?: () => void;
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
  Elements: ({ children }: { children: ReactNode }) => children,
  PaymentElement: (props: ElementProps) => {
    paymentElementProps = props;
    return <div />;
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
const originalStripePk = process.env.VITE_STRIPE_PUBLISHABLE_KEY;
process.env.VITE_STRIPE_PUBLISHABLE_KEY = "pk_test_fake";
const { AutoTopUpPaymentMethodModal } = await import(
  "./auto-top-up-payment-method-modal"
);

// `bun test` runs all test files in one process, so restore the env var to
// avoid leaking it into other test files.
afterAll(() => {
  if (originalStripePk === undefined) {
    delete process.env.VITE_STRIPE_PUBLISHABLE_KEY;
  } else {
    process.env.VITE_STRIPE_PUBLISHABLE_KEY = originalStripePk;
  }
});

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

/** Wait for the SetupIntent mutation to resolve and the card form to mount. */
async function renderModalWithForm(): Promise<ReturnType<typeof render>> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  });
  const result = render(
    <QueryClientProvider client={client}>
      <AutoTopUpPaymentMethodModal
        open
        onClose={() => {}}
        onSavedOptimistic={() => {}}
      />
    </QueryClientProvider>,
  );
  await result.findByTestId("stripe-address-element");
  return result;
}

function fireOnReady(props: ElementProps | null): void {
  if (!props?.onReady) throw new Error("expected an onReady handler");
  act(() => props.onReady!());
}

function fireOnLoadError(props: ElementProps | null): void {
  if (!props?.onLoadError) throw new Error("expected an onLoadError handler");
  act(() => props.onLoadError!());
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

    expect(addressElementProps?.options?.mode).toBe("billing");
    expect(paymentElementProps?.options?.fields).toEqual({
      billingDetails: { name: "never", address: "never" },
    });
  });

  test("keeps Save disabled until BOTH the PaymentElement and AddressElement report ready", async () => {
    const { getByTestId } = await renderModalWithForm();
    const saveButton = getByTestId(
      "auto-top-up-pm-save-button",
    ) as HTMLButtonElement;

    expect(saveButton.disabled).toBe(true);

    fireOnReady(paymentElementProps);
    expect(saveButton.disabled).toBe(true);

    fireOnReady(addressElementProps);
    expect(saveButton.disabled).toBe(false);
  });

  test("surfaces an error when an element fails to load", async () => {
    const { getByTestId } = await renderModalWithForm();

    fireOnLoadError(paymentElementProps);
    expect(
      getByTestId("auto-top-up-pm-modal-confirm-error").textContent,
    ).toContain("Failed to load the payment form");

    fireOnLoadError(addressElementProps);
    expect(
      getByTestId("auto-top-up-pm-modal-confirm-error").textContent,
    ).toContain("Failed to load the billing address form");
  });

  test("submitting calls stripe.confirmSetup with elements and redirect: 'if_required'", async () => {
    const { getByTestId } = await renderModalWithForm();
    fireOnReady(paymentElementProps);
    fireOnReady(addressElementProps);

    fireEvent.submit(getByTestId("auto-top-up-pm-save-button").closest("form")!);

    await waitFor(() => {
      if (confirmSetupCalls.length === 0) {
        throw new Error("confirmSetup not called");
      }
    });
    expect(confirmSetupCalls).toHaveLength(1);
    const call = confirmSetupCalls[0]!;
    // Address value flows via `elements`; no manual billing_details plumbing.
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
