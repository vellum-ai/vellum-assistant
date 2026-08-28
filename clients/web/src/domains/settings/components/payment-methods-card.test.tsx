/**
 * Tests for the PaymentMethodsCard section:
 *  - Renders the payment-method row (brand, last4, Replace card) whenever a
 *    card is on file (including while auto-reload is off) and a muted empty
 *    state otherwise.
 *  - The backend enforces a single payment method, so a saved card offers
 *    Replace card only (no Remove) and the "Add Payment Method" header button
 *    appears only while no card is on file.
 *  - "Add Payment Method" and "Replace card" open the Stripe setup modal
 *    (stubbed here; the modal has its own tests), in replace mode with the
 *    card on file once one exists and in add mode otherwise.
 *  - The mode and card on file are captured when the modal opens, so the
 *    config the save itself writes back into the query cache cannot turn an
 *    in-flight add into a replace or restate the card being replaced.
 *  - While a 3DS redirect return is still resolving, the Add and Replace
 *    actions are disabled, so no modal can be opened ahead of the outcome the
 *    return will replay into one.
 *  - A 3DS redirect return replays its outcome into a freshly opened modal:
 *    a saved card on the success panel alone, a failure back into the form in
 *    the mode the saved card calls for. The failure waits for the config query
 *    to settle, so it cannot be pinned to add mode by a still-pending one.
 *  - The config query is gated on org readiness: before the org store
 *    hydrates the card shows the loading state, never the Add button or the
 *    error notice, so a headerless request can't mislabel the org as having
 *    no saved card.
 *
 * Strategy: pre-populate the React Query cache so `useQuery` resolves
 * synchronously; mock the SDK boundary so any background refetch is
 * deterministic.
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

import { useState } from "react";

import type {
  AutoTopUpPaymentMethodModalProps,
  SetupIntentOutcome,
} from "@/domains/settings/components/auto-top-up-payment-method-modal";
import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

let retrieveResponse: AutoTopUpConfigResponse;
let retrieveShouldFail = false;
// Set by `holdRetrieve()` to keep the config query in flight, so a test can
// observe what the card does before the query has settled.
let retrieveGate: Promise<void> | null = null;
let releaseRetrieve: (() => void) | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpRetrieve: async () => {
    if (retrieveGate != null) {
      await retrieveGate;
    }
    if (retrieveShouldFail) {
      throw new Error("org header missing");
    }
    return { data: retrieveResponse, response: { ok: true } };
  },
}));

function holdRetrieve() {
  retrieveGate = new Promise<void>((resolve) => {
    releaseRetrieve = resolve;
  });
}

function releaseHeldRetrieve() {
  retrieveGate = null;
  releaseRetrieve?.();
  releaseRetrieve = null;
}

// Stub the Stripe setup modal: these tests assert only that it is
// opened/closed and which mode and card on file it is handed.
let pmModalProps: AutoTopUpPaymentMethodModalProps | null = null;
mock.module(
  "@/domains/settings/components/auto-top-up-payment-method-modal",
  () => ({
    AutoTopUpPaymentMethodModal: (props: AutoTopUpPaymentMethodModalProps) => {
      pmModalProps = props;
      return props.open ? <div data-testid="pm-modal-stub" /> : null;
    },
  }),
);

function lastPmModalProps(): AutoTopUpPaymentMethodModalProps {
  if (pmModalProps == null) {
    throw new Error("AutoTopUpPaymentMethodModal was never rendered");
  }
  return pmModalProps;
}

// Stands in for the 3DS redirect-return hook. It owns the outcome in state
// like the real one does, so clearing it on close is what keeps the modal
// shut rather than the absence of a re-render.
let returnedOutcome: SetupIntentOutcome | null = null;
let returnPending = false;
let clearOutcomeCalls = 0;
mock.module("@/domains/settings/hooks/use-setup-intent-return", () => ({
  useSetupIntentReturn: () => {
    const [outcome, setOutcome] = useState(returnedOutcome);
    return {
      outcome,
      pending: returnPending,
      clearOutcome: () => {
        clearOutcomeCalls += 1;
        setOutcome(null);
      },
    };
  },
}));

import * as orgReadyModule from "@/hooks/use-is-org-ready";

// Drives the org-readiness gate. `"ready"` matches the default test
// environment (no platform session); the gating tests flip it to simulate a
// platform session whose org store is still hydrating ("resolving") or
// produced no usable org ("unavailable").
let orgReadiness: orgReadyModule.OrgHeaderReadiness = "ready";
mock.module("@/hooks/use-is-org-ready", () => ({
  ...orgReadyModule,
  useOrgHeaderReadiness: () => orgReadiness,
}));

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

function makeClient(config?: AutoTopUpConfigResponse) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  if (config != null) {
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      config,
    );
  }
  return client;
}

function wrapWith(client: QueryClient) {
  return (
    <QueryClientProvider client={client}>
      <PaymentMethodsCard />
    </QueryClientProvider>
  );
}

function wrap(config?: AutoTopUpConfigResponse) {
  return wrapWith(makeClient(config));
}

/**
 * Waits out the fetch the mounted query starts, so a later `setQueryData` is
 * not clobbered when that response lands.
 */
