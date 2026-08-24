/**
 * Tests for the PaymentMethodsCard section:
 *  - Renders the payment-method row (brand, last4, Update/Remove) whenever a
 *    card is on file (including while auto-reload is off) and a muted empty
 *    state otherwise.
 *  - "Add Payment Method" and "Update Card" open the Stripe setup modal
 *    (stubbed here; the modal has its own tests).
 *  - Removing the saved card opens a destructive confirm warning it turns off
 *    auto-reload; confirming calls the remove endpoint and drives the config
 *    to disabled / no card. A failed removal closes the dialog and surfaces
 *    the error notice.
 *
 * Strategy: pre-populate the React Query cache so `useQuery` resolves
 * synchronously; mock the SDK boundary so the remove mutation and the
 * follow-up GET are deterministic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

let removeCalls: Array<Record<string, unknown>> = [];
let removeShouldFail = false;
let retrieveResponse: AutoTopUpConfigResponse;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpRemovePaymentMethodCreate: (
    opts: Record<string, unknown>,
  ) => {
    removeCalls.push(opts);
    if (removeShouldFail) {
      return Promise.reject(new Error("remove failed"));
    }
    // The endpoint clears the PM and disables auto-reload server-side, so the
    // next GET reflects that.
    retrieveResponse = {
      ...retrieveResponse,
      enabled: false,
      has_payment_method: false,
      payment_method_brand: null,
      payment_method_last4: null,
    };
    return Promise.resolve({
      data: {
        enabled: false,
        stubbed: false,
        message: "Payment method removed",
      },
      response: { ok: true },
    });
  },
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

const { PaymentMethodsCard, paymentMethodCards, showsRemove } =
  await import("./payment-methods-card");
const { DISABLED_CONFIG } = await import("./auto-top-up-card");
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

/** Drives the `obscure-credits` client flag the way the app's LD sync does. */
function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
}

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

async function openRemoveConfirm(container: HTMLElement) {
  fireEvent.click(
    container.querySelector('[data-testid="payment-method-remove"]')!,
  );
  return waitFor(() => {
    const btn = document.querySelector<HTMLButtonElement>(
      "[data-confirm-dialog-confirm]",
    );
    if (!btn) {
      throw new Error("confirm dialog not open");
    }
    return btn;
  });
}

beforeEach(() => {
  removeCalls = [];
  removeShouldFail = false;
  retrieveResponse = { ...DISABLED_CONFIG };
});

afterEach(cleanup);

describe("PaymentMethodsCard row and empty state", () => {
  test("renders the saved card row with Update/Remove", () => {
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
    ).not.toBeNull();
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

describe("PaymentMethodsCard remove card", () => {
  test("confirming Remove calls the endpoint and clears the card", async () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container } = render(wrap(ENABLED_WITH_CARD));

    expect(
      container.querySelector('[data-testid="payment-method-row"]'),
    ).not.toBeNull();

    // Remove opens a destructive confirm that warns it turns off auto-reload.
    const confirmButton = await openRemoveConfirm(container);
    expect(document.body.textContent).toContain("Remove payment method?");
    expect(document.body.textContent).toContain("turn off auto-reload");
    expect(removeCalls.length).toBe(0);

    fireEvent.click(confirmButton);

    await waitFor(() => {
      if (removeCalls.length === 0) {
        throw new Error("remove endpoint not called");
      }
    });

    // The section drops to the empty state; no error notice.
    await waitFor(() => {
      if (container.querySelector('[data-testid="payment-method-row"]')) {
        throw new Error("payment-method row still present");
      }
      if (
        !container.querySelector('[data-testid="payment-methods-empty"]')
      ) {
        throw new Error("empty state not shown");
      }
    });
    expect(
      container.querySelector('[data-testid="auto-top-up-remove-error"]'),
    ).toBeNull();
  });

  test("a failed removal closes the confirm dialog and surfaces the error notice", async () => {
    removeShouldFail = true;
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container } = render(wrap(ENABLED_WITH_CARD));

    const confirmButton = await openRemoveConfirm(container);
    fireEvent.click(confirmButton);

    await waitFor(() => {
      if (removeCalls.length === 0) {
        throw new Error("remove endpoint not called");
      }
    });

    // On failure the dialog closes (so the notice isn't hidden behind the
    // overlay) and the card row stays put for a retry.
    await waitFor(() => {
      if (document.querySelector("[data-confirm-dialog-confirm]")) {
        throw new Error("confirm dialog still open");
      }
      if (
        !container.querySelector('[data-testid="auto-top-up-remove-error"]')
      ) {
        throw new Error("remove error notice not shown");
      }
    });
    expect(
      container.querySelector('[data-testid="payment-method-row"]'),
    ).not.toBeNull();
  });
});

describe("PaymentMethodsCard with obscure-credits on", () => {
  beforeEach(() => {
    setObscureCredits(true);
  });

  afterEach(() => {
    setObscureCredits(false);
  });

  test("the only card keeps Update but drops Remove", () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container } = render(wrap(ENABLED_WITH_CARD));

    const row = container.querySelector('[data-testid="payment-method-row"]');
    expect(row).not.toBeNull();
    expect(row?.textContent).toContain("Ending in 4242");
    expect(
      container.querySelector('[data-testid="payment-method-update"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="payment-method-remove"]'),
    ).toBeNull();
  });

  test("Update Card still opens the setup modal", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { container, getByTestId } = render(wrap(DISABLED_WITH_CARD));

    fireEvent.click(getByTestId("payment-method-update"));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).not.toBeNull();
  });

  test("the empty state is unchanged", () => {
    const { container, getByTestId } = render(wrap(DISABLED_CONFIG));

    expect(getByTestId("payment-methods-empty")).not.toBeNull();
    expect(
      container.querySelector('[data-testid="payment-method-row"]'),
    ).toBeNull();
  });
});

describe("PaymentMethodsCard with the flag off", () => {
  test("the only card still offers Remove", () => {
    setObscureCredits(false);
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container } = render(wrap(ENABLED_WITH_CARD));

    expect(
      container.querySelector('[data-testid="payment-method-remove"]'),
    ).not.toBeNull();
  });
});

/**
 * The backend stores at most one payment method and has no list endpoint, so
 * the multi-card rule is only reachable through the pure helper.
 */
describe("paymentMethodCards / showsRemove", () => {
  test("maps a saved card onto a single stably-keyed entry", () => {
    expect(paymentMethodCards(ENABLED_WITH_CARD)).toEqual([
      { id: "primary", brand: "visa", last4: "4242" },
    ]);
  });

  test("maps no card and a missing config onto an empty list", () => {
    expect(paymentMethodCards(DISABLED_CONFIG)).toEqual([]);
    expect(paymentMethodCards(undefined)).toEqual([]);
  });

  test("hides Remove only for a lone card under the flag", () => {
    expect(showsRemove(1, true)).toBe(false);
    expect(showsRemove(2, true)).toBe(true);
    expect(showsRemove(1, false)).toBe(true);
    expect(showsRemove(2, false)).toBe(true);
  });
});
