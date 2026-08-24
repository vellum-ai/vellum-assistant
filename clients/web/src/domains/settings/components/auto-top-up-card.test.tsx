/**
 * Tests for the AutoTopUpCard enabled-state layout, the repeated-decline
 * cutoff notice, and the `configure_top_up` deeplink:
 *  - The enabled view renders two summary chips (spend rule + monthly-cap
 *    progress) and Adjust swaps the chips for the inline form. Card
 *    management lives in `PaymentMethodsCard`, so no payment-method row
 *    renders here.
 *  - When the shared config's payment method goes away (removed in the
 *    Payment Methods section), the card exits the Adjust form and drops the
 *    add-card gate.
 *  - When the backend reports `disabled_due_to_repeated_failures` on a disabled
 *    config, the card renders a tailored warning; a normally-disabled config
 *    renders no such notice; the notice is suppressed when `enabled`.
 *  - Toggling Enable on while cut off (even with a saved PM) does NOT open the
 *    form.
 *  - Arriving with `?configure_top_up=1` replays the toggle-on path (reveal the
 *    form, or the add-card gate with no PM), no-ops while enabled, and never
 *    fires an update mutation.
 *  - A successful enable invalidates the daily-limit and billing summary
 *    queries so the daily-limit card picks up the server-applied default.
 *
 * Strategy: the render-only cases pre-populate the React Query cache so the
 * card's `useQuery` resolves synchronously — `renderToStaticMarkup` is
 * single-pass, so a pending query would otherwise report `isLoading`. The
 * interaction cases use @testing-library/react (happy-dom via the test
 * preload). Every render is wrapped in a MemoryRouter because the card reads
 * `useSearchParams`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as platformDetection from "@/runtime/platform-detection";
import * as runtimeBrowser from "@/runtime/browser";
import type {
  AutoTopUpConfigResponse,
  DailyCreditLimitResponse,
} from "@/generated/api/types.gen";

let nativeAndroid = false;
mock.module("@/runtime/platform-detection", () => ({
  ...platformDetection,
  useIsNativeAndroid: () => nativeAndroid,
}));

let openedUrl: string | null = null;
mock.module("@/runtime/browser", () => ({
  ...runtimeBrowser,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

let updateCalls: Array<Record<string, unknown>> = [];
let retrieveResponse: AutoTopUpConfigResponse;
let dailyLimitResponse: DailyCreditLimitResponse;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  // Record any auto-top-up update (the PUT that persists a config). The
  // `configure_top_up` deeplink must never trigger this on mount.
  organizationsBillingAutoTopUpUpdate: (opts: Record<string, unknown>) => {
    updateCalls.push(opts);
    return Promise.resolve({ data: retrieveResponse, response: { ok: true } });
  },
  organizationsBillingAutoTopUpRetrieve: () =>
    Promise.resolve({ data: retrieveResponse, response: { ok: true } }),
  organizationsBillingDailyCreditLimitRetrieve: () =>
    Promise.resolve({ data: dailyLimitResponse, response: { ok: true } }),
}));

import {
  organizationsBillingAutoTopUpRetrieveQueryKey,
  organizationsBillingDailyCreditLimitRetrieveQueryKey,
  organizationsBillingSummaryRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

const { AutoTopUpCard, DISABLED_CONFIG } = await import("./auto-top-up-card");

function makeClient(config: AutoTopUpConfigResponse): QueryClient {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  client.setQueryData(organizationsBillingAutoTopUpRetrieveQueryKey(), config);
  client.setQueryData(
    organizationsBillingDailyCreditLimitRetrieveQueryKey(),
    dailyLimitResponse,
  );
  return client;
}

/**
 * Wrap the card in a QueryClientProvider (cache pre-seeded from `config` and
 * the current `dailyLimitResponse`) and a MemoryRouter at `route`, so both
 * `useQuery` and `useSearchParams` resolve. Pass `client` to observe the cache
 * from the test.
 */
function wrap(
  config: AutoTopUpConfigResponse,
  route = "/",
  client: QueryClient = makeClient(config),
) {
  return (
    <QueryClientProvider client={client}>
      <MemoryRouter initialEntries={[route]}>
        <AutoTopUpCard />
      </MemoryRouter>
    </QueryClientProvider>
  );
}

