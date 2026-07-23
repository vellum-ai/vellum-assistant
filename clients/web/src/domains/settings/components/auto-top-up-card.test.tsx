/**
 * Tests for the AutoTopUpCard enabled-state layout and the repeated-decline
 * cutoff notice:
 *  - The enabled view renders the payment-method row above two summary chips
 *    (spend rule + monthly-cap progress) and Adjust swaps the chips for the
 *    inline form.
 *  - Removing the saved card opens a destructive confirm; confirming calls the
 *    remove endpoint and drives the config to disabled / no card.
 *  - When the backend reports `disabled_due_to_repeated_failures` on a disabled
 *    config, the card renders a tailored warning; a normally-disabled config
 *    renders no such notice; the notice is suppressed when `enabled`.
 *  - Toggling Enable on while cut off (even with a saved PM) does NOT open the
 *    form.
 *
 * Strategy: the render-only cases pre-populate the React Query cache so the
 * card's `useQuery` resolves synchronously — `renderToStaticMarkup` is
 * single-pass, so a pending query would otherwise report `isLoading`. The
 * interaction cases use @testing-library/react (happy-dom via the test
 * preload). The remove flow mocks the SDK boundary so the mutation and the
 * follow-up GET are deterministic.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { AutoTopUpConfigResponse } from "@/generated/api/types.gen";

let removeCalls: Array<Record<string, unknown>> = [];
let retrieveResponse: AutoTopUpConfigResponse;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingAutoTopUpRemovePaymentMethodCreate: (
    opts: Record<string, unknown>,
  ) => {
    removeCalls.push(opts);
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
      data: { enabled: false, stubbed: false, message: "Payment method removed" },
      response: { ok: true },
    });
  },
  organizationsBillingAutoTopUpRetrieve: () =>
    Promise.resolve({ data: retrieveResponse, response: { ok: true } }),
}));

import { organizationsBillingAutoTopUpRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";

const { AutoTopUpCard, DISABLED_CONFIG } = await import("./auto-top-up-card");

function makeClient(config: AutoTopUpConfigResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), config);
  return client;
}

function renderCard(config: AutoTopUpConfigResponse): string {
  return renderToStaticMarkup(
    <QueryClientProvider client={makeClient(config)}>
      <AutoTopUpCard />
    </QueryClientProvider>,
  );
}

const ENABLED_WITH_CARD: AutoTopUpConfigResponse = {
  ...DISABLED_CONFIG,
  enabled: true,
  threshold_usd: "50.00",
  amount_usd: "200.00",
  monthly_cap_usd: "500.00",
  current_month_credits_purchased_usd: "150.00",
  has_payment_method: true,
  payment_method_brand: "Visa",
  payment_method_last4: "4242",
};

beforeEach(() => {
  removeCalls = [];
  retrieveResponse = { ...DISABLED_CONFIG };
});

afterEach(cleanup);

describe("AutoTopUpCard enabled-state layout", () => {
  test("renders both summary chips and Adjust swaps them for the form", () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container, getByTestId } = render(
      <QueryClientProvider client={makeClient(ENABLED_WITH_CARD)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );

    expect(getByTestId("auto-top-up-summary").textContent).toContain(
      "Add $200 when balance falls under $50",
    );
    const cap = getByTestId("auto-top-up-cap-progress").textContent ?? "";
    expect(cap).toContain("$150");
    expect(cap).toContain("$500");
    expect(cap).toContain("this month");

    // Adjust enters form mode: the chips disappear, the form's Save appears.
    fireEvent.click(getByTestId("auto-top-up-edit-button"));

    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="auto-top-up-summary"]'),
    ).toBeNull();
  });

  test("renders the payment-method row above the summary chips", () => {
    const html = renderCard(ENABLED_WITH_CARD);

    expect(html).toContain("payment-method-row");
    expect(html).toContain("Visa");
    expect(html).toContain("Ending in 4242");
    // The row's Update/Remove controls belong to it.
    expect(html).toContain("payment-method-update");
    expect(html).toContain("payment-method-remove");

    // The row is rendered before the summary chips.
    expect(html.indexOf("payment-method-row")).toBeLessThan(
      html.indexOf("auto-top-up-summary"),
    );
  });
});

describe("AutoTopUpCard remove card", () => {
  test("confirming Remove calls the endpoint and disables Extra Usage", async () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(ENABLED_WITH_CARD)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );

    // Precondition: the card is on file and Extra Usage is on.
    expect(
      container.querySelector('[data-testid="payment-method-row"]'),
    ).not.toBeNull();

    // Remove opens a destructive confirm that warns it turns off Extra Usage.
    fireEvent.click(
      container.querySelector('[data-testid="payment-method-remove"]')!,
    );
    const confirmButton = await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        "[data-confirm-dialog-confirm]",
      );
      if (!btn) {
        throw new Error("confirm dialog not open");
      }
      return btn;
    });
    expect(document.body.textContent).toContain("Remove payment method?");
    expect(document.body.textContent).toContain("turn off Extra Usage");
    expect(removeCalls.length).toBe(0);

    fireEvent.click(confirmButton);

    await waitFor(() => {
      if (removeCalls.length === 0) {
        throw new Error("remove endpoint not called");
      }
    });

    // The card drops to the disabled / no-card state: toggle off, no PM row.
    await waitFor(() => {
      const toggle = getByLabelText("Enable Extra Usage");
      if (toggle.getAttribute("aria-checked") !== "false") {
        throw new Error("still enabled");
      }
      if (container.querySelector('[data-testid="payment-method-row"]')) {
        throw new Error("payment-method row still present");
      }
    });
    expect(
      container.querySelector('[data-testid="auto-top-up-summary"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="auto-top-up-remove-error"]'),
    ).toBeNull();
  });
});

describe("AutoTopUpCard repeated-decline cutoff notice", () => {
  test("renders the cutoff notice when disabled after repeated declines", () => {
    const html = renderCard({
      ...DISABLED_CONFIG,
      has_payment_method: false,
      disabled_due_to_repeated_failures: true,
    });
    expect(html).toContain("auto-top-up-declined-cutoff");
    expect(html).toContain("We paused automatic reloads after several declined");
  });

  test("does not render the cutoff notice for a normally-disabled config", () => {
    const html = renderCard({
      ...DISABLED_CONFIG,
      has_payment_method: false,
      disabled_due_to_repeated_failures: false,
    });
    expect(html).not.toContain("auto-top-up-declined-cutoff");
  });

  test("suppresses the cutoff notice when the config is enabled", () => {
    // Defensive guard: the backend treats the cutoff as terminal (cutoff ⇒
    // enabled=false), but if a raced/stale response carried both `enabled: true`
    // and the flag, the enabled summary and the cutoff notice must stay mutually
    // exclusive — show the summary, not the contradictory "we paused reloads".
    const html = renderCard({
      ...DISABLED_CONFIG,
      enabled: true,
      threshold_usd: "50.00",
      amount_usd: "200.00",
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    });
    expect(html).not.toContain("auto-top-up-declined-cutoff");
    expect(html).toContain("auto-top-up-summary");
  });

  test("renders the cutoff notice (not the enabled summary) when cut off with a saved PM", () => {
    // The saved card is still on file (`has_payment_method: true`) but the
    // backend cut auto-reload off after repeated declines. The cutoff notice is
    // the single message; the enabled summary is absent.
    const html = renderCard({
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    });
    expect(html).toContain("auto-top-up-declined-cutoff");
    expect(html).not.toContain("auto-top-up-summary");
  });
});

describe("AutoTopUpCard enable gate", () => {
  test("toggling Enable on while cut off (with a saved PM) does not open the form", () => {
    // Even though a PM is on file, the repeated-decline cutoff must block
    // re-enabling with the same cut-off card. The toggle must not enter form
    // mode (no AutoTopUpForm / Save button), and the cutoff notice stays.
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    };

    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(config)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');

    // The form is not present before the click.
    expect(form()).toBeNull();

    fireEvent.click(getByLabelText("Enable Extra Usage"));

    // The enable gate tripped: still no form, and the cutoff notice persists.
    expect(form()).toBeNull();
    expect(
      container.querySelector('[data-testid="auto-top-up-declined-cutoff"]'),
    ).not.toBeNull();
  });

  test("toggling Enable on with a saved PM and no cutoff opens the form", () => {
    // Control case: without the cutoff flag, a saved PM lets the user enter the
    // configure form — confirms the gate only blocks the cut-off state.
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: false,
    };

    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(config)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');

    expect(form()).toBeNull();

    fireEvent.click(getByLabelText("Enable Extra Usage"));

    expect(form()).not.toBeNull();
  });

  test("toggling Enable on with no payment method shows the Add payment method button, not the form", () => {
    // The toggle is never disabled: turning it on with no PM on file flips
    // the toggle visually and gates on an actionable "Add payment method"
    // button instead of blocking the click or the form.
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: false,
      disabled_due_to_repeated_failures: false,
    };

    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(config)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');
    const addPmButton = () =>
      container.querySelector('[data-testid="auto-top-up-add-pm-button"]');
    const toggle = getByLabelText("Enable Extra Usage");

    // The add-a-card button stays mounted inside the collapse-animation
    // wrapper, so it is always in the DOM; the toggle starting unchecked is
    // the pre-condition the click flips.
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(addPmButton()).not.toBeNull();
    expect(form()).toBeNull();
  });

  test("the no-payment-method banner shows the connect-card notice without the ACTION placeholder", () => {
    // The banner renders the connect-a-card copy and only a dismiss control —
    // never the Figma component's empty actions-slot "ACTION" placeholder.
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: false,
      disabled_due_to_repeated_failures: false,
    };

    const { container, getByLabelText } = render(
      <QueryClientProvider client={makeClient(config)}>
        <AutoTopUpCard />
      </QueryClientProvider>,
    );

    fireEvent.click(getByLabelText("Enable Extra Usage"));

    expect(container.textContent).toContain(
      "Extra usage requires you to connect a credit card.",
    );
    expect(container.textContent).not.toContain("ACTION");
  });
});
