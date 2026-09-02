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
 *    return will replay into one. That state is read from
 *    `useSetupIntentReturnStore`, which the resolution driven from
 *    `BillingPage` writes, so this card can be unmounted and remounted by a
 *    tab switch without losing it.
 *  - A saved 3DS return also invalidates the config query through this card's
 *    own QueryClient, because the resolution's writes went to the client it
 *    captured when it started, which a request-scope change can discard. A
 *    saved outcome carrying no card is left alone: the cache then holds only
 *    the saved-poll's optimistic flip, which a refetch would wipe.
 *  - The store outlives that remount, so an outcome stamped with a different
 *    request scope is dropped rather than replayed or acted on here.
 *  - A 3DS redirect return replays its outcome into a freshly opened modal:
 *    a saved card on the success panel alone, a failure back into the form in
 *    the mode the saved card calls for. The failure waits for the config query
 *    to settle, so it cannot be pinned to add mode by a still-pending one.
 *  - The card expiry and the saved billing address come from the platform
 *    config: the row and the modal's replace subtitle show the expiry, the
 *    modal is seeded with the address, and a platform deployment that omits
 *    the keys renders with nulls instead.
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

import type {
  AutoTopUpPaymentMethodModalProps,
  SetupIntentOutcome,
} from "@/domains/settings/components/auto-top-up-payment-method-modal";
import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  AutoTopUpConfigResponse,
  BillingAddress,
} from "@/generated/api/types.gen";

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
import { currentRequestScopeKey } from "@/stores/request-scope";

const { PaymentMethodsCard } = await import("./payment-methods-card");
const { useSetupIntentReturnStore } =
  await import("@/domains/settings/setup-intent-return-store");
const { DISABLED_CONFIG } = await import("./auto-top-up-card");

/**
 * Park an outcome in the redirect-return store the way the resolution driven
 * from `BillingPage` does, and hand it back for the assertions. The scope
 * defaults to the one the card is rendering under, which is what a return
 * resolved in this tab carries.
 */