function renderCard(config: AutoTopUpConfigResponse, route = "/"): string {
  return renderToStaticMarkup(wrap(config, route));
}

const ENABLED_WITH_CARD: AutoTopUpConfigResponse = {
  ...DISABLED_CONFIG,
  enabled: true,
  threshold_usd: "50.00",
  amount_usd: "200.00",
  monthly_cap_usd: "500.00",
  current_month_credits_purchased_usd: "150.00",
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

beforeEach(() => {
  updateCalls = [];
  nativeAndroid = false;
  openedUrl = null;
  retrieveResponse = { ...DISABLED_CONFIG };
  dailyLimitResponse = {
    daily_credit_limit_usd: null,
    current_day_spent_usd: "0.00",
    day_bucket: null,
    daily_limit_snoozed: false,
    daily_limit_snoozed_day_bucket: null,
  };
});

afterEach(cleanup);

describe("AutoTopUpCard enabled-state layout", () => {
  test("renders both summary chips and Adjust swaps them for the form", () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container, getByTestId } = render(wrap(ENABLED_WITH_CARD));

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

  test("does not render the payment-method row (card management lives in Payment Methods)", () => {
    const html = renderCard(ENABLED_WITH_CARD);

    expect(html).not.toContain("payment-method-row");
    expect(html).toContain("auto-top-up-summary");
  });
});

describe("AutoTopUpCard on native Android", () => {
  test("toggle-on opens the web configure deep link instead of the form", async () => {
    nativeAndroid = true;
    const { container, getByLabelText } = render(wrap(DISABLED_WITH_CARD));

    fireEvent.click(getByLabelText("Enable auto-reload"));

    await waitFor(() =>
      expect(openedUrl).toBe(
        `${window.location.origin}/assistant/settings/usage?tab=billing&configure_top_up=1`,
      ),
    );
    expect(updateCalls).toEqual([]);
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).toBeNull();
  });

  test("Adjust opens the web configure deep link instead of the form", async () => {
    nativeAndroid = true;
    const { container, getByTestId } = render(wrap(ENABLED_WITH_CARD));

    fireEvent.click(getByTestId("auto-top-up-edit-button"));

    await waitFor(() =>
      expect(openedUrl).toBe(
        `${window.location.origin}/assistant/settings/usage?tab=billing&configure_top_up=1`,
      ),
    );
    expect(updateCalls).toEqual([]);
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).toBeNull();
  });
});