async function settleConfigQuery(client: QueryClient) {
  await waitFor(() => {
    const state = client.getQueryState(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
    );
    if (state?.fetchStatus !== "idle") {
      throw new Error("config query still fetching");
    }
  });
}

beforeEach(() => {
  retrieveResponse = { ...DISABLED_CONFIG };
  retrieveShouldFail = false;
  retrieveGate = null;
  releaseRetrieve = null;
  orgReadiness = "ready";
  pmModalProps = null;
  returnedOutcome = null;
  returnPending = false;
  clearOutcomeCalls = 0;
});

afterEach(cleanup);

describe("PaymentMethodsCard row and empty state", () => {
  test("renders the saved card row with Replace card as the only action", () => {
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

describe("PaymentMethodsCard org readiness", () => {
  test("shows loading while the org store hydrates, never the Add button or the error notice", () => {
    orgReadiness = "resolving";
    const { container } = render(wrap());

    expect(container.textContent).toContain("Loading…");
    expect(
      container.querySelector('[data-testid="payment-methods-add"]'),
    ).toBeNull();
    expect(container.textContent).not.toContain("Failed to load");
  });

  test("surfaces the error state when org resolution concluded without an org", async () => {
    orgReadiness = "unavailable";
    retrieveShouldFail = true;
    const { container } = render(wrap());

    await waitFor(() => {
      if (!container.textContent?.includes("Failed to load")) {
        throw new Error("error notice not shown");
      }
    });
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

  test("Replace card opens the setup modal", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { container, getByTestId } = render(wrap(DISABLED_WITH_CARD));

    fireEvent.click(getByTestId("payment-method-update"));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).not.toBeNull();
  });

  test("opens in replace mode carrying the card on file", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { getByTestId } = render(wrap(DISABLED_WITH_CARD));

    fireEvent.click(getByTestId("payment-method-update"));

    expect(lastPmModalProps().mode).toBe("replace");
    expect(lastPmModalProps().cardOnFile).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: null,
      expYear: null,
    });
  });

  test("opens in add mode with no card on file while none is saved", () => {
    const { getByTestId } = render(wrap(DISABLED_CONFIG));

    fireEvent.click(getByTestId("payment-methods-add"));

    expect(lastPmModalProps().mode).toBe("add");
    expect(lastPmModalProps().cardOnFile).toBeNull();
  });

  test("stays in add mode when the save writes a card into the cache", async () => {
    const client = makeClient(DISABLED_CONFIG);
    const { container, getByTestId } = render(wrapWith(client));
    await settleConfigQuery(client);

    fireEvent.click(getByTestId("payment-methods-add"));
    expect(lastPmModalProps().mode).toBe("add");

    // Stands in for the write `usePaymentMethodSavedSync` makes while the
    // modal is still submitting.
    retrieveResponse = { ...DISABLED_WITH_CARD };
    client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), {
      ...DISABLED_WITH_CARD,
    });

    // The saved card reaches the section body, so the modal below is holding
    // what it was opened with rather than a stale render.
    await waitFor(() => {
      if (
        container.querySelector('[data-testid="payment-method-row"]') == null
      ) {
        throw new Error("saved card row not rendered");
      }
    });
    expect(lastPmModalProps().open).toBe(true);
    expect(lastPmModalProps().mode).toBe("add");
    expect(lastPmModalProps().cardOnFile).toBeNull();
  });

  test("keeps the card being replaced when the save writes the new one into the cache", async () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const client = makeClient(DISABLED_WITH_CARD);
    const { container, getByTestId } = render(wrapWith(client));
    await settleConfigQuery(client);

    fireEvent.click(getByTestId("payment-method-update"));
    expect(lastPmModalProps().mode).toBe("replace");

    const saved: AutoTopUpConfigResponse = {
      ...DISABLED_WITH_CARD,
      payment_method_brand: "mastercard",
      payment_method_last4: "1881",
    };
    retrieveResponse = { ...saved };
    client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), saved);

    await waitFor(() => {
      const row = container.querySelector('[data-testid="payment-method-row"]');
      if (!row?.textContent?.includes("1881")) {
        throw new Error("new card row not rendered");
      }
    });
    expect(lastPmModalProps().open).toBe(true);
    expect(lastPmModalProps().mode).toBe("replace");
    expect(lastPmModalProps().cardOnFile).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: null,
      expYear: null,
    });
  });
});