function seedReturnOutcome(
  outcome: SetupIntentOutcome,
  scopeKey: string = currentRequestScopeKey(),
): SetupIntentOutcome {
  useSetupIntentReturnStore.setState({ pending: false, outcome, scopeKey });
  return outcome;
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

const BILLING_ADDRESS: BillingAddress = {
  line1: "100 Example Ave",
  line2: null,
  city: "Springfield",
  state: "CA",
  postal_code: "94000",
  country: "US",
};

const WITH_EXPIRY_AND_ADDRESS: AutoTopUpConfigResponse = {
  ...DISABLED_WITH_CARD,
  payment_method_exp_month: 4,
  payment_method_exp_year: 2042,
  billing_address: BILLING_ADDRESS,
};

/** A platform deployment older than the fields omits the keys entirely. */
function withoutPlatformExpiryAndAddress(
  config: AutoTopUpConfigResponse,
): AutoTopUpConfigResponse {
  const legacy: Record<string, unknown> = { ...config };
  delete legacy.payment_method_exp_month;
  delete legacy.payment_method_exp_year;
  delete legacy.billing_address;
  return legacy as AutoTopUpConfigResponse;
}

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

/** Records what the card invalidates, leaving the real behaviour in place. */
function trackInvalidations(client: QueryClient) {
  const invalidated: Array<Parameters<QueryClient["invalidateQueries"]>[0]> =
    [];
  const invalidateQueries = client.invalidateQueries.bind(client);
  client.invalidateQueries = (filters) => {
    invalidated.push(filters);
    return invalidateQueries(filters);
  };
  return invalidated;
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
  useSetupIntentReturnStore.setState({
    pending: false,
    outcome: null,
    scopeKey: null,
  });
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
    const returnedOutcome = seedReturnOutcome({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
    const { container } = render(wrap(DISABLED_WITH_CARD));

    expect(
      container.querySelector('[data-testid="pm-modal-stub"]'),
    ).not.toBeNull();
    expect(lastPmModalProps().initialOutcome).toEqual(returnedOutcome);
    expect(lastPmModalProps().mode).toBe("add");
    expect(lastPmModalProps().cardOnFile).toBeNull();
  });

  test("invalidates the config query through this card's own client", async () => {
    // The resolution confirms the card through the QueryClient it captured
    // when it started, and a request-scope change (the platform-session probe
    // swapping the user id) remounts that client: without this the section can
    // keep showing the empty state until an unrelated GET lands.
    const client = makeClient(DISABLED_CONFIG);
    const invalidated = trackInvalidations(client);
    seedReturnOutcome({
      kind: "saved",
      card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
    });
    render(wrapWith(client));

    await waitFor(() => {
      if (invalidated.length === 0) {
        throw new Error("config query not invalidated");
      }
    });
    expect(invalidated).toContainEqual({
      queryKey: organizationsBillingAutoTopUpRetrieveQueryKey(),
    });
  });

  test("drops an outcome that settled under a different user or organization", async () => {
    // The store is module level and survives the remount a user or org switch
    // gives the request-scoped QueryClient, so an outcome resolved under the
    // replaced scope would otherwise replay that organization's saved card
    // here and invalidate this organization's billing cache.
    const client = makeClient(DISABLED_CONFIG);
    const invalidated = trackInvalidations(client);
    seedReturnOutcome(
      {
        kind: "saved",
        card: { brand: "visa", last4: "4242", autoReloadEnabled: false },
      },
      "user:someone-else:org:org_other",
    );
    render(wrapWith(client));

    expect(lastPmModalProps().open).toBe(false);
    expect(lastPmModalProps().initialOutcome).toBeNull();
    await waitFor(() => {
      if (useSetupIntentReturnStore.getState().outcome != null) {
        throw new Error("stale outcome not cleared");
      }
    });
    expect(invalidated).toEqual([]);
  });

  test("leaves the cache alone when the confirm produced no card", () => {
    // The confirm failed and the 20s poll timed out, so the cache holds only
    // the poll's deliberate optimistic flip: a refetch would wipe it while the
    // modal still reads "Card saved".
    const client = makeClient(DISABLED_CONFIG);
    const invalidated = trackInvalidations(client);
    seedReturnOutcome({ kind: "saved", card: null });
    render(wrapWith(client));

    // The outcome did reach the card: it opened the modal on the success panel.
    expect(lastPmModalProps().open).toBe(true);
    expect(invalidated).toEqual([]);
  });

  test("replays an error outcome into replace mode with the card on file", () => {
    retrieveResponse = { ...DISABLED_WITH_CARD };
    const returnedOutcome = seedReturnOutcome({
      kind: "error",
      message: "Your card was declined.",
    });
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
    const returnedOutcome = seedReturnOutcome({
      kind: "error",
      message: "Your card was declined.",
    });
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
    useSetupIntentReturnStore.setState({ pending: true });
    const { getByTestId } = render(wrap(DISABLED_CONFIG));

    expect(
      (getByTestId("payment-methods-add") as HTMLButtonElement).disabled,
    ).toBe(true);
  });

  test("disables Replace card while the return is unresolved", () => {
    useSetupIntentReturnStore.setState({ pending: true });
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
    seedReturnOutcome({ kind: "saved", card: null });
    const { container } = render(wrap(DISABLED_CONFIG));

    act(() => {
      lastPmModalProps().onClose();
    });

    expect(useSetupIntentReturnStore.getState().outcome).toBeNull();
    expect(lastPmModalProps().open).toBe(false);
    expect(lastPmModalProps().initialOutcome).toBeNull();
    expect(container.querySelector('[data-testid="pm-modal-stub"]')).toBeNull();
  });
});

describe("PaymentMethodsCard expiry and billing address", () => {
  test("shows the expiry on the saved card row", () => {
    retrieveResponse = { ...WITH_EXPIRY_AND_ADDRESS };
    const { getByTestId } = render(wrap(WITH_EXPIRY_AND_ADDRESS));

    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Ending in 4242");
    expect(row.textContent).toContain("\u00b7 04 / 42");
  });

  test("hands the modal the expiry and the saved billing address", () => {
    retrieveResponse = { ...WITH_EXPIRY_AND_ADDRESS };
    const { getByTestId } = render(wrap(WITH_EXPIRY_AND_ADDRESS));

    fireEvent.click(getByTestId("payment-method-update"));

    expect(lastPmModalProps().mode).toBe("replace");
    expect(lastPmModalProps().cardOnFile).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: 4,
      expYear: 2042,
    });
    expect(lastPmModalProps().billingAddress).toEqual(BILLING_ADDRESS);
  });

  test("renders with nulls when the platform omits the keys", () => {
    const legacy = withoutPlatformExpiryAndAddress(WITH_EXPIRY_AND_ADDRESS);
    retrieveResponse = { ...legacy };
    const { getByTestId } = render(wrap(legacy));

    const row = getByTestId("payment-method-row");
    expect(row.textContent).toContain("Ending in 4242");
    expect(row.textContent).not.toContain("\u00b7");

    fireEvent.click(getByTestId("payment-method-update"));

    expect(lastPmModalProps().cardOnFile).toEqual({
      brand: "visa",
      last4: "4242",
      expMonth: null,
      expYear: null,
    });
    expect(lastPmModalProps().billingAddress).toBeNull();
  });
});