describe("AutoTopUpCard payment-method removal reaction", () => {
  test("losing the payment method while adjusting exits the form and turns the toggle off", async () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const client = makeClient(ENABLED_WITH_CARD);
    const { container, getByLabelText, getByTestId } = render(
      wrap(ENABLED_WITH_CARD, "/", client),
    );

    // Let the mount-time background refetch settle first, so its (stale)
    // result cannot land after the removal write below and mask the
    // transition.
    await waitFor(() => {
      if (client.isFetching() > 0) {
        throw new Error("config refetch still in flight");
      }
    });

    fireEvent.click(getByTestId("auto-top-up-edit-button"));
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).not.toBeNull();

    // Simulate `PaymentMethodsCard` removing the card: its optimistic write
    // drives the shared config cache to the disabled / no-PM state, and any
    // follow-up GET agrees.
    const removedConfig: AutoTopUpConfigResponse = {
      ...ENABLED_WITH_CARD,
      enabled: false,
      has_payment_method: false,
      payment_method_brand: null,
      payment_method_last4: null,
    };
    retrieveResponse = removedConfig;
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      removedConfig,
    );

    await waitFor(() => {
      if (container.querySelector('[data-testid="auto-top-up-save-button"]')) {
        throw new Error("form still mounted after removal");
      }
    });
    expect(
      getByLabelText("Enable auto-reload").getAttribute("aria-checked"),
    ).toBe("false");
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
    expect(html).toContain(
      "We paused automatic reloads after several declined",
    );
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

    const { container, getByLabelText } = render(wrap(config));
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');

    // The form is not present before the click.
    expect(form()).toBeNull();

    fireEvent.click(getByLabelText("Enable auto-reload"));

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

    const { container, getByLabelText } = render(wrap(config));
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');

    expect(form()).toBeNull();

    fireEvent.click(getByLabelText("Enable auto-reload"));

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

    const { container, getByLabelText } = render(wrap(config));
    const form = () =>
      container.querySelector('[data-testid="auto-top-up-save-button"]');
    const addPmButton = () =>
      container.querySelector('[data-testid="auto-top-up-add-pm-button"]');
    const toggle = getByLabelText("Enable auto-reload");

    // The add-a-card button stays mounted inside the collapse-animation
    // wrapper, so it is always in the DOM; the toggle starting unchecked is
    // the pre-condition the click flips.
    expect(toggle.getAttribute("aria-checked")).toBe("false");

    fireEvent.click(toggle);

    expect(toggle.getAttribute("aria-checked")).toBe("true");
    expect(addPmButton()).not.toBeNull();
    expect(form()).toBeNull();
  });

  test("a card saved via the Payment Methods section continues a pending enable into the form", async () => {
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: false,
      disabled_due_to_repeated_failures: false,
    };
    const client = makeClient(config);
    const { container, getByLabelText } = render(wrap(config, "/", client));

    // Let the mount-time background refetch settle so it cannot overwrite the
    // card-appeared write below.
    await waitFor(() => {
      if (client.isFetching() > 0) {
        throw new Error("config refetch still in flight");
      }
    });

    // Toggle on with no card: the add-card gate shows, no form.
    fireEvent.click(getByLabelText("Enable auto-reload"));
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).toBeNull();

    // Simulate the card arriving through the Payment Methods section: its
    // poll refreshes the shared config query.
    const withCard: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      payment_method_brand: "visa",
      payment_method_last4: "4242",
      stripe_payment_method_updated_at: "2026-08-19T00:00:00Z",
    };
    retrieveResponse = withCard;
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      withCard,
    );

    // The pending enable continues into the configure form; the toggle stays
    // visually on (still pendingEnable until Save persists).
    await waitFor(() => {
      if (
        !container.querySelector('[data-testid="auto-top-up-save-button"]')
      ) {
        throw new Error("form did not open after the card appeared");
      }
    });
    expect(
      getByLabelText("Enable auto-reload").getAttribute("aria-checked"),
    ).toBe("true");
  });

  test("clearing the declines cutoff with a fresh card continues a pending enable into the form", async () => {
    // Toggle-on while cut off gates the flow even though the declined card is
    // on file. Once a fresh card lands (backend clears the flag), the pending
    // enable continues into the form.
    const cutOff: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: true,
    };
    retrieveResponse = { ...cutOff };
    const client = makeClient(cutOff);
    const { container, getByLabelText } = render(wrap(cutOff, "/", client));

    await waitFor(() => {
      if (client.isFetching() > 0) {
        throw new Error("config refetch still in flight");
      }
    });

    fireEvent.click(getByLabelText("Enable auto-reload"));
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).toBeNull();

    const freshCard: AutoTopUpConfigResponse = {
      ...cutOff,
      disabled_due_to_repeated_failures: false,
      stripe_payment_method_updated_at: "2026-08-19T00:00:00Z",
    };
    retrieveResponse = freshCard;
    client.setQueryData(
      organizationsBillingAutoTopUpRetrieveQueryKey(),
      freshCard,
    );

    await waitFor(() => {
      if (
        !container.querySelector('[data-testid="auto-top-up-save-button"]')
      ) {
        throw new Error("form did not open after the cutoff cleared");
      }
    });
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

    const { container, getByLabelText } = render(wrap(config));

    fireEvent.click(getByLabelText("Enable auto-reload"));

    expect(container.textContent).toContain(
      "Auto-reload requires you to connect a credit card.",
    );
    expect(container.textContent).not.toContain("ACTION");
  });
});