describe("PaymentMethodsCard redirect return", () => {
  test("replays a saved outcome into the modal on the success panel alone", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    returnedOutcome = {
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    };
    const { container } = render(wrap(DISABLED_WITH_CARD));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).not.toBeNull();
    expect(lastPmModalProps().initialOutcome).toEqual(returnedOutcome);
    expect(lastPmModalProps().mode).toBe("add");
    expect(lastPmModalProps().cardOnFile).toBeNull();
  });

  test("replays an error outcome into replace mode with the card on file", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    returnedOutcome = { kind: "error", message: "Your card was declined." };
    render(wrap(DISABLED_WITH_CARD));

    expect(lastPmModalProps().open).toBe(true);
    expect(lastPmModalProps().initialOutcome).toEqual(returnedOutcome);
    expect(lastPmModalProps().mode).toBe("replace");
    expect(lastPmModalProps().cardOnFile).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: null,
      expYear: null,
    });
  });

  test("holds a failed outcome until the config query settles", async () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    returnedOutcome = { kind: "error", message: "Your card was declined." };
    holdRetrieve();
    const client = makeClient();
    const { container } = render(wrapWith(client));

    // Snapshotting here would read no cards and pin the modal to add mode.
    expect(container.querySelector('[data-testid="pm-modal-stub"]')).toBeNull();

    releaseHeldRetrieve();
    await settleConfigQuery(client);

    await waitFor(() => {
      if (lastPmModalProps().open !== true) {
        throw new Error("modal not opened after the config query settled");
      }
    });
    expect(lastPmModalProps().initialOutcome).toEqual(returnedOutcome);
    expect(lastPmModalProps().mode).toBe("replace");
    expect(lastPmModalProps().cardOnFile).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: null,
      expYear: null,
    });
  });

  test("disables Add Payment Method while the return is unresolved", () => {
    returnPending = true;
    const { getByTestId } = render(wrap(DISABLED_CONFIG));

    expect(
      (getByTestId("payment-methods-add") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("disables Replace card while the return is unresolved", () => {
    returnPending = true;
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { getByTestId } = render(wrap(DISABLED_WITH_CARD));

    expect(
      (getByTestId("payment-method-update") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("leaves Add Payment Method usable when no return is in flight", () => {
    const { getByTestId } = render(wrap(DISABLED_CONFIG));

    expect(
      (getByTestId("payment-methods-add") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("leaves Replace card usable when no return is in flight", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const { getByTestId } = render(wrap(DISABLED_WITH_CARD));

    expect(
      (getByTestId("payment-method-update") as HTMLButtonElement).disabled,
    ).toBe(false);
  });

  test("closing clears the outcome and leaves the modal shut", () => {
    returnedOutcome = { kind: "saved", card: null };
    const { container } = render(wrap(DISABLED_CONFIG));

    act(() => {
      lastPmModalProps().onClose();
    });

    expect(clearOutcomeCalls).toBe(1);
    expect(lastPmModalProps().open).toBe(false);
    expect(lastPmModalProps().initialOutcome).toBeNull();
    expect(container.querySelector('[data-testid="pm-modal-stub"]')).toBeNull();
  });
});

/**
 * The backend stores at most one payment method and has no list endpoint, so
 * the multi-card shape is only reachable through the pure helper.
 */
describe("paymentMethodCards", () => {
  test("maps a saved card onto a single stably-keyed entry", () => {
    expect(paymentMethodCards(ENABLED_WITH_CARD)).toEqual([
      {
        id: "primary",
        brand: "visa",
        last4: "4242",
        expMonth: null,
        expYear: null,
      },
    ]);
  });

  test("maps no card and a missing config onto an empty list", () => {
    expect(paymentMethodCards(DISABLED_CONFIG)).toEqual([]);
    expect(paymentMethodCards(undefined)).toEqual([]);
  });
});