describe("AutoTopUpCard configure_top_up deeplink", () => {
  test("arriving with ?configure_top_up=1 (disabled, PM on file) reveals the configure form", () => {
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
      disabled_due_to_repeated_failures: false,
    };

    const { container, getByLabelText } = render(
      wrap(config, "/?configure_top_up=1"),
    );

    // The toggle-on path ran: the toggle flipped and the configure form opened,
    // exactly as clicking the toggle would — with no update mutation.
    expect(
      getByLabelText("Enable auto-reload").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).not.toBeNull();
    expect(updateCalls.length).toBe(0);
  });

  test("arriving with ?configure_top_up=1 and no PM shows the Add a Credit Card gate", () => {
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: false,
      disabled_due_to_repeated_failures: false,
    };

    const { container, getByLabelText } = render(
      wrap(config, "/?configure_top_up=1"),
    );

    // No PM on file → the add-card gate is shown instead of the form.
    expect(
      getByLabelText("Enable auto-reload").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="auto-top-up-add-pm-button"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).toBeNull();
    expect(updateCalls.length).toBe(0);
  });

  test("arriving with ?configure_top_up=1 while already enabled opens the Adjust editor", () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const { container, getByLabelText } = render(
      wrap(ENABLED_WITH_CARD, "/?configure_top_up=1"),
    );

    // Already enabled: the link opens the same editor the Adjust button does.
    // The toggle stays on and nothing mutates; persistence still needs Save.
    expect(
      getByLabelText("Enable auto-reload").getAttribute("aria-checked"),
    ).toBe("true");
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="auto-top-up-summary"]'),
    ).toBeNull();
    expect(updateCalls.length).toBe(0);
  });

  test("without the param the card stays disabled and closed (no auto-open)", () => {
    const config: AutoTopUpConfigResponse = {
      ...DISABLED_CONFIG,
      enabled: false,
      has_payment_method: true,
    };

    const { container, getByLabelText } = render(wrap(config, "/"));

    expect(
      getByLabelText("Enable auto-reload").getAttribute("aria-checked"),
    ).toBe("false");
    expect(
      container.querySelector('[data-testid="auto-top-up-save-button"]'),
    ).toBeNull();
    expect(updateCalls.length).toBe(0);
  });
});

describe("AutoTopUpCard default daily credit limit", () => {
  test("invalidates the daily-limit and summary queries after a successful enable", async () => {
    const client = makeClient(DISABLED_WITH_CARD);
    const invalidated: string[] = [];
    const invalidateQueries = client.invalidateQueries.bind(client);
    client.invalidateQueries = (filters, options) => {
      invalidated.push(JSON.stringify(filters?.queryKey));
      return invalidateQueries(filters, options);
    };

    const { getByLabelText, getByTestId } = render(
      wrap(DISABLED_WITH_CARD, "/", client),
    );

    fireEvent.click(getByLabelText("Enable auto-reload"));
    fireEvent.click(getByTestId("auto-top-up-save-button"));

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("update endpoint not called");
      }
    });

    // The server applies its default daily limit on enable, so both the
    // daily-limit card's query and the summary that carries the derived limit
    // fields are refreshed.
    await waitFor(() => {
      const expected = [
        JSON.stringify(organizationsBillingDailyCreditLimitRetrieveQueryKey()),
        JSON.stringify(organizationsBillingSummaryRetrieveQueryKey()),
      ];
      for (const key of expected) {
        if (!invalidated.includes(key)) {
          throw new Error(`missing invalidation for ${key}`);
        }
      }
    });
  });

  test("does not invalidate the daily-limit query when adjusting an enabled config", async () => {
    retrieveResponse = { ...ENABLED_WITH_CARD };
    const client = makeClient(ENABLED_WITH_CARD);
    const invalidated: string[] = [];
    const invalidateQueries = client.invalidateQueries.bind(client);
    client.invalidateQueries = (filters, options) => {
      invalidated.push(JSON.stringify(filters?.queryKey));
      return invalidateQueries(filters, options);
    };

    const { getByTestId } = render(wrap(ENABLED_WITH_CARD, "/", client));

    fireEvent.click(getByTestId("auto-top-up-edit-button"));
    fireEvent.click(getByTestId("auto-top-up-save-button"));

    await waitFor(() => {
      if (updateCalls.length === 0) {
        throw new Error("update endpoint not called");
      }
    });

    expect(invalidated).not.toContain(
      JSON.stringify(organizationsBillingDailyCreditLimitRetrieveQueryKey()),
    );
  });
});
